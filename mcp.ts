// MCP endpoint: JSON-RPC 2.0 Streamable HTTP (modern 2026-07-28 era via server/discover,
// legacy initialize handshake also accepted). Six tools sharing the REST store.

import { Store, VIEWER, type Repo } from './store.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListPayload(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function resolveOwnerRepo(store: Store, args: Record<string, unknown>): { owner: string; repoName: string; repo: Repo | undefined } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repoName) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner || parts[0];
      repoName = repoName || parts[1];
    }
  }
  if (!owner) owner = VIEWER.login;
  const repo = repoName ? store.getRepo(owner, repoName) : undefined;
  return { owner, repoName, repo };
}

function toolResult(result: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function toolError(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function handleMcp(store: Store, bodyText: string): { status: number; body: unknown } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get no JSON-RPC response.
  if (id === undefined) {
    return { status: 202, body: null };
  }

  const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const err = (code: number, message: string) => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return ok({
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo,
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP.',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
      ? params.protocolVersion
      : PROTOCOL_VERSION;
    return ok({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return ok({});
  }
  if (method === 'tools/list') {
    return ok(toolsListPayload());
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      return err(-32602, `unknown tool ${name}`);
    }
    const missing = tool.required.filter((prop) => !(prop in args) || args[prop] === undefined || args[prop] === null);
    if (missing.length > 0) {
      return err(-32602, `missing required argument(s): ${missing.join(', ')}`);
    }
    const result = dispatchTool(store, tool.name, args);
    return ok(result);
  }
  return err(-32601, `method not found: ${method}`);
}

function dispatchTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  if (name === 'create_repo') {
    const repoName = String(args.name);
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
    if (owner !== VIEWER.login) return toolError(`cannot create a repository under ${owner}`);
    const created = store.createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    if (!created) return toolError(`repository ${owner}/${repoName} already exists`);
    return toolResult(repoJson(created));
  }
  if (name === 'get_repo') {
    const { repo } = resolveOwnerRepo(store, args);
    if (!repo) return toolError('repository not found');
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const { repo, owner, repoName } = resolveOwnerRepo(store, args);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    const created = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    if ('error' in created) return toolError(created.error);
    return toolResult({
      id: created.id,
      number: created.number,
      title: created.title,
      body: created.body,
      state: created.state,
      full_name: `${owner}/${repoName}`,
      html_url: `https://github.com/${owner}/${repoName}/issues/${created.number}`,
    });
  }
  if (name === 'list_issues') {
    const { repo, owner, repoName } = resolveOwnerRepo(store, args);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = store.listIssues(repo, state === 'all' ? undefined : state, 'desc');
    return toolResult({
      issues: list.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      })),
    });
  }
  if (name === 'create_pull_request') {
    const { repo, owner, repoName } = resolveOwnerRepo(store, args);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    const created = store.createPull(
      repo,
      String(args.title),
      typeof args.body === 'string' ? args.body : '',
      String(args.head),
      String(args.base),
    );
    if ('error' in created) return toolError(created.error);
    const headTip = repo.refs.get(`refs/heads/${created.headRef}`) ?? '';
    const baseTip = repo.refs.get(`refs/heads/${created.baseRef}`) ?? '';
    return toolResult({
      id: created.id,
      number: created.number,
      title: created.title,
      body: created.body,
      state: created.state,
      head: created.headRef,
      base: created.baseRef,
      head_ref: created.headRef,
      base_ref: created.baseRef,
      head_sha: headTip,
      base_sha: baseTip,
      full_name: `${owner}/${repoName}`,
      html_url: `https://github.com/${owner}/${repoName}/pull/${created.number}`,
    });
  }
  if (name === 'merge_pull_request') {
    const { repo, owner, repoName } = resolveOwnerRepo(store, args);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    const number = Number(args.pull_number);
    const pull = store.getPull(repo, number);
    if (!pull) return toolError(`pull request #${number} not found`);
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return toolError(`merge failed: ${merged.error}`);
    return toolResult({ merged: true, number, state: 'closed', sha: merged.sha });
  }
  return toolError(`unknown tool ${name}`);
}
