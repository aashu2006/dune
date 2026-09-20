# 01 · Backend build spec

Dune · CloudSmiths

## Scope and stack

This doc covers everything behind the API: indexing, storage, retrieval, generation, and the MCP server. Frontend is in `02-FRONTEND.md`. The API contract both sides build against is in `03-API.md` and is authoritative. If this doc and that one disagree, the API doc wins.

### Stack

- **Runtime:** Node.js 24, TypeScript throughout.
- **Parsing:** `web-tree-sitter` with WASM grammars for TypeScript, TSX and Python. Not the native `tree-sitter` bindings, which would mean compiling native modules for the Lambda runtime.
- **Compute:** Lambda. `ApiFn` for the HTTP handlers, `IndexFn` for the pipeline, `McpFn` for the MCP server.
- **Storage:** S3 for repo snapshots, DynamoDB for graph, metadata, chunks and context.
- **Vectors:** stored in DynamoDB as packed blobs, cosine similarity computed in the query Lambda. OpenSearch Serverless only if measured retrieval time exceeds 1 second.
- **Embeddings and generation:** both behind provider interfaces. The default embedder is local, `@xenova/transformers` running `all-MiniLM-L6-v2` in-process, so indexing needs no model access. Generation is Gemini, with Groq as an alternative. The Bedrock implementations (Claude Sonnet through the global cross-Region inference profile, Titan for embeddings) are written against the same interfaces and unused, because model access was never granted.
- **IaC:** AWS SAM. One template, one deploy command.

### Non-negotiables

- Language support is TypeScript, TSX, JavaScript, JSX and Python. Python was added once the rest was deployed, because a second grammar in the same pipeline is cheap: see "Python extraction". Do not add a third without the same evidence.
- Every response the API returns must match the shape in `03-API.md` exactly, including null fields rather than missing keys.
- No feature lands without an error path. The frontend must never receive an unhandled exception.

### Order of work

Build in this order. Each step is verifiable on its own before the next starts.

1. Hello-world deploy through the whole stack, before any real logic
2. Clone and parse, producing a graph JSON
3. Chunk and embed, stored and retrievable
4. Query endpoint producing a structured answer
5. Context read and write
6. Git-aware suggestions
7. MCP server

## Repository layout

One deployable unit (the SAM stack: `ApiFn`, `IndexFn`, `McpFn`), plus the web app on Amplify. Shared types throughout.

```
dune/
  docs/                      # all specs, this doc included
  packages/
    shared/                  # types shared by everything
      src/types.ts           # Answer, GraphNode, GraphEdge, ContextItem
      src/schema.ts          # zod schemas, single source of validation
    indexer/                 # the pipeline, one step per file
      src/clone.ts
      src/parse.ts             # TypeScript, TSX, JS, JSX
      src/python.ts            # Python: imports, routes, mount prefixes
      src/next-routes.ts       # Next.js App Router file-path routes
      src/chunk.ts
      src/embed.ts
      src/graph.ts             # nodes, edges, kinds, layout
      src/pipeline.ts          # runs the steps in order
      src/lambda.ts            # IndexFn handler
    api/                     # Lambda handlers behind API Gateway
      src/handlers/repos.ts
      src/handlers/query.ts
      src/handlers/context.ts
      src/handlers/export.ts
      src/handlers/suggestions.ts
      src/lib/retrieval.ts
      src/lib/generation/      # the Generator interface, Gemini and Groq
      src/lib/answer.ts        # anti-hallucination checks and confidence
      src/lib/db.ts
    mcp/                     # MCP server
      src/tools.ts             # the three tools
      src/lambda.ts            # McpFn handler, Streamable HTTP
      src/server.ts            # the same tools as a local process, with SSE
  infra/
    template.yaml            # SAM template, everything
  scripts/
    eval.ts                  # run the 10 known-answer questions
```

### Rules

- **All types live in `shared`.** The frontend imports the same `Answer` type. If a field changes, it changes in one place.
- **zod schemas are the validation layer.** The same schema validates the model's response and the API response. No hand-written type guards.
- **`lib/db.ts` is the only file that talks to DynamoDB.** Handlers call functions, never the SDK directly.
- **Every pipeline step is a pure function of its input plus S3 and DynamoDB.** A step must be re-runnable without side effects beyond its own writes.

### The eval script

`scripts/eval.ts` runs ten questions with known-correct answers against the deployed API and prints a pass rate. It exists so that prompt and retrieval changes are measured rather than eyeballed. Without it, every change merely feels like an improvement.

## Indexing pipeline

`POST /repos` writes a `queued` job record and invokes `IndexFn` asynchronously. `IndexFn` runs the whole pipeline in one invocation: clone, parse, chunk, embed, persist. It has 3 GB of memory, a 15-minute limit and 2 GB of `/tmp`, and writes the job record at every stage so `GET /repos/:repoId` can report progress. `npm run index` runs the same code locally.

```
RegisterJob -> Clone -> Parse -> Embed -> Persist -> Done
```

The design was a Step Functions state machine with one Lambda per step. One Lambda replaced it: the state machine needs five functions, a Map state, payloads passed through S3 to stay under the 256 KB limit, and IAM for all of it, and its benefits (per-step retries, execution history) matter little at this scale. The cost is that a failed index is re-submitted whole, one repo must index within 15 minutes, and a crash the Lambda cannot report is detected from outside: a job whose record stops moving for longer than the Lambda's timeout is reported as failed. The steps are still separate functions, so moving back is wiring, not a rewrite.

### 1. RegisterJob

**In:** `{ repoUrl, teamId }` **Out:** `{ repoId, jobId }`

`repoId` is a hash of the normalised repo URL, so re-indexing a repo overwrites rather than duplicates. Writes a job record with status `queued` and returns, so the API responds while the pipeline runs.

### 2. Clone

**In:** `{ repoId, repoUrl }` **Out:** `{ repoId, s3Prefix, fileList[] }`

Resolve the default branch's HEAD to a commit SHA, download that commit's tarball into `/tmp`, then upload the working tree to `s3://dune-repos/{repoId}/`. Pin to the SHA and record it. A tarball rather than `git clone`, because the Lambda runtime has no git binary. GitHub's archive of a commit holds exactly its tracked files, the same set `git ls-files` gives, so the `.gitignore` filter still holds.

Filters applied while walking the tree, in this order:

- Skip anything matched by `.gitignore`
- Skip `node_modules`, `dist`, `build`, `.next`, `coverage`, `vendor`, and Python's `__pycache__`, `venv`, `.venv`, `site-packages`, `.tox`, `.mypy_cache`, `.pytest_cache`
- Skip any `.env*` file. Never read, never upload
- Skip files over 500 KB
- Keep only `.ts`, `.tsx`, `.js`, `.jsx`, `.py` for parsing. Other files count towards the file total but are not parsed

If the file count exceeds the cap (1,000), keep all files but mark the overflow so Parse can prioritise, and record `truncated: true` on the repo record so the UI can show a banner.

`/tmp` is 512 MB by default and set to 2 GB here. A download that would exceed it fails loudly rather than truncating.

### 3. Parse

**In:** `{ repoId, fileList[] }` **Out:** graph nodes and edges written to DynamoDB

What to extract is in the next section. A parse failure on one file does not fail the run: log the path and the error, skip it, continue, and track `parseFailures` on the repo record.

### 4. Embed

**In:** chunks produced during Parse **Out:** vectors written alongside chunks

Batches of 32 chunks through the embedder. One bad batch does not fail the index.

### 5. Persist

Computes the derived data the UI needs, so the frontend never computes it:

- Entry point detection (below)
- Graph layout coordinates
- Per-file summary counts: imports in, imports out, exported symbols
- Repo summary: file count, line count

Sets repo status to `ready`.

### Entry point detection

A node is an entry point if any of these hold. It is heuristic, which is enough:

- Path matches `**/routes/**`, `**/routers/**`, `**/api/**`, `**/pages/**`
- Filename is `index.ts`, `main.ts`, `server.ts`, `app.ts`, or Python's `__main__.py`, `main.py`, `app.py`, `wsgi.py`, `asgi.py`, `manage.py`, `settings.py`
- The file has imports out and none in, so something external calls it
- The file registers handlers: calls matching `app.get`, `app.post`, `router.use`, `createServer`

`app/` is deliberately not in the directory list. It means the router in a Next.js repo but the whole package in most Python ones, where it would mark every file.

### Progress reporting

Each stage updates the job record with a stage name and a count, which `GET /repos/:repoId` reads. Stages in order: `queued`, `cloning`, `parsing`, `embedding`, `finalising`, `ready`, `failed`. On `failed`, record which stage failed and a human-readable reason.

## Tree-sitter extraction

The goal is a **module-level graph**, not full semantic analysis. Imports, exports and call sites are enough to answer "where does this belong".

### Setup

```ts
import { Language, Parser } from 'web-tree-sitter';

await Parser.init();
const parser = new Parser();
const TS = await Language.load('tree-sitter-typescript.wasm');
const TSX = await Language.load('tree-sitter-tsx.wasm');
const PY = await Language.load('tree-sitter-python.wasm');
// .ts -> TS grammar, .tsx/.jsx -> TSX grammar, .js -> TSX grammar (handles flow-ish syntax)
// .py -> Python grammar; the extraction for it is in packages/indexer/src/python.ts
```

Bundle the `.wasm` files into the Lambda package. Do not fetch them at runtime.

Take the grammars from `@vscode/tree-sitter-wasm`. The obvious package, `tree-sitter-wasms`, is built against the tree-sitter 0.20 ABI and fails to load in web-tree-sitter 0.27 with an opaque dylink error.

### What to extract per file

**Imports.** From `import_statement` nodes: the module specifier and the imported names. Resolve relative specifiers to repo-relative paths in the usual order (`.ts`, `.tsx`, `.js`, `/index.ts`). Also resolve path aliases from the repo's `tsconfig.json` or `jsconfig.json` (`baseUrl` and `paths`). A Next.js repo leans on `@/*`, and without alias resolution most internal imports resolve to nothing and the graph comes out as unconnected nodes. Record bare specifiers as external dependencies without resolving them.

**Exports.** From `export_statement` nodes: exported symbol names and whether the export is default.

**Declarations.** `function_declaration`, `class_declaration`, `method_definition`, `variable_declarator` holding an arrow function. For each: name, kind, start line, end line.

**Call sites.** From `call_expression` nodes: the callee text and the line. Do not resolve the callee to a declaration. Store the raw text; retrieval matches on it.

**Route registrations.** Call expressions whose callee matches `app.get|post|put|delete|use` or `router.get|post|put|delete|use`. Capture the first string argument as the route path. These matter disproportionately, because most "where do I add X" questions are about request paths.

**Next.js App Router routes.** A Next.js app routes by file path, so it has no registration calls and the rule above finds nothing. When the repo has a `next.config.*`, treat `app/` and `src/app/` beside it as route roots: every `page.jsx|tsx` is a page route, and every `route.js|ts` contributes one route per exported HTTP handler. The URL comes from the directory path, with dynamic segments such as `[groupId]` kept as written, route groups like `(marketing)` and slots like `@modal` dropped, and private `_folders` not routable. `src/app/group/[groupId]/page.jsx` becomes a page route at `/group/[groupId]`. These join the Express-style registrations in the same route table.

### Python extraction

Same `ParsedFile` out, so chunking, the graph and retrieval never learn a second shape. Three things differ, and they are the whole of `python.ts`.

**Imports resolve through the package tree.** `a.b.c` is `a/b/c.py` or `a/b/c/__init__.py`, and the package root is often a subdirectory (`app/`, `src/`, `backend/`), so the repo root and every ancestor of the importing file are tried as roots, nearest first. Relative imports count their leading dots: `from .module import y` is the current package, `from ..pkg.mod import z` the one above. `from package import module` names a file rather than a symbol, so it yields an edge to that module as well as to the package's `__init__.py`. An alias (`import api as articles`) binds the alias, while the original name locates the file. Both are kept, because the alias is the name the rest of the file uses.

**There are no exports.** Module-level `def`, `class` and assignments are the public surface. A module declaring `__all__` is taken at its word. Otherwise every top-level name not starting with `_` is exported.

**Routes are decorators, and their prefixes live somewhere else.** Flask's `@app.route("/x", methods=["POST"])` and `@bp.route`, FastAPI's `@app.get("/x")` and `@router.post("/x")`. `@router.get("")` is the collection endpoint and is real. The path a request uses is only known once the mounts are read: `app.register_blueprint(auth_bp, url_prefix="/auth")` and `router.include_router(articles.router, prefix="/articles")` sit in different files from the routes, and they nest. So a prefix belongs to a router or blueprint *object*, identified by the file that defines it and its name there, with names followed back through imports. Prefixes then accumulate along the mount chain. Flask's `bp`, created in `app/auth/__init__.py`, decorated in `app/auth/routes.py` and registered in `app/__init__.py`, comes out as `/auth/login`. A prefix given as a variable (`prefix=settings.api_prefix`) cannot be read statically, so that link contributes nothing and the path is one segment short rather than wrong.

### Output shape

```ts
interface ParsedFile {
  path: string;
  language: 'ts' | 'tsx' | 'js' | 'jsx' | 'py';
  lineCount: number;
  imports: { specifier: string; resolved: string | null; names: string[] }[];
  exports: { name: string; isDefault: boolean }[];
  declarations: { name: string; kind: string; startLine: number; endLine: number }[];
  calls: { callee: string; line: number }[];
  routes: { method: string; path: string; line: number }[];
}
```

### Building the graph

Nodes are files. Edges are resolved imports, from importer to imported. An edge whose target did not resolve to a file in the repo is dropped. External packages are recorded on the node, not as edges, or the graph becomes noise.

Computed in Persist:

- `importedByCount` per node, a decent proxy for importance
- Simple centrality: many inbound edges means structural, many outbound and none inbound means an entry point
- A cluster label per node from its directory path, used for grouping and colour in the map
- A label per node: the shortest tail of the path no other file shares, so six `users.py` do not all read as `users.py`

### What to deliberately skip

- Type resolution and inference
- Cross-file call graph resolution
- Dynamic imports and re-export chains beyond one hop
- Monorepo package boundary resolution

None of these changes the answer to a "where does this belong" question.

## Chunking and embedding

### Chunking strategy

Chunk on **declaration boundaries**, not fixed character windows. A function split across two chunks retrieves badly.

For each file, produce:

1. **One file-summary chunk.** Path, exported symbols, imports, route registrations, declaration names. A synthetic chunk of roughly 200 tokens describing the file's role. These retrieve well for "where does X happen" questions, because they read like an index.
2. **One chunk per declaration** over 5 lines, containing the declaration's source. A declaration over 1,500 tokens is split and the parts marked.
3. **One chunk for module-level code** outside any declaration, if it is more than 5 lines.

Every chunk carries metadata:

```ts
interface Chunk {
  chunkId: string;        // `${repoId}#${path}#${startLine}#${kind}`
  repoId: string;
  path: string;
  kind: 'file-summary' | 'declaration' | 'module';
  symbolName: string | null;
  startLine: number;
  endLine: number;
  content: string;
  vector: number[];
}
```

The metadata matters as much as the vector. Retrieval filters and re-ranks on it.

### Embedding

Embedding sits behind an `Embedder` interface: an `id`, a `dimension`, and `embed(texts)` returning one vector per text. Two implementations:

- **`LocalEmbedder`**, the default. `@xenova/transformers` running `all-MiniLM-L6-v2` in-process, 384 dimensions. No model access, no per-call cost, fast enough at this scale.
- **`TitanEmbedder`**, the Bedrock path. `amazon.titan-embed-text-v2:0`, 1,024 dimensions. Batches of roughly 50 chunks per call.

**The dimension differs between the two, so their vectors are not comparable.** Every stored vector set records the embedder id and the dimension that produced it, and retrieval refuses a set whose embedder does not match the one embedding the question. Without that record, a switch computes cosine similarity across two incompatible spaces and returns numbers that look fine and mean nothing. Changing embedder means re-indexing.

Embed the chunk content **prefixed with its path and symbol name**. `src/routes/auth.ts :: loginHandler` followed by the source retrieves better than bare source, because path tokens carry real signal for these questions.

### Storage

Store vectors in DynamoDB alongside the chunk. At this scale (roughly 2,000 to 5,000 chunks) loading one repo's vectors and computing cosine similarity in the query Lambda takes well under a second. Measure before moving to OpenSearch Serverless, not the other way round.

To keep the load cheap, store vectors as one packed binary blob per repo (Float32Array to base64), sharded to stay under the item limit, not one item per chunk. One read, not thousands.

## DynamoDB design

Single table, `dune`. Every access pattern here is keyed by `repoId`, so one table and no GSIs.

### Keys

| Entity | PK | SK |
| --- | --- | --- |
| Repo record | `REPO#{repoId}` | `META` |
| Job status | `REPO#{repoId}` | `JOB#{jobId}` |
| File node | `REPO#{repoId}` | `FILE#{path}` |
| Graph (packed) | `REPO#{repoId}` | `GRAPH#{shard}` |
| Vectors (packed) | `REPO#{repoId}` | `VECTORS#{shard}` |
| Route table | `REPO#{repoId}` | `ROUTES` |
| Chunk | `REPO#{repoId}` | `CHUNK#{path}#{startLine}#{kind}` |
| Context item | `TEAM#{teamId}` | `CTX#{repoId}#{timestamp}#{id}` |
| Suggestion draft | `TEAM#{teamId}` | `SUGG#{repoId}#{id}` |

### Access patterns

| Pattern | Query |
| --- | --- |
| Get repo status | GetItem on `REPO#{repoId}` / `META` |
| Get the graph for the map | Query on the `GRAPH#` prefix, pre-computed in Persist |
| Load vectors for retrieval | Query on the `VECTORS#` prefix, typically 1 to 3 shards |
| Fetch chunks by id after ranking | BatchGetItem, up to 100 keys, deduplicated first |
| Get file detail on node click | GetItem on `FILE#{path}` |
| List team context for a repo | Query `TEAM#{teamId}` with SK prefix `CTX#{repoId}#`, newest first |
| List pending suggestions | Query `TEAM#{teamId}` with SK prefix `SUGG#{repoId}#` |

If a GSI becomes necessary the key layout is wrong. Revisit the layout instead.

### Notes

- **On-demand billing.** No capacity planning, scales to zero.
- **Item size limit is 400 KB.** The graph and vector blobs exceed it on a large repo, so both are sharded: `GRAPH#0`, `GRAPH#1`, with a count on the META record.
- **TTL on job records**, 7 days. Keeps the table clean without a cleanup job.
- **Context items are never hard-deleted.** Dismissing a suggestion sets `dismissed: true`. History is the point of the product.

### Team ID

There is no auth. `teamId` is a query parameter that defaults to `demo`, so everyone with the link shares a team. State it plainly rather than implying auth exists.

## Retrieval

This is where answer quality is won or lost. Pure vector search is not enough. The graph is the advantage over generic RAG, so use it.

### Pipeline

**1. Embed the question.** Same model as the chunks.

**2. Vector search.** Cosine similarity over the repo's vectors, top 20.

**3. Keyword boost.** Extract identifier-like tokens from the question (`rate limiting`, `auth`, `login`) and boost chunks whose path or symbol name contains them, weighted around 0.3 against the vector score. A question mentioning "auth" should surface `src/routes/auth.ts` even when the vector score is middling. Test files score at half weight unless the question is about tests.

**4. Graph expansion.** For the top 5 chunks after re-ranking, pull their graph neighbours, the files they import and the files that import them, and include those files' summary chunks. This is the step generic RAG does not have. "Where do I add rate limiting" needs the router above the handlers, and the router is a graph neighbour, not a semantic match.

**5. Route table.** Include the repo's full route list when it has fewer than 50 entries. It is small and disproportionately useful.

**6. Team context.** Always include the team's decisions, failed attempts and constraints for this repo. If someone recorded "we tried Passport.js and removed it", the answer must not suggest Passport.js. This is an injection into every prompt, not an optional extra.

**7. Assemble and cap.** Cap total context around 30,000 tokens. Order: team context, route table, file summaries, then declaration bodies. When the cap is hit, drop declaration bodies from the bottom of the ranking, never the team context.

Team context goes first in the prompt, not last. It is the highest-value, lowest-volume input, and it should not compete for attention with thousands of tokens of source.

### Tuning loop

Run `scripts/eval.ts`, look at which of the ten questions fail, and inspect what was retrieved rather than what was generated. Most wrong answers are retrieval failures, not generation failures. Fix retrieval first. Change the prompt only when the right context was present and the model still got it wrong.

## Generation

Gemini by default, with Groq as an alternative; `GENERATOR` selects one. Model ids live in `GEMINI_MODEL` and `GROQ_MODEL`, never in code, because providers retire models regularly. Gemini is the default because Groq's free tier accepts only 8,000 tokens a minute, far below the 30,000-token context cap.

Generation sits behind a `Generator` interface that takes the assembled context and the question and returns a validated `Answer`. Bedrock drops in behind the same interface, as would anything else that can be made to fill a schema. Prompt structure, the anti-hallucination check and the confidence rules are provider-independent. How the JSON shape is forced is provider-specific.

On the Bedrock path, use the global cross-Region inference profile, which is how Claude models are reachable from India:

```
modelId: 'global.anthropic.claude-sonnet-4-6'
region:  'ap-south-1'
```

Model access is requested per account in the console and is separate from IAM.

### Prompt structure

System prompt, fixed:

> You help engineers locate where a change belongs in a codebase you have been given context for. You never invent file paths. Every file you name must appear in the provided context. If the context does not support a confident answer, say so and name the most likely candidates instead of guessing. You are not writing code; you are locating work.

User message, assembled in this order:

1. Team context block (decisions, failed attempts, constraints), first, because it is the highest-signal input
2. Repo summary (name, framework, file count)
3. Route table
4. Retrieved file summaries
5. Retrieved declaration bodies
6. The question

### Schema enforcement

Do not parse prose. How the shape is forced differs by provider, because they differ in which mechanism is reliable:

- **Gemini:** JSON mode (`responseMimeType: application/json`), with the `Answer` shape in the system prompt.
- **Groq:** JSON mode (`response_format: json_object`), with the `Answer` shape in the system prompt. Groq's JSON mode is more reliable than its tool calling.
- **Bedrock:** tool calling. One tool whose input schema is the `Answer` object from `03-API.md`, and the model required to call it.

Validate the result with the same zod schema the API uses. On validation failure, retry once with the error appended. On a second failure, return `confidence: "low"` with whatever fields did validate and let the UI show a retry.

### Anti-hallucination check

After validation, verify every path in `recommendedFile`, `attachTo` and `sources` against the repo's file list. Drop any that does not exist and downgrade confidence. Line ranges in `sources` are held to the file's real length: clamped when they run past the end, dropped when they start past it. This is a five-line check that prevents the worst failure, a confident answer pointing at a file that does not exist.

### Confidence

Set `confidence` from real signals, not the model's self-report:

- `high`: top retrieval score above threshold, and the recommended file was in the retrieved set
- `medium`: recommended file was retrieved but scores were middling
- `low`: recommended file came from graph expansion only, or validation needed a retry

Retrieval scores alone undersell precise answers, so verified evidence from the index can raise them, and nothing else can:

- **Route:** the question names a request path in the route table (with its method, if given) and the recommended file registers it, so `high`.
- **Symbol:** a retrieved declaration in the recommended file has a name covering two or more of the question's keywords, and no other retrieved file matches as well, so at least `medium`. The "no other file" condition keeps a caller from being raised alongside the definition.

Both need a recommended file, so "nothing here does this" stays `low`. The penalties above still apply afterwards, and the model's own confidence can only lower the result. On the known-answer eval this moved answerable questions from 3 high / 6 medium / 18 low to 6 / 9 / 12 across three runs, with the pass rate unchanged.

Saying "I am not sure, here are the three likely places" is better than a confident wrong answer.

## Suggestions and MCP

### Git-aware suggestion drafting

**Trigger:** the user opens the context panel or hits refresh on it. Not a background job.

**Input:** the diff between the indexed commit and the repo's current HEAD, through GitHub's compare API. An explicit `since` commit can replace the indexed one.

**Process:** send the diff, plus the current team context, to the generator, asking for candidate records in three categories:

- A decision, where the diff shows a choice was made
- A failed attempt, where the diff shows something added and then removed, or a dependency dropped
- A constraint, where the diff shows a version pin or config limit

**Output:** drafts, each with type, title, body, and the files it came from, stored with `status: 'pending'`.

**Critical rule:** drafts are never saved as context automatically. The user approves, edits or dismisses. An approved draft becomes a context item; a dismissed one is marked dismissed and never re-suggested. Auto-detection that is sometimes wrong pollutes the context permanently, and the value of the context is that it can be trusted.

Cap at 5 pending drafts. More than that and nobody reviews any of them. A draft repeating an existing item or an earlier suggestion is discarded.

### MCP server

`McpFn`, on the existing HTTP API at `/mcp`, serving the stateless Streamable HTTP transport: each `POST` builds a server, answers and ends, which suits a Lambda. Nothing is always-on.

The design was App Runner with the SSE transport, because SSE holds a long-lived connection that a Lambda cannot. App Runner is not available to this account, and the MCP spec has since deprecated SSE in favour of Streamable HTTP, which Claude Code, Claude Desktop and Cursor all speak. `packages/mcp/src/server.ts` runs the same tools as a long-lived process with both transports, for local development or a container host later.

**Tools exposed:**

| Tool | Input | Returns |
| --- | --- | --- |
| `get_project_context` | `repoId` | Decisions, failed attempts, constraints, repo summary, as markdown |
| `find_where_to_change` | `repoId`, `question` | The same Answer the web app gets, rendered as markdown |
| `save_decision` | `repoId`, `type`, `title`, `body`, `files` | Confirmation and the new item id |

`repoId` is optional when the connection URL carries `?repoId=`, and `?teamId=` picks the team.

**Implementation:** the MCP server is a thin wrapper over the same HTTP API the frontend calls. No duplicated logic, no second retrieval path. If the web app works, the MCP server works.

**One safety note:** `save_decision` lets an agent write to shared team context. Anything written through MCP is stored as `authoredBy: "agent"` and badged in the UI, whatever the caller claims, so a human can always tell what a model wrote.

## Local development

### Prerequisites

- Node 24
- AWS CLI configured, SAM CLI installed
- A Gemini API key in the gitignored `.env`

### Commands

```bash
npm install
npm run build                     # sam build
npm run deploy                    # sam build and deploy with every parameter

sam local start-api               # API on localhost:3000
npm run index -- <repoUrl>        # run the pipeline locally against real S3 and DynamoDB
npm run similarity -- <question>  # inspect what retrieval returns, before generation
npm run eval                      # the ten known-answer questions
npm run typecheck                 # every package
```

### Environment

```
AWS_REGION=ap-south-1
GENERATOR=gemini                # or groq
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_API_KEY=...              # in the gitignored .env only; deployed as a NoEcho parameter
GROQ_MODEL=openai/gpt-oss-120b
GROQ_API_KEY=...                # likewise; only needed when GENERATOR=groq
GITHUB_TOKEN=...                # optional; raises GitHub's rate limit
TABLE_NAME=dune
REPO_BUCKET=dune-repos-<account>
BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-4-6
BEDROCK_EMBED_MODEL_ID=amazon.titan-embed-text-v2:0
```

Never commit a `.env`. The parser skips them for a reason and so does the repo.

### Local pipeline

`npm run index` runs clone, parse, chunk, embed and persist in one process, against real S3 and DynamoDB. It is the same pipeline `IndexFn` runs when a repo is submitted through the API, so a change verified locally is the change that deploys. `--dry-run` writes the graph and chunks to JSON and touches no AWS resource.

### Order of verification

After each step of the build order, verify before moving on:

1. Hello-world deploy: a request reaches a Lambda and returns, through the real API Gateway URL
2. Parse: `npm run index` on a repo produces a graph JSON with sane node and edge counts
3. Embed: chunks exist in DynamoDB with vectors, and a manual similarity query returns plausible files
4. Query: a question returns a valid Answer that passes zod validation
5. Context: a write from one browser appears in a read from another
6. Suggestions: a real diff produces at least one sensible draft
7. MCP: a client connects and `get_project_context` returns

If a step cannot be verified, do not build on top of it.
