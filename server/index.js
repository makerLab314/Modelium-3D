import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { headerLimitOk, REQUIRED_HEADER_SIZE } from './lib/http.js';
import { proxyUrl, serveImage } from './lib/imageProxy.js';
import { serveStatic } from './lib/static.js';
import { describeSettings, saveSettings, testSource } from './settings.js';
import { describeSources } from './sources/index.js';
import { merge, resolveSources, searchSource, SORT_MODES } from './search.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/api/health') return sendJson(res, 200, health());
    if (url.pathname === '/api/sources') return sendJson(res, 200, { sources: describeSources() });
    if (url.pathname === '/api/search') return await handleSearch(url, req, res);
    if (url.pathname === '/api/settings') return await handleSettings(req, res);
    if (url.pathname === '/api/settings/test') return await handleSettingsTest(url, req, res);
    if (url.pathname === '/img') return await serveImage(url.searchParams.get('u') ?? '', res);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(PUBLIC_DIR, url.pathname, res)) return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    if (res.headersSent) return res.end();
    sendJson(res, error.statusCode ?? 500, { error: error.message });
  }
});

/**
 * One endpoint, two shapes. `stream=1` opens a Server Sent Events channel so
 * every site's hits land on screen the moment that site answers, instead of
 * everyone waiting for the slowest one. Without it you get a plain JSON body,
 * which is the friendlier shape for scripts and tests.
 */
async function handleSearch(url, req, res) {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) return sendJson(res, 400, { error: 'Missing query parameter q' });

  const sort = SORT_MODES.includes(url.searchParams.get('sort') ?? '')
    ? url.searchParams.get('sort')
    : 'relevance';
  const selected = resolveSources((url.searchParams.get('sources') ?? '').split(',').filter(Boolean));
  const page = clampPage(url.searchParams.get('page'));

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const startedAt = Date.now();
  const streaming = url.searchParams.get('stream') === '1';
  const reports = [];

  const runs = selected.map(async (sourceId) => {
    const report = await searchSource(sourceId, query, { signal: controller.signal, page });
    reports.push(report);
    return report;
  });

  if (!streaming) {
    await Promise.all(runs);
    return sendJson(res, 200, {
      query,
      tookMs: Date.now() - startedAt,
      ...withProxiedImages(merge(reports, query, sort, page)),
    });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  send(res, 'start', { query, sort, page, sources: selected });

  // Emit in completion order, not registry order, so one slow site cannot hold
  // back the results of a fast one.
  await Promise.all(
    runs.map((run) =>
      run.then((report) => {
        if (res.writableEnded) return;
        send(res, 'source', { ...report, items: undefined, count: report.items.length });
        send(res, 'results', withProxiedImages(merge(reports, query, sort, page)));
      }),
    ),
  );

  if (res.writableEnded) return;
  send(res, 'done', { tookMs: Date.now() - startedAt });
  res.end();
}

async function handleSettings(req, res) {
  requireLocalRequest(req);

  if (req.method === 'GET') return sendJson(res, 200, describeSettings());

  if (req.method === 'PUT' || req.method === 'POST') {
    const result = saveSettings(await readJsonBody(req));
    return sendJson(res, 200, { ...result, ...describeSettings() });
  }

  return sendJson(res, 405, { error: 'Use GET or PUT' });
}

async function handleSettingsTest(url, req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
  requireLocalRequest(req);
  return sendJson(res, 200, await testSource(url.searchParams.get('source') ?? ''));
}

/**
 * The settings surface reads and writes a file containing an API token, so both
 * halves are restricted to requests that actually came from this machine. The
 * Host check is what stops a page on the open web from pointing a DNS name at
 * 127.0.0.1 and talking to us; `sec-fetch-site` is a second, browser-enforced
 * belt against a cross-site request.
 */
function requireLocalRequest(req) {
  const address = req.socket.remoteAddress ?? '';
  const isLoopback =
    address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

  const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
  const localHostname = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

  const site = req.headers['sec-fetch-site'];
  const sameOrigin = site === undefined || site === 'same-origin' || site === 'none';

  if (!isLoopback || !localHostname || !sameOrigin) {
    throw forbidden('Settings are only available from this machine');
  }
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw badRequest('Request body too large');
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Body must be JSON');
  }
}

/** Everything the UI needs to tell the user why a search might not work. */
function health() {
  return {
    ok: true,
    version: '0.2.0',
    node: process.version,
    headerLimitOk: headerLimitOk(),
    headerLimitNeeded: REQUIRED_HEADER_SIZE,
    headerLimit: http.maxHeaderSize,
    sources: describeSources(),
  };
}

/** Rewrite image URLs to the local proxy so the browser never calls the CDNs. */
function withProxiedImages(payload) {
  if (!config.proxyImages) return payload;

  return {
    ...payload,
    results: payload.results.map((item) =>
      item.image
        ? { ...item, image: { thumb: proxyUrl(item.image.thumb), full: item.image.full } }
        : item,
    ),
  };
}

function clampPage(raw) {
  const page = Number.parseInt(raw ?? '1', 10);
  return Number.isFinite(page) && page > 0 ? Math.min(page, 20) : 1;
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

/* --- Lifecycle ----------------------------------------------------------- */

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use. Either stop the other process or start with a different port:\n` +
        `  PORT=8788 npm start`,
    );
    process.exit(1);
  }
  if (error.code === 'EACCES') {
    console.error(`Not allowed to bind ${config.host}:${config.port}. Try a port above 1024.`);
    process.exit(1);
  }
  throw error;
});

server.listen(config.port, config.host, () => {
  console.log(`\n  Modelium 3D  ·  http://${config.host}:${config.port}\n`);

  if (!headerLimitOk()) {
    console.warn(
      `  ! Node's HTTP header limit is ${Math.round(http.maxHeaderSize / 1024)} KB. Printables sends larger\n` +
        `    headers than that and will fail. Start with \`npm start\`, which passes\n` +
        `    --max-http-header-size=${REQUIRED_HEADER_SIZE}.\n`,
    );
  }

  const missing = describeSources().filter((source) => !source.configured);
  if (missing.length) {
    console.log(
      `  ${missing.map((source) => source.label).join(', ')} needs a token — add it under Settings in the app.\n`,
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Do not let a held-open SSE stream block the exit.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
