import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A tiny dotenv: read `server/.env` into process.env at boot, and write single
 * keys back when the user saves them in the interface.
 *
 * Rolling our own keeps the project dependency free, and the file this has to
 * understand is one the app itself writes. The parser is still forgiving about
 * the things people type by hand: `export` prefixes, quotes, inline comments
 * and CRLF line endings.
 */

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the settings file lives, in order of precedence:
 *
 *   1. MODELIUM_ENV_FILE   — an explicit file. The tests use this.
 *   2. MODELIUM_CONFIG_DIR — a directory; the Docker image points it at /data.
 *   3. server/.env         — a git checkout, which is where it has always been.
 *   4. the OS config dir   — an installed copy.
 *
 * Steps 3 and 4 are the packaging half. Installed through npm the code sits in
 * `node_modules/modelium-3d/`, which npm replaces wholesale on every upgrade and
 * which may not even be writable — a token saved there would quietly vanish. So
 * an installed copy keeps its configuration in the user's own config directory,
 * while a checkout keeps the behaviour it has today.
 */
function defaultEnvPath() {
  if (process.env.MODELIUM_ENV_FILE) return path.resolve(process.env.MODELIUM_ENV_FILE);
  if (process.env.MODELIUM_CONFIG_DIR) {
    return path.join(path.resolve(process.env.MODELIUM_CONFIG_DIR), '.env');
  }

  const installed = SERVER_DIR.split(path.sep).includes('node_modules');
  if (!installed) return path.join(SERVER_DIR, '.env');

  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

  return path.join(base, 'modelium-3d', '.env');
}

export const ENV_PATH = defaultEnvPath();

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function parseEnv(text) {
  const values = {};

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = LINE.exec(rawLine);
    if (!match) continue;

    values[match[1]] = unquote(match[2]);
  }

  return values;
}

/**
 * Quoted values keep everything between the quotes (double quotes also expand
 * \n and \t). Unquoted values stop at the first ` #`, which is how people write
 * trailing comments.
 */
function unquote(value) {
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
      .replaceAll('\\"', '"');
  }
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export function readEnvFile(file = ENV_PATH) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Real environment variables win over the file, so `PORT=9000 npm start` still
 * does what it looks like it does.
 */
export function loadEnv(file = ENV_PATH) {
  const values = readEnvFile(file);

  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }

  return values;
}

/**
 * Merge `values` into the file, rewriting keys in place so hand written
 * comments and ordering survive. A value of `null` or `''` removes the key.
 * Also updates process.env so the change takes effect without a restart.
 */
export function updateEnvFile(values, file = ENV_PATH) {
  const existing = readFileOrEmpty(file);
  const lines = existing.split(/\r?\n/);
  const pending = new Map(Object.entries(values));

  const DROP = Symbol('drop');

  const next = lines
    .map((line) => {
      const match = LINE.exec(line);
      if (!match || !pending.has(match[1])) return line;

      const key = match[1];
      const value = pending.get(key);
      pending.delete(key);
      // Clearing a field removes its line entirely, so the file keeps only what
      // was actually set and the built in default takes over again.
      return isBlank(value) ? DROP : `${key}=${serialize(value)}`;
    })
    .filter((line) => line !== DROP);

  // New keys go at the end, separated from whatever was there by one blank line.
  let separated = false;
  for (const [key, value] of pending) {
    if (isBlank(value)) continue; // nothing to remove, nothing to add
    if (!separated) {
      if (next.some((line) => line.trim() !== '')) next.push('');
      separated = true;
    }
    next.push(`${key}=${serialize(value)}`);
  }

  // Collapse runs of blank lines left behind by removals, and never start or
  // end the file with one.
  const body = `${next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd()}\n`;

  writeAtomic(file, body);

  for (const [key, value] of Object.entries(values)) {
    if (isBlank(value)) delete process.env[key];
    else process.env[key] = String(value);
  }

  return body;
}

/**
 * Write through a temporary file and rename over the target.
 *
 * The file holds an API token, so the two things that can go wrong both matter:
 * a crash or a full disk mid-write would otherwise leave a truncated `.env` and
 * lose the token, and `writeFileSync`'s `mode` is only honoured when it creates
 * the file — a `.env` copied from `.env.example` would silently keep 0644.
 * Renaming a fresh 0600 file over the old one fixes both at once.
 *
 * No locking is needed: this function is synchronous from end to end, so two
 * concurrent requests cannot interleave inside it.
 */
function writeAtomic(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const temporary = `${file}.tmp-${process.pid}`;
  let handle;

  try {
    handle = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(handle, body, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }

  try {
    // A no-op on Windows, which has no POSIX mode bits. Harmless there.
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename already consumed it, or the directory went away. Either way
      // the original error below is the one worth reporting.
    }
    throw error;
  }
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** Quote only when the raw form would not round trip. */
function serialize(value) {
  const text = String(value).trim();
  if (/^[A-Za-z0-9_./:@+-]*$/.test(text)) return text;
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}
