# github-core-clone-01 — EXACT scenario + benchmark setup (from kit-v13)

Sources (verbatim, read 2026-11-15):
- `program/env/src/wire.ts` (1305 lines) — scenario generators, `buildScenario()`, `TOKEN_ENV`
- `program/env/src/manifest.ts` (540 lines) — `CHECK_COUNTS`, `BENCH_ROUNDS`, `BENCH_WARMUP_OPS`, `T_REF_MS`, `workloadPoints`
- `program/env/src/bench.ts` (877 lines) — the 4 workloads
- `program/env/src/calibration.json` — the actual `T_REF_MS` values (manifest reads them from here)
- `program/env/src/git-client.ts:479` — `CONFORMANCE_IDENTITY` (used by bench commits)

> Determinism rule (wire.ts): "every user, repo, path, blob, commit message and issue/PR title derives from the one constant SCENARIO_SEED through scenarioRng(label)… No check builds data of its own, and nothing reads Math.random or the wall clock for data, so live, replay and the entrant's local practice run all see byte-identical data."
> The concrete names below were verified by executing the real `buildScenario()` from `wire.ts` (Node 24 type-stripping import) — they are NOT hand-computed guesses.

## 0. Wire / lifecycle (wire.ts)

- Entry: standalone GitHub-compatible forge (server). Env listens on `MAKEFUN_ENV_HOST`/`MAKEFUN_ENV_PORT` (default port `8080`, `DEFAULT_ENV_PORT = 8080`, container host `0.0.0.0`, process-driver host `127.0.0.1`), writes `/state/ready` (`{"schema":"github-core-clone-01/ready/v1",…}`), waits for first register.
- Entry binds ephemeral port (`listen(0)`), then `POST $MAKEFUN_ENV_URL/register` with `{"port": N}`. Env records `req.socket.remoteAddress:N` as entry base URL. First register wins; later register → `409` (`{ok:false, error:'already_registered'}`), first → `200 {ok:true}`. Bad body → `400`, wrong method → `405`. Port must be integer `1..65535` (`MIN_PORT`/`MAX_PORT`); max register body `65_536` bytes.
- Entry long-polls `GET $MAKEFUN_ENV_URL/done` → `{"done":false}` until export written, then `{"done":true}` and entry exits `0`. Poll: first interval `DONE_POLL_INTERVAL_MS = 250`, max `DONE_POLL_MAX_MS = 2_000`, exponential; env answers within `DONE_ANSWER_DEADLINE_MS = 1_000`; entry request timeout `DONE_REQUEST_TIMEOUT_MS = 30_000`.
- Phases: boot → conformance → benchmark → export. Budgets: `BOOT_BUDGET_MS = 20_000`, `CONFORMANCE_BUDGET_MS = 240_000`, `BENCHMARK_BUDGET_MS = 240_000`, `EXPORT_BUDGET_MS = 30_000`; `DEADLINE_MARGIN_MS = 90_000`; `TRIAL_WALL_BUDGET_SEC = 900` (internal deadline = `startedAtMs + wallBudgetSec*1000 - DEADLINE_MARGIN_MS`). Boot: `GET /healthz` twice (`HEALTHZ_ATTEMPTS = 2`) within `HEALTHZ_BUDGET_MS = 10_000`; healthz answers `200 {"ok":true}`. Check timeout: default `CHECK_TIMEOUT_MS = 15_000`, clamped `CHECK_TIMEOUT_MIN_MS = 5_000` .. `CHECK_TIMEOUT_MAX_MS = 15_000`.
- Paths: `REGISTER_PATH = '/register'`, `DONE_PATH = '/done'`, `HEALTHZ_PATH = '/healthz'`, `API_PREFIX = '/api/v3'`, `GRAPHQL_PATH = '/api/graphql'`, `MCP_PATH = '/mcp'`, `AUTH_SCHEME = 'Bearer'`. Exports: `export/state.json` (version `STATE_VERSION = 1`) and `export/perf.json` (`PERF_VERSION = 1`).

## 1. Scenario — the one seeded scenario

```ts
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';
export const SCENARIO_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z
export const SCENARIO_USERS = 12;
export const SCENARIO_VIEWER_REPOS = 30;
export const SCENARIO_ORG_REPOS = 6;
export const SCENARIO_STRANGER_REPOS = 3;
export const SCENARIO_FILE_PATHS = 60;
export const SCENARIO_BLOBS = 24;
export const SCENARIO_COMMITS = 60;
export const SCENARIO_ISSUES = 60;
export const SCENARIO_PULLS = 30;
export const DEFAULT_BRANCH = 'main';
```

RNG: `scenarioSeedFor(label) = mix64(SCENARIO_SEED ^ fnv1a64(label))` (FNV-1a 64-bit, offset `0xcbf29ce484222325`, prime `0x100000001b3`; splitmix64 finalizer `mix64`); `scenarioRng(label)` = xorshift64* (`x ^= x>>12; x ^= x<<25; x ^= x>>27; return x * 0x2545f4914f6cdd1d`). Streams used: `'users'`, `'org'`, `'branches'`, `'paths'`, `'blobs'`, `'commits'`, `'issues'`, `'pulls'`, `'repos.viewer'`, `'repos.org'`, `'repos.stranger'`, `'bench.push'`, `'bench.clone'`.

### 1.1 Users (verified output of `buildScenario()`)

| role | id | login | name | email |
|---|---|---|---|---|
| viewer (`users[0]`) | 1000 | `adaiversen` | `ada iversen` | `adaiversen@example.invalid` |
| teammate (`users[1]`) | 1001 | `quinnkeller` | `quinn keller` | `quinnkeller@example.invalid` |
| stranger (`users[2]`) | 1002 | `olgabauer` | `olga bauer` | `olgabauer@example.invalid` |

All 12 users (`id 1000+i`, `login = first+last`, `name = "first last"`, `email = login@example.invalid`, dedup suffix `-2`, `-3`, …):
`adaiversen` (1000), `quinnkeller` (1001), `olgabauer` (1002), `dmitriquist` (1003), `adanovak` (1004), `zanerossi` (1005), `pavelcosta` (1006), `wrenkeller` (1007), `coraquist` (1008), `elenaulrich` (1009), `tesssato` (1010), `svenrossi` (1011).
First-name pool (25): `ada, bram, cora, dmitri, elena, felix, greta, hugo, iris, jonas, kira, lars, mira, nico, olga, pavel, quinn, rosa, sven, tess, ulla, vito, wren, yara, zane`. Last-name pool (26): `anders, bauer, costa, dahl, eriksen, fischer, garcia, holm, iversen, jansen, keller, lind, moreau, novak, olsen, peters, quist, rossi, sato, turi, ulrich, vega, weber, xu, yilmaz, zimmer`.

Org: `faint-meadow-org` (`${adjective}-${noun}-org`, stream `'org'`).

### 1.2 Repos — viewer: 30, pattern `{adjective}-{noun}` (+ `-2`… on collision)

Viewer repos (`owner = adaiversen`, ids `5000+i`, `defaultBranch: 'main'`, `private: i % 7 === 3` — i.e. indices 3, 10, 17, 24 are private):
1. `amber-thistle` (5000) · 2. `happy-willow` (5001) · 3. `happy-ember` (5002) · 4. `crisp-thistle` (5003, private) · 5. `nimble-delta` (5004) · 6. `tidy-harbor` (5005) · 7. `quiet-orchid` (5006) · 8. `gentle-quartz` (5007) · 9. `happy-nebula` (5008) · 10. `witty-thistle` (5009) · 11. `upbeat-yarrow` (5010, private) · 12. `faint-falcon` (5011) · 13. `quick-juniper` (5012) · 14. `tidy-umber` (5013) · 15. `eager-pebble` (5014) · 16. `warm-raven` (5015) · 17. `idle-badger` (5016) · 18. `calm-orchid` (5017, private) · 19. `tidy-ember` (5018) · 20. `brisk-cedar` (5019) · 21. `steady-meadow` (5020) · 22. `idle-lantern` (5021) · 23. `quick-raven` (5022) · 24. `plain-cedar` (5023) · 25. `calm-quartz` (5024, private) · 26. `tidy-lantern` (5025) · 27. `happy-thistle` (5026) · 28. `crisp-zephyr` (5027) · 29. `keen-glade` (5028) · 30. `amber-badger` (5029).
`fullName = "adaiversen/<name>"`. Descriptions drawn from 8 fixed strings: `'a small service with a sharp edge'`, `'notes and experiments, kept until they are not'`, `'the tooling behind the thing'`, `'a reference implementation, for reading'`, `'what the prototype became'`, `'fixtures, generators and the odd benchmark'`, `'the parts that must not break'`, `'a sandbox for the next idea'`.
Adjective pool (28): `amber, brisk, calm, crisp, eager, faint, gentle, happy, idle, jolly, keen, lively, mellow, nimble, open, plain, quick, quiet, rapid, soft, steady, tidy, upbeat, vivid, warm, witty, young, zesty`. Noun pool (28): `acorn, badger, canyon, cedar, comet, coral, delta, ember, falcon, glade, harbor, indigo, juniper, kettle, lantern, meadow, nebula, orchid, pebble, quartz, raven, saffron, thistle, umber, violet, willow, yarrow, zephyr`.

Stranger repos (3, owner `olgabauer`, ids 7000–7002): `gentle-comet`, `faint-raven`, `upbeat-orchid` (all public).
Org repos (6, owner `faint-meadow-org`, ids 6000–6005): `quick-ember`, `mellow-comet`, `happy-kettle`, `amber-raven` (private, index 3), `brisk-glade`, `jolly-violet`.

### 1.3 Branches

`DEFAULT_BRANCHES = ['main', 'develop', 'release/1.0']` plus 8 generated unique branches (stream `'branches'`, `generateBranchName`: kind ∈ `feature|fix|perf|docs|chore` + `/` + slugged `PULL_SUBJECTS`, dedup suffix `-2`…). Full `scenario.branches` in order:
`main`, `develop`, `release/1.0`, `docs/graphql-cursor-pagination`, `feature/issue-label-validation`, `feature/push-report-status-checks`, `fix/repo-pagination`, `perf/issue-label-validation`, `docs/repo-pagination`, `perf/conditional-requests-2`, `fix/shallow-fetch-support`.
Every scenario repo's `defaultBranch` is `'main'`; PR templates use `base = 'main'` (`generatePull(rng, base = DEFAULT_BRANCH)`).

### 1.4 Blob paths + content patterns

- `generateFilePaths`: depth 0 with prob. 1/3 (`rng.nextInt(3) === 0`), else 1–2 dirs shuffled from 20 segments (`src, lib, docs, test, scripts, api, core, util, config, data, web, cli, pkg, internal, examples, assets, build, tools, server, client`) + stem + extension. Stems (20): `index, request, response, server, client, schema, parser, router, config, store, clock, queue, render, format, validate, session, token, event, stream, cache`. Extensions: `ts, js, json, md, txt, yml, toml, css, html, sql`. Collision → `2-<filename>` prefix.
- First 10 `filePaths`: `config/token.css`, `server.toml`, `examples/index.json`, `cli/render.json`, `schema.txt`, `client.json`, `examples/core/client.txt`, `client/store.ts`, `schema.html`, `config/lib/config.ts`.
- Blobs: first 24 file paths, size `64 + rng.nextInt(4_033)` bytes each (i.e. 64–4096 bytes), ASCII text. `generateBlobText(rng, sizeBytes)`: words picked from 40 `BLOB_WORDS` (`alpha…zulu` NATO + `amber, basalt, cobalt, drift, ember, frost, granite, hollow, ivory, jasper, kelp, lichen, moss, nickel`), joined by `' '` or `'\n'` (14% newline), sliced to exactly `sizeBytes`. First 3 blobs: `config/token.css` 2023 B starting `lichen\nkelp victor\nuniform india kilo oscar yankee quebec lichen kilo bravo\nfoxt…`; `server.toml` 1349 B starting `nickel\ncharlie\ngranite\nhotel granite amber drift xray delta romeo jasper basalt …`; `examples/index.json` 3282 B starting `hollow yankee granite sierra mike papa hotel whiskey echo alpha lichen zulu lima…`. `base64` = standard base64 of the UTF-8 bytes (`textToBase64`, no imports).

### 1.5 Commits

`generateCommit`: `scenarioDate` = `SCENARIO_EPOCH_SEC + rng.nextInt(90*24*60*60)` (so 2025-01-01 … ~2025-04-01), `iso = new Date(epochSec*1000).toISOString()`; author = `rng.pick(users)` (any of the 12). Message: `` `${verb} ${object}` ``, 35% chance + `\n\n` + one sentence. Verbs (15): `Add, Fix, Refactor, Document, Test, Tidy, Speed up, Simplify, Handle, Extract, Inline, Rename, Guard, Wire, Drop`. Objects (15): `the request parser, repo lookup, issue pagination, the merge path, token checks, the clone endpoint, packfile handling, error bodies, branch listing, the GraphQL node query, MCP tool dispatch, rate limit headers, the upload pack, the ref advertisement, commit ancestry`.
First 3 commits: (1) `Tidy issue pagination` — adaiversen, epoch `1739175597`, `2025-02-10T08:19:57.000Z`; (2) `Tidy the upload pack\n\nThe same flow works over the API and nothing is written to the log.` — olgabauer, `1741392915`, `2025-03-08T00:15:15.000Z`; (3) `Extract token checks` — adaiversen, `1737801788`, `2025-01-25T10:43:08.000Z`.
Sentence pattern: `` `${SENTENCE_STARTS} ${SENTENCE_ENDS}.` `` — starts (6): `Steps to reproduce are below, This showed up after the last change, The expected behaviour is clear, A minimal case is attached, It works on a fresh repository, The same flow works over the API`; ends (6): `and the server answers with a JSON error, but the second request fails, and nothing is written to the log, while the reply body stays empty, and the status is wrong for the method, so the client gives up`. Bodies = 1–3 such sentences joined by `' '`.

### 1.6 Issues (60 templates) and labels

Labels (`scenario.labels` = `ISSUE_LABELS`): `bug, enhancement, documentation, question, good first issue, help wanted`.
`generateIssue`: title = `` `${adjective} ${subject}` ``; body = 1–3 sentences; `labels`: 50% chance `[one picked label]`, else `[]`.
Issue adjectives (10): `Broken, Slow, Missing, Confusing, Unexpected, Flaky, Incorrect, Unclear, Stale, Noisy`. Subjects (12): `clone over HTTP, push report-status, issue pagination, merge button, GraphQL node ids, MCP tool list, shallow fetch, tag listing, repo creation, content update, branch deletion, commit listing`.
First 3 issues: (1) title `Incorrect GraphQL node ids`, body `A minimal case is attached but the second request fails. The same flow works over the API and the server answers with a JSON error. Steps to reproduce are below but the second request fails.`, labels `["bug"]`; (2) `Stale push report-status`, body `The same flow works over the API and nothing is written to the log. The same flow works over the API and the status is wrong for the method. The same flow works over the API and nothing is written to the log.`, labels `["question"]`; (3) `Unclear clone over HTTP`, body `The expected behaviour is clear and the server answers with a JSON error. This showed up after the last change while the reply body stays empty. A minimal case is attached so the client gives up.`, labels `[]`.

### 1.7 Pulls (30 templates)

`generatePull`: title = `` `${verb} ${subject}` ``; body = 1–3 sentences; `head` = generated branch name; `base = 'main'`.
Pull verbs (8): `Add, Fix, Improve, Simplify, Document, Refactor, Speed up, Harden`. Subjects (10): `shallow fetch support, push report status checks, issue label validation, merge conflict detection, GraphQL cursor pagination, MCP tool schemas, packfile delta reuse, conditional requests, repo pagination, branch protection stubs`.
First 3 pulls: (1) `Improve MCP tool schemas`, body `It works on a fresh repository and the status is wrong for the method.`, head `chore/mcp-tool-schemas`, base `main`; (2) `Simplify MCP tool schemas`, body `The same flow works over the API while the reply body stays empty.`, head `chore/conditional-requests`, base `main`; (3) `Harden branch protection stubs`, body `This showed up after the last change and nothing is written to the log.`, head `feature/repo-pagination`, base `main`.

### 1.8 Author format (git objects)

Bench/conformance git identity (git-client.ts:479): `CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>'`. `buildCommit` writes `author <identity> <timestamp> +0000` / `committer <identity> <timestamp> +0000` (timezone default `'+0000'`, timestamp default `1700000000` when unset). Scenario commits carry a `ScenarioUser` author (login/name/email above) + `epochSec`/`iso`.

## 2. Token

- Env var name: `TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN'` (wire.ts:82). Every API call carries `Authorization: Bearer <token>` (`AUTH_SCHEME = 'Bearer'`); no token → `401` (competition.yaml:189).
- **No fixed token value exists in wire.ts / manifest.ts / bench.ts.** `main.ts:887`: `const token = env[TOKEN_ENV] ?? ''` — the harness injects it into the env process; bench passes `process.env[TOKEN_ENV] ?? ''`, and an empty token sends no `Authorization` header. The token names the scenario's **viewer**: "One bearer token … is the viewer's" (checks-rest.ts:13); `GET /api/v3/user` / GraphQL `query { viewer { login } }` must answer the token owner = viewer login `adaiversen` (checks-graphql.ts:848: `viewer.login is …, expected the token owner …`). "a repository belongs to the login the token names, so the same repository name under another owner is 404, never 403" (competition.yaml:189). So the forge must treat the presented bearer token as authenticating `adaiversen`; its literal value is whatever the harness sets — accept any non-empty bearer as that user, reject missing/invalid with 401.

## 3. Manifest — checks, scoring, benchmark constants

### 3.1 Check counts (manifest.ts `CHECK_GROUPS`, `CHECK_COUNTS`, `TOTAL_CHECKS = 120`)

| group | checks | about |
|---|---|---|
| `git` | 30 | clone, fetch, push and the pack protocol against the entry as a real git server |
| `repos` | 15 | REST v3 repository, branch, commit and contents APIs |
| `issues` | 15 | REST v3 issue, comment and label APIs |
| `pulls` | 20 | REST v3 pull request, files and merge APIs |
| `graphql` | 20 | v4 documents gh and github-mcp-server actually send |
| `mcp` | 15 | streamable-HTTP MCP endpoint, its tools, and their effect on the REST view |
| `protocol` | 5 | status codes, JSON and error bodies, auth, pagination headers and method handling |
| **Total** | **120** | `30 + 15 + 15 + 20 + 20 + 15 + 5 = 120` |

Agent column: `AGENT_GROUP = 'mcp'`, `AGENT_CHECKS = 15` (mcp counted both in the 120 and alone as the agent column).

### 3.2 Scoring columns (manifest.ts)

- `feature = round(600 * passedChecks / totalChecks)` (`FEATURE_COLUMN_MAX = 600`)
- `agent = round(200 * passedAgentChecks / AGENT_CHECKS)` (`AGENT_COLUMN_MAX = 200`)
- `perf = sum over the four workloads of round(clamp(25 - 12.5*log2(t_ms / T_ref_ms), 0, 50))` (`PERF_COLUMN_MAX = 200`, `PERF_WORKLOAD_MAX = 50`, `PERF_TIER_STEP = 12.5`, `PERF_TIER_MAX = 4`)
- `score = feature + agent + perf`, integer `0..1000` (`SCORE_MAX = 1000`).
- Perf tier per workload: `perfTier(points) = floor(points / 12.5)`, clamped `0..4`.
- Tie-break `perf_p50_us`: `perfTieBreakUs(p50Ms)` = `round(1000 * exp(mean(log(max(ms, 0.001)))))` — geometric mean of the four workloads' `p50_ms`, in microseconds, rounded; each time floored at 1 µs. Ascending wins; then earlier receipt. In bench.ts: when NO workload measured, `perf_p50_us = FAILED_PERF_P50_US = 1_000_000_000`; otherwise `round(1000 * geometric mean of the p50_ms of the workloads that DID measure)` (sentinel p50s excluded, capped at 1e9). A failed/cut workload writes `p50_ms = p99_ms = FAILED_P50_MS = 1_000_000_000`, `points = 0`, but completed rounds are still recorded in `rounds`.

### 3.3 Benchmark constants

- `BENCH_ROUNDS = 3` (timed rounds per workload; p50 = median round, p99 = largest of 3 — nearest-rank percentile).
- `BENCH_WARMUP_OPS = 5` (untimed warm-up operations before the first round).
- Per-workload `budgetMs = 60_000` (60 s each); phase budget `BENCH_PHASE_BUDGET_MS = BENCHMARK_BUDGET_MS = 240_000` (240 s for all four). A workload past budget / not finishing all rounds = 0 points, stops early.
- `workloadPoints(tMs, tRef)`: `if (!finite(tMs) || tMs <= 0) return 0; if (!finite(tRef) || tRef <= 0) return 0; return Math.round(Math.min(50, Math.max(0, 25 - 12.5 * Math.log2(tMs / tRef))))`. A `T_ref` of 0 = uncalibrated → workload still runs, times kept, 0 points, `calibrated: false`.
- `T_REF_MS` (from `calibration.json`, measured 2026-11-14, medians of 3 dev grades of the house reference forge on dsh-makefun; `schema: agent-fun/calibration/v1`, `contest: github-core-clone-01`):

| workload | T_ref (p50_ms) | runs p50_ms |
|---|---|---|
| push | **1640.82** | [1914.548, 1640.82, 1415.785] |
| clone | **266.941** | [266.941, 313.634, 259.436] |
| read | **2759.715** | [2874.092, 2759.715, 2428.118] |
| write | **348.965** | [448.01, 348.965, 289.433] |

At its own T_ref a workload scores `round(25 - 12.5*log2(1)) = 25` points, so the reference forge earns 100/200 perf (geometric mean of medians `perf_p50_us = 805899` µs). Previous (superseded, 2026-11-13 rig) T_refs were push 514.838 / clone 121.436 / read 899.962 / write 120.093 — NOT current.

## 4. Bench setup per workload (bench.ts)

Common: owner for every bench repo = `run.scenario.viewer.login` = `adaiversen`. Setup (repo creation, clone history, read issue) happens inside the workload's 60 s budget but OUTSIDE every timed round. Every workload: `recreateRepo` = `DELETE /api/v3/repos/{owner}/{repo}` (404 when absent is normal, not scored) then `git.createRepo(owner, repo)` (accepts 422 "already exists"). All payloads built before the first timing starts — "no object hashing or deflating is ever timed". Clock: `performance.now()`, rounds rounded to 0.001 ms. Order in `runBenchmark`: push, clone, read, write (`BENCH_WORKLOAD_NAMES`).

### 4.1 push — repo `bench-push`, 200 ops/round

- `PUSH_REPO = 'bench-push'`, `PUSH_FILE = 'bench-data.txt'`, `PUSH_CHANGE_BYTES = 1_024`, `MAIN_REF = 'refs/heads/main'`, `BENCH_EPOCH_SEC = 1_700_000_000`.
- `buildPushPayloads(count)` with `count = warmupOps + rounds*ops = 5 + 3*200 = 605`, stream `scenarioRng('bench.push')`. Each payload: blob = `generateBlobText(rng, 1024)` (ASCII NATO-word text, exactly 1024 bytes); tree = single entry `{mode: '100644', name: 'bench-data.txt', oid: blobOid}`; commit = `buildCommit({tree, parents: [prev] or [], message: "bench: push ${index+1}\n", author/committer: CONFORMANCE_IDENTITY ('Conformance <conformance@make.fun>'), timestamp: BENCH_EPOCH_SEC + index})` — i.e. timestamps 1700000000, 1700000001, …; command `{oldOid: parent ?? ZERO_OID, newOid: commitOid, ref: 'refs/heads/main'}`; pack = `writePack([blob, tree, commit])` only — "exactly 'one 1 KiB change and its commit'". First push creates the branch (`oldOid = ZERO_OID`), later ones update from previous commit.
- A round = 200 sequential `git.push(owner, 'bench-push', [command], {pack})` receive-pack exchanges (advertisement + command list + pack). Each must pass `assertPushOk`: `report !== null`, `report.unpackOk`, ref named in `report.refs`, `report.ok` — else workload fails. 5 warm-ups first, then 3 timed rounds of 200.

### 4.2 clone — repo `bench-clone`, 50 ops/round, concurrent

- `CLONE_REPO = 'bench-clone'`, `CLONE_FILE = 'history.txt'`, `CLONE_CHANGE_BYTES = 512`, `CLONE_HISTORY_COMMITS = 200`.
- `buildCloneHistory()`, stream `scenarioRng('bench.clone')`: ONE pack holding all 200 commits × 3 objects (blob+tree+commit = 600 objects). Each commit `i` (0-based): blob = `generateBlobText(rng, 512)`; tree = single `100644 history.txt`; commit message `` `bench: history ${index+1}\n` ``, author/committer `CONFORMANCE_IDENTITY`, timestamp `BENCH_EPOCH_SEC + index` (1700000000…1700000199), parent = previous tip (first has none). Pushed once in setup as a single push `{oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main'}` with the whole pack; `assertPushOk` applies.
- A round = 50 CONCURRENT (`Promise.all`) shallow clones: `git.clone(owner, 'bench-clone', {depth: 1, parse: false, singleBranch: true})` — "each stream checksum-verified" (`result.checksumOk === true`, `result.packBytes > 0`, `result.refs.length > 0` required) but objects NOT parsed (`parse: false`). 5 warm-up clones, then 3 timed rounds of 50 concurrent.

### 4.3 read — repo `bench-read`, 2000 ops/round, keep-alive

- `READ_REPO = 'bench-read'`.
- Setup: create ONE issue via `POST /api/v3/repos/adaiversen/bench-read/issues` with body `{title: "<scenario.issues[0].title> (bench setup)", body: scenario.issues[0].body}` — i.e. title **`Incorrect GraphQL node ids (bench setup)`**, body `A minimal case is attached but the second request fails. The same flow works over the API and the server answers with a JSON error. Steps to reproduce are below but the second request fails.` Must answer `201` and a numeric positive `number` in the JSON body, or setup fails. (The issue number is whatever the forge assigns — typically 1 — and is then read back; it is NOT hardcoded.)
- A round = 2,000 sequential `GET /api/v3/repos/adaiversen/bench-read/issues/{number}` on ONE warm keep-alive connection (same `RestClient`, undici pool reuses the socket). Each must answer `200` with a JSON object body. 5 warm-ups, then 3 timed rounds of 2,000.

### 4.4 write — repo `bench-write`, 200 ops/round

- `WRITE_REPO = 'bench-write'`.
- Payloads pre-built (`total = 5 + 3*200 = 605`): for `index` 0-based, `template = scenario.issues[index % 60]`, payload `{title: "<template.title> [bench ${index+1}]", body: template.body}` — e.g. #1 `Incorrect GraphQL node ids [bench 1]`, #2 `Stale push report-status [bench 2]`, #3 `Unclear clone over HTTP [bench 3]`, cycling through all 60 templates, bodies verbatim (labels NOT sent — only `title` + `body`). No labels, no other fields.
- A round = 200 sequential `POST /api/v3/repos/adaiversen/bench-write/issues` with those payloads; each must answer `201` (GitHub's create-issue status) or the workload fails. 5 warm-ups, then 3 timed rounds of 200.

### 4.5 perf.json shape (bench.ts `perfFileOf` / `finishWorkload`)

```json
{"version":1,"calibrated":true,"workloads":[{"name":"push|clone|read|write","rounds":[ms,ms,ms],"p50_ms":<median or 1e9>,"p99_ms":<largest of 3 or 1e9>,"ops":<200|50|2000|200>,"points":0,"error":"<why, if 0>"}],"tiers":{"push":0,"clone":0,"read":0,"write":0},"points":{"push":0,"clone":0,"read":0,"write":0},"perf_p50_us":<tie-break or 1e9>,"points_total":0,"notes":["…"]}
```
`p50` = nearest-rank median of the 3 rounds; `p99` = largest of 3. Points are always recomputed from p50 + T_ref at assembly. Uncalibrated error line: `uncalibrated: T_ref is 0, so the workload earns 0 points until calibration fills it`.

## 5. Forge-implementation traps (derived strictly from the above)

1. The token has NO fixed value in the kit — the forge must accept the harness-supplied `MAKEFUN_SHOP_TOKEN` bearer as viewer `adaiversen` (any non-empty bearer), 401 without it; hardcoding a token value will fail.
2. Bench repos are NOT scenario repos: `bench-push` / `bench-clone` / `bench-read` / `bench-write` under owner `adaiversen`, created fresh per workload (DELETE-then-create), and the push/clone workloads speak raw git smart-HTTP (receive-pack with `report-status`, pack checksum verification on clone) — a REST-only forge scores 0 on git (30 checks) + push/clone bench.
3. Read bench is 2,000 sequential GETs of ONE issue on one keep-alive socket — per-request overhead (not just throughput) dominates; clone bench is 50 concurrent depth-1 clones of a 200-commit repo where only the tip tree/blob is served.
4. T_refs are slow (push 1640.82 ms / 200 pushes ≈ 8.2 ms per push; read 2759.715 ms / 2000 GETs ≈ 1.38 ms per GET; write 348.965 ms / 200 ≈ 1.74 ms per create; clone 266.941 ms / 50 concurrent): beating T_ref by 2× on a workload earns `25 - 12.5*log2(0.5) = 37.5 → 38` points; 4× earns 50 (max).
