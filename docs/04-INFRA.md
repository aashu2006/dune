# 04 · Infra and deployment

Dune · CloudSmiths

## AWS resources

One SAM template at `infra/template.yaml`. One deploy command. Region ap-south-1 throughout.

### Resources

| Resource | Type | Notes |
| --- | --- | --- |
| `DuneTable` | DynamoDB | Single table, on-demand billing, TTL on `expiresAt` |
| `RepoBucket` | S3 | Repo snapshots, lifecycle rule deleting objects after 7 days |
| `ApiFn` | Lambda | 1 GB memory, 30 s timeout, all HTTP handlers |
| `IndexFn` | Lambda | 3 GB memory, 15 min timeout, 2 GB ephemeral storage, WASM grammars and the embedding model bundled |
| `McpFn` | Lambda | 256 MB, 30 s timeout, the MCP server on `/mcp` |
| `Api` | API Gateway HTTP API | Cheaper and simpler than a REST API. CORS is open |

The design had a Step Functions state machine with one Lambda per pipeline step (`CloneFn`, `ParseFn`, `EmbedFn`, `PersistFn`) and the MCP server on App Runner. `IndexFn` runs the whole pipeline in a single invocation instead, and `McpFn` replaces App Runner, which this account cannot use. Reasons are in `01-BACKEND.md` under "Indexing pipeline" and "MCP server".

### Lambda sizing notes

**`IndexFn` needs ephemeral storage raised.** The default `/tmp` is 512 MB, which a mid-size repo exceeds. It is set to 2048 MB. A download that would exceed it fails loudly rather than truncating.

**Memory is also CPU.** Lambda allocates CPU in proportion to memory, so 3 GB on `IndexFn` buys download and parse speed, not just headroom. Parsing and embedding are CPU-bound.

**`ApiFn` holds all handlers** and routes internally. Fewer cold starts, one deploy, one set of permissions. At this scale there is no reason to split it.

### Frontend hosting

Amplify Hosting, connected to the GitHub repo and building `packages/web` from `amplify.yml`. Auto-deploy on push to `main`.

## IAM

SAM policy templates cover most of this.

| Function | Needs |
| --- | --- |
| `ApiFn` | DynamoDB read and write, S3 read on `RepoBucket`, `lambda:InvokeFunction` on `IndexFn` |
| `IndexFn` | DynamoDB read and write, S3 read and write on `RepoBucket` |
| `McpFn` | Nothing AWS-side. It calls the public HTTP API |

No function holds a `bedrock:` permission. Embeddings run inside `IndexFn` and `ApiFn`; generation calls Gemini over the internet with a key passed in as a stack parameter.

### The Bedrock permission that trips people up

Only relevant if generation moves to Bedrock. Global cross-Region inference means the request may be served from another region, so the IAM resource must cover the inference profile, not a regional model ARN:

```yaml
- Effect: Allow
  Action:
    - bedrock:InvokeModel
    - bedrock:InvokeModelWithResponseStream
  Resource: "*"
```

A wildcard is not production practice. It is a deliberate shortcut here, and worth naming as one.

### CORS

HTTP API with `AllowOrigins: "*"`. The web app and the API are on different domains. The Lambda does not set CORS headers itself; duplicating them in both places is what breaks the browser.

Preflight needs one thing in the router: the `ANY /{proxy+}` route sends `OPTIONS` to `ApiFn` rather than letting API Gateway answer it, and a browser rejects any preflight that is not 2xx. The router returns 204 for `OPTIONS` and API Gateway adds the headers.

### Secrets

The generation API keys, Gemini's and optionally Groq's, live in the gitignored `.env`. They reach the stack as `NoEcho` CloudFormation parameters through `npm run deploy` and become environment variables on `ApiFn`. Only the selected provider's key is required; a template rule refuses a deploy without it. A key never appears in the template, `samconfig.toml` or deploy output.

`GITHUB_TOKEN` is optional and raises GitHub's limit from 60 requests an hour per shared Lambda IP to 5,000 for the token. It needs no scopes, because every repo Dune reads is public.

Keys are visible in the Lambda console to anyone who can read the function's configuration. SSM Parameter Store with a SecureString is the stronger option. Everything else, DynamoDB and S3, runs on IAM roles with no keys at all.

## Deployment

### Commands

```bash
npm run deploy             # sam build, then sam deploy with every parameter
```

`npm run deploy` sources `.env` and passes each parameter explicitly, because on an existing stack SAM keeps a parameter's previous value unless told otherwise, so a changed default would never reach the stack. An empty value is not a valid override, so optional keys are passed only when set.

`samconfig.toml` is committed, with stack name `dune` and region `ap-south-1`, so every deploy is identical. `sam local start-api` runs the API locally.

### Environments

One environment. No staging.

### Frontend deployment

Amplify builds from `main` on push. Set in the Amplify environment variables:

- `VITE_API_URL`: the `ApiUrl` stack output
- `VITE_USE_MOCKS`: `false`
- `VITE_MCP_URL`: the `McpUrl` stack output, which makes the context panel show the MCP endpoint

The build installs from the repo root (`npm ci -w @dune/web`), because `@dune/shared` is a workspace package and resolves only through the root lockfile.

### MCP deployment

`McpFn` is in the same SAM template and deploys with everything else. It serves Streamable HTTP at `{ApiUrl}/mcp`, the `McpUrl` stack output.

### Pre-indexing a repo

```bash
REPO_BUCKET=<RepoBucketName output> npm run index -- <repo url>
```

This runs the same pipeline `IndexFn` runs, from your machine, against the deployed stack. The sample repo on the connect screen is instant because it is already indexed. Re-run after any change to the parser or chunking, or the stored index will not match the current code.

## Known gotchas

**Lambda `/tmp` default is 512 MB.** A repo download exceeds it. Raise `EphemeralStorage`.

**tree-sitter native bindings do not build for Lambda easily.** Use `web-tree-sitter` with WASM grammars and bundle the `.wasm` files.

**`tree-sitter-wasms` is built against the tree-sitter 0.20 ABI** and fails to load in web-tree-sitter 0.27 with an opaque dylink error. Take the grammars from `@vscode/tree-sitter-wasm`.

**SAM's esbuild builder cannot handle npm workspaces.** The functions use `BuildMethod: makefile` and bundle from the monorepo root.

**DynamoDB item limit is 400 KB.** The graph and vector blobs exceed it on a real repo. Shard from the start.

**API Gateway HTTP API timeout is 30 seconds, hard.** A longer query returns a gateway error whatever the Lambda timeout says. Use a faster model rather than trying to raise the limit.

**Amplify needs the monorepo root set** to `packages/web`, or the build runs at the repo root and fails confusingly.

**CloudWatch logs are the only debugging tool** for a deployed Lambda. Log the inputs and outputs of each pipeline stage from the start.

**Cold starts on a 3 GB Lambda take a few seconds.** The first query after an idle period is slower than the rest.

**Bedrock model id prefix**, if access arrives: Claude from India goes through global inference profiles, so the id is `global.anthropic.claude-sonnet-4-6`. A plain regional id fails and the error is not obvious. Model access is also granted per account in the console, separately from IAM.
