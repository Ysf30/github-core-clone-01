// git-core: pkt-lines, object hashing, pack read/write, tree/commit parsing,
// reachability and shallow-boundary computation. Stdlib only (node:crypto, node:zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

/** SHA-1 id of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

// ---------------------------------------------------------------------------------------------
// pkt-lines

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer; // data payload only (without the 4-byte length)
  raw: Buffer; // the whole pkt-line including the length prefix
}

/** Encode one data pkt-line. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed line. */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buffer.length) throw new Error('bad pkt-line length');
    out.push({
      kind: 'data',
      payload: buffer.subarray(offset + 4, offset + len),
      raw: buffer.subarray(offset, offset + len),
    });
    offset += len;
  }
  return out;
}

/** Split a buffer into data-line strings (payloads without trailing \n), ignoring flush/delim. */
export function pktStrings(buffer: Buffer): string[] {
  const out: string[] = [];
  for (const pkt of decodePktLines(buffer)) {
    if (pkt.kind !== 'data') continue;
    out.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// object construction

export function buildCommit(opts: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author} ${opts.timestamp} +0000`);
  lines.push(`committer ${opts.committer} ${opts.timestamp} +0000`);
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function buildTag(opts: { object: string; type: string; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.from(
    `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\ntagger ${opts.tagger} ${opts.timestamp} +0000\n\n${message}`,
    'utf8',
  );
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git tree sort: entries by name, directories compared as if the name ended with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles (plain, no deltas — the client accepts deltaCount 0)

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePackEntry(type: GitObjectType, data: Buffer): Buffer {
  const code = TYPE_CODES[type];
  const size = data.length;
  const headerBytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let remaining = size >> 4;
  if (remaining > 0) first |= 0x80;
  headerBytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    headerBytes.push(byte);
  }
  const compressed = deflateSync(data, { level: 1 });
  return Buffer.concat([Buffer.from(headerBytes), compressed]);
}

/**
 * Cache of deflated pack entries by object id. Object ids are content hashes, so an entry
 * never changes for its id; the 50 concurrent shallow clones of one tip reuse the same
 * three entries instead of re-deflating them. Bounded with a plain clear.
 */
const packEntryCache = new Map<string, Buffer>();

function cachedPackEntry(type: GitObjectType, data: Buffer, oid: string): Buffer {
  const cached = packEntryCache.get(oid);
  if (cached) return cached;
  const entry = writePackEntry(type, data);
  if (packEntryCache.size > 20000) packEntryCache.clear();
  packEntryCache.set(oid, entry);
  return entry;
}

export function writePack(objects: readonly { type: GitObjectType; data: Buffer; oid?: string }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const oid = object.oid ?? hashObject(object.type, object.data);
    parts.push(cachedPackEntry(object.type, object.data, oid));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the zlib stream starting at `offset` and return its data plus the number of
 * compressed bytes it consumed. Node's inflateSync ignores trailing garbage, so the stream
 * end is found from the inflate engine itself: with `{ info: true }` the engine reports
 * `bytesWritten`, the exact number of input bytes the stream consumed (verified equal to a
 * re-deflate of the inflated data on this suite's packs). A re-deflate check guards the
 * fast path when the engine does not report a usable length (older Node); anything else
 * falls back to a binary search over the stream end (truncated streams throw).
 */
function inflateAt(pack: Buffer, offset: number, expectedSize?: number): { data: Buffer; consumed: number } {
  const input = pack.subarray(offset);
  const result = inflateSync(input, { info: true }) as unknown as {
    buffer: Buffer;
    engine?: { bytesWritten?: unknown };
  };
  const data = result.buffer;
  if (expectedSize !== undefined && data.length !== expectedSize) {
    throw new Error(`inflated size ${data.length}, expected ${expectedSize}`);
  }
  const written = result.engine?.bytesWritten;
  if (typeof written === 'number' && Number.isInteger(written) && written > 0 && written <= input.length) {
    return { data, consumed: written };
  }
  const recompressed = deflateSync(data);
  if (recompressed.length <= input.length && input.subarray(0, recompressed.length).equals(recompressed)) {
    return { data, consumed: recompressed.length };
  }
  let lo = 1;
  let hi = input.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const trial = inflateSync(input.subarray(0, mid));
      if (expectedSize !== undefined && trial.length !== expectedSize) throw new Error('short');
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, consumed: lo };
}

export interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/** Parse a pack, resolving ofs-delta / ref-delta entries against bases in the same pack. */
export function readPack(pack: Buffer): { objects: Map<string, GitObject>; entries: PackEntry[]; deltaCount: number } {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer checksum.
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let deltaCount = 0;
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: GitObjectType;
    let data: Buffer;
    if (typeCode === 6) {
      // ofs-delta
      deltaCount += 1;
      let baseOffsetByte = pack[offset];
      offset += 1;
      let baseOffset = baseOffsetByte & 0x7f;
      while (baseOffsetByte & 0x80) {
        baseOffsetByte = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (baseOffsetByte & 0x7f);
      }
      const baseEntryOffset = entryOffset - baseOffset;
      const base = byOffset.get(baseEntryOffset);
      if (!base) throw new Error('ofs-delta base not in pack');
      const { data: delta, consumed } = inflateAt(pack, offset);
      data = applyDelta(base.data, delta);
      type = base.type;
      offset += consumed;
    } else if (typeCode === 7) {
      // ref-delta
      deltaCount += 1;
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.get(baseOid);
      if (!base) throw new Error('ref-delta base not in pack');
      const { data: delta, consumed } = inflateAt(pack, offset);
      data = applyDelta(base.data, delta);
      type = base.type;
      offset += consumed;
    } else {
      type = PACK_TYPES[typeCode] as GitObjectType;
      if (!type) throw new Error(`unknown pack type ${typeCode}`);
      const { data: inflated, consumed } = inflateAt(pack, offset, size);
      data = inflated;
      offset += consumed;
    }
    const oid = hashObject(type, data);
    const entry: PackEntry = { type, data, oid };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
    objects.set(oid, { type, data });
  }
  return { objects, entries, deltaCount };
}

/** Apply a git delta (source size varint, target size varint, then copy/insert ops). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

// ---------------------------------------------------------------------------------------------
// reachability and shallow fetches

/** All objects reachable from `tips` (commits, trees, blobs, tags), following parents and tags. */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    if (tip !== ZERO_OID) stack.push(tip);
  }
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      if (parsed.tree) stack.push(parsed.tree);
      for (const parent of parsed.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Reachability that stops following parents at `cutoffs` (a shallow client's boundary commits):
 * the cutoff commit itself and its tree are included, its parents are not. With no cutoffs this
 * is exactly collectReachable. */
export function collectReachableCut(
  tips: Iterable<string>,
  cutoffs: ReadonlySet<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    if (tip !== ZERO_OID) stack.push(tip);
  }
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      if (parsed.tree) stack.push(parsed.tree);
      if (!cutoffs.has(oid)) {
        for (const parent of parsed.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Walk commits from `tips` up to `depth` generations (depth 1 = tips only). Returns the
 * included commits and the shallow boundary: the included commits whose parents were cut off
 * (i.e. the commits at the deepest level that still have parents). */
export function collectShallowCommits(
  tips: readonly string[],
  depth: number,
  lookup: (oid: string) => GitObject | undefined,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  let frontier = [...tips];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        // Peel tags to their commit for depth purposes, but include the tag object itself.
        included.add(oid);
        const target = parseTag(object.data).object;
        const targetObject = lookup(target);
        if (targetObject && targetObject.type === 'commit') {
          const parents = parseCommit(targetObject.data).parents;
          included.add(target);
          if (level === depth - 1) {
            if (parents.length > 0) boundary.add(target);
          } else {
            next.push(...parents);
          }
        }
        continue;
      }
      if (object.type !== 'commit') {
        included.add(oid);
        continue;
      }
      included.add(oid);
      const parents = parseCommit(object.data).parents;
      if (level === depth - 1) {
        if (parents.length > 0) boundary.add(oid);
      } else {
        next.push(...parents);
      }
    }
    frontier = next;
  }
  return { included, boundary };
}

/** Objects of the shallow closure: the included commits plus their trees/blobs (+ tag objects). */
export function shallowObjectSet(
  tips: readonly string[],
  depth: number,
  lookup: (oid: string) => GitObject | undefined,
): { objects: Set<string>; boundary: Set<string> } {
  const { included, boundary } = collectShallowCommits(tips, depth, lookup);
  const objects = new Set<string>();
  for (const oid of included) {
    const object = lookup(oid);
    if (!object) continue;
    objects.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      for (const treeOid of collectReachable([parsed.tree], lookup)) objects.add(treeOid);
    } else if (object.type === 'tag') {
      // The tag's target commit is in `included` already when it is a commit at depth.
    }
  }
  return { objects, boundary };
}

/** True when `ancestor` is reachable from `tip` (or equals it). */
export function isAncestor(
  ancestor: string,
  tip: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === tip) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** Merge-base: the first common ancestor of two commits (by BFS from both sides). */
export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  const ancestorsOfA = new Set<string>();
  const stackA = [a];
  while (stackA.length) {
    const oid = stackA.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = lookup(oid);
    if (object && object.type === 'commit') stackA.push(...parseCommit(object.data).parents);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length) {
    const oid = stackB.pop()!;
    if (ancestorsOfA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (object && object.type === 'commit') stackB.push(...parseCommit(object.data).parents);
  }
  return null;
}
