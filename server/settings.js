/**
 * The settings surface behind the interface's Settings panel.
 *
 * Everything here writes to `server/.env`, which is the same file you would
 * edit by hand and the same file the server reads at boot — so a value saved in
 * the browser and a value typed into the file are indistinguishable afterwards.
 *
 * Secrets go in but never come back out: reads return whether a field is set
 * and a short tail of it, never the value.
 */

import { config, refreshConfig } from './config.js';
import { ENV_PATH, readEnvFile, updateEnvFile } from './lib/env.js';
// The shared helper, not a local one: it carries the `expose` flag that lets the
// HTTP layer show this message. Without it every rejected value reads as
// "Internal error", which tells the user nothing about what they typed wrong.
import { badRequest } from './lib/errors.js';
import { getSource } from './sources/index.js';

/**
 * `restart: true` marks the fields Node can only apply at boot, so the UI can
 * say so instead of pretending the change already took.
 */
export const FIELDS = [
  {
    key: 'THINGIVERSE_TOKEN',
    label: 'Thingiverse app token',
    type: 'secret',
    source: 'thingiverse',
    help: 'Free. Create a "Desktop" app and copy the App Token.',
    docsUrl: 'https://www.thingiverse.com/apps/create',
    placeholder: '32 hex characters',
  },
  {
    key: 'PER_SOURCE_LIMIT',
    label: 'Results per site',
    type: 'number',
    min: 1,
    max: 100,
    help: 'How many hits to request from each site per page.',
  },
  {
    key: 'SOURCE_TIMEOUT_MS',
    label: 'Timeout per site (ms)',
    type: 'number',
    min: 1000,
    max: 120000,
    help: 'Give up on a slow site after this long.',
  },
  {
    key: 'HIDE_NSFW',
    label: 'Hide models flagged NSFW',
    type: 'boolean',
    help: 'Uses each site’s own flag.',
  },
  {
    key: 'PROXY_IMAGES',
    label: 'Proxy result images',
    type: 'boolean',
    help: 'Serve thumbnails through this server so the CDNs never see your searches.',
  },
  {
    key: 'PORT',
    label: 'Port',
    type: 'number',
    min: 1,
    max: 65535,
    restart: true,
    help: 'Applies the next time the server starts.',
  },
];

const BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

/**
 * What the settings panel renders. Never includes a secret's value.
 *
 * `redact` is set in server mode, where this endpoint answers anyone who can
 * reach the port. Two things then have to go: the absolute path of the settings
 * file, which describes the host's filesystem, and the last four characters of
 * the token, which are a free head start on guessing it. Both are fine to show
 * on a loopback-only instance and neither is fine to publish.
 */
export function describeSettings({ redact = false } = {}) {
  const stored = readEnvFile();

  return {
    file: redact ? null : ENV_PATH,
    readOnly: redact,
    fields: FIELDS.map((field) => {
      const { key, type } = field;
      const raw = process.env[key] ?? '';
      const set = String(raw).trim() !== '';

      return {
        ...field,
        set,
        // Secrets report only a tail, enough to tell two tokens apart.
        value: type === 'secret' ? null : set ? String(raw) : currentDefault(key),
        hint: type === 'secret' && set && !redact ? `…${String(raw).trim().slice(-4)}` : null,
        // A value from the real environment cannot be overwritten by this file.
        overriddenByEnv: set && stored[key] !== raw,
      };
    }),
  };
}

function currentDefault(key) {
  const map = {
    PER_SOURCE_LIMIT: config.perSourceLimit,
    SOURCE_TIMEOUT_MS: config.sourceTimeoutMs,
    HIDE_NSFW: config.hideNsfw,
    PROXY_IMAGES: config.proxyImages,
    PORT: config.port,
  };
  return map[key] ?? '';
}

/**
 * Validate then persist. Only known keys are accepted, so a typo in the request
 * cannot write arbitrary variables into the file.
 *
 * @returns {{ saved: string[], restartRequired: boolean }}
 * @throws {Error & { statusCode: number }} on a rejected value
 */
export async function saveSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw badRequest('Expected an object of settings');
  }

  const writes = {};

  for (const [key, raw] of Object.entries(patch)) {
    const field = BY_KEY.get(key);
    if (!field) throw badRequest(`Unknown setting "${key}"`);
    writes[key] = normalize(field, raw);
  }

  if (!Object.keys(writes).length) return { saved: [], restartRequired: false };

  // Serialized so two overlapping saves cannot interleave their read-modify-write
  // of the file. Within one process that is enough; two processes sharing a
  // config directory would still need a real lock, which this does not attempt.
  return queue(() => {
    updateEnvFile(writes);
    refreshConfig();

    const saved = Object.keys(writes);
    return {
      saved,
      restartRequired: saved.some((key) => BY_KEY.get(key)?.restart),
    };
  });
}

let pending = Promise.resolve();

function queue(work) {
  const run = pending.then(work, work);
  // Keep the chain alive even when a save throws, or every later save is rejected.
  pending = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalize(field, raw) {
  // Empty means "unset this and fall back to the default".
  if (raw === null || raw === undefined || String(raw).trim() === '') return '';

  const value = String(raw).trim();

  if (field.type === 'number') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) throw badRequest(`${field.label} must be a number`);
    if (parsed < field.min || parsed > field.max) {
      throw badRequest(`${field.label} must be between ${field.min} and ${field.max}`);
    }
    return String(parsed);
  }

  if (field.type === 'boolean') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) ? 'true' : 'false';
  }

  if (field.type === 'secret' && /\s/.test(value)) {
    throw badRequest(`${field.label} must not contain spaces`);
  }

  return value;
}

/**
 * Try a token against the live API before the user commits to it, so a typo
 * surfaces here instead of as a failed search later.
 *
 * `candidate` is the value the user just typed, passed straight to the adapter
 * rather than saved first. The panel used to save-then-test, which in server
 * mode would have spent the single setup window on an unverified token.
 */
export async function testSource(sourceId, candidate) {
  const source = getSource(sourceId);
  if (!source) throw badRequest(`Unknown source "${sourceId}"`);

  try {
    const { items } = await source.search('benchy', { limit: 1, offset: 0, token: candidate });
    return { ok: true, message: `${source.label} answered with ${items.length ? 'results' : 'no results'}` };
  } catch (error) {
    return { ok: false, message: error.message, kind: error.kind ?? 'error' };
  }
}

