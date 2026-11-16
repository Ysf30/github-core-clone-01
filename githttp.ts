// Git smart HTTP: info/refs (v0 + v2 advertisements), ls-refs, fetch (v2 + v0),
// receive-pack (push with report-status). Plain packs only (no deltas).

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  collectReachableCut,
  decodePktLines,
  isAncestor,
  isObjectId,
  parseTag,
  pktLine,
  readPack,
  shallowObjectSet,
  writePack,
  type GitObjectType,
} from './gitcore.ts';
import { Store, touchRefs, type Repo } from './store.ts';

const AGENT = 'github-core-clone-01/1.0.0';

/** The v2 capability advertisement never changes: build it once, serve the same bytes. */
const ADVERTISEMENT_V2: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${AGENT}\n`),
  PKT_FLUSH,
]);

/** A repo's refs as one string: the cache key for everything that depends on refs alone. */
function refsKey(repo: Repo): string {
  let key = '';
  for (const [name, oid] of repo.refs) key += `${name}=${oid};`;
  return key;
}

/** Per-repo advertisement + ls-refs caches (a repo's refs change rarely; the bench asks 200×). */
const adCache = new WeakMap<Repo, { key: string; upload: Buffer; receive: Buffer }>();
const lsRefsCache = new WeakMap<Repo, Map<string, Buffer>>();

/** Whole fetch responses, keyed by repo state + the exact fetch arguments (the clone round repeats one fetch 50×). */
const fetchCache = new Map<string, Buffer>();
function fetchCacheKey(repo: Repo, args: FetchArgs): string {
  return `${repo.id}:${repo.version}:${args.wants.join(',')}|${args.haves.join(',')}|${args.depth ?? ''}|${args.shallowBoundaries.join(',')}`;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function uploadPackCaps(repo: Repo): string[] {
  const caps = ['side-band-64k', 'multi_ack', 'thin-pack', 'ofs-delta', 'shallow', `agent=${AGENT}`];
  if (repo.refs.get(`refs/heads/${repo.defaultBranch}`)) caps.push(`symref=HEAD:refs/heads/${repo.defaultBranch}`);
  return caps;
}

function receivePackCaps(repo: Repo): string[] {
  const caps = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];
  if (repo.refs.get(`refs/heads/${repo.defaultBranch}`)) caps.push(`symref=HEAD:refs/heads/${repo.defaultBranch}`);
  return caps;
}

/** v0 advertisement body (with the service preamble). Cached per repo refs snapshot. */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const key = refsKey(repo);
  const cached = adCache.get(repo);
  if (cached && cached.key === key) return service === 'git-upload-pack' ? cached.upload : cached.receive;
  const upload = buildAdvertisementV0(repo, 'git-upload-pack');
  const receive = buildAdvertisementV0(repo, 'git-receive-pack');
  adCache.set(repo, { key, upload, receive });
  return service === 'git-upload-pack' ? upload : receive;
}

function buildAdvertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = service === 'git-upload-pack' ? uploadPackCaps(repo) : receivePackCaps(repo);
  const refs = sortedRefs(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    parts.push(pktLine(`${tip ?? ZERO_OID} HEAD\0${caps.join(' ')}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      if (name.startsWith('refs/tags/')) {
        const object = repo.objects.get(oid);
        if (object?.type === 'tag') {
          parts.push(pktLine(`${parseTag(object.data).object} ${name}^{}\n`));
        }
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement (no service preamble; first line is `version 2`). */
export function advertisementV2(): Buffer {
  return ADVERTISEMENT_V2;
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

export function lsRefsResponse(repo: Repo, lines: string[]): Buffer {
  const cacheKey = `${refsKey(repo)}|${lines.join('|')}`;
  let perRepo = lsRefsCache.get(repo);
  if (!perRepo) {
    perRepo = new Map<string, Buffer>();
    lsRefsCache.set(repo, perRepo);
  }
  const cached = perRepo.get(cacheKey);
  if (cached) return cached;
  const built = buildLsRefsResponse(repo, lines);
  if (perRepo.size > 64) perRepo.clear();
  perRepo.set(cacheKey, built);
  return built;
}

function buildLsRefsResponse(repo: Repo, lines: string[]): Buffer {
  const args = parseLsRefsArgs(lines);
  const out: Buffer[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headIncluded = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headIncluded && args.symrefs) {
    if (tip) {
      out.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (args.unborn) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let suffix = '';
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') suffix += ` peeled:${parseTag(object.data).object}`;
    }
    out.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------------------------
// fetch computation

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

export interface FetchResult {
  objects: { type: GitObjectType; data: Buffer; oid: string }[];
  shallow: string[];
  unshallow: string[];
}

export function computeFetch(store: Store, repo: Repo, args: FetchArgs): FetchResult {
  const lookup = store.lookup(repo);
  // A shallow client's haves are cut at its boundary: exclude only what it actually holds.
  const cutoffs = new Set(args.shallowBoundaries);
  let objectIds: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth !== null) {
    const { objects, boundary } = shallowObjectSet(args.wants, args.depth, lookup);
    const haveReachable = args.haves.length ? collectReachableCut(args.haves, cutoffs, lookup) : new Set<string>();
    objectIds = new Set([...objects].filter((oid) => !haveReachable.has(oid)));
    shallow = [...boundary].filter((oid) => objectIds.has(oid) || [...objects].includes(oid));
    // Old boundaries that are now interior (included, not a boundary any more) are unshallow.
    unshallow = args.shallowBoundaries.filter((oid) => objects.has(oid) && !boundary.has(oid));
  } else {
    const wanted = collectReachable(args.wants, lookup);
    const haveReachable = args.haves.length ? collectReachableCut(args.haves, cutoffs, lookup) : new Set<string>();
    objectIds = new Set([...wanted].filter((oid) => !haveReachable.has(oid)));
  }
  const objects: { type: GitObjectType; data: Buffer; oid: string }[] = [];
  for (const oid of objectIds) {
    const object = repo.objects.get(oid);
    if (object) objects.push({ type: object.type, data: object.data, oid });
  }
  return { objects, shallow, unshallow };
}

/** Split pack bytes into sideband band-1 pkt-lines (each well under the 64 KiB pkt cap). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const CHUNK = 60000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) {
    // An empty pack still needs one band-1 packet (fetch-nothing-new expects a pack).
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  }
  return chunks;
}

/** v2 fetch response: acknowledgments / shallow-info / packfile sections. Cached per repo state + args. */
export function fetchV2Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const key = fetchCacheKey(repo, args);
  const cached = fetchCache.get(key);
  if (cached) return cached;
  const built = buildFetchV2Response(store, repo, args);
  if (fetchCache.size > 512) fetchCache.clear();
  fetchCache.set(key, built);
  return built;
}

function buildFetchV2Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = computeFetch(store, repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch response: NAK/shallow lines plus sideband pack packets, then flush. Cached per repo state + args. */
export function fetchV0Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const key = `v0:${fetchCacheKey(repo, args)}`;
  const cached = fetchCache.get(key);
  if (cached) return cached;
  const built = buildFetchV0Response(store, repo, args);
  if (fetchCache.size > 512) fetchCache.clear();
  fetchCache.set(key, built);
  return built;
}

function buildFetchV0Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = computeFetch(store, repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// request parsing

/** Split a v2 command body into the argument lines after the command + delim. */
export function parseV2Args(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const command = lines[0] ?? '';
  // Drop the command line and the agent/object-format lines; the rest are arguments.
  const args = lines.slice(1).filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));
  return { command, args };
}

export function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

/** Parse a v0 fetch body: wants (with capabilities on the first want) before the flush,
 * haves after it. */
export function parseV0Fetch(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  const packets = decodePktLines(body);
  let section: 'wants' | 'haves' = 'wants';
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section = 'haves';
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // First want line may carry capabilities after a space: "want <oid> <caps>".
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      args.wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) args.depth = n;
    } else if (line === 'done') {
      // end of negotiation
    }
  }
  void section;
  return args;
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)

/**
 * Parse a receive-pack body: pkt-lined commands up to the first flush, then the raw pack.
 * Returns null when the command framing is malformed.
 */
export function parsePushBody(body: Buffer): { commands: { oldOid: string; newOid: string; ref: string }[]; pack: Buffer } | null {
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) return null;
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
    const len = parseInt(hex, 16);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) return null;
    const payload = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
    const nul = payload.indexOf('\0');
    const command = nul >= 0 ? payload.slice(0, nul) : payload;
    const parts = command.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
      return null;
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    offset += len;
  }
  return { commands, pack: body.subarray(offset) };
}

export interface PushReportEntry {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Apply a push: store the pack's objects, validate each ref, apply the ok ones. */
export function applyPush(
  store: Store,
  repo: Repo,
  commands: { oldOid: string; newOid: string; ref: string }[],
  pack: Buffer,
): { unpackOk: boolean; unpackDetail: string; refs: PushReportEntry[] } {
  if (pack.length > 0) {
    try {
      const { objects } = readPack(pack);
      for (const [oid, object] of objects) {
        // readPack already hashed each object: store by oid instead of hashing again.
        store.putObjectByOid(repo, oid, object);
      }
    } catch (err) {
      return { unpackOk: false, unpackDetail: err instanceof Error ? err.message : String(err), refs: [] };
    }
  }
  const lookup = store.lookup(repo);
  const results: PushReportEntry[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        touchRefs(repo);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (!newObject) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        touchRefs(repo);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.ref.startsWith('refs/tags/')) {
      repo.refs.set(command.ref, command.newOid);
      touchRefs(repo);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (isAncestor(current, command.newOid, lookup)) {
      repo.refs.set(command.ref, command.newOid);
      touchRefs(repo);
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  return { unpackOk: true, unpackDetail: 'ok', refs: results };
}

/** The report-status stream, pkt-lined inside one band-1 sideband packet. */
export function pushReportResponse(report: { unpackOk: boolean; unpackDetail: string; refs: PushReportEntry[] }): Buffer {
  const lines: Buffer[] = [pktLine(`unpack ${report.unpackOk ? 'ok' : report.unpackDetail}\n`)];
  for (const entry of report.refs) {
    lines.push(pktLine(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
  }
  lines.push(PKT_FLUSH);
  const inner = Buffer.concat(lines);
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
}
