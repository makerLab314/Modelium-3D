import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
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
  let relative;
  try {
    relative = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return false; // malformed percent-encoding is a 404, not a crash
  }

  // A NUL byte can truncate the path inside the OS call, past the check below.
  if (relative.includes('\0')) return false;

  const target = path.resolve(root, relative === '' ? 'index.html' : relative);

  if (target !== root && !target.startsWith(root + path.sep)) return false;

  // The prefix check above is about the path the caller asked for. This one is
  // about where that path actually leads: a symlink inside the served directory
  // resolves somewhere else entirely, which matters as soon as anyone mounts a
  // directory in here rather than using the one that shipped.
  let resolved;
  try {
    resolved = await realpath(target);
  } catch {
    return false;
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;

  let info;
  try {
    info = await stat(resolved);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  response.writeHead(200, {
    'content-type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(resolved).pipe(response);
  return true;
}
