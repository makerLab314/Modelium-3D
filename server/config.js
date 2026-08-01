/**
 * Runtime configuration. Everything is overridable through env vars so the
 * prototype can be tuned without touching code.
 */

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 8787),

  /** Hard ceiling per source before merging. */
  perSourceLimit: int(process.env.PER_SOURCE_LIMIT, 36),

  /** Abort a single upstream request after this many ms. */
  sourceTimeoutMs: int(process.env.SOURCE_TIMEOUT_MS, 12000),

  /** How long a successful search stays in the in-memory cache. */
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 5 * 60 * 1000),
  cacheMaxEntries: int(process.env.CACHE_MAX_ENTRIES, 200),

  /** Route result images through the local server instead of hotlinking. */
  proxyImages: bool(process.env.PROXY_IMAGES, true),

  /** Hide models the source flagged as not safe for work. */
  hideNsfw: bool(process.env.HIDE_NSFW, true),

  /**
   * Thingiverse needs an app token. Create one for free at
   * https://www.thingiverse.com/apps/create (type "Desktop") and export it
   * as THINGIVERSE_TOKEN before starting the server.
   */
  thingiverseToken: process.env.THINGIVERSE_TOKEN || '',

  /** Sent upstream so the sites see a normal looking client. */
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
