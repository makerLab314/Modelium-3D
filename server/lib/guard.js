import { forbidden } from './errors.js';

/**
 * Who may write to the settings file.
 *
 * These are pure functions over a request's address and headers — no I/O, no
 * clock — so the whole matrix can be exercised in unit tests without a socket.
 *
 * A note on what is deliberately absent: `X-Forwarded-For`, `X-Real-IP` and
 * `Forwarded` are never read, here or anywhere else in this codebase. They are
 * set by whoever is in front of us, which in the worst case is the caller. If a
 * reverse proxy is in play, `MODELIUM_MODE=server` is the answer — not a header
 * we choose to believe.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Extract the hostname from a Host header, minus any port.
 *
 * Written with the URL parser rather than `split(':')` because the obvious
 * version is wrong for IPv6: `'[::1]:8787'.split(':')[0]` is `'['`, which is why
 * the bracketed form used to be silently unreachable.
 */
export function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim();
  if (!raw) return '';

  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isLoopbackAddress(address) {
  const raw = String(address ?? '');
  if (raw === '::1' || raw === '::ffff:127.0.0.1') return true;
  // The whole 127.0.0.0/8 block, not just the canonical address.
  return /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw);
}

/**
 * The `local` mode gate: the request must have come from this machine, and the
 * browser must not have been talked into making it by another site.
 *
 * The Host check is DNS-rebinding defence — it stops a name on the open web from
 * resolving to 127.0.0.1 and reaching us. It is not an authentication control
 * and must not be mistaken for one; that is what `server` mode is for.
 */
export function checkLocalRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return 'Settings are only available from this machine';
  }

  const hostname = hostnameOf(req.headers?.host);
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return 'Settings are only available over a loopback address';
  }

  const site = req.headers?.['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return 'Settings cannot be changed from another site';
  }

  const origin = req.headers?.origin;
  if (origin !== undefined) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return 'Settings cannot be changed from another site';
    }
    if (!LOOPBACK_HOSTS.has(originHost)) {
      return 'Settings cannot be changed from another site';
    }
  } else if (site === undefined) {
    // A browser that omits sec-fetch-site but sends Origin is odd; one that
    // sends neither is a script on this machine, which is allowed.
  }

  if (isWrite(req.method) && req.headers?.['x-modelium-settings'] !== '1') {
    // A cross-origin page cannot set a custom header without a CORS preflight,
    // and this server answers no preflight. That makes this header — not
    // Sec-Fetch-Site, which depends on the browser being recent — the control
    // that actually stops a cross-site write.
    return 'Missing X-Modelium-Settings header';
  }

  return null;
}

export function requireLocalRequest(req) {
  const problem = checkLocalRequest(req);
  if (problem) throw forbidden(problem);
}

export function isWrite(method) {
  return method === 'PUT' || method === 'POST' || method === 'PATCH' || method === 'DELETE';
}
