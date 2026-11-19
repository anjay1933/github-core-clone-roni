// app.ts — the HTTP server: routing, bearer-token auth, and a request id on every reply.
// One process, stdlib only. Routes:
//   GET  /healthz                      boot probe, no auth
//   POST /mcp                          Model Context Protocol
//   POST /api/graphql                  GraphQL v4
//   /api/v3/...                        REST v3
//   /{owner}/{repo}.git/info/refs      git smart HTTP advertisement
//   /{owner}/{repo}.git/git-upload-pack
//   /{owner}/{repo}.git/git-receive-pack
//   anything else                      404 {"message":"Not Found"}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decodePktLines } from './gitpack.ts';
import {
  handleFetchV0,
  handleFetchV2,
  handleInfoRefs,
  handleLsRefs,
  handleReceivePack,
  readBody,
  sendJson,
} from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const TOKEN_FORMAT = /^shpat_[0-9a-f]{32}$/i;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(16, '0');
}

/** A token is valid when it is the env's shop token or matches the shop-token format. */
export function isValidToken(authorization: string | undefined): boolean {
  if (authorization === undefined) return false;
  const match = /^Bearer\s+(\S+)$/.exec(authorization);
  if (match === null) return false;
  const token = match[1] as string;
  const envToken = process.env.MAKEFUN_SHOP_TOKEN;
  if (envToken !== undefined && envToken !== '' && token === envToken) return true;
  return TOKEN_FORMAT.test(token);
}

export function createApp(): { server: Server; store: Store } {
  const store = new Store();
  const server = createServer((req, res) => {
    void handleRequest(store, req, res).catch((error: unknown) => {
      // Never crash on a bad request: answer 500 JSON and keep serving.
      if (!res.headersSent) {
        res.setHeader('x-github-request-id', nextRequestId());
        sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
  return { server, store };
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('x-github-request-id', nextRequestId());
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const rawSegments = url.pathname.split('/').filter((segment) => segment !== '');
  const segments = rawSegments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const method = req.method ?? 'GET';

  // Boot probe: no auth.
  if (segments.length === 1 && segments[0] === 'healthz') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else needs a valid bearer token.
  if (!isValidToken(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  // MCP.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    await handleMcp({ store, req, res });
    return;
  }

  // GraphQL.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    await handleGraphQL({ store, req, res });
    return;
  }

  // REST v3.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    const handled = await handleRest({ store, req, res, segments: segments.slice(2), query: url.searchParams });
    if (!handled) sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (segments.length === 1 && segments[0] === 'api') {
    // GET /api/v3/ is segments ['api','v3']; a bare /api is unknown.
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  if (segments.length === 4 && segments[1]?.endsWith('.git') === true && segments[2] === 'info' && segments[3] === 'refs') {
    const owner = segments[0] as string;
    const repo = (segments[1] as string).slice(0, -'.git'.length);
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const service = url.searchParams.get('service') ?? '';
    await handleInfoRefs({ store, req, res, owner, repo }, service);
    return;
  }
  if (segments.length === 3 && segments[1]?.endsWith('.git') === true && segments[2] === 'git-upload-pack') {
    const owner = segments[0] as string;
    const repo = (segments[1] as string).slice(0, -'.git'.length);
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    await handleUploadPack({ store, req, res, owner, repo });
    return;
  }
  if (segments.length === 3 && segments[1]?.endsWith('.git') === true && segments[2] === 'git-receive-pack') {
    const owner = segments[0] as string;
    const repo = (segments[1] as string).slice(0, -'.git'.length);
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    await handleReceivePack({ store, req, res, owner, repo });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleUploadPack(ctx: { store: Store; req: IncomingMessage; res: ServerResponse; owner: string; repo: string }): Promise<void> {
  const { store, req, res, owner, repo } = ctx;
  const body = await readBody(req);
  // v2 requests start with a command= line; v0 requests start with a want line.
  let firstLine = '';
  try {
    const packets = decodePktLines(body);
    for (const packet of packets) {
      if (packet.kind === 'data') {
        firstLine = packet.payload.toString('utf8');
        break;
      }
    }
  } catch {
    sendJson(res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  if (firstLine.startsWith('command=ls-refs')) {
    handleLsRefs({ store, req, res, owner, repo }, body);
    return;
  }
  if (firstLine.startsWith('command=fetch')) {
    handleFetchV2({ store, req, res, owner, repo }, body);
    return;
  }
  if (firstLine.startsWith('want ') || firstLine.startsWith('command=')) {
    // A v0 fetch (or an unknown v2 command, answered as a v0 fetch for robustness).
    handleFetchV0({ store, req, res, owner, repo }, body);
    return;
  }
  sendJson(res, 400, { message: 'Malformed upload-pack request' });
}
