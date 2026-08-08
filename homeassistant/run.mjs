#!/usr/bin/env node

/**
 * The add-on entrypoint: translate Home Assistant's options into the
 * environment, hand /data to the unprivileged user, drop root, start the server.
 *
 * `.mjs` rather than `.js` on purpose. `npm install` leaves a /app/package.json
 * without a `type` field, which would make a plain `.js` file here CommonJS and
 * every `import` below a syntax error.
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = '/data';
const OPTIONS_FILE = path.join(DATA_DIR, 'options.json');
const UID = 1000;
const GID = 1000;

/**
 * Add-on option to environment variable.
 *
 * An allowlist rather than a loop over whatever the file contains. The Supervisor
 * writes options.json from the schema in config.yaml, so the keys are known — but
 * mapping every key it happens to hold onto the environment would turn a future
 * schema edit into a way of setting MODELIUM_MODE. The variables the Dockerfile
 * fixes stay fixed.
 */
const VARIABLES = {
  thingiverse_token: 'THINGIVERSE_TOKEN',
  per_source_limit: 'PER_SOURCE_LIMIT',
  source_timeout_ms: 'SOURCE_TIMEOUT_MS',
  hide_nsfw: 'HIDE_NSFW',
  proxy_images: 'PROXY_IMAGES',
};

applyOptions(readOptions());
takeOwnershipAndDropRoot();

// Resolved through /app/node_modules, where the Dockerfile installed it. The
// package declares no `exports` field, so its subpaths are importable by path.
await import('modelium-3d/server/index.js');

function readOptions() {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
  } catch (error) {
    // Starting before anything has ever been saved leaves no options file, which
    // is not a problem: every option in config.yaml has a default. Malformed JSON
    // is a problem, and is left to throw.
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function applyOptions(options) {
  for (const [option, variable] of Object.entries(VARIABLES)) {
    const value = options[option];

    // Home Assistant represents "not filled in" for an optional password field as
    // an empty string. Passing that through would set THINGIVERSE_TOKEN to '',
    // which reads as configured-but-broken rather than as unconfigured.
    if (value === undefined || value === null || value === '') continue;

    process.env[variable] = String(value);
  }

  console.log(
    `Modelium add-on: Thingiverse token ${process.env.THINGIVERSE_TOKEN ? 'set' : 'not set'}`,
  );
}

/**
 * The Supervisor creates /data as root, and the server runs as uid 1000.
 *
 * That is the ownership trap the main Dockerfile documents, arriving from the
 * other direction, and it fails just as quietly: an unwritable config directory
 * does not stop the server from starting, it just makes it unconfigurable.
 *
 * Root is needed for the chown and for nothing else, so it is given up on the
 * next line. An add-on that puts a port on the network has no business keeping
 * it.
 */
function takeOwnershipAndDropRoot() {
  if (process.getuid?.() !== 0) return;
  if (fs.existsSync(DATA_DIR)) chownTree(DATA_DIR);

  // Group before user: after setuid the process can no longer change its group.
  process.setgid(GID);
  process.setuid(UID);
}

function chownTree(dir) {
  fs.chownSync(dir, UID, GID);

  for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, child.name);

    // isDirectory() comes from lstat, so a symlink lands in the else branch and
    // lchown refuses to follow it back out of /data.
    if (child.isDirectory()) chownTree(full);
    else fs.lchownSync(full, UID, GID);
  }
}
