# GraphQL spec — github-core-clone-01 (exact, quotable)

Source (read in full): `kit-v13/github-core-clone-01-kit/github-core-clone-01-kit/program/env/src/checks-graphql.ts` (1318 lines) and `graphql-client.ts` (331 lines).
Group: `graphql`, 20 checks. All checks POST to `{baseUrl}/api/graphql`.

## 0. Transport (graphql-client.ts — verbatim rules)

- `GRAPHQL_PATH = '/api/graphql'`; `GRAPHQL_USER_AGENT = 'makefun-github-core-clone-env/1'`; default timeout 10_000 ms.
- Request: `POST`, headers `accept: application/json`, `content-type: application/json`, `user-agent: makefun-github-core-clone-env/1`, `authorization: Bearer <token>` (omitted entirely when token is null).
- Single-op body: JSON `{query, variables}` — `variables` is always sent (default `{}`); no `operationName` is sent for single ops.
- Response envelope: JSON `{data, errors}`. A GraphQL-level failure (unknown field, bad argument) is **HTTP 200 with an `errors` array — NOT an HTTP error**. `errors` entries: `{message, path?, locations?: [{line, column}], extensions?}`.
- **Rule enforced by every check except `invalid-field`**: HTTP must be 200, `errors` must be empty (`errors.length > 0` = fail), and `data` must be a non-null object. A body with neither `data` nor `errors` on a 2xx is a parse error.
- Batching: body is a **JSON array** of `{query, variables, operationName?}`; response must be a **JSON array of `{data, errors}` envelopes in the same order**, HTTP 200. Empty operations array throws client-side (never sent).
- Unauthenticated = **HTTP 401** (any query; tested with `ViewerLogin`, no `Authorization` header at all).

## 1. Every document, verbatim (from `GRAPHQL_DOCUMENTS`)

### `viewerLogin` — `query ViewerLogin`
```graphql
query ViewerLogin {
  viewer {
    login
  }
}
```
Variables: none (`{}`).

### `repositoryFields` — `query RepositoryFields`
```graphql
query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}
```
Variables: `{owner, name}`. Note: `nameWithOwner` is NOT selected here (it is only required by introspection + `node`).

### `issueFields` — `query Issue_fields` (alias `Issue:` is the response key)
```graphql
query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}
```

### `typeFields` — `query PullRequestAndRepositoryFields` (two `__type` aliases in ONE document)
```graphql
query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}
```

### `searchTypeEnumValues` — `query SearchType_enumValues`
```graphql
query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}
```

### `openIssues` — `query OpenIssues` (inline enum list + inline input object)
```graphql
query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        id
      }
    }
  }
}
```
Variables: `{owner, name, first: 10}`.

### `issueByNumber` — `query IssueByNumber`
```graphql
query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}
```

### `createIssue` — `mutation IssueCreate`
```graphql
mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}
```
Variables: `{input: {repositoryId, title, body}}`.

### `closeIssue` — `mutation IssueClose`
```graphql
mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}
```
Variables: `{input: {issueId}}` — `issueId` is the issue's **global id** (read first via `IssueByNumber`).

### `pullRequests` — `query PullRequests`
```graphql
query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) {
      nodes {
        number
        headRefName
        baseRefName
        mergeable
        state
      }
    }
  }
}
```
Variables: `{owner, name, first: 5}`.

### `pullRequestFiles` — `query PullRequestFiles`
```graphql
query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}
```

### `pullRequestId` — `query PullRequestId` (helper, not a check by itself)
```graphql
query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}
```

### `createPullRequest` — `mutation PullRequestCreate`
```graphql
mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}
```
Variables: `{input: {repositoryId, baseRefName, headRefName, title}}`.

### `mergePullRequest` — `mutation MergePullRequest`
```graphql
mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}
```
Variables: `{input: {pullRequestId, mergeMethod: 'SQUASH'}}` — `mergeMethod` is the string `'SQUASH'` inside the input object.

### `addComment` — `mutation AddComment`
```graphql
mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}
```
Variables: `{input: {subjectId, body}}` — `subjectId` is the issue's **global id**.

### `invalidField` — `query ViewerInvalidField`
```graphql
query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}
```

### `nodeRepository` — `query NodeRepository` (inline fragment on `Repository`)
```graphql
query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}
```
Variables: `{id}` = repository global id.

### `issuesPage` — `query IssuesPage` (cursor pagination)
```graphql
query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) {
      nodes {
        number
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```
Variables: page 1 `{owner, name, first: 5, after: null}` (literal JSON `null`, NOT omitted); page 2 `after: <endCursor from page 1>`.

## 2. The 20 checks — request sent + exact assertion

Fixture context (all names are functions of `wire.ts`'s seeded Scenario; the forge is fresh/empty and checks seed via REST `/api/v3` + git push):
- Repo: `<scenario.repos[0].name>-graphql`; pagination repo: `<name>-graphql-pages`; unknown repo: `<name>-graphql-missing`. Owner = `scenario.viewer.login`.
- Issues fixture: 3 open (`"<titlePrefix> open 1/2/3"`, body = seeded body) + 1 closed (created open, then `PATCH /issues/{n} {state:'closed'}`).
- PR fixture: 3 head branches = `scenario.pulls[0..2].head` (distinct), base = `scenario.repos[0].defaultBranch`; each head branch gets one commit (git adapter; without it the 4 PR checks fail and the other 16 still run). PR fixture #1 from `pulls[0].head`, create-PR uses `pulls[1].head`, merge-PR uses `pulls[2].head`.
- `pageSize = 5`, `pageCount = 7` (pagination repo holds exactly 7 issues).
- Cross-surface rule: mutations are verified against REST (`GET /repos/{o}/{r}/issues/{n}`, `GET /pulls/{n}`, `GET /issues/{n}/comments`) — GraphQL and REST must share state. A fixture that cannot be built = that check fails, never a crash.

| # | slug (timeout) | Request | Exact assertion |
|---|---|---|---|
| 1 | `viewer-login` (8s) | `ViewerLogin`, `{}` | `data.viewer.login` is a non-empty string **equal to the token owner's login** (`scenario.viewer.login`). |
| 2 | `repository-fields` (10s) | `RepositoryFields {owner, name: <repo>}` | `data.repository` is an object; `id` equals the id read when the fixture was built (same GraphQL read); `databaseId` equals the fixture's numeric id (positive integer); `name` = repo name; `owner.login` = viewer login; `defaultBranchRef.name` = default branch **(asserted only when the git adapter is installed)**; `viewerPermission` ∈ `ADMIN, MAINTAIN, WRITE, TRIAGE, READ` (any one accepted); `hasIssuesEnabled === true` (strict). |
| 3 | `introspection-issue` (8s) | `Issue_fields` | `data.Issue.fields` (note alias key `Issue`) is non-empty; must include **all of** `id, number, title, state, body`. |
| 4 | `introspection-types` (10s) | `PullRequestAndRepositoryFields`, then `SearchType_enumValues` (two separate requests) | `data.PullRequest.fields` non-empty, must include `id, number, headRefName, baseRefName, mergeable, state, merged, files`; `data.Repository.fields` non-empty, must include `id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest`; `data.SearchType.enumValues` non-empty, must include `ISSUE`. (Only `ISSUE` is asserted; other `SearchType` values are NOT checked.) |
| 5 | `issues-open-order` (12s) | `OpenIssues {owner, name, first: 10}` | `data.repository.issues.nodes`: non-empty, length ≤ 10; every node: `number` positive integer, `state === 'OPEN'`, `title` a string, `id` non-empty string; numbers **strictly decreasing** (`numbers[i] > numbers[i-1]` fails — CREATED_AT DESC is proxied by descending issue number); the closed fixture issue must NOT appear; all 3 open fixture issues must appear. |
| 6 | `issue-by-number` (10s) | `IssueByNumber {owner, name, number: <open[0]>}` | `data.repository.issue` is an object; `number` equals requested; `state === 'OPEN'`; `title === "<titlePrefix> open 1"` exactly; `body` equals the seeded body exactly; `id` non-empty string. |
| 7 | `create-issue` (12s) | `IssueCreate {input: {repositoryId: <repo global id>, title: "<titlePrefix> created over graphql", body: <seeded body>}}` | `data.createIssue.issue.number` positive integer; `.id` non-empty string; then REST `GET /repos/{o}/{r}/issues/{n}` → 200, `number` equal, `title` equal, `state === 'open'` (lowercase REST). |
| 8 | `close-issue` (12s) | Issue created via REST, id read via `IssueByNumber`, then `IssueClose {input: {issueId: <global id>}}` | `data.closeIssue.issue.number` equals created number; `state === 'CLOSED'` (uppercase GraphQL enum); then REST `GET /issues/{n}` → `state === 'closed'` (lowercase). |
| 9 | `pull-requests-list` (15s) | `PullRequests {owner, name, first: 5}` | `data.repository.pullRequests.nodes` length ≤ 5; contains the fixture PR (by `number`); that node: `headRefName === pulls[0].head`, `baseRefName === <default branch>`, `state === 'OPEN'`, `mergeable` ∈ `MERGEABLE, CONFLICTING, UNKNOWN` (any one accepted). |
| 10 | `pull-request-files` (12s) | `PullRequestFiles {owner, name, number: <fixture PR>}` | `data.repository.pullRequest.number` equals requested; `files.nodes[].path` (non-empty strings) **includes** `scenario.blobs[0].path` (the path of the file the head-branch commit added). `files(first: 10)` — the literal `10` is in the document. |
| 11 | `create-pull-request` (15s) | `PullRequestCreate {input: {repositoryId, baseRefName: <default branch>, headRefName: pulls[1].head, title: "<titlePrefix> created over graphql"}}` | `data.createPullRequest.pullRequest.number` positive integer; `.id` non-empty; `state === 'OPEN'`; `headRefName === pulls[1].head`; `baseRefName === <default branch>`; then REST `GET /pulls/{n}` → 200, `head.ref === pulls[1].head`, `base.ref === <default branch>`. |
| 12 | `merge-pull-request` (15s) | PR id read via `PullRequestId`, then `MergePullRequest {input: {pullRequestId: <global id>, mergeMethod: 'SQUASH'}}` | `data.mergePullRequest.pullRequest.merged === true` (strict boolean). **GraphQL `state` is NOT asserted here** (selected but unchecked). Then REST `GET /pulls/{n}` → `merged === true` **and** `state === 'closed'`. |
| 13 | `add-comment` (12s) | Issue created via REST, id via `IssueByNumber`, then `AddComment {input: {subjectId: <issue global id>, body: <issues[1].body>}}` | `data.addComment.commentEdge.node.body` **equals the input body exactly**; `.id` non-empty string; then REST `GET /issues/{n}/comments` → 200 array containing an entry with `body` equal to the comment. |
| 14 | `invalid-field` (8s) | `ViewerInvalidField`, `{}` | **HTTP 200** (not 400/422); body parses as JSON; `errors` array is **non-empty**; at least one `error.message` **contains the substring `noSuchFieldOnViewer`** (`.includes('noSuchFieldOnViewer')`). `data` may be null/partial — not asserted. This is the ONLY check where `errors` is expected. |
| 15 | `unauthenticated` (8s) | `ViewerLogin` with **no `Authorization` header** (`client.withoutToken()`) | **HTTP 401**. Body content not asserted. |
| 16 | `node-repository` (10s) | `NodeRepository {id: <repo global id>}` | `data.node` is an object; `node.id` equals the input id exactly; `node.name` = repo name; `node.nameWithOwner === "<viewer>/<repo>"` exactly. |
| 17 | `unknown-repository` (8s) | `RepositoryFields {owner: <viewer>, name: <name>-graphql-missing}` | **HTTP 200, no `errors`, and `data.repository === null`** (strict null — not `{}`/missing). |
| 18 | `batched-operations` (10s) | **One HTTP POST whose JSON body is the array** `[{query: <ViewerLogin>}, {query: <Issue_fields>}]` (no `variables` keys sent — client adds `variables: {}` per entry; no `operationName`) | HTTP 200; response is an array of **exactly 2** envelopes **in request order**; envelope [0]: `data.viewer.login` = viewer login, no errors; envelope [1]: `data.Issue.fields` non-empty, no errors. |
| 19 | `global-id-stability` (12s) | `RepositoryFields` twice + `IssueByNumber` (for `open[0]`) twice | Repo id: non-empty, **identical on both reads**; issue id: non-empty, **identical on both reads**; repo id **must NOT equal `String(databaseId)`**; issue id **must NOT equal `String(number)`**. No other format constraint (see §4). |
| 20 | `issues-pagination` (12s) | `IssuesPage` on the `-graphql-pages` repo: page 1 `{first: 5, after: null}`, page 2 `{first: 5, after: <page1 endCursor>}` | Page 1: `data.repository.issues` is an object; `nodes.length === 5` exactly; `pageInfo.hasNextPage === true`; `pageInfo.endCursor` is a non-empty string. Page 2: `nodes.length === 2` exactly (7 − 5); `pageInfo.hasNextPage === false`. Union of both pages: **7 distinct issue numbers, no duplicates, exactly the 7 fixture numbers**. Node order within/across pages is NOT asserted (only set membership + no overlap). |

## 3. Introspection requirements (exact)

- `__type(name: String!)` must be served under the aliases gh uses: response keys are `Issue`, `PullRequest`, `Repository`, `SearchType` (the alias, not `__type`).
- `__type(...).fields(includeDeprecated: true)` — argument `includeDeprecated: Boolean` must be accepted (value `true` is sent); each entry exposes at least `name`.
- `__type(...).enumValues(includeDeprecated: true)` — same for enums; each entry exposes at least `name`.
- Required field-name sets (superset allowed — checks use "must include", never exact equality):
  - `Issue`: `id, number, title, state, body`
  - `PullRequest`: `id, number, headRefName, baseRefName, mergeable, state, merged, files`
  - `Repository`: `id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest`
- Required enum value: `SearchType` must list `ISSUE`. No other `SearchType` value is asserted by this group.
- Enum values asserted elsewhere in the group (header list in checks-graphql.ts): `IssueState OPEN/CLOSED`; `MergeableState MERGEABLE/CONFLICTING/UNKNOWN`; `PullRequestState OPEN/CLOSED/MERGED`; `PullRequestMergeMethod MERGE/SQUASH/REBASE` (only `SQUASH` is actually sent); `RepositoryPermission ADMIN/MAINTAIN/WRITE/TRIAGE/READ`; `IssueOrderField CREATED_AT/UPDATED_AT/COMMENTS` (only `CREATED_AT` is sent); `OrderDirection ASC/DESC` (only `DESC` is sent).

## 4. Global ids — what the kit does and does NOT specify

- **The kit never specifies an encoding.** No base64 construction, no `Type:dbid` payload, no decode rule appears anywhere in `checks-graphql.ts` or `graphql-client.ts` (verified by grep: the only base64 in the kit is REST file-content encoding and MCP header encoding, unrelated). A bundled `server.mjs` in the kit is the env itself, not a reference forge — it contains no id-construction code either.
- What IS asserted (check 19 + round-trip uses): an id is a **non-empty string**; it is **opaque** — repo id `!== String(databaseId)`, issue id `!== String(number)`; it is **stable** — identical across repeated reads of the same object; and it **round-trips**: the exact string returned by a read must be accepted as `repositoryId` (createIssue/createPullRequest), `issueId` (closeIssue), `pullRequestId` (mergePullRequest), `subjectId` (addComment), and `id` (`node(id:)` → returns the same string and the object's fields).
- Forge freedom: any deterministic opaque encoding satisfies the suite (e.g. base64 of `Repository:<databaseId>` / `Issue:<repo>:<number>` — GitHub's real convention — but that is **not** required by the kit; the suite cannot distinguish it from any other stable opaque string). Do NOT return the bare numeric id or the bare issue number.
- Same-object stability is the only cross-read rule; the suite never compares ids across different objects or requires a particular prefix.

## 5. Pagination — cursor semantics (what is and is not asserted)

- `issues(first: Int, after: String)` on `Repository`; connection shape asserted: `{nodes: [{number}], pageInfo: {hasNextPage: Boolean, endCursor: String}}`. `nodes` carries **only `number`** in this document.
- **Cursor format is unspecified by the kit** — only that `endCursor` is a non-empty string and that passing it back as `after` yields the next page. Any opaque encoding works (e.g. base64 of the last-seen offset/number); the suite never decodes it.
- First call sends `after: null` as a literal JSON null variable (declared `$after: String`, nullable — the forge must accept an explicit null, not just an omitted variable).
- Exact numbers: page size `first: 5`, total `7` issues → page 1 must return exactly 5 nodes with `hasNextPage === true`, page 2 exactly 2 nodes with `hasNextPage === false`; union = all 7, no duplicates. `endCursor` on the last page is not asserted (may be null or a string — check 20 never reads page 2's cursor).
- `first` is also capped-checked elsewhere: `OpenIssues first: 10` → nodes ≤ 10; `PullRequests first: 5` → nodes ≤ 5; `files(first: 10)` is inline in the document.
- Ordering: only check 5 asserts order (CREATED_AT DESC ⇔ strictly decreasing issue numbers). Pagination check 20 asserts **set membership only**, not order.

## 6. Schema surface the reference forge must implement (header list, checks-graphql.ts)

- `Query.viewer { login }`
- `Query.repository(owner: String!, name: String!) -> Repository` (nullable)
- `Repository { id, databaseId, name, nameWithOwner, owner { login }, defaultBranchRef { name }, viewerPermission, hasIssuesEnabled, issue(number: Int!), issues(first: Int, states: [IssueState!], orderBy: {field: IssueOrderField!, direction: OrderDirection!}, after: String), pullRequests(first: Int), pullRequest(number: Int!) }`
- `Issue { id, number, title, state, body }`
- `IssueConnection { nodes, pageInfo { hasNextPage, endCursor } }`
- `PullRequest { id, number, state, merged, headRefName, baseRefName, mergeable, files(first: Int) }`
- `PullRequestConnection { nodes }`
- `PullRequestChangedFile { path }`
- `User { login }`
- `Query.node(id: ID!) -> Node`, with `... on Repository { name nameWithOwner }`
- `Query.__type(name: String!) -> __Type`, with `fields(includeDeprecated: Boolean)` and `enumValues(includeDeprecated: Boolean)`, plus the gh aliases (`Issue: __type(...)`)
- `Mutation.createIssue(input: CreateIssueInput { repositoryId, title, body }) -> { issue { number, id } }`
- `Mutation.closeIssue(input: CloseIssueInput { issueId }) -> { issue { number, id, state } }`
- `Mutation.createPullRequest(input: CreatePullRequestInput { repositoryId, baseRefName, headRefName, title }) -> { pullRequest { number, id, state, headRefName, baseRefName } }`
- `Mutation.mergePullRequest(input: MergePullRequestInput { pullRequestId, mergeMethod }) -> { pullRequest { number, merged, state } }`, mergeMethod `SQUASH` accepted
- `Mutation.addComment(input: AddCommentInput { subjectId, body }) -> { commentEdge { node { id, body } } }`
- Arguments the forge must parse: string/int variables, inline enum lists (`states: [OPEN]`), inline input objects (`orderBy: {field: CREATED_AT, direction: DESC}`), null variables (`after: null`), operation names, and a JSON array of operation documents in one request (batching).
- REST cross-surface routes the checks rely on (prefix `/api/v3`): `POST /user/repos`, `GET /repos/{o}/{r}`, `POST/GET/PATCH /repos/{o}/{r}/issues[/{n}]`, `GET /repos/{o}/{r}/issues/{n}/comments`, `POST/GET /repos/{o}/{r}/pulls[/{n}]`.
