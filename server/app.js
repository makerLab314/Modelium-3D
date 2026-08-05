import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { badRequest, forbidden, HttpError, notFound } from './lib/errors.js';
import { requireLocalRequest } from './lib/guard.js';
import { applySecurityHeaders } from './lib/headers.js';
import { proxyUrl, serveImage } from './lib/imageProxy.js';
import { callerOf, createRateLimiter } from './lib/ratelimit.js';
import { createSetupWindow, STATES } from './lib/setupWindow.js';
import { ENV_PATH } from './lib/env.js';
import { serveStatic } from './lib/static.js';
import { describeSettings, saveSettings, testSource } from './settings.js';
import { describeSources } from './sources/index.js';
import { merge, resolveSources, searchSource, SORT_MODES } from './search.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/**
 * Read from package.json rather than repeated here, so a release bump cannot
 * leave /api/health reporting a version the package never had.
 */
export const VERSION = readVersion();

function readVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Which methods each route answers. Everything not listed is a 405 with an
 * `Allow` header, rather than the previous behaviour of running the handler for
 * any verb at all.
 */
const ROUTES = {
  '/api/health': ['GET', 'HEAD'],
  '/api/sources': ['GET', 'HEAD'],
  '/api/search': ['GET', 'HEAD'],
  '/img': ['GET', 'HEAD'],
  '/api/settings': ['GET', 'PUT', 'POST'],
  '/api/settings/test': ['POST'],
  '/api/setup/finish': ['POST'],
};

/** One search fans out to three sites; images stream. Both deserve their own budget. */
function buildLimiters() {
  const local = config.mode !== 'server';
  const off = process.env.MODELIUM_RATE_LIMIT === 'off';
  const enabled = !off && !local;

  return {
    expensive: createRateLimiter({ capacity: 20, refillPerSecond: 0.5, enabled }),
    cheap: createRateLimiter({ capacity: 120, refillPerSecond: 2, enabled }),
  };
}

/**
 * Build the server without starting it, so tests can bind an ephemeral port and
 * drive real HTTP against it.
 */
export function createApp({ setupWindow } = {}) {
  const setup =
    setupWindow ??
    createSetupWindow({
      mode: config.mode,
      enabled: config.setupEnabled,
      windowMs: config.setupWindowMs,
      envPath: ENV_PATH,
    });

  const limiters = buildLimiters();
  let openStreams = 0;

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);

    try {
      let url;
      try {
        // A fixed base on purpose: only pathname and searchParams are ever read,
        // and deriving the base from the Host header meant a malformed Host threw
        // here — outside any catch — and took the process down.
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw badRequest('Malformed request URL');
      }

      const allowed = ROUTES[url.pathname];
      if (allowed && !allowed.includes(req.method)) {
        res.writeHead(405, {
          allow: allowed.join(', '),
          'content-type': 'application/json; charset=utf-8',
        });
        return res.end(JSON.stringify({ error: `Use ${allowed.join(' or ')}` }));
      }

      const budget = allowed && (url.pathname === '/api/search' || url.pathname === '/img')
        ? limiters.expensive
        : limiters.cheap;
      const permit = budget.take(callerOf(req));
      if (!permit.ok) {
        res.writeHead(429, {
          'retry-after': String(permit.retryAfter),
          'content-type': 'application/json; charset=utf-8',
        });
        return res.end(JSON.stringify({ error: 'Too many requests' }));
      }

      if (url.pathname === '/api/health') return sendJson(res, 200, health(setup));
      if (url.pathname === '/api/sources') return sendJson(res, 200, { sources: describeSources() });
      if (url.pathname === '/api/search') return await handleSearch(url, req, res);
      if (url.pathname === '/api/settings') return await handleSettings(req, res, setup);
      if (url.pathname === '/api/settings/test') return await handleSettingsTest(url, req, res, setup);
      if (url.pathname === '/api/setup/finish') return handleSetupFinish(req, res, setup);
      if (url.pathname === '/img') return await serveImage(url.searchParams.get('u') ?? '', res);

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (await serveStatic(PUBLIC_DIR, url.pathname, res)) return;
      }

      throw notFound();
    } catch (error) {
      sendError(res, error);
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
    if (!query) throw badRequest('Missing query parameter q');

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

    // Every stream holds three upstream requests open, so the cap here is what
    // stops a handful of clients turning into a fan-out against the three sites.
    if (openStreams >= MAX_STREAMS) {
      res.writeHead(503, { 'retry-after': '5', 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Too many open searches' }));
    }

    openStreams += 1;
    res.on('close', () => {
      openStreams = Math.max(0, openStreams - 1);
    });

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

  return server;
}

/** Concurrent SSE streams. Each one is three upstream requests. */
const MAX_STREAMS = 20;

/**
 * Reading settings is always allowed. Writing them depends on the mode: in
 * `local` the request has to have come from this machine, in `server` it has to
 * carry the one-time setup token.
 */
async function handleSettings(req, res, setup) {
  const redact = config.mode === 'server';

  if (req.method === 'GET') return sendJson(res, 200, describeSettings({ redact }));

  const problem = config.mode === 'server' ? setup.authorize(req) : localProblem(req);
  if (problem) throw forbidden(problem);

  const result = await saveSettings(await readJsonBody(req));

  // Seal only now, after a save actually succeeded. Sealing on the attempt would
  // mean one rejected value costs the operator their single chance.
  if (config.mode === 'server') setup.seal();

  return sendJson(res, 200, { ...result, ...describeSettings({ redact }) });
}

/**
 * Try a token before committing to it. Takes the candidate in the body so the
 * settings panel no longer has to save first — which in server mode would have
 * burned the setup window on an unverified value.
 */
async function handleSettingsTest(url, req, res, setup) {
  const problem = config.mode === 'server' ? setup.authorize(req) : localProblem(req);
  if (problem) throw forbidden(problem);

  const body = await readJsonBody(req);
  const candidate = typeof body?.value === 'string' ? body.value : undefined;

  return sendJson(res, 200, await testSource(url.searchParams.get('source') ?? '', candidate));
}

function handleSetupFinish(req, res, setup) {
  const problem = setup.authorize(req);
  if (problem) throw forbidden(problem);

  setup.seal();
  return sendJson(res, 200, { sealed: true });
}

function localProblem(req) {
  try {
    requireLocalRequest(req);
    return null;
  } catch (error) {
    return error.message;
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
function health(setup) {
  return {
    ok: true,
    version: VERSION,
    node: process.version,
    mode: config.mode,
    // Whether a first-run window is open, never the token that opens it.
    setup: setup.state,
    sources: describeSources(),
  };
}

/** Rewrite image URLs to the local proxy so the browser never calls the CDNs. */
function withProxiedImages(payload) {
  if (!config.proxyImages) return payload;

  return {
    ...payload,
    // Only `thumb` is rewritten because only `thumb` is rendered. If `full` ever
    // reaches the page it will hotlink a CDN, which the CSP in lib/headers.js
    // blocks while proxying is on — rewrite it here if that day comes.
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

/**
 * Only errors raised on purpose carry their message outward. Anything else gets
 * a generic answer, because the previous behaviour — echoing `error.message` —
 * meant a filesystem failure handed the caller an absolute path.
 */
function sendError(res, error) {
  if (res.headersSent) return res.end();

  const status = error instanceof HttpError ? error.statusCode : (error?.statusCode ?? 500);
  const safe = error instanceof HttpError || error?.expose === true;

  if (!safe) console.error('[modelium]', error);

  sendJson(res, status, { error: safe ? error.message : 'Internal error' });
}

export { STATES };
