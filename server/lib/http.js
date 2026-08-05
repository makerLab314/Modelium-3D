import { config } from '../config.js';
import { SourceError } from './errors.js';

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
