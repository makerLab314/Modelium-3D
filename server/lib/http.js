import http from 'node:http';

import { config } from '../config.js';
import { SourceError } from './errors.js';

/**
 * Printables answers with a ~18 KB `Link` header full of preload hints, and
 * Node's HTTP parser rejects any response whose headers exceed 16 KB by
 * default. The limit is process wide and can only be raised on the command
 * line, so `npm start` passes --max-http-header-size and this is the check that
 * turns the resulting `fetch failed` into something a human can act on.
 */
export const REQUIRED_HEADER_SIZE = 64 * 1024;

export function headerLimitOk() {
  return http.maxHeaderSize >= REQUIRED_HEADER_SIZE;
}

export const HEADER_LIMIT_HINT =
  `Node's HTTP header limit is ${Math.round(http.maxHeaderSize / 1024)} KB, which is too small for this site. ` +
  'Start the server with `npm start` (it passes --max-http-header-size=65536).';

/**
 * fetch() with a timeout, sane default headers and error messages that are
 * safe to show a user.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: Record<string,string>, method?: string,
 *           body?: string, signal?: AbortSignal, redirect?: RequestRedirect }} [options]
 */
export async function request(url, options = {}) {
  const {
    timeoutMs = config.sourceTimeoutMs,
    headers = {},
    method = 'GET',
    body,
    signal,
    redirect = 'follow',
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    return await fetch(url, {
      method,
      body,
      redirect,
      signal: controller.signal,
      headers: {
        'user-agent': config.userAgent,
        'accept-language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (controller.signal.aborted) {
      throw new SourceError(`No answer within ${Math.round(timeoutMs / 1000)}s`, 'timeout');
    }
    // fetch() flattens every transport failure into "fetch failed"; the reason
    // is one level down in `cause` and is the only useful half of the message.
    const cause = error.cause;
    if (cause?.code === 'UND_ERR_HEADERS_OVERFLOW') {
      throw new SourceError(HEADER_LIMIT_HINT, 'misconfigured');
    }
    throw new SourceError(`Network request failed: ${describe(error)}`, 'unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** DNS failures and resets carry their detail on `cause`, not on the error. */
function describe(error) {
  const cause = error.cause;
  if (!cause) return error.message;
  return cause.code ? `${cause.code} (${cause.message ?? error.message})` : cause.message;
}

export async function requestText(url, options) {
  const response = await request(url, options);
  if (!response.ok) {
    throw new SourceError(
      `Upstream answered ${response.status}`,
      response.status === 403 || response.status === 429 ? 'blocked' : 'unavailable',
    );
  }
  return response.text();
}

export async function requestJson(url, options) {
  const response = await request(url, {
    ...options,
    headers: { accept: 'application/json', ...(options?.headers ?? {}) },
  });
  const text = await response.text();

  if (!response.ok) {
    const kind =
      response.status === 401 || response.status === 403
        ? 'blocked'
        : response.status === 429
          ? 'blocked'
          : 'unavailable';
    throw new SourceError(`Upstream answered ${response.status}`, kind);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError('Upstream sent something that is not JSON', 'unavailable');
  }
}
