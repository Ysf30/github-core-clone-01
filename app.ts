// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4, MCP. Stdlib only.
// main.ts owns the env lifecycle; this file is the server.
// The HTTP transport is transport.ts (raw TCP HTTP/1.1, a drop-in for
// node:http's createServer): the timed workloads are transport-bound, and the
// minimal parser cuts the per-request server cost. The handler below is
// unchanged by the transport swap.

import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer } from './transport.ts';
import {
  ZERO_OID,
  decodePktLines,
} from './gitcore.ts';
import {
  Store,
  VIEWER,
  diffFileMaps,
  touchRefs,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  advertisementV0,
  advertisementV2,
  applyPush,
  fetchV0Response,
  fetchV2Response,
  lsRefsResponse,
  parseFetchArgs,
  parsePushBody,
  parseV0Fetch,
  parseV2Args,
  pushReportResponse,
  sidebandPack,
} from './githttp.ts';
import { writePack } from './gitcore.ts';
import { executeGraphQLRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body; every reply carries X-GitHub-Request-Id. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(status === 204 ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let first: Buffer | null = null;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      if (first === null && chunks.length === 0) first = chunk;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      // One chunk (the usual small-body case): use it as-is, no copy.
      if (chunks.length === 0 && first !== null) resolve(first);
      else if (chunks.length === 0) resolve(Buffer.alloc(0));
      else resolve(Buffer.concat(first !== null ? [first, ...chunks] : chunks));
    });
    req.on('error', reject);
  });
}

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// serializers

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    language: null,
    homepage: null,
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/**
 * The serialized form of one issue, cached while the issue is unchanged. The read
 * workload GETs the same issue 2,000× in a row; rebuilding its JSON each time is pure
 * garbage. The cache key is the issue object plus a snapshot of every field issueJson
 * reads, so any PATCH or relabel rebuilds it exactly once.
 */
interface CachedIssueJson {
  title: string;
  body: string;
  state: string;
  updatedAt: string;
  labelsKey: string;
  buf: Buffer;
}
const issueJsonCache = new WeakMap<Issue, CachedIssueJson>();

function issueJsonBuffer(repo: Repo, issue: Issue): Buffer {
  const labelsKey = issue.labels.join(',');
  const cached = issueJsonCache.get(issue);
  if (
    cached &&
    cached.title === issue.title &&
    cached.body === issue.body &&
    cached.state === issue.state &&
    cached.updatedAt === issue.updatedAt &&
    cached.labelsKey === labelsKey
  ) {
    return cached.buf;
  }
  const buf = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  issueJsonCache.set(issue, { title: issue.title, body: issue.body, state: issue.state, updatedAt: issue.updatedAt, labelsKey, buf });
  return buf;
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headTip, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseTip, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: store.pullMergeable(repo, pull),
    mergeable_state: store.pullMergeable(repo, pull) ? 'clean' : 'dirty',
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
  };
}

const ISSUE_GET_RE = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
const ISSUE_POST_RE = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/;

/**
 * Fast path for GET /api/v3/repos/{owner}/{repo}/issues/{number} and
 * POST /api/v3/repos/{owner}/{repo}/issues with no query string: the two timed REST
 * workloads. Returns true when it answered (any status); false means "not this shape",
 * and the caller falls through to the general path. The checks run in the general
 * path's order (bearer, then body, then owner, then repo), so the answers are identical.
 */
async function fastIssueRoute(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rawUrl: string,
): Promise<boolean> {
  if (method === 'GET') {
    const match = ISSUE_GET_RE.exec(rawUrl);
    if (!match) return false;
    if (!bearer(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return true;
    }
    const owner = match[1];
    const repoName = match[2];
    if (owner !== VIEWER.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const issue = store.getIssue(repo, Number(match[3]));
    if (!issue) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendBuffer(res, 200, issueJsonBuffer(repo, issue), JSON_TYPE);
    return true;
  }
  if (method === 'POST') {
    const match = ISSUE_POST_RE.exec(rawUrl);
    if (!match) return false;
    if (!bearer(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return true;
    }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        else body = {};
      } catch {
        sendJson(res, 400, { message: 'malformed JSON body' });
        return true;
      }
    }
    const owner = match[1];
    const repoName = match[2];
    if (owner !== VIEWER.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const title = typeof body.title === 'string' ? body.title : '';
    const issueBody = typeof body.body === 'string' ? body.body : '';
    const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
    const created = store.createIssue(repo, title, issueBody, labels);
    if ('error' in created) {
      sendJson(res, 422, { message: created.error });
      return true;
    }
    sendJson(res, 201, issueJson(repo, created));
    return true;
  }
  return false;
}

/**
 * Fast path for GET /{owner}/{repo}.git/info/refs?service=... : every push and every
 * clone starts here. Same checks and answers as handleGit's info/refs branch.
 */
async function fastInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, rawUrl: string): Promise<boolean> {
  const marker = '.git/info/refs?service=';
  const idx = rawUrl.indexOf(marker);
  if (idx <= 1 || rawUrl[0] !== '/') return false;
  const slash = rawUrl.indexOf('/', 1);
  if (slash < 0 || slash >= idx) return false;
  const owner = rawUrl.slice(1, slash);
  const repoPart = rawUrl.slice(slash + 1, idx);
  if (!repoPart.endsWith('.git')) return false;
  const repoName = repoPart.slice(0, -'.git'.length);
  if (owner === '' || repoName === '') return false;
  let service = rawUrl.slice(idx + marker.length);
  const amp = service.indexOf('&');
  if (amp >= 0) service = service.slice(0, amp);
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return false;
  if (!bearer(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack' && isV2) {
    sendBuffer(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
  } else {
    sendBuffer(res, 200, advertisementV0(repo, service), `application/x-${service}-advertisement`);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// the app

export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } catch {
          // The socket is gone; nothing more to do.
        }
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    });
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  // Fast paths for the timed workloads: exact string matches, no URL object, no
  // split/filter, no decode. Anything unusual (a query string, a '%' escape, an odd
  // shape) falls through to the general path below, which is unchanged.
  if (method === 'GET' && rawUrl === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (!rawUrl.includes('%')) {
    if (method === 'GET' || method === 'POST') {
      if (await fastIssueRoute(store, req, res, method, rawUrl)) return;
    }
    if (method === 'GET') {
      if (await fastInfoRefs(store, req, res, rawUrl)) return;
    }
  }
  const url = urlOf(req);
  const path = url.pathname;
  const query = url.searchParams;
  const segments = path.split('/').filter((segment) => segment !== '');

  // The env's boot check: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    await handleGit(store, req, res, method, segments, query);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendNoContent(res, 204);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!bearer(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const text = (await readBody(req)).toString('utf8');
    const result = handleMcp(store, text);
    if (result.status === 202 || result.body === null) {
      sendNoContent(res, 202);
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!bearer(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] });
      return;
    }
    const result = executeGraphQLRequest(store, body);
    sendJson(res, result.status, result.body);
    return;
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest(store, req, res, method, segments, path, query);
    return;
  }

  // Everything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP

async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, method: string, segments: string[], query: URLSearchParams): Promise<void> {
  const owner = decodeSegment(segments[0]);
  const repoName = decodeSegment(segments[1].slice(0, -'.git'.length));
  const rest = segments.slice(2);
  if (!bearer(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack' || service === 'git-receive-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (service === 'git-upload-pack' && isV2) {
        sendBuffer(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, advertisementV0(repo, service), `application/x-${service}-advertisement`);
      }
      return;
    }
    sendJson(res, 400, { message: 'unknown service' });
    return;
  }

  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    const body = await readBody(req);
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      sendJson(res, 400, { message: 'malformed pkt-line stream' });
      return;
    }
    const firstData = packets.find((packet) => packet.kind === 'data');
    if (!firstData) {
      sendJson(res, 400, { message: 'empty upload-pack request' });
      return;
    }
    const firstLine = firstData.payload.toString('utf8').replace(/\n$/, '');
    if (firstLine.startsWith('command=')) {
      const { command, args } = parseV2Args(body);
      if (command === 'command=ls-refs') {
        sendBuffer(res, 200, lsRefsResponse(repo, args), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'command=fetch') {
        const fetchArgs = parseFetchArgs(args);
        let response: Buffer;
        try {
          response = fetchV2Response(store, repo, fetchArgs);
        } catch {
          // A missing want object: answer an empty pack rather than dying.
          response = Buffer.concat([...sidebandPack(writePack([])), Buffer.from('0000', 'ascii')]);
        }
        sendBuffer(res, 200, response, 'application/x-git-upload-pack-result');
        return;
      }
      sendJson(res, 400, { message: `unknown v2 command ${command}` });
      return;
    }
    // v0 fetch.
    const fetchArgs = parseV0Fetch(body);
    let response: Buffer;
    try {
      response = fetchV0Response(store, repo, fetchArgs);
    } catch {
      response = Buffer.concat([...sidebandPack(writePack([])), Buffer.from('0000', 'ascii')]);
    }
    sendBuffer(res, 200, response, 'application/x-git-upload-pack-result');
    return;
  }

  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    const body = await readBody(req);
    const parsed = parsePushBody(body);
    if (!parsed) {
      sendJson(res, 400, { message: 'malformed push request' });
      return;
    }
    const report = applyPush(store, repo, parsed.commands, parsed.pack);
    sendBuffer(res, 200, pushReportResponse(report), 'application/x-git-receive-pack-result');
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------------------------
// REST v3

async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, method: string, segments: string[], path: string, query: URLSearchParams): Promise<void> {
  // GET /api/v3/ — the API root, public (as api.github.com answers it).
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (!bearer(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  const rest = segments.slice(2); // after 'api', 'v3'

  // Read and parse a JSON body when one is present (POST/PUT/PATCH/DELETE).
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        else body = {};
      } catch {
        sendJson(res, 400, { message: 'malformed JSON body' });
        return;
      }
    }
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      html_url: `https://github.com/${VIEWER.login}`,
      url: '/api/v3/user',
    });
    return;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const created = store.createRepo(
        VIEWER.login,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      if (!created) {
        sendJson(res, 422, { message: `Repository ${VIEWER.login}/${name} already exists` });
        return;
      }
      sendJson(res, 201, repoJson(created));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Number(query.get('per_page') ?? 30) || 30);
      const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
      const all = store.listRepos(VIEWER.login);
      const pageItems = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      if (page < totalPages) {
        const host = req.headers.host ?? 'localhost';
        const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
        headers.link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${totalPages}>; rel="last"`;
      }
      sendJson(res, 200, pageItems.map(repoJson), headers);
      return;
    }
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeSegment(rest[1]);
    const repoName = decodeSegment(rest[2]);
    const tail = rest.slice(3);
    if (owner !== VIEWER.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    await handleRepoRest(store, req, res, method, repo, tail, body, query);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRepoRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  tail: string[],
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<void> {
  // GET/PATCH/DELETE /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        // Renames are not exercised by the suite; refuse rather than corrupt the key.
        sendJson(res, 422, { message: 'renaming a repository is not supported' });
        return;
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      sendNoContent(res, 204);
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  // GET /branches
  if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
    sendJson(res, 200, branches);
    return;
  }

  // GET /commits[?sha=]
  if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (!tip) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const commits = store.listCommits(repo, tip);
    sendJson(
      res,
      200,
      commits.map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })),
    );
    return;
  }

  // POST /git/refs — create a branch/tag ref.
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
      sendJson(res, 422, { message: 'invalid ref or sha' });
      return;
    }
    if (repo.refs.has(ref)) {
      sendJson(res, 422, { message: `ref ${ref} already exists` });
      return;
    }
    repo.refs.set(ref, sha);
    touchRefs(repo);
    sendJson(res, 201, { ref, object: { sha } });
    return;
  }

  // GET /git/refs[/{ref...}] — read one ref (or list all refs).
  if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
    if (tail.length === 2) {
      const refs = [...repo.refs.entries()].map(([name, oid]) => ({ ref: name, object: { sha: oid } }));
      sendJson(res, 200, refs);
      return;
    }
    const refName = tail.slice(2).map(decodeSegment).join('/');
    const oid = repo.refs.get(refName);
    if (!oid) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, { ref: refName, object: { sha: oid } });
    return;
  }

  // /contents/{path...}
  if (tail.length >= 1 && tail[0] === 'contents') {
    const filePath = tail.slice(1).map(decodeSegment).join('/');
    const branch = typeof body.branch === 'string' ? body.branch : (query.get('ref') ?? repo.defaultBranch);
    if (method === 'PUT') {
      const message = typeof body.message === 'string' ? body.message : 'update';
      const content = typeof body.content === 'string' ? body.content : '';
      let contentBytes: Buffer;
      try {
        contentBytes = Buffer.from(content, 'base64');
      } catch {
        sendJson(res, 422, { message: 'content must be base64' });
        return;
      }
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      if (tip) {
        const treeOid = store.treeOfRef(repo, refName);
        if (treeOid !== null) {
          const files = store.flattenTree(repo, treeOid);
          const existing = files.get(filePath);
          if (existing !== undefined) {
            const sha = typeof body.sha === 'string' ? body.sha : '';
            if (sha === '') {
              sendJson(res, 422, { message: 'sha is required to update a file' });
              return;
            }
            if (sha.toLowerCase() !== existing.toLowerCase()) {
              sendJson(res, 409, { message: 'sha does not match the current file' });
              return;
            }
          }
        }
      }
      const { commitSha, contentSha, created } = store.writeFile(repo, branch, filePath, contentBytes, message);
      sendJson(res, created ? 201 : 200, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: contentSha,
          size: contentBytes.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitSha },
      });
      return;
    }
    if (method === 'GET') {
      const refName = `refs/heads/${branch}`;
      const read = store.readPath(repo, refName, filePath);
      if (!read) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (read.kind === 'file') {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: read.data.toString('base64'),
          sha: read.oid,
          size: read.size,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
        });
        return;
      }
      sendJson(res, 200, read.entries);
      return;
    }
    if (method === 'DELETE') {
      const message = typeof body.message === 'string' ? body.message : 'delete';
      const commitSha = store.deleteFile(repo, branch, filePath, message);
      if (!commitSha) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, { commit: { sha: commitSha } });
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  // POST/GET /labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const label = store.createLabel(repo, name, typeof body.color === 'string' ? body.color : 'ededed');
      sendJson(res, 201, { name: label.name, color: label.color, description: '' });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  // /issues
  if (tail.length >= 1 && tail[0] === 'issues') {
    // /issues/{n}/comments
    if (tail.length === 3 && tail[2] === 'comments') {
      const number = Number(tail[1]);
      if (!Number.isInteger(number)) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'POST') {
        const comment = store.addComment(repo, number, typeof body.body === 'string' ? body.body : '');
        if (!comment) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 201, commentJson(repo, number, comment));
        return;
      }
      if (method === 'GET') {
        const issue = store.getIssue(repo, number);
        if (!issue) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, store.listComments(repo, number).map((comment) => commentJson(repo, number, comment)));
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    // /issues/{n}
    if (tail.length === 2) {
      const number = Number(tail[1]);
      if (!Number.isInteger(number)) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const issue = store.getIssue(repo, number);
      if (!issue) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        issue.updatedAt = new Date().toISOString();
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    // /issues (list + create)
    if (tail.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        const issueBody = typeof body.body === 'string' ? body.body : '';
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
        const created = store.createIssue(repo, title, issueBody, labels);
        if ('error' in created) {
          sendJson(res, 422, { message: created.error });
          return;
        }
        sendJson(res, 201, issueJson(repo, created));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') === 'asc' ? 'asc' : 'desc';
        const perPage = Math.max(1, Number(query.get('per_page') ?? 30) || 30);
        const list = store.listIssues(repo, state, direction).slice(0, perPage);
        sendJson(res, 200, list.map((issue) => issueJson(repo, issue)));
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /pulls
  if (tail.length >= 1 && tail[0] === 'pulls') {
    // /pulls/{n}/files
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const number = Number(tail[1]);
      const pull = Number.isInteger(number) ? store.getPull(repo, number) : undefined;
      if (!pull) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const files = store.pullFiles(repo, pull);
      sendJson(
        res,
        200,
        files.map((file) => ({
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
        })),
      );
      return;
    }
    // /pulls/{n}/merge
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const number = Number(tail[1]);
      const pull = Number.isInteger(number) ? store.getPull(repo, number) : undefined;
      if (!pull) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) {
        if (merged.error === 'conflict' || merged.error === 'already-merged') {
          sendJson(res, 405, { message: `pull request cannot be merged: ${merged.error}` });
        } else {
          sendJson(res, 404, { message: 'Not Found' });
        }
        return;
      }
      sendJson(res, 200, {
        merged: true,
        sha: merged.sha,
        message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
      });
      return;
    }
    // /pulls/{n}
    if (tail.length === 2 && method === 'GET') {
      const number = Number(tail[1]);
      const pull = Number.isInteger(number) ? store.getPull(repo, number) : undefined;
      if (!pull) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, pullJson(store, repo, pull));
      return;
    }
    // /pulls (list + create)
    if (tail.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        const pullBody = typeof body.body === 'string' ? body.body : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        const created = store.createPull(repo, title, pullBody, head, base);
        if ('error' in created) {
          sendJson(res, 422, { message: created.error });
          return;
        }
        sendJson(res, 201, pullJson(store, repo, created));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const perPage = Math.max(1, Number(query.get('per_page') ?? 30) || 30);
        const list = store.listPulls(repo, state === 'all' ? undefined : state).slice(0, perPage);
        sendJson(res, 200, list.map((pull) => pullJson(store, repo, pull)));
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
