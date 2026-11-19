// main.ts — the lifecycle the harness drives this forge with.
//
// 1. Bind an ephemeral port (never 8080: that is the env's port, on the same loopback).
// 2. Register that port at $MAKEFUN_ENV_URL/register. The first register wins.
// 3. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done":true}, then exit 0.
// Without MAKEFUN_ENV_URL there is nothing to talk to, so exit 1 at once.
//
// Retries use a short exponential backoff. The server is closed before exiting.

import { createApp } from './app.ts';

const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, init: RequestInit, attempts: number): Promise<unknown> {
  let delay = 100;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 2000);
        continue;
      }
      return (await response.json()) as unknown;
    } catch (error) {
      lastError = error;
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('request failed');
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set; nothing to register with');
    process.exit(1);
  }
  const { server } = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`roniforge listening on port ${port}`);

  await fetchJson(`${envUrl}${REGISTER_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  }, 10);
  console.log('registered with the env');

  for (;;) {
    const done = await fetchJson(`${envUrl}${DONE_PATH}`, { method: 'GET' }, 10);
    if (done !== null && typeof done === 'object' && (done as { done?: unknown }).done === true) break;
    await sleep(500);
  }
  console.log('env reports done; exiting');
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
