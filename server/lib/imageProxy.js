import { Readable } from 'node:stream';
import { request } from './http.js';

/**
 * The three sites serve their images from a handful of CDNs. Proxying them
 * keeps the browser from announcing every search to those CDNs and lets the
 * page work even where a host refuses hotlinking. Only these hosts are
 * reachable through the proxy, so it cannot be used as an open relay.
 */
export const ALLOWED_HOSTS = [
  'media.printables.com',
  'makerworld.bblmw.com',
  'public-cdn.bblmw.com',
  'cdn.thingiverse.com',
  'thingiverse-production-new.s3.amazonaws.com',
  'thingiverse-production-ssl.s3.amazonaws.com',
  'cdn.thingiverse.com.s3.amazonaws.com',
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Enough bytes for every signature below; AVIF needs the most, at 12. */
const SNIFF_BYTES = 16;

/**
 * Decide the content-type from the bytes, not from what the upstream claimed.
 *
 * Both directions of that claim turned out to be useless. These hosts serve
 * *user uploaded* files, so a declared `text/html` — or `image/svg+xml`, which
 * carries script — would run on this origin, right next to /api/settings. And
 * MakerWorld's CDN labels a good half of its images `application/octet-stream`,
 * so simply requiring a declared image type breaks real thumbnails.
 *
 * Reading the signature answers both at once: the type we send is derived from
 * the content, nothing remote-controlled reaches the header, and anything that
 * is not one of these five formats — markup and SVG included — has no signature
 * to match and is refused.
 *
 * @returns {string|null} the type, or null when the bytes are not an image
 */
export function sniffImageType(head) {
  const bytes = Buffer.isBuffer(head) ? head : Buffer.from(head ?? []);
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) {
    return 'image/avif';
  }

  return null;
}

/**
 * A ceiling against a stream that never ends, not a guess at a sensible image
 * size. MakerWorld hands out the uploaded original as its "thumbnail" and 10 MB
 * is ordinary there, so a tight limit rejects real content — measured, after an
 * 8 MB version turned a live thumbnail into a 413. Nothing is buffered beyond
 * the sniff window, so a generous bound costs no memory.
 */
const MAX_BYTES = 32 * 1024 * 1024;

/** Enough for a CDN to bounce to a regional edge, not enough to wander. */
const MAX_HOPS = 3;

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export function isAllowedImage(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && ALLOWED_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

export function proxyUrl(rawUrl) {
  return `/img?u=${encodeURIComponent(rawUrl)}`;
}

/**
 * Follow redirects by hand, checking the allowlist before *every* hop.
 *
 * fetch's own `redirect: 'follow'` would validate only the URL we started with,
 * and these hosts carry user uploaded content — an open redirect on any one of
 * them would otherwise turn this endpoint into a read primitive against
 * 127.0.0.1 or a cloud metadata service.
 *
 * No resolved-IP check is done on top of this, on purpose. A hop to a private
 * address has to name a host, and the seven names above are the only ones that
 * pass; checking the address a name resolves to would be a TOCTOU race against
 * the connection that follows it, and closing that properly means reaching for a
 * custom HTTP agent — a dependency this project does not have.
 */
async function fetchImage(rawUrl) {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!isAllowedImage(current)) return { error: 400, message: 'Image host not allowed' };

    const upstream = await request(current, {
      timeoutMs: 15000,
      redirect: 'manual',
      headers: { accept: 'image/*' },
    });

    if (!REDIRECT_CODES.has(upstream.status)) return { upstream };

    const location = upstream.headers.get('location');
    if (!location) return { error: 502, message: 'Image not available' };

    // Relative targets are legal and common; resolve before re-checking.
    try {
      current = new URL(location, current).toString();
    } catch {
      return { error: 502, message: 'Image not available' };
    }
  }

  return { error: 502, message: 'Too many redirects' };
}

export async function serveImage(rawUrl, response) {
  let outcome;
  try {
    outcome = await fetchImage(rawUrl);
  } catch {
    return fail(response, 502, 'Image fetch failed');
  }

  if (outcome.error) return fail(response, outcome.error, outcome.message);

  const { upstream } = outcome;
  if (!upstream.ok || !upstream.body) {
    return fail(response, upstream.status || 502, 'Image not available');
  }

  const declared = Number.parseInt(upstream.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await upstream.body.cancel().catch(() => {});
    return fail(response, 413, 'Image too large');
  }

  await stream(upstream.body, response);
}

/**
 * Copy the body across, deciding the type from its first bytes and stopping at a
 * byte ceiling.
 *
 * Written as a loop rather than `.pipe()` because a pipe leaves the readable's
 * `error` event unhandled: an upstream that resets mid-image would otherwise
 * throw out of the stream machinery and take the whole process down, which any
 * remote party could trigger at will. Here every failure is just a broken await.
 */
async function stream(body, response) {
  const readable = Readable.fromWeb(body);
  const head = [];
  let buffered = 0;
  let written = 0;
  let type = null;

  const start = (bytes) => {
    type = sniffImageType(bytes);
    if (!type) return false;

    response.writeHead(200, {
      // Derived from the content. Nothing the upstream said reaches this header.
      'content-type': type,
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'public, max-age=86400',
    });
    return true;
  };

  const push = async (chunk) => {
    if (!response.write(chunk)) {
      await new Promise((resolve) => response.once('drain', resolve));
    }
  };

  try {
    for await (const chunk of readable) {
      written += chunk.length;
      if (written > MAX_BYTES) {
        readable.destroy();
        break;
      }

      if (!type) {
        head.push(chunk);
        buffered += chunk.length;
        if (buffered < SNIFF_BYTES) continue;

        const opening = Buffer.concat(head);
        if (!start(opening)) {
          readable.destroy();
          return fail(response, 415, 'Not an image');
        }
        await push(opening);
        continue;
      }

      await push(chunk);
    }

    // A file smaller than the sniff window still has to be judged.
    if (!type) {
      const opening = Buffer.concat(head);
      if (!start(opening)) return fail(response, 415, 'Not an image');
      await push(opening);
    }
  } catch {
    // Upstream reset, client hung up, or the timeout fired.
    readable.destroy();
    if (!response.headersSent) return fail(response, 502, 'Image fetch failed');
  }

  response.end();
}

function fail(response, status, message) {
  if (response.headersSent) return response.end();
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  response.end(message);
}
