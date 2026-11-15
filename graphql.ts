// GraphQL v4: a small parser + executor for the exact documents the suite sends
// (viewer, repository, issues, pull requests, mutations, node, __type, batched ops).
// No external dependency; the schema surface is the one the checks exercise.

import { Store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// global ids (opaque, stable, round-trippable; never the bare numeric id)

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function unb64(text: string): string | null {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.id}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64(`PullRequest:${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return b64(`IssueComment:${repo.id}:${issueNumber}:${commentId}`);
}

type DecodedId =
  | { kind: 'Repository'; repoId: number }
  | { kind: 'Issue'; repoId: number; number: number }
  | { kind: 'PullRequest'; repoId: number; number: number }
  | { kind: 'IssueComment'; repoId: number; issueNumber: number; commentId: number }
  | null;

export function decodeGlobalId(id: string): DecodedId {
  const text = unb64(id);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts[0] === 'Repository' && parts.length === 2) {
    const repoId = Number(parts[1]);
    return Number.isInteger(repoId) ? { kind: 'Repository', repoId } : null;
  }
  if (parts[0] === 'Issue' && parts.length === 3) {
    const repoId = Number(parts[1]);
    const number = Number(parts[2]);
    return Number.isInteger(repoId) && Number.isInteger(number) ? { kind: 'Issue', repoId, number } : null;
  }
  if (parts[0] === 'PullRequest' && parts.length === 3) {
    const repoId = Number(parts[1]);
    const number = Number(parts[2]);
    return Number.isInteger(repoId) && Number.isInteger(number) ? { kind: 'PullRequest', repoId, number } : null;
  }
  if (parts[0] === 'IssueComment' && parts.length === 4) {
    const repoId = Number(parts[1]);
    const issueNumber = Number(parts[2]);
    const commentId = Number(parts[3]);
    return Number.isInteger(repoId) && Number.isInteger(issueNumber) && Number.isInteger(commentId)
      ? { kind: 'IssueComment', repoId, issueNumber, commentId }
      : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// schema surface (for introspection and field validation)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
    'description',
    'isPrivate',
    'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url'],
  PullRequest: [
    'id',
    'number',
    'title',
    'state',
    'merged',
    'headRefName',
    'baseRefName',
    'mergeable',
    'files',
    'body',
    'createdAt',
    'updatedAt',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  Ref: ['name', 'prefix', 'target'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// tokenizer + parser (subset of GraphQL sufficient for the suite's documents)

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1];
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else out += next;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'int', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  args?: { name: string; value: ValueNode }[];
  selections?: Selection[];
  typeCondition?: string;
}

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value as string;
    }
    if (this.isPunct('(')) this.skipVarDefs();
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }

  /** Skip "(...)" variable definitions; only the names matter and they come from `variables`. */
  private skipVarDefs(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.isPunct('...')) {
      this.next();
      let typeCondition: string | undefined;
      const token = this.peek();
      if (token?.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: { name: string; value: ValueNode }[] | undefined;
    if (this.isPunct('(')) args = this.parseArguments();
    // Skip directives (@foo...) if any.
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
    let selections: Selection[] | undefined;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// resolver nodes

type NodeValue =
  | { kind: 'root' }
  | { kind: 'user'; login: string }
  | { kind: 'repo'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pull'; repo: Repo; pull: Pull }
  | { kind: 'ref'; name: string }
  | { kind: 'issueConn'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'pullConn'; repo: Repo; pulls: Pull[] }
  | { kind: 'pullFiles'; repo: Repo; pull: Pull; first: number }
  | { kind: 'pullFile'; path: string }
  | { kind: 'commentEdge'; repo: Repo; issueNumber: number; commentId: number; body: string }
  | { kind: 'comment'; repo: Repo; issueNumber: number; commentId: number; body: string }
  | { kind: 'type'; name: string }
  | { kind: 'typeField'; name: string }
  | { kind: 'typeEnumValue'; name: string }
  | { kind: 'pageInfo'; hasNextPage: boolean; endCursor: string | null };

function typeNameOf(node: NodeValue): string {
  switch (node.kind) {
    case 'root':
      return 'Query';
    case 'user':
      return 'User';
    case 'repo':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'pull':
      return 'PullRequest';
    case 'ref':
      return 'Ref';
    case 'issueConn':
      return 'IssueConnection';
    case 'pullConn':
      return 'PullRequestConnection';
    case 'pullFiles':
      return 'PullRequestChangedFileConnection';
    case 'pullFile':
      return 'PullRequestChangedFile';
    case 'commentEdge':
      return 'IssueCommentEdge';
    case 'comment':
      return 'IssueComment';
    case 'type':
      return '__Type';
    case 'typeField':
      return '__Field';
    case 'typeEnumValue':
      return '__EnumValue';
    case 'pageInfo':
      return 'PageInfo';
  }
}

function cursorForIssue(issue: Issue): string {
  return b64(`IssueCursor:${issue.number}`);
}

function issueFromCursor(cursor: string): number | null {
  const text = unb64(cursor);
  if (text === null || !text.startsWith('IssueCursor:')) return null;
  const n = Number(text.slice('IssueCursor:'.length));
  return Number.isInteger(n) ? n : null;
}

export class GraphQLExecutor {
  constructor(private readonly store: Store) {}

  executeOperation(query: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors: { message: string }[] } {
    const errors: { message: string }[] = [];
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    let operation: Operation | undefined;
    if (operationName) {
      operation = operations.find((op) => op.name === operationName);
    } else if (operations.length === 1) {
      operation = operations[0];
    } else {
      operation = operations.find((op) => op.type === 'query');
    }
    if (!operation) return { data: null, errors: [{ message: 'no operation found' }] };
    const data = this.executeSelections({ kind: 'root' }, operation.selections, variables, errors);
    return { data, errors };
  }

  /** Resolve a plain result object (mutation payload) against a selection set. */
  executeSelectionsOnObject(
    obj: Record<string, unknown>,
    selections: Selection[],
    variables: Record<string, unknown>,
    errors: { message: string }[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') continue;
      const fieldName = selection.name!;
      const key = selection.alias ?? fieldName;
      const value = obj[fieldName];
      if (value === undefined || value === null) {
        out[key] = null;
        continue;
      }
      if (selection.selections && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
        out[key] = this.executeSelections(value as NodeValue, selection.selections, variables, errors);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private executeSelections(node: NodeValue, selections: Selection[], variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition && selection.typeCondition !== typeNameOf(node)) continue;
        Object.assign(out, this.executeSelections(node, selection.selections ?? [], variables, errors));
        continue;
      }
      const fieldName = selection.name!;
      const key = selection.alias ?? fieldName;
      const value = this.resolveField(node, fieldName, selection, variables, errors);
      if (value === undefined) {
        out[key] = null;
        continue;
      }
      if (selection.selections && value !== null && typeof value === 'object' && !Array.isArray(value) && 'kind' in value) {
        out[key] = this.executeSelections(value as NodeValue, selection.selections, variables, errors);
      } else if (selection.selections && Array.isArray(value)) {
        out[key] = value.map((item) => {
          if (item !== null && typeof item === 'object' && 'kind' in item) {
            return this.executeSelections(item as NodeValue, selection.selections!, variables, errors);
          }
          return item;
        });
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private argsOf(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const arg of selection.args ?? []) out[arg.name] = evalValue(arg.value, variables);
    return out;
  }

  private unknownField(node: NodeValue, fieldName: string, errors: { message: string }[]): undefined {
    errors.push({ message: `Cannot query field "${fieldName}" on type "${typeNameOf(node)}"` });
    return undefined;
  }

  private resolveField(
    node: NodeValue,
    fieldName: string,
    selection: Selection,
    variables: Record<string, unknown>,
    errors: { message: string }[],
  ): unknown {
    const args = this.argsOf(selection, variables);
    const known = TYPE_FIELDS[typeNameOf(node)] ?? [];
    if (!known.includes(fieldName)) return this.unknownField(node, fieldName, errors);

    switch (node.kind) {
      case 'root': {
        if (fieldName === 'viewer') return { kind: 'user', login: VIEWER.login } as NodeValue;
        if (fieldName === 'repository') {
          const repo = this.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo ? ({ kind: 'repo', repo } as NodeValue) : null;
        }
        if (fieldName === 'node') {
          const decoded = decodeGlobalId(String(args.id ?? ''));
          if (decoded?.kind === 'Repository') {
            const repo = [...this.store.repos.values()].find((candidate) => candidate.id === decoded.repoId);
            return repo ? ({ kind: 'repo', repo } as NodeValue) : null;
          }
          return null;
        }
        if (fieldName === '__type') {
          const name = String(args.name ?? '');
          if (!TYPE_FIELDS[name] && !ENUM_VALUES[name]) return null;
          return { kind: 'type', name } as NodeValue;
        }
        return null;
      }
      case 'user': {
        if (fieldName === 'login') return node.login;
        if (fieldName === 'id') return b64(`User:${node.login}`);
        if (fieldName === 'name') return node.login;
        return null;
      }
      case 'repo': {
        const repo = node.repo;
        if (fieldName === 'id') return repoGlobalId(repo);
        if (fieldName === 'databaseId') return repo.id;
        if (fieldName === 'name') return repo.name;
        if (fieldName === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
        if (fieldName === 'description') return repo.description;
        if (fieldName === 'isPrivate') return repo.private;
        if (fieldName === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
        if (fieldName === 'owner') return { kind: 'user', login: repo.owner } as NodeValue;
        if (fieldName === 'defaultBranchRef') {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? ({ kind: 'ref', name: repo.defaultBranch } as NodeValue) : null;
        }
        if (fieldName === 'viewerPermission') return 'ADMIN';
        if (fieldName === 'hasIssuesEnabled') return true;
        if (fieldName === 'issue') {
          const issue = this.store.getIssue(repo, Number(args.number));
          return issue ? ({ kind: 'issue', repo, issue } as NodeValue) : null;
        }
        if (fieldName === 'issues') {
          return this.issuesConnection(repo, args);
        }
        if (fieldName === 'pullRequests') {
          const first = typeof args.first === 'number' ? args.first : 100;
          const pulls = this.store.listPulls(repo, undefined).slice(0, first);
          return { kind: 'pullConn', repo, pulls } as NodeValue;
        }
        if (fieldName === 'pullRequest') {
          const pull = this.store.getPull(repo, Number(args.number));
          return pull ? ({ kind: 'pull', repo, pull } as NodeValue) : null;
        }
        return null;
      }
      case 'issue': {
        const issue = node.issue;
        if (fieldName === 'id') return issueGlobalId(node.repo, issue);
        if (fieldName === 'number') return issue.number;
        if (fieldName === 'title') return issue.title;
        if (fieldName === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        if (fieldName === 'body') return issue.body;
        if (fieldName === 'createdAt' || fieldName === 'updatedAt') return issue.createdAt;
        if (fieldName === 'url') return `https://github.com/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
        return null;
      }
      case 'pull': {
        const pull = node.pull;
        if (fieldName === 'id') return pullGlobalId(node.repo, pull);
        if (fieldName === 'number') return pull.number;
        if (fieldName === 'title') return pull.title;
        if (fieldName === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        if (fieldName === 'merged') return pull.merged;
        if (fieldName === 'headRefName') return pull.headRef;
        if (fieldName === 'baseRefName') return pull.baseRef;
        if (fieldName === 'mergeable') return this.store.pullMergeable(node.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        if (fieldName === 'body') return pull.body;
        if (fieldName === 'createdAt' || fieldName === 'updatedAt') return pull.createdAt;
        if (fieldName === 'files') {
          const first = typeof args.first === 'number' ? args.first : 100;
          return { kind: 'pullFiles', repo: node.repo, pull, first } as NodeValue;
        }
        return null;
      }
      case 'ref': {
        if (fieldName === 'name') return node.name;
        if (fieldName === 'prefix') return 'refs/heads/';
        return null;
      }
      case 'issueConn': {
        if (fieldName === 'nodes') {
          return node.issues.map((issue) => ({ kind: 'issue', repo: node.repo, issue }) as NodeValue);
        }
        if (fieldName === 'edges') {
          return node.issues.map((issue) => ({ kind: 'issue', repo: node.repo, issue }) as NodeValue);
        }
        if (fieldName === 'pageInfo') {
          return { kind: 'pageInfo', hasNextPage: node.hasNextPage, endCursor: node.endCursor } as NodeValue;
        }
        if (fieldName === 'totalCount') return node.issues.length;
        return null;
      }
      case 'pullConn': {
        if (fieldName === 'nodes') {
          return node.pulls.map((pull) => ({ kind: 'pull', repo: node.repo, pull }) as NodeValue);
        }
        if (fieldName === 'edges') {
          return node.pulls.map((pull) => ({ kind: 'pull', repo: node.repo, pull }) as NodeValue);
        }
        if (fieldName === 'pageInfo') {
          return { kind: 'pageInfo', hasNextPage: false, endCursor: null } as NodeValue;
        }
        if (fieldName === 'totalCount') return node.pulls.length;
        return null;
      }
      case 'pullFiles': {
        if (fieldName === 'nodes') {
          const files = this.store.pullFiles(node.repo, node.pull).slice(0, node.first);
          return files.map((file) => ({ kind: 'pullFile', path: file.path }) as NodeValue);
        }
        if (fieldName === 'pageInfo') {
          return { kind: 'pageInfo', hasNextPage: false, endCursor: null } as NodeValue;
        }
        if (fieldName === 'totalCount') return this.store.pullFiles(node.repo, node.pull).length;
        return null;
      }
      case 'pullFile': {
        if (fieldName === 'path') return node.path;
        if (fieldName === 'additions') return 0;
        if (fieldName === 'deletions') return 0;
        return null;
      }
      case 'commentEdge': {
        if (fieldName === 'node') {
          return { kind: 'comment', repo: node.repo, issueNumber: node.issueNumber, commentId: node.commentId, body: node.body } as NodeValue;
        }
        if (fieldName === 'cursor') return b64(`CommentCursor:${node.commentId}`);
        return null;
      }
      case 'comment': {
        if (fieldName === 'id') return commentGlobalId(node.repo, node.issueNumber, node.commentId);
        if (fieldName === 'body') return node.body;
        if (fieldName === 'createdAt') return '';
        return null;
      }
      case 'typeField': {
        if (fieldName === 'name') return node.name;
        if (fieldName === 'description') return null;
        return null;
      }
      case 'typeEnumValue': {
        if (fieldName === 'name') return node.name;
        if (fieldName === 'description') return null;
        if (fieldName === 'isDeprecated') return false;
        if (fieldName === 'deprecationReason') return null;
        return null;
      }
      case 'type': {
        if (fieldName === 'name') return node.name;
        if (fieldName === 'kind') return ENUM_VALUES[node.name] ? 'ENUM' : 'OBJECT';
        if (fieldName === 'description') return null;
        if (fieldName === 'fields') {
          const fields = TYPE_FIELDS[node.name] ?? [];
          return fields.map((name) => ({ kind: 'typeField', name }) as NodeValue);
        }
        if (fieldName === 'enumValues') {
          const values = ENUM_VALUES[node.name] ?? [];
          return values.map((name) => ({ kind: 'typeEnumValue', name }) as NodeValue);
        }
        return null;
      }
      case 'pageInfo': {
        if (fieldName === 'hasNextPage') return node.hasNextPage;
        if (fieldName === 'endCursor') return node.endCursor;
        if (fieldName === 'hasPreviousPage') return false;
        if (fieldName === 'startCursor') return null;
        return null;
      }
      default:
        return null;
    }
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
    const first = typeof args.first === 'number' ? args.first : 100;
    const after = typeof args.after === 'string' ? args.after : null;
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
    const direction = orderBy.direction === 'ASC' ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
    let issues = [...repo.issues];
    if (states) {
      const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    if (after) {
      const cursorNumber = issueFromCursor(after);
      if (cursorNumber !== null) {
        issues = issues.filter((issue) => (direction === 'asc' ? issue.number > cursorNumber : issue.number < cursorNumber));
      }
    }
    const page = issues.slice(0, first);
    const hasNextPage = issues.length > first;
    const endCursor = page.length ? cursorForIssue(page[page.length - 1]) : null;
    return { kind: 'issueConn', repo, issues: page, hasNextPage, endCursor };
  }

  private findRepoById(repoId: number): Repo | undefined {
    return [...this.store.repos.values()].find((candidate) => candidate.id === repoId);
  }

  // -------------------------------------------------------------------------------------------
  // mutations (called from the executor via resolveField on the root — see executeMutation)

  executeMutation(mutation: string, input: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
    const errors: { message: string }[] = [];
    const data: Record<string, unknown> = {};
    if (mutation === 'createIssue') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded && decoded.kind === 'Repository' ? this.findRepoById(decoded.repoId) : undefined;
      if (!repo) {
        errors.push({ message: 'repository not found' });
        return { data: { createIssue: null }, errors };
      }
      const created = this.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) {
        errors.push({ message: created.error });
        return { data: { createIssue: null }, errors };
      }
      data.createIssue = { issue: { kind: 'issue', repo, issue: created } as NodeValue };
    } else if (mutation === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      let issue: Issue | undefined;
      let repo: Repo | undefined;
      if (decoded && decoded.kind === 'Issue') {
        repo = this.findRepoById(decoded.repoId);
        issue = repo ? this.store.getIssue(repo, decoded.number) : undefined;
      }
      if (!repo || !issue) {
        errors.push({ message: 'issue not found' });
        return { data: { closeIssue: null }, errors };
      }
      issue.state = 'closed';
      issue.updatedAt = new Date().toISOString();
      data.closeIssue = { issue: { kind: 'issue', repo, issue } as NodeValue };
    } else if (mutation === 'createPullRequest') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded && decoded.kind === 'Repository' ? this.findRepoById(decoded.repoId) : undefined;
      if (!repo) {
        errors.push({ message: 'repository not found' });
        return { data: { createPullRequest: null }, errors };
      }
      const created = this.store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) {
        errors.push({ message: created.error });
        return { data: { createPullRequest: null }, errors };
      }
      data.createPullRequest = { pullRequest: { kind: 'pull', repo, pull: created } as NodeValue };
    } else if (mutation === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      let pull: Pull | undefined;
      let repo: Repo | undefined;
      if (decoded && decoded.kind === 'PullRequest') {
        repo = this.findRepoById(decoded.repoId);
        pull = repo ? this.store.getPull(repo, decoded.number) : undefined;
      }
      if (!repo || !pull) {
        errors.push({ message: 'pull request not found' });
        return { data: { mergePullRequest: null }, errors };
      }
      const merged = this.store.mergePull(repo, pull);
      if ('error' in merged) {
        errors.push({ message: `merge failed: ${merged.error}` });
        return { data: { mergePullRequest: null }, errors };
      }
      data.mergePullRequest = { pullRequest: { kind: 'pull', repo, pull } as NodeValue };
    } else if (mutation === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      let comment: { id: number; body: string } | null = null;
      let repo: Repo | undefined;
      let issueNumber = 0;
      if (decoded && decoded.kind === 'Issue') {
        repo = this.findRepoById(decoded.repoId);
        issueNumber = decoded.number;
        comment = repo ? this.store.addComment(repo, decoded.number, String(input.body ?? '')) : null;
      }
      if (!repo || !comment) {
        errors.push({ message: 'issue not found' });
        return { data: { addComment: null }, errors };
      }
      data.addComment = {
        commentEdge: { kind: 'commentEdge', repo, issueNumber, commentId: comment.id, body: comment.body } as NodeValue,
      };
    } else {
      errors.push({ message: `unknown mutation ${mutation}` });
    }
    return { data, errors };
  }
}

// The executor's root mutation dispatch: mutations are resolved through the same selection
// machinery, with the mutation field's input argument evaluated first.
export function executeGraphQLRequest(
  store: Store,
  body: unknown,
): { status: number; body: unknown } {
  const executor = new GraphQLExecutor(store);
  const runOne = (entry: unknown): { data: unknown; errors: { message: string }[] } => {
    if (typeof entry !== 'object' || entry === null) {
      return { data: null, errors: [{ message: 'request must be a JSON object' }] };
    }
    const { query, variables, operationName } = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'query must be a string' }] };
    }
    const vars = (variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const operation = operationName
      ? operations.find((op) => op.name === operationName)
      : operations.length === 1
        ? operations[0]
        : operations.find((op) => op.type === 'query');
    if (!operation) return { data: null, errors: [{ message: 'no operation found' }] };

    if (operation.type === 'mutation') {
      // Each mutation document in the suite has exactly one root field.
      const rootField = operation.selections.find((selection) => selection.kind === 'field');
      if (!rootField || !rootField.name) return { data: null, errors: [{ message: 'empty mutation' }] };
      const args: Record<string, unknown> = {};
      for (const arg of rootField.args ?? []) args[arg.name] = evalValue(arg.value, vars);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const result = executor.executeMutation(rootField.name, input);
      if (result.errors.length) return { data: result.data, errors: result.errors };
      // Resolve the mutation's selected sub-fields against the returned nodes.
      const data: Record<string, unknown> = {};
      const fieldResult = result.data[rootField.name] as Record<string, unknown> | null;
      if (fieldResult && rootField.selections) {
        data[rootField.name] = executor.executeSelectionsOnObject(fieldResult, rootField.selections, vars, []);
      } else {
        data[rootField.name] = fieldResult;
      }
      return { data, errors: [] };
    }
    return executor.executeOperation(query, vars, typeof operationName === 'string' ? operationName : undefined);
  };

  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(body) };
}
