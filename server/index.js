import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { proxyUrl, serveImage } from './lib/imageProxy.js';
import { serveStatic } from './lib/static.js';
import { describeSources } from './sources/index.js';
import { merge, resolveSources, searchSource, SORT_MODES } from './search.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/api/sources') return sendJson(res, 200, { sources: describeSources() });
    if (url.pathname === '/api/search') return await handleSearch(url, req, res);
    if (url.pathname === '/img') return await serveImage(url.searchParams.get('u') ?? '', res);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(PUBLIC_DIR, url.pathname, res)) return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    if (res.headersSent) return res.end();
    sendJson(res, 500, { error: error.message });
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

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const startedAt = Date.now();
  const streaming = url.searchParams.get('stream') === '1';
  const reports = [];

  const runs = selected.map(async (sourceId) => {
    const report = await searchSource(sourceId, query, { signal: controller.signal });
    reports.push(report);
    return report;
  });

  if (!streaming) {
    await Promise.all(runs);
    return sendJson(res, 200, {
      query,
      tookMs: Date.now() - startedAt,
      ...withProxiedImages(merge(reports, query, sort)),
    });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  send(res, 'start', { query, sort, sources: selected });

  // Emit in completion order, not registry order, so one slow site cannot hold
  // back the results of a fast one.
  await Promise.all(
    runs.map((run) =>
      run.then((report) => {
        if (res.writableEnded) return;
        send(res, 'source', { ...report, items: undefined, count: report.items.length });
        send(res, 'results', withProxiedImages(merge(reports, query, sort)));
      }),
    ),
  );

  if (res.writableEnded) return;
  send(res, 'done', { tookMs: Date.now() - startedAt });
  res.end();
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

server.listen(config.port, config.host, () => {
  const missing = describeSources().filter((source) => !source.configured);
  console.log(`Modelium 3D running on http://${config.host}:${config.port}`);
  if (missing.length) {
    console.log(
      `Inactive source(s): ${missing.map((source) => source.label).join(', ')}. See README for setup.`,
    );
  }
});
