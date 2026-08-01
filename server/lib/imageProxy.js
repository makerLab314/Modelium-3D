import { Readable } from 'node:stream';
import { request } from './http.js';

/**
 * The three sites serve their images from a handful of CDNs. Proxying them
 * keeps the browser from announcing every search to those CDNs and lets the
 * page work even where a host refuses hotlinking. Only these hosts are
 * reachable through the proxy, so it cannot be used as an open relay.
 */
const ALLOWED_HOSTS = [
  'media.printables.com',
  'makerworld.bblmw.com',
  'public-cdn.bblmw.com',
  'cdn.thingiverse.com',
  'thingiverse-production-new.s3.amazonaws.com',
  'thingiverse-production-ssl.s3.amazonaws.com',
  'cdn.thingiverse.com.s3.amazonaws.com',
];

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

export async function serveImage(rawUrl, response) {
  if (!isAllowedImage(rawUrl)) {
    response.writeHead(400, { 'content-type': 'text/plain' });
    response.end('Image host not allowed');
    return;
  }

  let upstream;
  try {
    upstream = await request(rawUrl, { timeoutMs: 15000, headers: { accept: 'image/*' } });
  } catch {
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('Image fetch failed');
    return;
  }

  if (!upstream.ok || !upstream.body) {
    response.writeHead(upstream.status || 502, { 'content-type': 'text/plain' });
    response.end('Image not available');
    return;
  }

  response.writeHead(200, {
    'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
    'cache-control': 'public, max-age=86400',
  });
  Readable.fromWeb(upstream.body).pipe(response);
}
