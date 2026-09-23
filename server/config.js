/**
 * Runtime configuration.
 *
 * Values come from `server/.env` first (see lib/env.js) and can be overridden
 * by real environment variables. The object is mutated in place by refresh()
 * rather than rebuilt, so modules that captured `config` at import time see
 * settings saved through the interface without a restart.
 */

import { loadEnv } from './lib/env.js';

loadEnv();

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const config = {};

export function refreshConfig() {
  /**
   * `local` is a single-user app on one machine; `server` is a shared instance
   * that may sit behind a reverse proxy. The difference is not cosmetic: in
   * `local` the settings panel may rewrite the token file because the request
   * provably came from this machine, and in `server` no such proof exists — a
   * proxy makes every request look local — so the file is read-only except
   * during the one-time setup window.
   */
  const mode = process.env.MODELIUM_MODE === 'server' ? 'server' : 'local';

  Object.assign(config, {
    mode,
    host: process.env.HOST || (mode === 'server' ? '0.0.0.0' : '127.0.0.1'),
    port: int(process.env.PORT, 8787),

    /** How long the first-run window accepts a save. Only meaningful in server mode. */
    setupWindowMs: clamp(int(process.env.MODELIUM_SETUP_WINDOW_MS, 15 * 60 * 1000), 60_000, 3_600_000),
    setupEnabled: bool(process.env.MODELIUM_SETUP, true),

    /** Hard ceiling per source, per page, before merging. */
    perSourceLimit: clamp(int(process.env.PER_SOURCE_LIMIT, 36), 1, 100),

    /** Abort a single upstream request after this many ms. */
    sourceTimeoutMs: clamp(int(process.env.SOURCE_TIMEOUT_MS, 12000), 1000, 120000),

    /** How long a successful search stays in the in-memory cache. */
    cacheTtlMs: int(process.env.CACHE_TTL_MS, 5 * 60 * 1000),
    cacheMaxEntries: int(process.env.CACHE_MAX_ENTRIES, 200),

    /** Route result images through the local server instead of hotlinking. */
    proxyImages: bool(process.env.PROXY_IMAGES, true),

    /** Hide models the source flagged as not safe for work. */
    hideNsfw: bool(process.env.HIDE_NSFW, true),

    /**
     * Thingiverse needs an app token. Create one for free at
     * https://www.thingiverse.com/apps/create (type "Desktop"). Set it here,
     * in the environment, or through Settings in the interface.
     */
    thingiverseToken: (process.env.THINGIVERSE_TOKEN || '').trim(),

    /**
     * Sent upstream so the sites see a normal looking client. The major
     * version here has to stay in step with `chromeMajor` below — real Chrome
     * reports the same number in both places, and a mismatch is a more overt
     * tell than any of the fields being spoofed in the first place.
     */
    userAgent:
      process.env.USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

    /**
     * Real Chromium browsers volunteer these three low-entropy Client Hints on
     * every request, unprompted — no `Accept-CH` round trip required, unlike
     * the high-entropy ones (bitness, full version list, ...) a site has to ask
     * for. A `fetch()` from Node sends none of them, which is a cleaner
     * distinguishing signal than the User-Agent string ever was. This only
     * matches what a stock browser already discloses; it cannot reproduce the
     * TLS/HTTP2 handshake fingerprint an actual Chromium network stack has, so
     * it will not get past a challenge that checks that instead of headers.
     */
    chromeMajor: 131,
  });

  return config;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

refreshConfig();
