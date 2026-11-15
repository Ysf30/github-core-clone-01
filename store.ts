// In-memory store: repositories, git objects, issues, pull requests, labels, comments.
// One store per process; the suite drives a fresh process, so nothing persists to disk.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './gitcore.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  commitSeq: Map<string, number>;
  issues: Issue[];
  nextIssueNumber: number;
  pulls: Pull[];
  nextPullNumber: number;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  oldOid: string | null;
  newOid: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Multiset line diff: lines gained and lines lost between two texts. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) {
      if (line === '' && text.endsWith('\n')) continue;
      map.set(line, (map.get(line) ?? 0) + 1);
    }
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) {
    const oldCount = oldLines.get(line) ?? 0;
    if (count > oldCount) additions += count - oldCount;
  }
  for (const [line, count] of oldLines) {
    const newCount = newLines.get(line) ?? 0;
    if (count > newCount) deletions += count - newCount;
  }
  return { additions, deletions };
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private seq = 1;
  private createdCounter = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.createdCounter,
      createdAt: nowIso(),
      refs: new Map(),
      objects: new Map(),
      commitSeq: new Map(),
      issues: [],
      nextIssueNumber: 1,
      pulls: [],
      nextPullNumber: 1,
      labels: new Map(),
      comments: new Map(),
    };
    this.nextRepoId += 1;
    this.createdCounter += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') repo.commitSeq.set(oid, this.seq);
      this.seq += 1;
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** The tree oid of a branch tip, or null when the branch is unborn. */
  treeOfRef(repo: Repo, ref: string): string | null {
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  }

  /** Flat path -> blob oid map for a tree (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, path: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, childPath);
        else out.set(childPath, entry.oid);
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) a tree from a flat path -> blob oid map. */
  buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], make());
        node = node.dirs.get(segments[i])!;
      }
      node.files.set(segments[segments.length - 1], oid);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object and store it. Returns its oid. */
  makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string, timestamp?: number): string {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const data = buildCommit({
      tree,
      parents,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: ts,
      message,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Commits reachable from a tip oid, newest first (by creation sequence). */
  listCommits(repo: Repo, tip: string): { sha: string; message: string }[] {
    const seen = collectReachable([tip], this.lookup(repo));
    const commits: { sha: string; message: string; seq: number }[] = [];
    for (const oid of seen) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') {
        const parsed = parseCommit(object.data);
        commits.push({ sha: oid, message: parsed.message.replace(/\n+$/, ''), seq: repo.commitSeq.get(oid) ?? 0 });
      }
    }
    commits.sort((a, b) => b.seq - a.seq);
    return commits.map(({ sha, message }) => ({ sha, message }));
  }

  /** Resolve a ref name or commit oid to a tip oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    if (repo.refs.has(full)) return repo.refs.get(full)!;
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // contents

  /**
   * Write one file on a branch (creating the branch if needed). Returns the new commit sha and
   * the blob sha. `expectedSha` (when given) must match the file's current blob sha, else 409.
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string; created: boolean } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const currentTree = tip ? this.treeOfRef(repo, ref) : null;
    const files = currentTree ? this.flattenTree(repo, currentTree) : new Map<string, string>();
    const existing = files.get(path);
    const created = existing === undefined;
    const blobOid = this.putObject(repo, 'blob', content);
    files.set(path, blobOid);
    const tree = this.buildTreeFromFiles(repo, files);
    const parents = tip ? [tip] : [];
    const commitSha = this.makeCommit(repo, tree, parents, message);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: blobOid, created };
  }

  readPath(
    repo: Repo,
    ref: string,
    path: string,
  ):
    | { kind: 'file'; oid: string; size: number; data: Buffer }
    | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] }
    | null {
    const treeOid = this.treeOfRef(repo, ref);
    if (treeOid === null) return null;
    if (path === '') {
      const object = repo.objects.get(treeOid);
      if (!object) return null;
      const entries = parseTree(object.data).map((entry) => ({
        type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
      }));
      return { kind: 'dir', entries };
    }
    const segments = path.split('/');
    let currentTree = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(currentTree);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const dirObject = repo.objects.get(entry.oid);
          if (!dirObject) return null;
          const entries = parseTree(dirObject.data).map((child) => ({
            type: child.mode === '40000' ? ('dir' as const) : ('file' as const),
            name: child.name,
            path: `${path}/${child.name}`,
            sha: child.oid,
          }));
          return { kind: 'dir', entries };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, size: blob.data.length, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      currentTree = entry.oid;
    }
    return null;
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const treeOid = this.treeOfRef(repo, ref);
    if (treeOid === null) return null;
    const files = this.flattenTree(repo, treeOid);
    if (!files.has(path)) return null;
    files.delete(path);
    const tree = this.buildTreeFromFiles(repo, files);
    const commitSha = this.makeCommit(repo, tree, [tip], message);
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  // -------------------------------------------------------------------------------------------
  // issues, labels, comments

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `label ${label} does not exist` };
    }
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.seq,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.nextIssueId += 1;
    this.seq += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, state: string | undefined, direction: 'asc' | 'desc'): Issue[] {
    let list = [...repo.issues];
    if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const comment: Comment = { id: this.nextCommentId, body, createdAt: nowIso() };
    this.nextCommentId += 1;
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    return repo.comments.get(issueNumber) ?? [];
  }

  // -------------------------------------------------------------------------------------------
  // pull requests

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headTip) return { error: `head branch ${headRef} does not exist` };
    if (!baseTip) return { error: `base branch ${baseRef} does not exist` };
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.seq,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.nextPullId += 1;
    this.seq += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: string | undefined): Pull[] {
    let list = [...repo.pulls];
    if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return list;
  }

  /** Files changed between the merge-base tree and the head tree. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return [];
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const baseTree = base ? this.treeOfRefAt(repo, base) : new Map<string, string>();
    const headTree = this.treeOfRefAt(repo, headTip);
    return diffFileMaps(repo, baseTree, headTree);
  }

  private treeOfRefAt(repo: Repo, commitOid: string): Map<string, string> {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(commit.data).tree);
  }

  /** Is this pull mergeable right now (no conflicting file changes)? */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.merged || pull.state !== 'open') return false;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return false;
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    if (base === null) return false;
    const baseFiles = this.treeOfRefAt(repo, base);
    const headFiles = this.treeOfRefAt(repo, headTip);
    const baseTipFiles = this.treeOfRefAt(repo, baseTip);
    for (const [path, headOid] of headFiles) {
      const baseOid = baseFiles.get(path);
      const tipOid = baseTipFiles.get(path);
      if (baseOid !== headOid && baseOid !== tipOid && headOid !== tipOid) return false;
    }
    for (const [path, baseOid] of baseFiles) {
      if (!headFiles.has(path) && baseTipFiles.get(path) !== baseOid) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha,
   * or an error string ('not-found' | 'already-merged' | 'conflict').
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string } {
    if (pull.merged || pull.state !== 'open') return { error: 'already-merged' };
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return { error: 'not-found' };
    if (!this.pullMergeable(repo, pull)) return { error: 'conflict' };
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const baseFiles = base ? this.treeOfRefAt(repo, base) : new Map<string, string>();
    const headFiles = this.treeOfRefAt(repo, headTip);
    const baseTipFiles = this.treeOfRefAt(repo, baseTip);
    // Apply head's changes (vs merge-base) onto the base tip's files.
    const merged = new Map(baseTipFiles);
    for (const [path, headOid] of headFiles) {
      if (baseFiles.get(path) !== headOid) merged.set(path, headOid);
    }
    for (const path of baseFiles.keys()) {
      if (!headFiles.has(path)) merged.delete(path);
    }
    const tree = this.buildTreeFromFiles(repo, merged);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const mergeSha = this.makeCommit(repo, tree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = nowIso();
    return { sha: mergeSha };
  }
}

/** Diff two flat file maps (path -> blob oid) into per-file changes with line counts. */
export function diffFileMaps(repo: Repo, oldFiles: Map<string, string>, newFiles: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const readText = (oid: string | null): string => {
    if (oid === null) return '';
    const object = repo.objects.get(oid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : '';
  };
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = oldFiles.get(path) ?? null;
    const newOid = newFiles.get(path) ?? null;
    if (oldOid === newOid) continue;
    if (oldOid === null && newOid !== null) {
      changes.push({ path, status: 'added', additions: lineCount(readText(newOid)), deletions: 0, oldOid, newOid });
    } else if (newOid === null && oldOid !== null) {
      changes.push({ path, status: 'removed', additions: 0, deletions: lineCount(readText(oldOid)), oldOid, newOid });
    } else {
      const { additions, deletions } = lineDiff(readText(oldOid), readText(newOid));
      changes.push({ path, status: 'modified', additions, deletions, oldOid, newOid });
    }
  }
  return changes;
}
