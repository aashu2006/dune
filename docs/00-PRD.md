# 00 · Product requirements: Dune

Dune · CloudSmiths

## The problem

Two things break in the same place, and both cost real time.

**AI agents forget.** You work with one agent, then switch tools or start a new session, and the new one has no idea what happened. It does not know why JWT was picked over sessions, what was already tried and thrown away, which files were changed on purpose, or what is left to do. So you re-explain your own project to an AI every time.

**New people are lost.** Open an unfamiliar repo: 500 files, 80,000 lines, 12 services. Someone says "add rate limiting to the auth API." You spend an hour finding where authentication happens before writing a line.

These look like two problems but they are one: **context about a codebase lives in people's heads, and nothing keeps it.** Every new session, every new joiner, every new agent starts from zero.

The cost is concrete. A new engineer's first weeks go into understanding the codebase, not shipping. The same questions get asked in team chat again and again. Every AI session spends its first few thousand tokens re-learning what the last one knew.

## Who it is for

**Primary: small engineering teams, 3 to 30 people.** The ones where nobody has time to write docs, where the person who built the auth layer has moved on, and where every new joiner asks the same five questions.

**Secondary:**

- New joiners and interns, whose first month goes into reading code instead of writing it
- Open source contributors landing in a repo they have never seen, trying to find where a fix belongs
- The AI agents these people run, which need the same context and currently get none

The unit of value is hours not spent re-discovering what the team already knows.

## Competition and the gap

Both halves of the problem already have tools.

### Repo understanding

| Tool | What it does | Where it stops |
| --- | --- | --- |
| DeepWiki (Cognition) | Pre-indexed architecture wikis for 50,000+ popular public repos | Read-only wiki, nothing about your team's own decisions, public repos only |
| Sourcegraph Cody | Cross-repo search and comprehension on Sourcegraph's code graph | Enterprise infrastructure, heavy setup, priced for large orgs |
| Greptile | Semantic graph across repos, multi-hop investigation for code review | Review-focused, paid per seat, code indexed on their servers |
| Cursor / Augment | IDE-native indexing for generation | Context stays inside that one editor and that one machine |

### Context persistence

This side is more crowded. On GitHub and PyPI: codebase-memory (MCP server storing architecture, patterns, conventions, decisions), handoff-mcp (saves tasks, decisions, blockers to a local .handoff directory), memory-mcp, promem-mcp / ContextMCP, DevContext, Cursor10x, A/MCL.

### The gap

Three things none of them do together:

1. **Everything is local and single-player.** codebase-memory runs on local SQLite, handoff-mcp writes to a local folder. The context is trapped on one machine. Dune is hosted, so one person saves a decision and the whole team's agents have it.
2. **They trust the agent to remember on its own.** Memory is only saved if the agent decides to call a save tool, which is unreliable. Dune reads the git diff, drafts the decision, and asks a human to confirm.
3. **They are invisible.** These are MCP servers with no interface. Nothing to look at, nothing to audit, nothing to hand a new joiner. Dune has a visible map and a readable decision log, with the MCP server on top of it.

One line: **existing tools give one developer a private memory of code. Dune gives a team a shared brain for a repo, readable by humans and agents both.**

## What it is

**Dune is a shared brain for a repo. Point it at your codebase and it answers two questions for everyone on the team: where does this change belong, and what have we already figured out about this code.**

It is not a code generator and not another chat window. It sits one step before those. It gives you, or your agent, the context needed to make a change correctly, and it keeps that context after you make it.

The loop:

1. Connect a repo. It is parsed into a structure map.
2. Ask where a change belongs. You get a specific file, a reason, the blast radius, and the tests to update.
3. As work happens, decisions, dead ends and constraints get captured with one click.
4. All of it is available to the next person and the next agent, through the UI or through MCP.

## Features

**1. Repo connect and index.** Paste a GitHub repo URL. It downloads, parses and builds the structure. Tree-sitter extracts files, imports, exports and function calls. Code chunks are embedded and stored. Progress is live while it runs.

**2. Architecture map.** A graph of the repo: which module depends on what. Entry points, routes, services and models are marked. Click a node to read the file.

**3. "Where do I change this" query.** Ask a question, get a structured answer: the recommended file and the spot to attach the change, why there, what else is affected, which tests to update, and the source lines the conclusion came from.

**4. Team knowledge layer.** Three things are stored and shared across the team: decisions ("JWT not sessions, because X"), failed attempts ("tried Passport.js, removed, conflicted with existing auth"), and constraints ("cannot go above Node 18"). One person saves it, everyone gets it.

**5. Git-aware drafting.** The system reads the diff and proposes: "looks like Passport.js was removed, want to record why?" A human approves or edits. Suggested, never stored on its own.

**6. Context export.** One button, the full record as markdown. Paste into any agent.

**7. MCP server.** The same context delivered straight to agents, no copy-paste. Three tools: `get_project_context`, `find_where_to_change`, `save_decision`.

### Not built

On the roadmap, in this order:

- More languages beyond TypeScript, JavaScript and Python
- Multiple repos in one brain
- Auth, accounts and real team management
- Code generation, not just locating the change
- Real-time collaboration
- Interactive draggable graph instead of static rendering

## Architecture

Everything is serverless and scales to zero. Region is ap-south-1.

### Flow

A repo URL arrives at API Gateway. `ApiFn` writes a job record and invokes `IndexFn`, which runs the whole pipeline in one invocation: download the tarball, parse with tree-sitter into an import graph, chunk the code, embed the chunks, write graph, chunks, vectors and metadata to DynamoDB, and upload a snapshot to S3.

At query time, `ApiFn` embeds the question in-process, ranks chunks by cosine similarity with a keyword boost, expands through the graph, adds the route table and the team's saved context, and sends that to the generator. The answer comes back as JSON against a fixed schema. The web app runs on Amplify Hosting. The MCP server is `McpFn`, on the same HTTP API.

### Services and why

| Layer | Choice | Reason |
| --- | --- | --- |
| API | API Gateway + Lambda | Scales to zero, nothing running when idle |
| Indexing | One Lambda per job (`IndexFn`) | 3 GB memory, 15-minute limit. The design was Step Functions; a state machine costs a day of plumbing and its per-step retries matter little at this scale (see `01-BACKEND.md`) |
| Repo storage | S3 | Snapshots, cheap, nothing to manage |
| Graph and metadata | DynamoDB | Single-digit ms lookups on file and symbol keys, on-demand billing |
| Vectors | Packed blobs in DynamoDB, cosine computed in the query Lambda | For one mid-size repo, OpenSearch Serverless costs more setup than it returns |
| Embeddings | all-MiniLM-L6-v2, bundled in the function | No model access needed, no external call, no per-token cost |
| Generation | Gemini behind a provider interface | Groq is a switchable alternative. Bedrock implements the same interface for when access arrives |
| Frontend | Amplify Hosting | Live URL, builds from `main` |
| MCP server | Lambda (`McpFn`) on the same API | The design was App Runner for SSE; App Runner is not available to this account, and the MCP spec now prefers Streamable HTTP, which is stateless and suits Lambda |

### Technical notes

- Use the WASM tree-sitter grammars, not native bindings. Native modules mean compiling for the Lambda runtime.
- Force structured JSON from the model rather than parsing prose. The answer shape is fixed, so the model fills a schema.
- Claude through Bedrock is reachable from Mumbai only through Global cross-Region inference profiles, so the model id carries a `global.` prefix.

### Cost posture

Nothing is provisioned. Between runs the standing cost is storage only.

## API contract

`03-API.md` is the contract and wins over this section. The endpoints:

```
POST /v1/repos                      { repoUrl, teamId }   -> { repoId, jobId, alreadyIndexed }
GET  /v1/repos/:repoId                                    -> { meta, job, graph }
GET  /v1/repos/:repoId/files/*                            -> { path, content, lineCount, language }
POST /v1/query                      { repoId, teamId, question } -> { answer, tookMs }
GET  /v1/context/:repoId                                  -> { items[], suggestions[] }
POST /v1/context                    { repoId, type, title, body, files[], authoredBy } -> ContextItem
POST /v1/suggestions/:repoId/refresh                      -> { suggestions[] }
POST /v1/suggestions/:id/dismiss                          -> { ok }
GET  /v1/export/:repoId                                   -> { markdown }
```

### Answer shape

The object the whole UI is built around.

```json
{
  "recommendedFile": "src/middleware/rateLimiter.ts",
  "attachTo": "src/routes/auth.ts",
  "reason": "All auth endpoints pass through this router.",
  "affected": ["/login", "/register", "/forgot-password"],
  "testsToUpdate": ["auth.test.ts", "rateLimit.test.ts"],
  "sources": [{ "file": "src/routes/auth.ts", "lines": [12, 48] }],
  "confidence": "high",
  "candidates": null
}
```

Every field is required. A value the backend cannot fill is null, never a missing key, so the frontend never breaks.

## User flows

Three journeys the product supports end to end.

### Flow 1 · First contact with an unfamiliar repo

1. The user pastes a GitHub repo URL and submits.
2. Indexing starts. Progress is visible: cloning, parsing, embedding, finalising, with counts where they exist.
3. On completion the map appears, entry points marked.
4. The user clicks a node and reads the file at that path.

**Success:** within 60 seconds the user can name the repo's entry points without opening the code.

### Flow 2 · Locating a change

1. From the map, the user asks "where do I add rate limiting to the auth API?"
2. A skeleton shows while retrieval and generation run.
3. The answer card renders: recommended file, attach point, reason, affected paths, tests to update.
4. Each cited source opens the file at those lines, so the user verifies rather than trusts.
5. The user can save the answer to the team context.

**Success:** question to verified location in under a minute, without opening the repo tree.

### Flow 3 · Capturing and carrying context

1. The user opens the context panel. Decisions, failed attempts and constraints are listed, newest first.
2. A suggestion drafted from the git diff appears: "Passport.js was removed from auth.ts. Record why?"
3. The user edits the draft and approves it, or dismisses it.
4. Export gives the whole record as markdown in one click.
5. Or the user's agent calls the MCP server and gets the same context directly.

**Success:** a teammate opening the same repo tomorrow sees the decision without asking anyone.

## Success metrics

| Metric | Target | Measured |
| --- | --- | --- |
| Answer correctness | 8 of 10 questions point at the right file | 29 of 30, three runs of ten questions across two repos (`npm run eval`) |
| Answer verifiability | Every answer cites at least one real source file with line numbers | Enforced in code: invented paths are dropped, line ranges clamped |
| Index time | Under 3 minutes for ~500 files | About 8 minutes at 500 files. Embedding runs in-process at roughly 10 seconds per 32 chunks. Under a minute on the demo repos |
| Query latency | Under 8 seconds end to end | 1.4 seconds median over 30 answers |
| Graph coverage | Over 90% of source files appear as nodes | 32 of 33 on the demo repo; isolated files are excluded by design and counted |
| Context round trip | A decision saved by one user appears for another within 5 seconds | Single DynamoDB write, read on next fetch |

Answer correctness is the one that matters. Everything else can be respectable and the product still fails if it confidently names the wrong file. That is why ten known-answer questions are re-run after every prompt change.

No user testing, no retention data. There is none to report, and inventing it would be worse than leaving it out.

## Non-functional requirements

**Scale**

- Up to 1,000 files, 150,000 lines. Above that, index the first files by path order and mark the repo truncated in the UI.
- One repo per brain. No multi-repo joins.
- Around 10 concurrent users.

**Performance**

- Index: under 3 minutes for 500 files. Not met at that size; see the metrics table.
- Query: under 8 seconds, split as retrieval under 1s, generation under 6s, overhead under 1s.
- Map render: under 1 second for 500 nodes. Layout is computed server side and shipped as coordinates. No force-directed layout in the browser.
- Context read: under 500ms. It is one DynamoDB query.

**Reliability**

- A failed index is re-submitted whole. There are no per-step retries, and a job whose record stops moving is reported as failed.
- A failed embed on one file does not fail the index. Log it, skip it, continue.
- The UI never shows a raw error string. Every failure has a human sentence and a retry action.

**Cost**

- Everything scales to zero. No provisioned capacity, no always-on instances.

**Browser support**

- Latest Chrome.

## Edge cases and failure handling

| Case | Behaviour |
| --- | --- |
| Private or non-existent repo | Clear message: repo not reachable, check the URL or make it public. No stack trace |
| Repo with no supported files | Index completes and the map shows its empty state |
| Repo too large | Index up to the cap, mark the repo truncated, show how many files were covered |
| Empty or near-empty repo | Say so plainly, offer the sample repo |
| Question the engine cannot place | Return confidence low, say what was searched, name two or three likely files rather than inventing one |
| Model returns malformed JSON | Retry once with a stricter instruction. On the second failure, show a retry button, never a half-rendered card |
| Generator throttling | A message saying the service is busy, with a retry action. Gemini's free tier allows 15 requests a minute, which is the practical limit |
| Indexing fails midway | The repo is marked failed with the stage named, and a retry |
| No decisions saved yet | Empty state with an example, not a blank panel |
| Two users save a conflicting decision | Both stored, both shown, newest first. No merge logic |
| Export with nothing in context | Export the repo structure summary, so the button never produces an empty file |
| MCP client calls before indexing finishes | A status response saying indexing is in progress, not an error |

Every failure state gets a human sentence and a next action. "Something went wrong" is not acceptable.

## Risks and fallbacks

| Risk | Likelihood | Fallback |
| --- | --- | --- |
| Answer quality stays poor after tuning | Medium | Narrow the question types accepted. A tool that answers three kinds of question well beats one that answers anything badly, and says so |
| First AWS deploy eats a day | Medium | Deploy a hello-world through the full stack before any feature exists, so IAM and region problems surface early |
| Indexing too slow on a large repo | Medium | Pre-index the demo repos and serve them from cache |
| Bedrock access not enabled | High, and the case here | Not fatal. Embeddings run locally and generation sits behind a provider interface, so nothing waits on access |
| Frontend and backend integrate late and break | High | The frozen API contract exists for this. The frontend works against fixtures from hour one |
| MCP server absorbs the remaining time | Medium | It is built last and can be dropped. The product stands without it |
| Demo repo changes behaviour between tests | Low | Pin a commit SHA. Do not track the default branch |

Answer quality is the risk that would sink the product. Without the evaluation, every prompt change merely feels like an improvement.

## Data handling

**What is stored**

- Repo snapshot in S3, public repos only, deleted after 7 days
- Extracted graph: file paths, symbol names, import edges, in DynamoDB
- Code chunks and their embeddings, for retrieval
- Team context: decisions, failed attempts, constraints, written by users

**What is not stored**

- Credentials, tokens, or anything from a .env file. The parser skips env files and anything gitignored
- No user accounts, so no personal data beyond a team ID

**Where it goes**

Code chunks are sent to the generation provider at query time as retrieval context. That is Google Gemini, reached over the public API from the Lambda in ap-south-1, so chunks leave AWS and are processed outside India. Gemini's terms say paid-tier prompts are not used for training. Free-tier usage may be reviewed by humans and used to improve the models, and this deployment is on the free tier. Embeddings never leave AWS: that model runs inside the Lambda. With Bedrock, generation would stay within AWS, served through global cross-Region inference and so possibly outside ap-south-1.

**The honest limitation**

A team that cannot send its code to a third party cannot use the hosted version. Self-hosted deployment is on the roadmap for that reason, and it is where several existing tools lose enterprise deals.

## Roadmap

**Near term**

- Go, then other languages. Each is a grammar plus its own import resolution.
- Multiple repos in one brain, for teams whose services are split across repos.
- Real accounts and team management, replacing the shared team ID.

**Medium term**

- Pull request awareness. When a PR lands, propose the decisions it implies and ask for confirmation.
- Onboarding mode. Generate a guided path through a repo, ordered by what to read first.
- Slack or Discord surface, so the answer arrives where the question was asked.

**Longer term**

- Propose the change, not just its location.
- Staleness detection, flagging recorded decisions the code has moved away from.
- Self-hosted deployment for teams that cannot send code to a third party.
