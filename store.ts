// store.ts — the forge's state: one content-addressed object store plus the repo records
// every view (REST, GraphQL, MCP, git) is derived from. No clock, no randomness: ids are
// sequential counters, timestamps are fixed, so two runs on the same input produce the same
// state byte for byte.
//
// The scenario's viewer is fixed by the competition's seed: adaiversen (id 1000). The shop
// token is opaque and carries no login, so any well-formed token maps to that viewer.

import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  SERVER_IDENTITY,
  SERVER_TIMESTAMP,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
} from './gitpack.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const TEAMMATE_ID = 1001;
export const STRANGER_LOGIN = 'olgabauer';
export const STRANGER_ID = 1002;
export const ORG_LOGIN = 'faint-meadow-org';

/** The fixed timestamp every server-made object carries (2025-01-08T00:00:00Z). */
export const FIXED_ISO = '2025-01-08T00:00:00Z';
export const DEFAULT_BRANCH = 'main';

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  seq: number;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  seq: number;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface UserView {
  login: string;
  id: number;
  email: string;
}

const USERS: Record<string, UserView> = {
  [VIEWER_LOGIN]: { login: VIEWER_LOGIN, id: VIEWER_ID, email: VIEWER_EMAIL },
  [TEAMMATE_LOGIN]: { login: TEAMMATE_LOGIN, id: TEAMMATE_ID, email: `${TEAMMATE_LOGIN}@example.invalid` },
  [STRANGER_LOGIN]: { login: STRANGER_LOGIN, id: STRANGER_ID, email: `${STRANGER_LOGIN}@example.invalid` },
};

export function userView(login: string): UserView {
  return USERS[login] ?? { login, id: 1000, email: `${login}@example.invalid` };
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, RepoRecord>();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextCommentId = 1;
  private nextRepoSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRecord | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const repo: RepoRecord = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.nextRepoSeq,
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nextRepoId += 1;
    this.nextRepoSeq += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposForUser(login: string): RepoRecord[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === login)
      .sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------

  putObject(type: GitObjectType, data: Buffer): string {
    const { oid, object } = makeObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, object);
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** The commit a ref points at, peeling annotated tags. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) return null;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
  }

  /** Every object reachable from the given roots (commits, their trees and blobs, tags). */
  collectReachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** True when `ancestor` is an ancestor of `oid` (or the same commit). */
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The newest common ancestor of two commits (first shared commit found walking both sides). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [current, depth] = queueA.shift() as [string, number];
      if (ancestorsA.has(current)) continue;
      ancestorsA.set(current, depth);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
    }
    const queueB: Array<[string, number]> = [[b, 0]];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    while (queueB.length > 0) {
      const [current, depth] = queueB.shift() as [string, number];
      if (seenB.has(current)) continue;
      seenB.add(current);
      const depthA = ancestorsA.get(current);
      if (depthA !== undefined && depthA + depth < bestDepth) {
        best = current;
        bestDepth = depthA + depth;
      }
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
    }
    return best;
  }

  /** The flat path -> {oid, mode} map of a tree, recursing into subtrees. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return files;
  }

  /** Build (and store) the tree objects for a flat file map; returns the root tree oid. */
  buildTreeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    const byDir = new Map<string, Map<string, { oid: string; mode: string }>>();
    const ensureDir = (dir: string): void => {
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      if (dir !== '') {
        const slash = dir.lastIndexOf('/');
        ensureDir(slash < 0 ? '' : dir.slice(0, slash));
      }
    };
    for (const [path, file] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      ensureDir(dir);
      (byDir.get(dir) as Map<string, { oid: string; mode: string }>).set(name, file);
    }
    const buildDir = (dir: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, file] of byDir.get(dir) ?? []) {
        entries.push({ mode: file.mode, name, oid: file.oid });
      }
      for (const [childDir] of byDir) {
        if (childDir === dir) continue;
        const parent = childDir.slice(0, childDir.lastIndexOf('/'));
        if (parent === dir || (dir === '' && !childDir.includes('/'))) {
          const name = dir === '' ? childDir : childDir.slice(dir.length + 1);
          entries.push({ mode: '40000', name, oid: buildDir(childDir) });
        }
      }
      return this.putObject('tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Create a server commit on top of `parents` with `files` as its full tree. */
  makeServerCommit(parents: readonly string[], files: Map<string, { oid: string; mode: string }>, message: string): string {
    const treeOid = this.buildTreeFromFiles(files);
    const commitBytes = buildCommit({ tree: treeOid, parents, message });
    return this.putObject('commit', commitBytes);
  }

  /** The ref a branch name resolves to, or null. */
  branchRef(repo: RepoRecord, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit oid a branch points at (tags peeled), or null. */
  branchCommit(repo: RepoRecord, branch: string): string | null {
    const ref = this.branchRef(repo, branch);
    if (ref === null) return null;
    return this.peelToCommit(ref);
  }

  /** The flat file map of a branch's tip, or null when the branch does not exist. */
  branchFiles(repo: RepoRecord, branch: string): Map<string, { oid: string; mode: string }> | null {
    const commitOid = this.branchCommit(repo, branch);
    if (commitOid === null) return null;
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return this.flattenTree(parseCommit(object.data).tree);
  }

  // -------------------------------------------------------------------------
  // contents (file read/write as commits)
  // -------------------------------------------------------------------------

  /** Write `path` with `content` on `branch`; returns the new commit oid and blob sha. */
  writeFile(repo: RepoRecord, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject('blob', content);
    const parent = this.branchCommit(repo, branch);
    const files = parent === null ? new Map<string, { oid: string; mode: string }>() : this.branchFiles(repo, branch) ?? new Map();
    files.set(path, { oid: blobSha, mode: '100644' });
    const commitSha = this.makeServerCommit(parent === null ? [] : [parent], files, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete `path` from `branch`; returns the new commit oid, or null when nothing changed. */
  deleteFile(repo: RepoRecord, branch: string, path: string, message: string): string | null {
    const files = this.branchFiles(repo, branch);
    if (files === null || !files.has(path)) return null;
    const parent = this.branchCommit(repo, branch) as string;
    files.delete(path);
    const commitSha = this.makeServerCommit([parent], files, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return commitSha;
  }

  // -------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------

  createIssue(repo: RepoRecord, title: string, body: string, labels: string[]): IssueRecord {
    const issue: IssueRecord = {
      id: this.nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.issues.length + 1,
    };
    this.nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(
    repo: RepoRecord,
    title: string,
    body: string,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
  ): PullRecord {
    const pull: PullRecord = {
      id: this.nextIssueId,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      seq: repo.pulls.length + 1,
    };
    this.nextIssueId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** The file diff between a pull request's base and head tips. */
  pullFiles(repo: RepoRecord, pull: PullRecord): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseFiles = this.branchFiles(repo, pull.baseRef);
    const headFiles = this.branchFiles(repo, pull.headRef);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...(baseFiles?.keys() ?? []), ...(headFiles?.keys() ?? [])]);
    for (const path of [...paths].sort()) {
      const base = baseFiles?.get(path);
      const head = headFiles?.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      if (base === undefined && head !== undefined) {
        out.push({ filename: path, status: 'added', additions: lineCount(head.oid, this), deletions: 0, changes: lineCount(head.oid, this) });
      } else if (base !== undefined && head === undefined) {
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(base.oid, this), changes: lineCount(base.oid, this) });
      } else if (base !== undefined && head !== undefined) {
        const added = lineCount(head.oid, this);
        const removed = lineCount(base.oid, this);
        out.push({ filename: path, status: 'modified', additions: added, deletions: removed, changes: added + removed });
      }
    }
    return out;
  }

  /** "MERGEABLE" when the head applies cleanly on the base, "CONFLICTING" otherwise. */
  pullMergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' {
    const baseCommit = this.branchCommit(repo, pull.baseRef);
    const headCommit = this.branchCommit(repo, pull.headRef);
    if (baseCommit === null || headCommit === null) return 'CONFLICTING';
    if (this.isAncestor(baseCommit, headCommit)) return 'MERGEABLE';
    const baseFiles = this.flattenTree(parseCommit(this.objects.get(baseCommit)!.data).tree);
    const headFiles = this.flattenTree(parseCommit(this.objects.get(headCommit)!.data).tree);
    const mergeBaseOid = this.mergeBase(baseCommit, headCommit);
    const ancestorFiles =
      mergeBaseOid === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(parseCommit(this.objects.get(mergeBaseOid)!.data).tree);
    for (const [path, head] of headFiles) {
      const ancestor = ancestorFiles.get(path);
      const base = baseFiles.get(path);
      if (ancestor === undefined) {
        // Added on head; conflicts only when the base added the same path differently.
        if (base !== undefined && base.oid !== head.oid) return 'CONFLICTING';
      } else if (ancestor.oid !== head.oid) {
        // Changed on head; conflicts when the base changed the same path differently.
        if (base !== undefined && base.oid !== ancestor.oid && base.oid !== head.oid) return 'CONFLICTING';
      }
    }
    for (const [path, ancestor] of ancestorFiles) {
      if (!headFiles.has(path) && baseFiles.has(path) && (baseFiles.get(path) as { oid: string }).oid !== ancestor.oid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request: one new commit on the base branch whose tree is the head's tree.
   * Returns the merge commit sha, or null when the pull cannot merge.
   */
  mergePull(repo: RepoRecord, pull: PullRecord): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullMergeable(repo, pull) !== 'MERGEABLE') return null;
    const baseCommit = this.branchCommit(repo, pull.baseRef);
    const headCommit = this.branchCommit(repo, pull.headRef);
    if (baseCommit === null || headCommit === null) return null;
    const headFiles = this.flattenTree(parseCommit(this.objects.get(headCommit)!.data).tree);
    const mergeSha = this.makeServerCommit([baseCommit], headFiles, pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }
}

/** Line count of a blob (files with at least one line count 1 for an empty blob's 0). */
function lineCount(blobOid: string, store: Store): number {
  const object = store.getObject(blobOid);
  if (object === undefined || object.type !== 'blob') return 0;
  if (object.data.length === 0) return 0;
  const text = object.data.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export { hashObject, isObjectId, ZERO_OID, SERVER_IDENTITY, SERVER_TIMESTAMP };
