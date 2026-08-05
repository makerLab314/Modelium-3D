import { config } from '../config.js';
import { ALLOWED_HOSTS } from './imageProxy.js';

/**
 * Headers that go on every response.
 *
 * The app runs on a machine the user trusts, but it is a server: once it is
 * reachable from a LAN it shares an origin with `/api/settings`, which reads a
 * file containing an API token. Anything that manages to execute script on this
 * origin can read that endpoint, so the policy below is written to make script
 * execution impossible rather than merely unlikely.
 *
 * There is no `font-src` and no `'unsafe-inline'` for styles because the stylesheet
 * contains no `url()`, no `@font-face` and no `@import`, and no script sets inline
 * styles. If that changes, this is the file that has to change with it.
 */

const CDN_SOURCES = ALLOWED_HOSTS.map((host) => `https://${host}`).join(' ');

/**
 * Built per request, not once at boot: `PROXY_IMAGES` is editable in the settings
 * panel and takes effect without a restart (see refreshConfig in config.js), so a
 * policy captured at import time would be wrong for the rest of the process.
 *
 * With proxying on, every thumbnail is served from `/img` on this origin and the
 * policy can stay at `'self'`. With it off, the page hotlinks the same CDNs the
 * image proxy allowlists — one list, two consumers.
 *
 * Note that only `image.thumb` is ever rewritten to `/img` (see withProxiedImages)
 * and only `thumb` is rendered (public/app.js:375). Rendering `image.full` would
 * hotlink a CDN even while proxying is on, and this policy would block it.
 */
function contentSecurityPolicy() {
  const imageSources = config.proxyImages ? "'self'" : `'self' ${CDN_SOURCES}`;

  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${imageSources}`,
    // EventSource and fetch both fall under connect-src.
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Set on the response before any route writes its own headers. `setHeader` is
 * merged into a later `writeHead(status, {...})`, with writeHead winning on a
 * conflict — so a route that needs its own content-type keeps it.
 *
 * No Access-Control-Allow-Origin is set anywhere, deliberately: without it a page
 * on another origin can trigger a request but never read the answer. The
 * same-origin CORP header additionally stops a cross-origin `<img src="/api/...">`
 * from being used to make this server fan out to the three upstream sites.
 */
export function applySecurityHeaders(response) {
  response.setHeader('content-security-policy', contentSecurityPolicy());
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
}
