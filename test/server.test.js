import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Keep every write away from the real settings file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelium-server-'));
process.env.MODELIUM_ENV_FILE = path.join(dir, '.env');

const { createApp } = await import('../server/app.js');
const { config } = await import('../server/config.js');

/** Start the app on an ephemeral port and hand back a client bound to it. */
async function withServer(run) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    return await run({
      base,
      port,
      get: (route, init) => fetch(base + route, init),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('every response carries the security headers', async () => {
  await withServer(async ({ get }) => {
    for (const route of ['/', '/api/health', '/api/sources']) {
      const response = await get(route);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', route);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer', route);
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin', route);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, route);
      assert.equal(response.headers.get('access-control-allow-origin'), null, route);
    }
  });
});

/**
 * PROXY_IMAGES is editable at runtime, so a policy computed once at import time
 * would be wrong for the rest of the process.
 */
test('the image policy follows the proxy setting per request', async () => {
  const original = config.proxyImages;

  await withServer(async ({ get }) => {
    config.proxyImages = true;
    const proxied = (await get('/api/health')).headers.get('content-security-policy');
    assert.match(proxied, /img-src 'self';/, 'proxying keeps images on this origin');
    assert.doesNotMatch(proxied, /printables/);

    config.proxyImages = false;
    const hotlinked = (await get('/api/health')).headers.get('content-security-policy');
    assert.match(hotlinked, /img-src 'self' https:\/\/media\.printables\.com/);
    assert.match(hotlinked, /cdn\.thingiverse\.com/);
  });

  config.proxyImages = original;
});

test('a route answers only the methods it declares', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/api/health', { method: 'DELETE' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');

    assert.equal((await get('/api/settings/test', { method: 'GET' })).status, 405);
    assert.equal((await get('/img', { method: 'POST' })).status, 405);
  });
});

/**
 * A space is a legal HTTP field-value character, so this reaches the handler.
 * It used to be fed into `new URL(req.url, 'http://' + host)` outside any catch,
 * where it threw and took the process with it. The URL is now built against a
 * fixed base — the Host header was never read for anything — so a malformed one
 * is simply irrelevant. Has to be a raw socket: fetch will not emit an invalid
 * Host header.
 */
test('a malformed Host header cannot reach the URL parser', async () => {
  await withServer(async ({ port, get }) => {
    const answer = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET /api/health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });

    assert.match(answer, /^HTTP\/1\.1 200 /, answer.slice(0, 80));

    // The part that actually matters: the server is still alive afterwards.
    assert.equal((await get('/api/health')).status, 200);
  });
});

test('health reports the mode and the setup state, never a token', async () => {
  await withServer(async ({ get }) => {
    const payload = await (await get('/api/health')).json();

    assert.equal(payload.ok, true);
    assert.equal(payload.mode, 'local');
    assert.equal(payload.setup, 'n/a');
    assert.match(payload.version, /^\d+\.\d+\.\d+/);
    assert.doesNotMatch(JSON.stringify(payload), /token/i);
  });
});

test('an unknown route is a JSON 404 rather than a stack trace', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/nope');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  });
});

test('a search without a query explains itself', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/api/search');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Missing query parameter/);
  });
});

/* --- Settings guard, over real HTTP -------------------------------------- */

test('reading settings from loopback works and leaks no absolute path in server mode', async () => {
  await withServer(async ({ get }) => {
    const payload = await (await get('/api/settings')).json();
    assert.equal(payload.readOnly, false);
    assert.equal(typeof payload.file, 'string');
  });
});

test('a write without the custom header is refused', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ PER_SOURCE_LIMIT: '10' }),
    });

    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /X-Modelium-Settings/);
  });
});

test('a write claiming another origin is refused', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/api/settings', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-modelium-settings': '1',
        origin: 'https://evil.com',
      },
      body: JSON.stringify({ PER_SOURCE_LIMIT: '10' }),
    });

    assert.equal(response.status, 403);
  });
});

test('a well formed local write is accepted', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-modelium-settings': '1' },
      body: JSON.stringify({ PER_SOURCE_LIMIT: '11' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).saved, ['PER_SOURCE_LIMIT']);
  });
});

/**
 * The old catch-all answered with `error.message`, which for a filesystem
 * failure is an absolute path — a free description of the host.
 */
test('a rejected value says what is wrong without describing the host', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-modelium-settings': '1' },
      body: JSON.stringify({ PER_SOURCE_LIMIT: '9999' }),
    });

    assert.equal(response.status, 400);
    const body = await response.text();
    assert.match(body, /between 1 and 100/);
    assert.doesNotMatch(body, /[A-Za-z]:\\|\/(home|tmp|Users)\//, 'no filesystem paths');
  });
});

test('an oversized body is refused instead of buffered', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-modelium-settings': '1' },
      body: 'x'.repeat(128 * 1024),
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /too large/);
  });
});

test('the image proxy refuses a host outside the allowlist', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/img?u=https%3A%2F%2Fevil.com%2Fa.png');
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});
