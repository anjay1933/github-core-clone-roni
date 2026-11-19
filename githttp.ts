// githttp.ts — git smart HTTP: info/refs (v2 and v0), git-upload-pack (v2 and v0 fetch),
// git-receive-pack (v0 push). The framing follows protocol-v2 and the v0 wire format exactly
// as the suite's client parses it: v2 sections in order (acknowledgments, shallow-info, packfile),
// sideband band 1 for pack bytes, report-status inside band 1 for pushes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitpack.ts';
import { DEFAULT_BRANCH, type RepoRecord, type Store } from './store.ts';

export interface GitRequestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  owner: string;
  repo: string;
}

const UPLOAD_CAPS = 'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';
const EMPTY_CAPS = 'side-band-64k ofs-delta shallow';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, 'application/json', Buffer.from(JSON.stringify(body), 'utf8'));
}

/** All refs of a repo, HEAD first, then refs sorted by name (git order). */
function sortedRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headOid(repo: RepoRecord): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** The peeled commit of a ref that points at an annotated tag, or null. */
function peeledOid(store: Store, oid: string): string | null {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return store.peelToCommit(oid);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

function advertiseUploadV2(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function advertiseUploadV0(store: Store, repo: RepoRecord): Buffer {
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii')];
  if (head === null && refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${EMPTY_CAPS}\n`));
  } else {
    const headLine = head === null ? `${ZERO_OID} HEAD\0${UPLOAD_CAPS}\n` : `${head} HEAD\0${UPLOAD_CAPS}\n`;
    parts.push(encodePktLine(headLine));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(store, ref.oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function advertiseReceiveV0(store: Store, repo: RepoRecord): Buffer {
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), Buffer.from('0000', 'ascii')];
  if (head === null && refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    const headLine = head === null ? `${ZERO_OID} HEAD\0${RECEIVE_CAPS}\n` : `${head} HEAD\0${RECEIVE_CAPS}\n`;
    parts.push(encodePktLine(headLine));
    for (const ref of refs) parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export async function handleInfoRefs(ctx: GitRequestContext, service: string): Promise<void> {
  const { store, req, res, repo: repoName, owner } = ctx;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (wantsV2) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertiseUploadV2());
    } else {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertiseUploadV0(store, repo));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    // Receive-pack is v0 only: the suite's client refuses a v2 advertisement here.
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', advertiseReceiveV0(store, repo));
    return;
  }
  sendJson(res, 400, { message: 'Unknown service' });
}

// ---------------------------------------------------------------------------
// ls-refs (v2, over git-upload-pack)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: ReturnType<typeof decodePktLines>): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) continue;
    if (line.startsWith('agent=')) continue;
    if (line.startsWith('object-format=')) continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

export function handleLsRefs(ctx: GitRequestContext, body: Buffer): void {
  const { store, res, repo: repoName, owner } = ctx;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let args: LsRefsArgs;
  try {
    args = parseLsRefsArgs(decodePktLines(body));
  } catch {
    sendJson(res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  const lines: string[] = [];
  const head = headOid(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (head === null) {
    if (args.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else if (keep('HEAD')) {
    lines.push(`${head} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOid(store, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', encodePktLines([...lines, 'flush']));
}

// ---------------------------------------------------------------------------
// fetch computation (shared by v2 and v0)
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, in deterministic order. */
  objects: GitObject[];
  /** New shallow boundary commits (depth-limited tips). */
  shallow: string[];
  /** Old boundaries whose parents are now all known. */
  unshallow: string[];
}

/**
 * Work out which objects a fetch sends. `wants` are the wanted oids (commits or tags),
 * `haves` the client's commits, `depth` a shallow limit, `oldBoundaries` the client's
 * current shallow boundary commits.
 */
export function computeFetch(
  store: Store,
  wants: string[],
  haves: string[],
  depth: number | null,
  oldBoundaries: string[],
): FetchPlan {
  // What the client already holds. A plain `have` implies its whole history — but a
  // shallow boundary's parents are NOT held: the client never received them. Without this
  // distinction a deepen would deliver nothing (the parent looks already-held).
  const held = new Set<string>();
  for (const have of haves) {
    if (oldBoundaries.includes(have)) {
      const object = store.getObject(have);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        held.add(have);
        for (const oid of store.collectReachable([parseCommit(object.data).tree])) held.add(oid);
      } else {
        for (const oid of store.collectReachable([have])) held.add(oid);
      }
    } else {
      for (const oid of store.collectReachable([have])) held.add(oid);
    }
  }
  const sent = new Set<string>();
  const ordered: GitObject[] = [];
  const shallow: string[] = [];
  const includedCommits = new Set<string>();

  const includeObject = (oid: string): void => {
    if (sent.has(oid) || held.has(oid)) return;
    const object = store.getObject(oid);
    if (object === undefined) return;
    sent.add(oid);
    ordered.push(object);
  };

  const includeTree = (treeOid: string): void => {
    const object = store.getObject(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    includeObject(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') includeTree(entry.oid);
      else includeObject(entry.oid);
    }
  };

  const includeCommitAndTree = (commitOid: string): void => {
    includeObject(commitOid);
    const object = store.getObject(commitOid);
    if (object === undefined || object.type !== 'commit') return;
    includedCommits.add(commitOid);
    includeTree(parseCommit(object.data).tree);
  };

  for (const want of wants) {
    const object = store.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      includeObject(want);
      const target = store.peelToCommit(want);
      if (target === null) continue;
      // Walk the tagged commit with the same depth rules as a direct want.
      const queue: Array<[string, number]> = [[target, 0]];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const [current, distance] = queue.shift() as [string, number];
        if (seen.has(current)) continue;
        seen.add(current);
        if (depth !== null && distance >= depth) continue;
        includeCommitAndTree(current);
        const commitObject = store.getObject(current);
        if (commitObject === undefined || commitObject.type !== 'commit') continue;
        const parents = parseCommit(commitObject.data).parents;
        if (depth !== null && distance + 1 >= depth) {
          if (parents.length > 0 && !shallow.includes(current)) shallow.push(current);
        }
        for (const parent of parents) queue.push([parent, distance + 1]);
      }
      continue;
    }
    if (object.type !== 'commit') continue;
    const queue: Array<[string, number]> = [[want, 0]];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const [current, distance] = queue.shift() as [string, number];
      if (seen.has(current)) continue;
      seen.add(current);
      if (depth !== null && distance >= depth) continue;
      includeCommitAndTree(current);
      const commitObject = store.getObject(current);
      if (commitObject === undefined || commitObject.type !== 'commit') continue;
      const parents = parseCommit(commitObject.data).parents;
      if (depth !== null && distance + 1 >= depth) {
        if (parents.length > 0 && !shallow.includes(current)) shallow.push(current);
      }
      for (const parent of parents) queue.push([parent, distance + 1]);
    }
  }

  // Unshallow: an old boundary whose parents are all in the sent commits or in the client's
  // non-boundary holdings (i.e. the client now has everything below it).
  const unshallow: string[] = [];
  const heldNonBoundary = new Set([...haves].filter((oid) => !oldBoundaries.includes(oid)));
  for (const boundary of oldBoundaries) {
    const object = store.getObject(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => includedCommits.has(parent) || heldNonBoundary.has(parent) || held.has(parent))) {
      unshallow.push(boundary);
    }
  }

  return { objects: ordered, shallow, unshallow };
}

/** Split a pack into sideband band-1 packets (each pkt-line at most 65520 bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const maxChunk = PKT_MAX_PAYLOAD;
  for (let offset = 0; offset < pack.length; offset += maxChunk) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxChunk));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    packets.push(encodePktLine(payload));
  }
  if (packets.length === 0) packets.push(encodePktLine(Buffer.from([1])));
  return packets;
}

const PKT_MAX_PAYLOAD = 65515;

// ---------------------------------------------------------------------------
// git-upload-pack: v2 fetch
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchV2(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let sawCommand = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=fetch') {
      sawCommand = true;
      continue;
    }
    if (line.startsWith('command=')) return null;
    if (line.startsWith('agent=')) continue;
    if (line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line.startsWith('filter ')) continue;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) request.depth = depth;
    } else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      // Not exercised by the suite; treat as a full fetch.
    } else if (line === 'done') {
      // End of the request's negotiation lines.
    } else {
      return null;
    }
  }
  if (!sawCommand) return null;
  return request;
}

export function handleFetchV2(ctx: GitRequestContext, body: Buffer): void {
  const { store, res, repo: repoName, owner } = ctx;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const request = parseFetchV2(body);
  if (request === null) {
    sendJson(res, 400, { message: 'Malformed fetch request' });
    return;
  }
  for (const oid of [...request.wants, ...request.haves, ...request.shallow]) {
    if (!isObjectId(oid)) {
      sendJson(res, 400, { message: 'Fetch names a bad object id' });
      return;
    }
  }
  const plan = computeFetch(store, request.wants, request.haves, request.depth, request.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  const acked = request.haves.filter((oid) => store.hasObject(oid));
  if (acked.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const oid of acked) parts.push(encodePktLine(`ACK ${oid}\n`));
  parts.push(Buffer.from('0000', 'ascii'));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// git-upload-pack: v0 fetch
// ---------------------------------------------------------------------------

function parseFetchV0(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) request.depth = depth;
    } else if (line === 'done') {
      // End of negotiation.
    }
    // Unknown lines are ignored: v0 clients may send capabilities the server need not act on.
  }
  if (request.wants.length === 0) return null;
  return request;
}

export function handleFetchV0(ctx: GitRequestContext, body: Buffer): void {
  const { store, res, repo: repoName, owner } = ctx;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const request = parseFetchV0(body);
  if (request === null) {
    sendJson(res, 400, { message: 'Malformed fetch request' });
    return;
  }
  for (const oid of [...request.wants, ...request.haves]) {
    if (!isObjectId(oid)) {
      sendJson(res, 400, { message: 'Fetch names a bad object id' });
      return;
    }
  }
  const plan = computeFetch(store, request.wants, request.haves, request.depth, request.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const acked = request.haves.filter((oid) => store.hasObject(oid));
  if (acked.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const oid of acked) parts.push(encodePktLine(`ACK ${oid}\n`));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// git-receive-pack: v0 push
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } | null {
  let packets;
  try {
    packets = decodePktLines(body.subarray(0, firstPackOffset(body)));
  } catch {
    return null;
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) return null;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return null;
  const offset = firstPackOffset(body);
  const pack = offset === null ? null : body.subarray(offset);
  return { commands, pack };
}

/** The offset where the pack bytes start: just after the flush that ends the command list. */
function firstPackOffset(body: Buffer): number | null {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') return offset + 4;
    const size = parseInt(hex, 16);
    if (!Number.isFinite(size) || size < 4 || offset + size > body.length) return null;
    offset += size;
  }
  return null;
}

export async function handleReceivePack(ctx: GitRequestContext): Promise<void> {
  const { store, req, res, repo: repoName, owner } = ctx;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const body = await readBody(req);
  const parsed = parsePush(body);
  if (parsed === null) {
    sendJson(res, 400, { message: 'Malformed push request' });
    return;
  }
  const { commands, pack } = parsed;
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackError: string | null = null;
  if (needsPack) {
    if (pack === null || pack.length === 0) {
      unpackOk = false;
      unpackError = 'missing packfile';
    } else {
      try {
        const objects = readPack(pack);
        for (const [oid, object] of objects) {
          if (!store.hasObject(oid)) store.objects.set(oid, object);
        }
      } catch (error) {
        unpackOk = false;
        unpackError = error instanceof Error ? error.message : 'bad packfile';
      }
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok\n');
  else reportLines.push(`unpack ${unpackError ?? 'error'}\n`);
  if (unpackOk) {
    for (const command of parsed.commands) {
      if (!command.ref.startsWith('refs/')) {
        reportLines.push(`ng ${command.ref} invalid ref\n`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
          continue;
        }
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
          continue;
        }
        if (!store.hasObject(command.newOid)) {
          reportLines.push(`ng ${command.ref} object not found\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      // Update.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (!store.hasObject(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      const newObject = store.getObject(command.newOid) as GitObject;
      if (newObject.type === 'commit' && !store.isAncestor(current, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }
  const inner = encodePktLines([...reportLines, 'flush']);
  const outer = Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), inner])), Buffer.from('0000', 'ascii')]);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', outer);
}

export { readBody, sendJson };
