// gitpack.ts — the git primitives: object hashing, pkt-line framing, packfiles,
// tree/commit/tag parsing and building, reachability. Stdlib only (node:crypto, node:zlib).
// Every object is stored by its SHA-1, exactly as git computes it, so a clone round-trips
// byte-for-byte. No clock, no randomness: anything this module builds is deterministic.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 of `<type> <size>\0<data>`, exactly as git hashes an object. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function makeObject(type: GitObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const size = body.length + 4;
  const header = Buffer.alloc(4);
  header.write(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('pkt-line: truncated length prefix');
    const hex = bytes.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (hex === '0002') {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    const size = parseInt(hex, 16);
    if (!Number.isFinite(size) || size < 4 || offset + size > bytes.length) {
      throw new Error(`pkt-line: bad length ${JSON.stringify(hex)}`);
    }
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return packets;
}

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if ending in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** The fixed identity every server-built commit and tag carries, so bytes are reproducible. */
export const SERVER_IDENTITY = 'adaiversen <adaiversen@example.invalid>';
export const SERVER_TIMESTAMP = 1700000000;

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
}): Buffer {
  const who = `${fields.author ?? SERVER_IDENTITY} ${SERVER_TIMESTAMP} +0000`;
  const committer = `${fields.committer ?? SERVER_IDENTITY} ${SERVER_TIMESTAMP} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// packfiles (plain objects only, no deltas — the suite's client sends plain packs too)
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a v2 packfile from plain objects. Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Read a packfile's entries (plain objects only). Throws on a bad checksum or a delta. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset >= pack.length - 20) throw new Error('pack ends before its declared object count');
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
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not supported');
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
    const inflated = inflateSync(pack.subarray(offset));
    if (inflated.length !== size) throw new Error('pack entry size mismatch after inflate');
    // Advance past the zlib stream: re-deflate is not needed — find the stream end by trying
    // increasing lengths is wasteful; instead use the deflate stream's own length via a second
    // inflate with a bounded window is unavailable, so recompute: the zlib stream ends where the
    // next object (or the trailer) begins. We locate it by inflating incrementally.
    offset = skipZlib(pack, offset);
    const { oid, object } = makeObject(type, inflated);
    objects.set(oid, object);
  }
  return objects;
}

/** The offset just past the zlib stream starting at `start` (deflate streams are self-terminating). */
function skipZlib(buffer: Buffer, start: number): number {
  // Binary-search the smallest end that inflates cleanly: the stream is short (objects are small),
  // and inflateSync throws on a truncated stream, so a linear scan from the end of the plausible
  // range is avoided by growing the window exponentially then bisecting.
  let low = start + 1;
  let high = start + 1;
  const limit = buffer.length - 20;
  while (high <= limit) {
    try {
      inflateSync(buffer.subarray(start, high));
      break;
    } catch {
      high = Math.min(limit, high * 2);
      if (high === limit) {
        try {
          inflateSync(buffer.subarray(start, high));
          break;
        } catch {
          throw new Error('pack entry has a corrupt zlib stream');
        }
      }
    }
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buffer.subarray(start, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

/** Verify a pack's trailer checksum without parsing entries. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}
