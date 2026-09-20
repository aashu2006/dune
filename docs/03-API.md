# 03 · API contract

Dune · CloudSmiths · First Commit (AWS x WeMakeDevs)

Authoritative. If any other doc disagrees with this one, this one wins. Frozen before implementation started; changes need both sides to agree.

## Conventions

### Base

```
Deployed:  https://ivaqlw3t8d.execute-api.ap-south-1.amazonaws.com/v1
Local:     sam local start-api, then http://localhost:3000/v1
```

The deployed base is the `ApiUrl` output of the `dune` stack. The web app takes it from `VITE_API_URL` and appends `/v1` itself.

All requests and responses are JSON. All timestamps are ISO 8601 UTC strings.

### Rules both sides must follow

**Never omit a key.** If a value is unknown or not applicable, send `null`. The frontend destructures these objects, so a missing key is a crash and a null is a rendered dash.

**Arrays are never null.** An empty array is `[]`. This removes an entire class of null checks from the UI.

**Types live in `packages/shared`.** Both sides import them. This doc and that file must agree; if they drift, fix the file and this doc in the same commit.

**Validation is zod, both directions.** The backend validates what Bedrock returns and what it sends out with the same schemas.

### teamId

There is no auth. `teamId` is passed as a query parameter and defaults to `demo`, so everyone sharing the link shares the team. A deliberate scope cut, stated in the PRD and worth stating plainly rather than implying away.

### Error format

Every non-2xx response, without exception:

```json
{
  "error": {
    "code": "REPO_NOT_FOUND",
    "message": "Repository not found or private. Check the URL, or try a public repository.",
    "retryable": false
  }
}
```

`message` is written for a human and is rendered directly in the UI. It is never a stack trace, never an exception string. Writing these well is a backend job, not something the frontend patches over.

### Error codes

| Code | HTTP | Retryable |
| --- | --- | --- |
| `INVALID_REPO_URL` | 400 | false |
| `INVALID_REQUEST` | 400 | false |
| `REPO_NOT_FOUND` | 404 | false |
| `REPO_TOO_LARGE` | 400 | false |
| `NO_SUPPORTED_FILES` | 400 | false |
| `INDEX_NOT_READY` | 409 | true |
| `INDEX_FAILED` | 500 | true |
| `QUERY_FAILED` | 500 | true |
| `MODEL_UNAVAILABLE` | 503 | true |
| `RATE_LIMITED` | 429 | true |
| `NOT_FOUND` | 404 | false |
| `INTERNAL` | 500 | true |

`retryable` drives whether the UI shows a retry button. The frontend does not decide this; the backend states it.

`INVALID_REQUEST` means the request body is missing, is not JSON, or fails validation, an empty question for example. Any endpoint that takes a body can return it, and retrying the same request will not help.

## Shared types

These live in `packages/shared/src/types.ts` with matching zod schemas in `schema.ts`. Copy this block into the file as the starting point.

```ts
export type Confidence = 'high' | 'medium' | 'low';

export interface Source {
  file: string;
  lines: [number, number];
}

export interface Answer {
  recommendedFile: string | null;
  attachTo: string | null;
  reason: string;
  affected: string[];
  testsToUpdate: string[];
  sources: Source[];
  confidence: Confidence;
  candidates: Candidate[] | null;   // populated when confidence is low
}

export interface Candidate {
  file: string;
  reason: string;
}

export interface GraphNode {
  id: string;          // repo-relative path, also the display key
  label: string;       // filename only
  cluster: string;     // top-level directory, for grouping and colour
  kind: 'entry' | 'route' | 'service' | 'model' | 'util';
  entryPoint: boolean;
  importedByCount: number;
  importsCount: number;
  x: number;           // pre-computed layout, frontend never lays out
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'import';
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hiddenCount: number;   // isolated nodes not included
}

export type ContextType = 'decision' | 'dead-end' | 'constraint';

export interface ContextItem {
  id: string;
  repoId: string;
  type: ContextType;
  title: string;
  body: string;
  files: string[];
  authoredBy: 'human' | 'agent';   // agent-written items are badged in the UI
  createdAt: string;
}

export interface Suggestion {
  id: string;
  type: ContextType;
  title: string;
  body: string;          // editable draft text
  files: string[];
  status: 'pending' | 'saved' | 'dismissed';
  createdAt: string;
}

export type JobStage =
  | 'queued' | 'cloning' | 'parsing'
  | 'embedding' | 'finalising' | 'ready' | 'failed';

export interface JobStatus {
  repoId: string;
  jobId: string;
  stage: JobStage;
  progress: number;                 // 0 to 100
  detail: string | null;            // "1,204 / 2,180 chunks"
  failedStage: JobStage | null;
  failureReason: string | null;     // human sentence
}

export interface RepoMeta {
  repoId: string;
  repoUrl: string;
  name: string;                     // "owner/repo"
  commitSha: string;
  fileCount: number;
  lineCount: number;
  truncated: boolean;
  parseFailures: number;
  indexedAt: string;
}
```

### Note on `candidates`

When `confidence` is `low`, `recommendedFile` may still be set but `candidates` must be populated with two or three options. The UI renders the candidate list instead of a single recommendation. This is how uncertainty surfaces honestly rather than as a confident guess.

## Repo endpoints

### POST /repos

Start indexing. Returns immediately; the pipeline runs asynchronously.

**Request**

```json
{ "repoUrl": "https://github.com/owner/repo", "teamId": "demo" }
```

**Response 202**

```json
{ "repoId": "a3f9c21b", "jobId": "job_7k2m", "alreadyIndexed": false }
```

`repoId` is deterministic from the normalised URL, so re-submitting the same repo returns the same id. If it is already indexed and ready, `alreadyIndexed` is true and the frontend skips straight to the map.

**Errors:** `INVALID_REPO_URL`, `REPO_NOT_FOUND`, `REPO_TOO_LARGE`, `INVALID_REQUEST` (no `repoUrl` in the body), `RATE_LIMITED` (GitHub is limiting requests), `INDEX_FAILED` (the job could not be started)

### GET /repos/:repoId

Polled every 1.5s during indexing, then once on load.

**Response 200, while indexing**

```json
{
  "meta": null,
  "job": {
    "repoId": "a3f9c21b",
    "jobId": "job_7k2m",
    "stage": "embedding",
    "progress": 62,
    "detail": "1,204 / 2,180 chunks",
    "failedStage": null,
    "failureReason": null
  },
  "graph": null
}
```

**Response 200, ready**

```json
{
  "meta": {
    "repoId": "a3f9c21b",
    "repoUrl": "https://github.com/owner/repo",
    "name": "owner/repo",
    "commitSha": "9f2c1a7",
    "fileCount": 412,
    "lineCount": 38204,
    "truncated": false,
    "parseFailures": 2,
    "indexedAt": "2026-09-19T14:02:11Z"
  },
  "job": { "stage": "ready", "progress": 100, "detail": null, "failedStage": null, "failureReason": null },
  "graph": { "nodes": [], "edges": [], "hiddenCount": 125 }
}
```

**Response 200, failed**

Stage is `failed`, `failedStage` names where it broke, `failureReason` is a human sentence. Still a 200, because the request succeeded and the job did not. The frontend renders the failure state from the body, not from an HTTP code.

**Errors:** `NOT_FOUND` (the repo has never been submitted)

### GET /repos/:repoId/files/\*

File contents for the source drawer.

**Response 200**

```json
{ "path": "src/routes/auth.ts", "content": "...", "lineCount": 84, "language": "ts" }
```

`language` is one of `ts`, `tsx`, `js`, `jsx`, `py`, the indexed languages.

**Errors:** `NOT_FOUND` if the path is not in the indexed set. The frontend shows a "file not available" state rather than an empty drawer.

## Query endpoint

### POST /query

The core call. Everything else supports this.

**Request**

```json
{
  "repoId": "a3f9c21b",
  "teamId": "demo",
  "question": "Where do I add rate limiting to the auth API?"
}
```

**Response 200, confident**

```json
{
  "answer": {
    "recommendedFile": "src/middleware/rateLimiter.ts",
    "attachTo": "src/routes/auth.ts",
    "reason": "All authentication endpoints are registered on this router, so a middleware attached here covers every one of them without touching individual handlers.",
    "affected": ["/login", "/register", "/forgot-password"],
    "testsToUpdate": ["src/routes/auth.test.ts"],
    "sources": [
      { "file": "src/routes/auth.ts", "lines": [12, 48] },
      { "file": "src/middleware/index.ts", "lines": [1, 20] }
    ],
    "confidence": "high",
    "candidates": null
  },
  "tookMs": 4820
}
```

**Response 200, uncertain**

```json
{
  "answer": {
    "recommendedFile": null,
    "attachTo": null,
    "reason": "No single location clearly owns this. Rate limiting could sit at the router or at the gateway layer depending on how the app is deployed.",
    "affected": [],
    "testsToUpdate": [],
    "sources": [{ "file": "src/routes/auth.ts", "lines": [12, 48] }],
    "confidence": "low",
    "candidates": [
      { "file": "src/middleware/", "reason": "Where other cross-cutting middleware lives" },
      { "file": "src/routes/auth.ts", "reason": "Directly on the router, if only auth needs limiting" }
    ]
  },
  "tookMs": 5210
}
```

**Errors:** `INVALID_REQUEST` (missing or empty question), `NOT_FOUND` (the repo has never been indexed), `INDEX_NOT_READY` (retryable, frontend polls and retries), `QUERY_FAILED`, `MODEL_UNAVAILABLE`, `RATE_LIMITED`

### Guarantees the backend must hold

These are contract, not best effort:

- Every path in `recommendedFile`, `attachTo`, `sources` and `candidates` **exists in the indexed file set**. Verified after generation. Never a hallucinated path.
- `sources` is never empty. If nothing was retrieved, the answer is `low` confidence with whatever was searched named in `reason`.
- Team context is always injected into the prompt. If a dead end says Passport.js was removed, the answer must not recommend Passport.js.
- `tookMs` is real and is shown in the UI. It is also how the latency target gets measured during tuning.

### Frontend behaviour

On `low` confidence, render the candidate list instead of a single recommendation, with a line stating the answer is uncertain. Do not visually flatten the difference between a confident and an uncertain answer.

## Context endpoints

### GET /context/:repoId?teamId=demo

**Response 200**

```json
{
  "items": [
    {
      "id": "ctx_8h3k",
      "repoId": "a3f9c21b",
      "type": "decision",
      "title": "JWT over sessions",
      "body": "Stateless auth needed for the edge runtime; sessions would need a shared store.",
      "files": ["src/auth/jwt.ts", "src/middleware/auth.ts"],
      "authoredBy": "human",
      "createdAt": "2026-09-19T11:20:00Z"
    }
  ],
  "suggestions": [
    {
      "id": "sug_2m9p",
      "type": "dead-end",
      "title": "Passport.js removed",
      "body": "Passport.js was removed from auth.ts. Record why it did not work?",
      "files": ["src/routes/auth.ts"],
      "status": "pending",
      "createdAt": "2026-09-19T13:45:00Z"
    }
  ]
}
```

Items are newest first. Only suggestions with pending status are returned; saved and dismissed ones are not.

**Errors:** `NOT_FOUND` (the repo was never indexed)

### POST /context

Create a context item, either from scratch or by approving a suggestion.

**Request**

```json
{
  "repoId": "a3f9c21b",
  "teamId": "demo",
  "type": "dead-end",
  "title": "Passport.js",
  "body": "Conflicted with the existing auth middleware.",
  "files": ["src/routes/auth.ts"],
  "fromSuggestionId": "sug_2m9p",
  "authoredBy": "human"
}
```

The fromSuggestionId field is optional. When present, that suggestion is marked saved in the same write.

Approving a suggestion is a human act: a request with `fromSuggestionId` and `authoredBy: "agent"` is rejected with `INVALID_REQUEST`. Agents write their own items, which are stored as agent-authored; they never turn a draft into team context.

**Response 201:** the created ContextItem.

**Errors:** `INVALID_REQUEST` (missing fields, an agent approving a suggestion, or a suggestion that was already saved or dismissed), `NOT_FOUND` (the repo was never indexed, or the suggestion does not exist)

### POST /suggestions/:repoId/refresh?teamId=demo

Generate drafts from the diff between the indexed commit and current HEAD.

**Request body, optional**

```json
{ "since": "07516da" }
```

`since` compares that commit with HEAD instead of the indexed commit. It exists for demos and testing, where the repo may not have moved since it was indexed. Without a body, the indexed commit is used.

**Response 200:** an object with a suggestions array, capped at 5. It holds every pending suggestion for the repo, new ones included, and there are never more than 5 pending at once, because a refresh only drafts enough to fill the free slots. Drafts that repeat an existing context item or any earlier suggestion, dismissed ones included, are discarded.

Synchronous and may take several seconds. The frontend shows a loading state on the refresh control.

**Errors:** `NOT_FOUND` (the repo was never indexed), `REPO_NOT_FOUND` (GitHub cannot find the repo or the `since` commit), `RATE_LIMITED`, `MODEL_UNAVAILABLE`, `QUERY_FAILED`

### POST /suggestions/:id/dismiss?teamId=demo

**Response 200:** an ok flag. Dismissed suggestions are marked, not deleted, and are never re-suggested. Dismissing one that is already dismissed is a no-op that succeeds.

**Errors:** `NOT_FOUND` (no such suggestion), `INVALID_REQUEST` (the suggestion was already saved as context)

### GET /export/:repoId?teamId=demo

**Response 200:** an object with a single markdown string field.

The markdown contains, in this order: repo summary, decisions, dead ends, constraints, and the current file structure overview. It is written to be pasted directly into any agent, so it must be readable on its own without knowing where it came from.

Export never fails on empty context. With nothing saved, it returns the repo structure summary alone.

**Errors:** `NOT_FOUND` (the repo was never indexed)

## MCP tool contract

The MCP server is a thin wrapper over the HTTP API above. No duplicated logic, no second retrieval path.

**Transport:** remote, Streamable HTTP (stateless), `POST` only, at `{API base}/mcp` on the same HTTP API as everything above. The design was SSE on App Runner. App Runner is not available to this AWS account, so the server runs as a Lambda, which cannot hold SSE sessions, and Streamable HTTP is what the MCP spec now recommends anyway. See `01-BACKEND.md`, "MCP server".

**Connection URL parameters,** both optional: `teamId` (default `demo`, as in the API) and `repoId`, a default repo for the connection. With `repoId` on the URL, `repoId` may be left out of every tool call.

### Tools

**get\_project\_context**

```json
{ "repoId": "a3f9c21b" }
```

Returns the export markdown: repo summary, decisions, dead ends, constraints, structure. One call and an agent knows what the team knows. Calls GET /export internally.

**find\_where\_to\_change**

```json
{ "repoId": "a3f9c21b", "question": "Where do I add rate limiting?" }
```

Returns the Answer object rendered as readable markdown rather than raw JSON, since the consumer is a model. Calls POST /query internally.

**save\_decision**

```json
{
  "repoId": "a3f9c21b",
  "type": "decision",
  "title": "JWT over sessions",
  "body": "Reasoning here.",
  "files": ["src/auth/jwt.ts"]
}
```

Calls POST /context with authoredBy set to agent. Returns a confirmation and the new item id.

### The agent-authored rule

Anything written through save\_decision is stored with `authoredBy: "agent"` and badged in the UI. A human must always be able to tell which parts of the team's record a model wrote.

This is a design position, not an implementation detail. The value of the context layer is that it can be trusted, and a record the team cannot tell apart from a model's guesses is not trustworthy.

### Behaviour before indexing completes

If an agent calls any tool while indexing is still running, return a normal response saying indexing is in progress with the current stage. Not an error. Agents handle a status message far better than a thrown error.

### If it does not ship

MCP is last in the build order and can be dropped. Nothing else depends on it, and the export button covers the same need with a copy-paste.
