// mcp.ts — Model Context Protocol over streamable HTTP (POST /mcp).
// Modern revision 2026-07-28 (server/discover, no handshake, revision declared in _meta
// and the MCP-Protocol-Version header) with the legacy 2025-11-25 initialize path kept
// for older clients. Six tools, all backed by the same store as REST and GraphQL.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from './githttp.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER_LOGIN, type Store } from './store.ts';

const SERVER_NAME = 'roniforge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

// Frozen once: tools/list must be byte-identical across calls.
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
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
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolTextResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function handleMcp(ctx: { store: Store; req: IncomingMessage; res: ServerResponse }): Promise<void> {
  const { store, req, res } = ctx;
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, { code: -32700, message: 'Parse error' }));
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, { code: -32600, message: 'Invalid Request' }));
    return;
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string') {
    sendJson(res, 400, rpcError(id, { code: -32600, message: 'Invalid Request: method is required' }));
    return;
  }
  // A notification (no id) gets a 202 with no body.
  const isNotification = request.id === undefined;

  if (method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    const result = {
      supportedVersions: [MODERN_REVISION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    };
    sendJson(res, 200, rpcResult(id, result));
    return;
  }

  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const protocolVersion = requested !== null && LEGACY_REVISIONS.includes(requested) ? requested : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    const params = request.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      sendJson(res, 200, rpcError(id, { code: -32602, message: 'Invalid params: tools/call needs a params object' }));
      return;
    }
    const name = (params as Record<string, unknown>).name;
    const args = (params as Record<string, unknown>).arguments;
    if (typeof name !== 'string') {
      sendJson(res, 200, rpcError(id, { code: -32602, message: 'Invalid params: tool name is required' }));
      return;
    }
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      sendJson(res, 200, rpcError(id, { code: -32602, message: `Unknown tool: ${name}` }));
      return;
    }
    const argsObject = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const missing = (tool.inputSchema.required ?? []).filter((key) => argsObject[key] === undefined || argsObject[key] === null);
    if (missing.length > 0) {
      sendJson(res, 200, rpcResult(id, toolErrorResult(`Missing required argument(s): ${missing.join(', ')}`)));
      return;
    }
    const result = callTool(store, tool.name, argsObject);
    sendJson(res, 200, rpcResult(id, result));
    return;
  }

  // Unknown method.
  void isNotification;
  sendJson(res, 200, rpcError(id, { code: -32601, message: `Method not found: ${method}` }));
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === null || repoName === '') return toolErrorResult('Missing required argument: name');
      const description = asString(args.description) ?? '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
      if (repo === null) return toolErrorResult(`Repository "${repoName}" already exists`);
      return toolTextResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (owner === null || repoName === null) return toolErrorResult('Missing required argument: owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`Repository "${owner}/${repoName}" not found`);
      return toolTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      if (owner === null || repoName === null || title === null) return toolErrorResult('Missing required argument: owner, repo and title');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`Repository "${owner}/${repoName}" not found`);
      const issue = store.createIssue(repo, title, asString(args.body) ?? '', []);
      return toolTextResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (owner === null || repoName === null) return toolErrorResult('Missing required argument: owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`Repository "${owner}/${repoName}" not found`);
      const state = asString(args.state) ?? 'open';
      const issues = state === 'all' ? [...repo.issues] : repo.issues.filter((issue) => issue.state === state);
      const views = issues.map((issue) => issueJson(repo, issue));
      return toolTextResult({ issues: views });
    }
    case 'create_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (owner === null || repoName === null || title === null || head === null || base === null) {
        return toolErrorResult('Missing required argument: owner, repo, title, head and base');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`Repository "${owner}/${repoName}" not found`);
      const headSha = store.branchCommit(repo, head);
      const baseSha = store.branchCommit(repo, base);
      if (headSha === null || baseSha === null) return toolErrorResult('Head or base branch does not exist');
      const pull = store.createPull(repo, title, asString(args.body) ?? '', head, headSha, base, baseSha);
      return toolTextResult(pullJson(repo, pull, store));
    }
    case 'merge_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const pullNumber = asNumber(args.pull_number);
      if (owner === null || repoName === null || pullNumber === null) return toolErrorResult('Missing required argument: owner, repo and pull_number');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`Repository "${owner}/${repoName}" not found`);
      const pull = repo.pulls.find((item) => item.number === pullNumber);
      if (pull === undefined) return toolErrorResult(`Pull request #${pullNumber} not found`);
      if (pull.merged || pull.state !== 'open') return toolErrorResult('Pull request is already merged or closed');
      const sha = store.mergePull(repo, pull);
      if (sha === null) return toolErrorResult('Pull request is not mergeable');
      return toolTextResult({ sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(repo, pull, store) });
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}
