# MCP spec — github-core-clone-01 (`mcp` group, 15 checks)

Sources (verbatim, read fully): `kit-v13/github-core-clone-01-kit/github-core-clone-01-kit/program/env/src/checks-mcp.ts` (1002 lines, `MCP_CHECKS`, 15 specs) and `.../env/src/mcp-client.ts` (795 lines, hand-rolled `fetch` client, no SDK). Endpoint: `POST <baseUrl>/mcp` (`MCP_ENDPOINT_PATH = '/mcp'`, `MCP_PATH` same). Nothing here scores; `checks-mcp.ts` judges, `mcp-client.ts` only transports. Client never throws for an HTTP status — every answer is `McpHttpResponse {status, ok, headers, contentType, bodyText, json, rpc, sse}`; it throws only on no answer / timeout / abort. `connect()` throwing = "speaks neither era".

## 0. Constants

```ts
MCP_PREFERRED_REVISION = '2026-07-28'
MCP_LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] // newest first
MCP_CLIENT_INFO = { name: 'makefun-github-core-clone-env', version: '1.0.0' }
MCP_ACCEPT = 'application/json, text/event-stream'
MCP_DEFAULT_TIMEOUT_MS = 3_000   // per-request; check budget capped at this (`requestTimeoutOf`)
JSON_RPC_PARSE_ERROR = -32700; JSON_RPC_INVALID_PARAMS = -32602
JSON_RPC_METHOD_NOT_FOUND = -32601; MCP_UNSUPPORTED_VERSION = -32022; MCP_HEADER_MISMATCH = -32020
```

## 1. Handshake — two eras, `connect()` probes `server/discover` first

### Modern (2026-07-28 and later): no handshake, no session
- First request: `server/discover`, `params: {}`, `id: 'discover-1'`. A `result` makes it modern.
- Every request declares its revision in `_meta` **and** mirrors it in header `MCP-Protocol-Version` (see §1.3).
- `server/discover` result (`DiscoverResult`): `supportedVersions?: string[]`, `capabilities?: Record<string, unknown>`, `instructions?: string`, `serverInfo?: McpServerInfo`, `resultType?: string`, `_meta?: Record<string, unknown>`.
  - `serverInfo` is read from `_meta['io.modelcontextprotocol/serverInfo']` **first**, then loose `result.serverInfo`.
  - Negotiation: `chosen = supportedVersions.includes('2026-07-28') ? '2026-07-28' : supportedVersions[0]`; `probeDiscover()` applies the same rule. `supportedVersions` entries must match `/^\d{4}-\d{2}-\d{2}$/` (`isRevision` / `revisionsOf` filters out anything else).
  - `UnsupportedProtocolVersionError` (`-32022`): retry once with a version named in `error.data.supported` (`supportedFromError`: `data.supported` filtered by `isRevision`); preferred if listed, else `supported[0]`; if none named → `McpError`. If retry still fails → `McpError`.
  - Modern refusal that is **not** method-not-found is reported, never smoothed over: `errorCode` in `[-32020, -32022, -32021, -32600, -32602]` **or** HTTP `401`/`403`/`>=500` → `connect()` throws `McpError('the MCP endpoint refused server/discover (...)')`.
- `initialize` check (`mcp/initialize`): `serverInfo.name` and `serverInfo.version` must be **non-empty strings**; `capabilities.tools` must be present **and a record** (`isRecord(info.capabilities.tools)`). Pass detail: `` `${era==='modern' ? 'server/discover' : 'initialize'}: ${name} ${version}, protocol ${info.protocolVersion}, tools capability present` ``. `capabilities.tools` need not be `true` — presence as an object suffices.
- `server-discover` check (`mcp/server-discover`): modern → `supportedVersions.length === 0` fails; else pass `` `server/discover: supportedVersions ${...join(', ')}; negotiated ${info.protocolVersion}` ``. Legacy → **passes** as `"pre-discover revision"` — a 404, JSON-RPC `-32601`, or any other refusal **before a working `initialize` handshake** never fails this check (detail records how: `HTTP 404` / `HTTP <status>, JSON-RPC <code>` / `no answer`).

### Legacy (2025-11-25 and earlier): `initialize` + `notifications/initialized`
- Fallback triggers: `server/discover` answers `-32601`, or HTTP `404`/`405` (`missingEndpoint`). (Anything else that is not method-not-found / missing-endpoint and not a modern refusal above also falls through to legacy.)
- `initializeLegacy(probe)`: loops `MCP_LEGACY_REVISIONS` newest first, each call:
  ```ts
  request('initialize', { protocolVersion: revision, capabilities: {}, clientInfo: { ...clientInfo } },
          { id: 'initialize-1', omitProtocolVersionHeader: true })
  ```
  Note: `capabilities: {}` (empty), `clientInfo` = `{name: 'makefun-github-core-clone-env', version: '1.0.0'}`, **no `MCP-Protocol-Version` header** on this call.
- Success: `error === undefined && isRecord(result)` → negotiated revision = `isRevision(result.protocolVersion) ? result.protocolVersion : <offered revision>` (server echo accepted as-is); then `notify('notifications/initialized', {}, { omitProtocolVersionHeader: true }).catch(() => null)` — a **notification: `{jsonrpc: '2.0', method, params}` with no `id`**, loss is not an error. Connection: `{era: 'legacy', protocolVersion: negotiated, supportedVersions: [], serverInfo: result.serverInfo (record or null), capabilities: result.capabilities (record or {}), sessionId, discover: probe}`.
- Failure loop: if `outcome.error?.code !== -32602`, `break` immediately (only `-32602` tries the next older revision). All revisions exhausted → `McpError('the entry serves no MCP endpoint at <endpoint> (initialize answered JSON-RPC <code>: <message> | initialize answered no result (HTTP <status>))')`.
- Brief explicitly: `2025-06-18` "must not be failed" — it is an accepted handshake revision.

### 1.3 Every request — `_meta` and headers
`withMeta(params)`: params get `_meta` = 
```ts
{ 'io.modelcontextprotocol/protocolVersion': <revision>,
  'io.modelcontextprotocol/clientInfo': { name: 'makefun-github-core-clone-env', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
  protocolVersion: <revision> }   // plain spelling too: "an older server may look for that spelling"
```
merged under (never overwriting) an explicit caller-supplied `_meta`. Every JSON-RPC request body: `{jsonrpc: '2.0', id, method, params: withMeta(params)}`. Default ids: sequential integers from `allocateId()` starting at `1` (`nextId = 1`); explicit string ids allowed (concurrent check uses them).

`headersFor()` — every POST carries:
```
Accept: application/json, text/event-stream
Content-Type: application/json
MCP-Protocol-Version: <revision>            // header name lowercase in code: 'mcp-protocol-version'; OMITTED only when omitProtocolVersionHeader (initialize / notifications/initialized)
Mcp-Method: <method>                        // 'mcp-method'
Mcp-Name: <tool name>                       // 'mcp-name', only for tools/call; encodeHeaderValue(): plain ASCII as-is, else "=?base64?<b64-utf8>?="
Mcp-Session-Id: <session>                   // 'mcp-session-id', only when a session was handed out
Authorization: Bearer <token>               // only when token !== '' and omitAuth !== true
Mcp-Param-<header>: <value>                 // only for tool params annotated x-mcp-header (see §3.4)
```

### 1.4 `Mcp-Session-Id` handling
- Captured from **any** response: `response.headers.get('mcp-session-id')` → stored (`this.sessionId`), sent on all later POSTs. Modern era: "no protocol-level session" — none is expected, but a handed-out one is still carried.
- `close()`: if `sessionId !== null`, best-effort `DELETE <baseUrl>/mcp` with headers `{accept: 'application/json, text/event-stream', 'mcp-session-id': session, authorization?: 'Bearer <token>'}`, timeout `min(timeoutMs, 1000)`; errors swallowed ("a session the server already forgot needs no goodbye"). No GET stream exists in either era.

## 2. `tools/list` — required tools, matching, schema, idempotency

- `listTools()`: `request('tools/list', {} | {cursor})`; follows `nextCursor` up to **10 pages**; throws `McpError` on a JSON-RPC error or if `result.tools` is not an array. Only entries that are records with a non-empty string `name` are kept (and remembered in `toolsByName` for `x-mcp-header` mirroring).
- `mcp/tools-list`: **at least 6 tools** (`tools.length < 6` fails) **and** all six canonical tools present. `MCP_REQUIRED_TOOLS`:
  ```ts
  ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']
  ```
  No other tool is required; extras are allowed and also schema-checked (§2.2).
- Matching (`findTool`): `normalizeName(name) = name.toLowerCase().replace(/[^a-z0-9]/g, '')` (lowercase, every non-alphanumeric removed). **Exact first** (canonical or alias, normalized), **then suffix**: a tool whose normalized name **ends with** a wanted normalized name **and is strictly longer** (`name.length > suffix.length && name.endsWith(suffix)`) — e.g. prefix `github__create_issue` matches `create_issue`. Case-insensitive throughout. Aliases (`MCP_TOOL_ALIASES`, matched by normalized suffix too):
  ```ts
  create_repo:         ['create_repository', 'repo_create', 'repos_create', 'repository_create']
  get_repo:            ['get_repository', 'repo_get', 'repos_get', 'repository_get']
  create_issue:        ['issue_create', 'issues_create']
  list_issues:         ['issues_list', 'issue_list']
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create']
  merge_pull_request:  ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge']
  ```
  Pass detail lists the resolution, e.g. `create_issue->github__create_issue`.
- `mcp/tool-schemas`: **every** listed tool must have a non-empty `description` (string, `.trim() !== ''`) **and** `inputSchema` a record with `inputSchema.type === 'object'`. Failure names up to 4 bad tools, then `(+N more)`.
- `mcp/tools-list-idempotent`: two consecutive `tools/list` calls must hold the **same tools array, byte for byte**: `JSON.stringify(first) === JSON.stringify(second)` (length compared first). Any reordering / added field / changed description fails. So: deterministic order, deterministic schema serialization, no per-call timestamps/randomness in the listing.

## 3. `tools/call` — argument mapping, per-tool contract, result shape

### 3.1 Call shape
`callTool(name, args, options)`: `request('tools/call', { name, arguments: args }, { ...options, extraHeaders: headerParamsFor(name, args) })`. Result parsed as `McpToolResult`; `toolError = toolResult !== null && toolResult.isError === true`. A JSON-RPC `error` and `isError: true` are **different** failure channels; `callFailure()` reports either: `` `tools/call ${toolName} -> JSON-RPC ${code}: ${message}` `` or `` `tools/call ${toolName} -> isError: ${resultText(...).slice(0, 300)}` ``.

### 3.2 Argument mapping — the suite maps onto YOUR schema, it does not send canonical names blindly
`mapArguments(tool, semantic)`: for each semantic key, it looks up the tool's `inputSchema.properties` by **normalized** name against the synonym list for that key (first synonym whose normalized form is a property wins); unmapped semantic keys are dropped (value `undefined` skipped). If `inputSchema.properties` is absent/not a record, semantic args are passed through unchanged. **Required properties the suite cannot fill are never invented**: `missing = schema.required.filter(name => !(name in args))`; the check then **fails naming the property** (`` `the ${toolName} inputSchema requires ${missing.join(', ')}, which the suite has no value for` ``) and the call is **not made** — except the missing-arguments check, which calls anyway with `allowMissing: true` (see §4.3).

`ARGUMENT_SYNONYMS` (verbatim — normalized matching, so `ownerLogin`, `owner-login`, `owner_login` are equivalent):
```ts
owner:        ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']
repo:         ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']
repo_full_name:['full_name', 'repo_full_name', 'repository_full_name', 'fullName']
title:        ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']
body:         ['body', 'issue_body', 'description', 'content', 'text', 'comment']
head:         ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']
base:         ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']
pull_number:  ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']
name:         ['name', 'repo', 'repository', 'repository_name', 'repo_name']
description:  ['description', 'about', 'summary', 'body']
private:      ['private', 'is_private']
state:        ['state', 'status']
```
**`full_name` rule:** if no `repo` property exists but a `repo_full_name` property does, and semantic `owner` + `repo` are strings, the suite fills it with `` `${owner}/${repo}` `` (e.g. property `full_name` receives `"owner/repo"`). Note the collision: `body` and `description` share synonyms (`description`/`body` appear in both lists) — the first synonym hit per key decides; keep property names unambiguous.

### 3.3 Per-tool semantic arguments (what the suite sends)
Header contract in `checks-mcp.ts` (github-mcp-server's names):
```ts
create_repo:        { name, description?, private? }
get_repo:           { owner, repo }
create_issue:       { owner, repo, title, body? }
list_issues:        { owner, repo, state? }
create_pull_request:{ owner, repo, title, head, base }        // actual call ALSO sends body: template.body
merge_pull_request: { owner, repo, pull_number }
```
Actual calls in the checks (all values seeded/deterministic from the scenario; repo names `mcp-<tag>-<slug>`, tag = first 8 hex of scenario seed):
- `create_repo` (rest-parity only): `{ owner, name: repoName, description: scenario.repos[0].description, private: true }` — `owner` is the token's login (`GET /api/v3/user` → `login`, fallback `scenario.viewer.login`). The `owner` semantic key has **no** `create_repo` synonym target unless your schema has an owner-ish property; a schema that *requires* an owner property the suite cannot map will fail as unfillable — safest is to not require `owner` on `create_repo`, or accept it via a synonym.
- `create_issue`: `{ owner, repo, title, body }` (both issue checks).
- `list_issues`: `{ owner, repo, state: 'open' }` — setup first creates the issue over REST (`POST /api/v3/repos/{owner}/{repo}/issues`).
- `create_pull_request`: `{ owner, repo, title, body, head, base }` — setup: repo created over REST, base commit via `PUT .../contents/{path}`, head branch via `POST .../git/refs {ref: 'refs/heads/<head>', sha: <baseSha>}` (fallback: contents write with `branch: <head>`).
- `merge_pull_request`: `{ owner, repo, pull_number: <number> }` — setup creates the PR over REST first.
- `get_repo`: `{ owner, repo }` (concurrent check only; two different repos).

### 3.4 Result shape — what the checks actually read
`McpToolResult`: `{ content?: Array<{type?: string, text?: string}>, structuredContent?: unknown, isError?: boolean, resultType?: string }`.
- `resultText(result)`: concatenates `content` blocks where `block.type === 'text'` and `typeof block.text === 'string'` (joined `'\n'`), **plus** `JSON.stringify(result.structuredContent)` when present (non-null). So a plain-text JSON body and/or `structuredContent` both work; `structuredContent` is appended after the text.
- `resultJson(result)`: **`structuredContent` first** if non-null; else `JSON.parse(text)` of the text above; else the outermost `{...}` or `[...]` slice of the text (prose-wrapped JSON tolerated). Returns `null` if nothing parses.
- What each check extracts from that JSON / text:
  - `create_issue` / `rest-parity`: only the REST read-back matters (see §6); `rest-parity` additionally reads `resultJson(...).full_name` (string containing `/` → split into owner/repo override) and `number` via `numberFrom(json, ['number'])` — `numberFrom` accepts an integer `number` **or** a digit-only string for keys `number`/`pull_number`/`id`.
  - `list_issues`: pass if the result text **contains the issue title** (`text.includes(title)`) **or** matches regex `` `"number"\s*:\s*<number>(?!\d)` ``. So the list must surface each issue's `title` and/or `"number": <n>` literally in text or structured content.
  - `create_pull_request`: `number = numberFrom(resultJson, ['number', 'pull_number', 'pull_request_number'])`; if null, REST lookup falls back to title/head match. REST then must read back the same `head`/`base` (see §6).
  - `merge_pull_request`: success is judged by REST (`merged: true`), not by the tool result text.
  - `get_repo` (concurrent): result text must **include the repo name** (`leftText.includes(left.repo)` / same for right).
- `x-mcp-header` mirroring: for each `inputSchema.properties` entry whose schema has a string `x-mcp-header`, if the call supplies that parameter and it is a string/finite number/boolean, the client sends header `Mcp-Param-<header>` with `encodeHeaderValue` (stringified: numbers via `String()`, booleans `'true'`/`'false'`; non-plain-ASCII → `=?base64?<utf8-b64>?=`). A server that annotates a parameter this way must read it from the header, not only the body.
- Success signal: **no JSON-RPC `error` AND `isError !== true`**. Either channel failing fails the check with the message above. There is no separate "HTTP 2xx = success" rule — the JSON-RPC/result layer decides.

## 4. Error cases (exact codes / statuses)

| Check | Trigger | Required answer | Fails on |
|---|---|---|---|
| `mcp/unknown-tool` | `tools/call {name: 'mcp_no_such_tool_<tag>', arguments: {}}` | JSON-RPC error `-32602` **or** `-32601` (any HTTP status except 500) | **HTTP 500** (explicit fail, checked first); a `result` (no error); any other error code |
| `mcp/parse-error` | `postRaw('{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"')` — truncated JSON, no closing brace; `expectedId: 424242`, `methodHeader: 'tools/list'` | **HTTP 400 + JSON-RPC `-32700`** | anything else — **except** legacy-era allowance: HTTP `200` + `-32700` passes when `info.era === 'legacy'` ("the pre-2026-07-28 transport status") |
| `mcp/missing-arguments` | `tools/call create_issue` with `{}` (`allowMissing: true`, i.e. required args deliberately unfilled) | JSON-RPC error `-32602` **or** tool result `isError: true` | any other JSON-RPC code; an accepted result (`isError` not true) — fail message includes `HTTP ${status}, isError=${...}` |
| `mcp/auth-required` | `tools/call create_issue {owner: 'no-auth', repo: 'no-auth-<tag>', title, body}` with `omitAuth: true` (no `Authorization` header at all) | **HTTP 401 exactly** | any other status (fail message appends `(JSON-RPC <code>)` if an error was present). Note: `connect()` + `listTools()` run **with** auth first; the 401 is judged on the unauthenticated call alone. Auth is decided before any tool exists — a prefixed tool name is still the same tool, so 401 must fire even for an unknown tool name. |
| `mcp/concurrent-calls` | Two `tools/call get_repo` in `Promise.all`, ids `'concurrent-left-<tag>'` / `'concurrent-right-<tag>'`, different repos | Each answer's `matchedId` (the `id` in the JSON-RPC response) **equals its own sent id**; neither answer has a JSON-RPC `error`; each result text names its own repo | Swapped/missing ids, either error, either text naming the wrong repo. `matchedId` is `rpc?.id ?? null` (`null` for an error response with no id also fails the id check). |

Notes: `-32601` vs `-32602` for unknown tool are **both** accepted (the check accepts `JSON_RPC_INVALID_PARAMS (-32602)` or `-32601`); do not use HTTP 500 for it. Missing-arg as a JSON-RPC error must be exactly `-32602`. Parse error must be exactly `-32700`. The client parses a JSON **array** response by taking the first element that looks like a JSON-RPC response (`id` present + `result` or `error`); a response object without `id`, or with neither `result` nor `error`, is not a JSON-RPC response (`isJsonRpcResponse` false → `rpc: null`).

## 5. Transport

- `POST <baseUrl>/mcp` only (no GET stream, no separate SSE endpoint). `redirect: 'manual'` on every fetch.
- Request: `Accept: application/json, text/event-stream`, `Content-Type: application/json`, body `JSON.stringify({jsonrpc: '2.0', id, method, params})` (or exact raw text for `postRaw`).
- Response — **either** is accepted:
  1. **Single JSON body**: `Content-Type` not SSE; `response.text()` parsed; must be a JSON-RPC response object (or array containing one).
  2. **Request-scoped SSE stream**: `Content-Type` contains `text/event-stream`; `readEventStream` reads until the JSON-RPC response with `expectedId` arrives (or stream ends). Skips notifications and comment lines; `data:` lines (after `data:` + one optional space) joined with `'\n'` per event, dispatched on a blank line; only a parsed frame with `id === expectedId` (or any frame when `expectedId === null`, i.e. notifications) counts; the reader is then cancelled. The final data frame is the JSON-RPC response. `json` is `null` for SSE bodies; `bodyText` keeps the raw SSE framing.
- **Deadline: 3,000 ms per request** (`MCP_DEFAULT_TIMEOUT_MS`; the check's own budget is capped at it). Exceeding it → `McpTimeoutError('POST <endpoint> did not answer inside 3000 ms')` (client-side abort; the check fails). No retries in the client (except the single `-32022` discover retry, §1).
- Session: see §1.4 — modern has no protocol-level session; legacy session id is carried in `Mcp-Session-Id` and torn down with `DELETE` on `close()`.

## 6. REST parity — MCP-created objects must read back over REST with stable ids

REST base used by the checks: `<baseUrl>/api/v3`, `Authorization: Bearer <token>`, `Accept: application/json`, `User-Agent: makefun-github-core-clone-env`. (A broken REST route fails these checks with route + status named — the MCP checks depend on REST working.)

- `mcp/create-issue`: issue created via `create_issue` must appear in `GET /api/v3/repos/{owner}/{repo}/issues?state=all&per_page=100` with an entry whose `title` is exactly the sent title. Listed shape accepted: a bare array, `{issues: [...]}`, or `{items: [...]}` (`issuesOf`).
- `mcp/list-issues`: inverse direction — issue created over REST, `list_issues` must return it (title or `"number"` in text, §3.4).
- `mcp/create-pull-request`: PR created via MCP must be findable over REST — by `number` from the tool result (`GET /api/v3/repos/{owner}/{repo}/pulls/{number}`), else by scanning `GET .../pulls?state=all&per_page=100` for `title` or `head` match. REST must read `head` == sent head and `base` == sent base, where `refOf(v)` = `v` if string, else `v.ref`, else `v.branch`, else last segment of `v.label` after `':'`. Pass detail: `` `pull request #${number} created over MCP; REST reads ${head} into ${base}, state ${state}` ``.
- `mcp/merge-pull-request`: after `merge_pull_request`, `GET .../pulls/{number}` must read `merged === true` (boolean, not truthy string); `state` is reported in the pass detail.
- `mcp/rest-parity` (the strictest): (a) `create_repo` over MCP → `GET /api/v3/repos/{owner}/{repo}` **twice**; both must be HTTP 200, the repo object must have an `id`, and `String(id)` must be **identical across the two reads**. The repo name/owner used for the REST path come from the tool result's `full_name` if it contains `/` (split on first `/`), else the requested `owner`/`repoName`. (b) `create_issue` over MCP in that repo → its `number` (from tool-result JSON, else REST list by title) → `GET /api/v3/repos/{owner}/{repo}/issues/{number}` **twice**; issue `id` identical across reads (string-compared), and `title` exactly the sent title. Pass: `` `repo ${owner}/${repo} id ${repoId} and issue #${number} id ${issueId} are the same objects over MCP and REST, stable across reads` ``. I.e. MCP and REST must share one object store / id space — same numeric `id` and `number` on both surfaces, stable, not regenerated per read.
- Setup repos for the other checks are created over REST (`POST /api/v3/user/repos {name, private: true, description: 'github-core-clone-01 MCP setup'}`), owner resolved via `GET /api/v3/user` → `login` (fallback `scenario.viewer.login`).

## 7. Check inventory (15, in run order)

`initialize`, `server-discover`, `tools-list`, `tool-schemas`, `create-issue`, `list-issues`, `create-pull-request`, `merge-pull-request`, `unknown-tool`, `parse-error`, `missing-arguments`, `concurrent-calls`, `tools-list-idempotent`, `rest-parity`, `auth-required` — each id is `checkId('mcp', slug)`. A check that throws fails with its message, never crashes the suite. Determinism: every name/title/branch/path/byte comes from the scenario (`wire.ts buildScenario()`, one fixed seed); no `Math.random`, no clock in a pass bit.
