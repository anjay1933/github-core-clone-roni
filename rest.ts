// rest.ts — GitHub REST v3: repositories, branches, commits, refs, contents, labels,
// issues, comments, pull requests, files and merges. Every reply is JSON with a
// non-empty X-GitHub-Request-Id (set by app.ts); errors are always {message: string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isObjectId, parseCommit } from './gitpack.ts';
import { readBody, sendJson } from './githttp.ts';
import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments after /api/v3 (already URL-decoded). */
  segments: string[];
  query: URLSearchParams;
}

interface JsonObject {
  [key: string]: unknown;
}

function parseJsonBody(body: Buffer): JsonObject | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { pageItems: T[]; totalPages: number; perPage: number; page: number } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages, perPage, page };
}

function linkHeader(req: IncomingMessage, query: URLSearchParams, page: number, totalPages: number, perPage: number): string | null {
  const host = req.headers.host ?? '127.0.0.1';
  const path = req.url?.split('?')[0] ?? '';
  const base = `http://${host}${path}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (totalPages > 1) links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  return links.length > 0 ? links.join(', ') : null;
}

function sendPage<T>(ctx: RestContext, items: readonly T[], toJson: (item: T) => unknown): void {
  const { pageItems, totalPages, perPage, page } = paginate(items, ctx.query);
  const link = linkHeader(ctx.req, ctx.query, page, totalPages, perPage);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (link !== null) headers.link = link;
  ctx.res.writeHead(200, headers);
  ctx.res.end(JSON.stringify(pageItems.map(toJson)));
}

// ---------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------

function userJson(login: string, id: number): JsonObject {
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: RepoRecord): JsonObject {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
  };
}

function labelJson(label: { name: string; color: string }): JsonObject {
  return { name: label.name, color: label.color, description: '' };
}

function issueJson(repo: RepoRecord, issue: IssueRecord): JsonObject {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: RepoRecord, pull: PullRecord, store: Store): JsonObject {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: store.pullMergeable(repo, pull) === 'MERGEABLE',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    draft: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(store: Store, sha: string): JsonObject | null {
  const object = store.getObject(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const authorLine = parseIdentity(commit.author);
  const committerLine = parseIdentity(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message,
      author: { name: authorLine.name, email: authorLine.email, date: new Date(authorLine.timestamp * 1000).toISOString() },
      committer: { name: committerLine.name, email: committerLine.email, date: new Date(committerLine.timestamp * 1000).toISOString() },
      tree: { sha: commit.tree },
    },
    author: { login: authorLine.email === VIEWER_EMAIL ? VIEWER_LOGIN : null, id: authorLine.email === VIEWER_EMAIL ? VIEWER_ID : null },
    committer: { login: committerLine.email === VIEWER_EMAIL ? VIEWER_LOGIN : null, id: committerLine.email === VIEWER_EMAIL ? VIEWER_ID : null },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', timestamp: 0 };
  return { name: match[1] as string, email: match[2] as string, timestamp: Number.parseInt(match[3] as string, 10) };
}

function branchNames(repo: RepoRecord): string[] {
  return [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getRepoOr404(ctx: RestContext, owner: string, name: string): RepoRecord | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendJson(ctx.res, 404, { message: 'Not Found' });
    return null;
  }
  return repo;
}

async function readJson(ctx: RestContext): Promise<JsonObject | null> {
  const body = await readBody(ctx.req);
  const parsed = parseJsonBody(body);
  if (parsed === null) {
    sendJson(ctx.res, 400, { message: 'Problems parsing JSON' });
    return null;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// route table
// ---------------------------------------------------------------------------

export async function handleRest(ctx: RestContext): Promise<boolean> {
  const { segments, req } = ctx;
  const method = req.method ?? 'GET';

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') {
      sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    ctx.res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, read:org' });
    ctx.res.end(JSON.stringify({
      current_user_url: 'https://api.github.com/user',
      repository_url: 'https://api.github.com/repos/{owner}/{repo}',
      user_url: 'https://api.github.com/users/{user}',
    }));
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    sendJson(ctx.res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // GET /api/v3/user and /api/v3/user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') {
        sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      sendJson(ctx.res, 200, {
        ...userJson(VIEWER_LOGIN, VIEWER_ID),
        name: 'Ada Iversen',
        email: VIEWER_EMAIL,
        type: 'User',
      });
      return true;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = ctx.store.listReposForUser(VIEWER_LOGIN);
        sendPage(ctx, repos, repoJson);
        return true;
      }
      if (method === 'POST') {
        const body = await readJson(ctx);
        if (body === null) return true;
        const name = asString(body.name);
        if (name === null || name === '') {
          sendJson(ctx.res, 422, { message: 'Validation Failed: name is required' });
          return true;
        }
        const description = asString(body.description) ?? '';
        const isPrivate = asBoolean(body.private) ?? false;
        const repo = ctx.store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
        if (repo === null) {
          sendJson(ctx.res, 422, { message: 'Validation Failed: name already exists on this account' });
          return true;
        }
        sendJson(ctx.res, 201, repoJson(repo));
        return true;
      }
      sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    return false;
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);
    return handleRepoRoutes(ctx, owner, name, rest);
  }

  return false;
}

async function handleRepoRoutes(ctx: RestContext, owner: string, name: string, rest: string[]): Promise<boolean> {
  const { store, req } = ctx;
  const method = req.method ?? 'GET';

  // /repos/{owner}/{name} itself
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      sendJson(ctx.res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const body = await readJson(ctx);
      if (body === null) return true;
      const description = asString(body.description);
      if (description !== null) repo.description = description;
      const isPrivate = asBoolean(body.private);
      if (isPrivate !== null) repo.isPrivate = isPrivate;
      const defaultBranch = asString(body.default_branch);
      if (defaultBranch !== null && repo.refs.has(`refs/heads/${defaultBranch}`)) repo.defaultBranch = defaultBranch;
      sendJson(ctx.res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      store.deleteRepo(owner, name);
      ctx.res.writeHead(204);
      ctx.res.end();
      return true;
    }
    sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const resource = rest[0] as string;

  // Branches
  if (resource === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') {
        sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const branches = branchNames(repo).map((branch) => ({
        name: branch,
        commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: '' },
        protected: false,
      }));
      sendPage(ctx, branches, (branch) => branch);
      return true;
    }
    if (rest.length === 2) {
      if (method !== 'GET') {
        sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const branch = rest[1] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendJson(ctx.res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(ctx.res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
      return true;
    }
    return false;
  }

  // Commits
  if (resource === 'commits') {
    if (method !== 'GET') {
      sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const repo = getRepoOr404(ctx, owner, name);
    if (repo === null) return true;
    const refName = ctx.query.get('sha') ?? repo.defaultBranch;
    let tip: string | null = null;
    if (isObjectId(refName)) tip = store.peelToCommit(refName);
    else tip = store.branchCommit(repo, refName);
    if (tip === null) {
      sendJson(ctx.res, 404, { message: 'Not Found' });
      return true;
    }
    const commits: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = store.getObject(current);
      if (object === undefined || object.type !== 'commit') continue;
      commits.push(current);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    // Newest first: walk order is already tip-first for linear histories; sort by nothing else.
    const views = commits.map((sha) => commitJson(store, sha)).filter((view): view is JsonObject => view !== null);
    sendPage(ctx, views, (view) => view);
    return true;
  }

  // Git refs
  if (resource === 'git' && rest[1] === 'refs') {
    if (method === 'GET') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const refPath = rest.slice(2).join('/');
      if (refPath === '') {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([ref, oid]) => {
            const object = store.getObject(oid);
            return { ref, object: { sha: oid, type: object?.type ?? 'commit', url: '' } };
          });
        sendJson(ctx.res, 200, refs);
        return true;
      }
      const oid = repo.refs.get(refPath);
      if (oid === undefined) {
        sendJson(ctx.res, 404, { message: 'Not Found' });
        return true;
      }
      const object = store.getObject(oid);
      sendJson(ctx.res, 200, { ref: refPath, object: { sha: oid, type: object?.type ?? 'commit', url: '' } });
      return true;
    }
    if (method === 'POST' && rest.length === 2) {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const body = await readJson(ctx);
      if (body === null) return true;
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === null || sha === null || !isObjectId(sha) || !store.hasObject(sha)) {
        sendJson(ctx.res, 422, { message: 'Validation Failed: ref and sha are required' });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(ctx.res, 422, { message: 'Validation Failed: reference already exists' });
        return true;
      }
      repo.refs.set(ref, sha);
      const object = store.getObject(sha);
      sendJson(ctx.res, 201, { ref, object: { sha, type: object?.type ?? 'commit', url: '' } });
      return true;
    }
    sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // Contents
  if (resource === 'contents') {
    return handleContents(ctx, owner, name, rest.slice(1));
  }

  // Labels
  if (resource === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      sendJson(ctx.res, 200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const body = await readJson(ctx);
      if (body === null) return true;
      const labelName = asString(body.name);
      if (labelName === null || labelName === '') {
        sendJson(ctx.res, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      if (repo.labels.has(labelName)) {
        sendJson(ctx.res, 422, { message: 'Validation Failed: label already exists' });
        return true;
      }
      const color = asString(body.color) ?? 'ededed';
      const label = { name: labelName, color };
      repo.labels.set(labelName, label);
      sendJson(ctx.res, 201, labelJson(label));
      return true;
    }
    sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // Issues
  if (resource === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const repo = getRepoOr404(ctx, owner, name);
        if (repo === null) return true;
        let issues = [...repo.issues];
        const state = ctx.query.get('state') ?? 'open';
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const direction = ctx.query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        sendPage(ctx, issues, (issue) => issueJson(repo, issue));
        return true;
      }
      if (method === 'POST') {
        const repo = getRepoOr404(ctx, owner, name);
        if (repo === null) return true;
        const body = await readJson(ctx);
        if (body === null) return true;
        const title = asString(body.title);
        if (title === null || title === '') {
          sendJson(ctx.res, 422, { message: 'Validation Failed: title is required' });
          return true;
        }
        const labels = asStringArray(body.labels) ?? [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendJson(ctx.res, 422, { message: `Validation Failed: label "${label}" does not exist` });
            return true;
          }
        }
        const issue = store.createIssue(repo, title, asString(body.body) ?? '', labels);
        sendJson(ctx.res, 201, issueJson(repo, issue));
        return true;
      }
      sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const issueNumber = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(issueNumber)) return false;
    if (rest.length === 2) {
      if (method === 'GET') {
        const repo = getRepoOr404(ctx, owner, name);
        if (repo === null) return true;
        const issue = repo.issues.find((item) => item.number === issueNumber);
        if (issue === undefined) {
          sendJson(ctx.res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(ctx.res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const repo = getRepoOr404(ctx, owner, name);
        if (repo === null) return true;
        const issue = repo.issues.find((item) => item.number === issueNumber);
        if (issue === undefined) {
          sendJson(ctx.res, 404, { message: 'Not Found' });
          return true;
        }
        const body = await readJson(ctx);
        if (body === null) return true;
        const title = asString(body.title);
        if (title !== null) issue.title = title;
        const bodyText = asString(body.body);
        if (bodyText !== null) issue.body = bodyText;
        const state = asString(body.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const labels = asStringArray(body.labels);
        if (labels !== null) {
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendJson(ctx.res, 422, { message: `Validation Failed: label "${label}" does not exist` });
              return true;
            }
          }
          issue.labels = [...labels];
        }
        sendJson(ctx.res, 200, issueJson(repo, issue));
        return true;
      }
      sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        const repo = getRepoOr404(ctx, owner, name);
        if (repo === null) return true;
        const issue = repo.issues.find((item) => item.number === issueNumber);
        if (issue === undefined) {
          sendJson(ctx.res, 404, { message: 'Not Found' });
          return true;
        }
        sendPage(ctx, issue.comments, (comment) => ({
          id: comment.id,
          body: comment.body,
          user: userJson(VIEWER_LOGIN, VIEWER_ID),
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        }));
        return true;
      }
      if (method === 'POST') {
        const repo = getRepoOr404(ctx, owner, name);
        if (repo === null) return true;
        const issue = repo.issues.find((item) => item.number === issueNumber);
        if (issue === undefined) {
          sendJson(ctx.res, 404, { message: 'Not Found' });
          return true;
        }
        const body = await readJson(ctx);
        if (body === null) return true;
        const commentBody = asString(body.body);
        if (commentBody === null || commentBody === '') {
          sendJson(ctx.res, 422, { message: 'Validation Failed: body is required' });
          return true;
        }
        const comment = { id: store.nextCommentId, body: commentBody };
        store.nextCommentId += 1;
        issue.comments.push(comment);
        sendJson(ctx.res, 201, {
          id: comment.id,
          body: comment.body,
          user: userJson(VIEWER_LOGIN, VIEWER_ID),
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        });
        return true;
      }
      sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    return false;
  }

  // Pull requests
  if (resource === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const repo = getRepoOr404(ctx, owner, name);
        if (repo === null) return true;
        let pulls = [...repo.pulls];
        const state = ctx.query.get('state') ?? 'open';
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.seq - a.seq);
        sendPage(ctx, pulls, (pull) => pullJson(repo, pull, store));
        return true;
      }
      if (method === 'POST') {
        const repo = getRepoOr404(ctx, owner, name);
        if (repo === null) return true;
        const body = await readJson(ctx);
        if (body === null) return true;
        const title = asString(body.title);
        const head = asString(body.head);
        const base = asString(body.base);
        if (title === null || title === '' || head === null || base === null) {
          sendJson(ctx.res, 422, { message: 'Validation Failed: title, head and base are required' });
          return true;
        }
        const headSha = store.branchCommit(repo, head);
        const baseSha = store.branchCommit(repo, base);
        if (headSha === null || baseSha === null) {
          sendJson(ctx.res, 422, { message: 'Validation Failed: head or base branch does not exist' });
          return true;
        }
        const pull = store.createPull(repo, title, asString(body.body) ?? '', head, headSha, base, baseSha);
        sendJson(ctx.res, 201, pullJson(repo, pull, store));
        return true;
      }
      sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const pullNumber = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(pullNumber)) return false;
    if (rest.length === 2) {
      if (method !== 'GET') {
        sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const pull = repo.pulls.find((item) => item.number === pullNumber);
      if (pull === undefined) {
        sendJson(ctx.res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(ctx.res, 200, pullJson(repo, pull, store));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') {
        sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const pull = repo.pulls.find((item) => item.number === pullNumber);
      if (pull === undefined) {
        sendJson(ctx.res, 404, { message: 'Not Found' });
        return true;
      }
      sendPage(ctx, store.pullFiles(repo, pull), (file) => file);
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') {
        sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return true;
      const pull = repo.pulls.find((item) => item.number === pullNumber);
      if (pull === undefined) {
        sendJson(ctx.res, 404, { message: 'Not Found' });
        return true;
      }
      const body = await readJson(ctx);
      if (body === null) return true;
      const mergeMethod = asString(body.merge_method);
      if (mergeMethod !== null && mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
        sendJson(ctx.res, 422, { message: 'Validation Failed: unknown merge method' });
        return true;
      }
      if (pull.merged || pull.state !== 'open') {
        sendJson(ctx.res, 405, { message: 'Pull request already merged or closed' });
        return true;
      }
      if (store.pullMergeable(repo, pull) !== 'MERGEABLE') {
        sendJson(ctx.res, 405, { message: 'Pull request is not mergeable' });
        return true;
      }
      const sha = store.mergePull(repo, pull);
      if (sha === null) {
        sendJson(ctx.res, 405, { message: 'Pull request is not mergeable' });
        return true;
      }
      sendJson(ctx.res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    return false;
  }

  return false;
}

async function handleContents(ctx: RestContext, owner: string, name: string, pathSegments: string[]): Promise<boolean> {
  const { store, req } = ctx;
  const method = req.method ?? 'GET';
  const path = pathSegments.join('/');
  const branch = ctx.query.get('ref') ?? null;

  const repo = getRepoOr404(ctx, owner, name);
  if (repo === null) return true;

  if (method === 'GET') {
    const branchName = branch ?? repo.defaultBranch;
    const files = store.branchFiles(repo, branchName);
    if (files === null) {
      sendJson(ctx.res, 404, { message: 'Not Found' });
      return true;
    }
    if (path === '') {
      // Root directory listing.
      const entries = directoryEntries(store, repo, files, '');
      sendJson(ctx.res, 200, entries);
      return true;
    }
    const file = files.get(path);
    if (file !== undefined) {
      const object = store.getObject(file.oid);
      if (object === undefined || object.type !== 'blob') {
        sendJson(ctx.res, 404, { message: 'Not Found' });
        return true;
      }
      const namePart = path.slice(path.lastIndexOf('/') + 1);
      sendJson(ctx.res, 200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: namePart,
        path,
        content: object.data.toString('base64'),
        sha: file.oid,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
      });
      return true;
    }
    // Directory listing for a sub-path.
    const prefix = `${path}/`;
    const hasChildren = [...files.keys()].some((key) => key.startsWith(prefix));
    if (!hasChildren) {
      sendJson(ctx.res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(ctx.res, 200, directoryEntries(store, repo, files, path));
    return true;
  }

  if (method === 'PUT') {
    const body = await readJson(ctx);
    if (body === null) return true;
    const content = asString(body.content);
    const message = asString(body.message) ?? `Update ${path}`;
    const branchName = asString(body.branch) ?? repo.defaultBranch;
    const sha = asString(body.sha);
    if (content === null || path === '') {
      sendJson(ctx.res, 422, { message: 'Validation Failed: content and path are required' });
      return true;
    }
    let contentBytes: Buffer;
    try {
      contentBytes = Buffer.from(content, 'base64');
    } catch {
      sendJson(ctx.res, 422, { message: 'Validation Failed: content is not valid base64' });
      return true;
    }
    const files = store.branchFiles(repo, branchName) ?? new Map<string, { oid: string; mode: string }>();
    const existing = files.get(path);
    if (existing !== undefined) {
      if (sha === null || sha !== existing.oid) {
        sendJson(ctx.res, 409, { message: 'Conflict: sha does not match the current file' });
        return true;
      }
      const { commitSha, blobSha } = store.writeFile(repo, branchName, path, contentBytes, message);
      sendJson(ctx.res, 200, {
        content: { name: path.slice(path.lastIndexOf('/') + 1), path, sha: blobSha, size: contentBytes.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message },
      });
      return true;
    }
    const { commitSha, blobSha } = store.writeFile(repo, branchName, path, contentBytes, message);
    sendJson(ctx.res, 201, {
      content: { name: path.slice(path.lastIndexOf('/') + 1), path, sha: blobSha, size: contentBytes.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await readJson(ctx);
    if (body === null) return true;
    const message = asString(body.message) ?? `Delete ${path}`;
    const branchName = asString(body.branch) ?? repo.defaultBranch;
    const sha = asString(body.sha);
    const files = store.branchFiles(repo, branchName);
    if (files === null) {
      sendJson(ctx.res, 404, { message: 'Not Found' });
      return true;
    }
    const existing = files.get(path);
    if (existing === undefined) {
      sendJson(ctx.res, 404, { message: 'Not Found' });
      return true;
    }
    if (sha === null || sha !== existing.oid) {
      sendJson(ctx.res, 409, { message: 'Conflict: sha does not match the current file' });
      return true;
    }
    const commitSha = store.deleteFile(repo, branchName, path, message);
    if (commitSha === null) {
      sendJson(ctx.res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(ctx.res, 200, { commit: { sha: commitSha, message } });
    return true;
  }

  sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
  return true;
}

function dirTreeOid(store: Store, files: Map<string, { oid: string; mode: string }>, dir: string): string {
  const subset = new Map<string, { oid: string; mode: string }>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const [path, file] of files) {
    if (path.startsWith(prefix)) subset.set(path.slice(prefix.length), file);
  }
  return store.buildTreeFromFiles(subset);
}

function directoryEntries(
  store: Store,
  repo: RepoRecord,
  files: Map<string, { oid: string; mode: string }>,
  dir: string,
): JsonObject[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, JsonObject>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const object = store.getObject(file.oid);
      entries.set(rest, {
        type: 'file',
        name: rest,
        path,
        sha: file.oid,
        size: object?.type === 'blob' ? object.data.length : 0,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
      });
    } else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) {
        const subDir = `${prefix}${dirName}`;
        entries.set(dirName, {
          type: 'dir',
          name: dirName,
          path: subDir,
          sha: dirTreeOid(store, files, subDir),
          size: 0,
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
        });
      }
    }
  }
  return [...entries.values()].sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
}

export { DEFAULT_BRANCH, repoJson, issueJson, pullJson };
