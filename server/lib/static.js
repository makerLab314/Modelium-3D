import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serve a file from `root`, refusing anything that escapes it.
 * @returns {Promise<boolean>} true when the request was answered
 */
export async function serveStatic(root, urlPath, response) {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.resolve(root, relative === '' ? 'index.html' : relative);

  if (target !== root && !target.startsWith(root + path.sep)) return false;

  let info;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  response.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(target).pipe(response);
  return true;
}
