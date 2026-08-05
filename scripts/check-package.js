#!/usr/bin/env node

/**
 * Assert what `npm publish` would actually upload.
 *
 * The `files` allowlist and `.npmignore` both say the right thing, but neither
 * is verified by anything, and the failure they guard against — shipping
 * `server/.env` with a live Thingiverse token in it — cannot be undone once it
 * reaches the registry. So this asks npm to list the tarball and checks the
 * answer.
 */

import { execFileSync } from 'node:child_process';

/** Anything matching these must never be in the tarball. */
const FORBIDDEN = [
  { pattern: /(^|\/)\.env($|\.)(?!example)/, why: 'holds a live API token' },
  { pattern: /^test\//, why: 'not needed to run' },
  { pattern: /^scripts\//, why: 'not needed to run' },
  { pattern: /^\.github\//, why: 'not needed to run' },
  { pattern: /^\.claude\//, why: 'local editor state' },
  { pattern: /\.log$/, why: 'local run output' },
  { pattern: /(^|\/)node_modules\//, why: 'never packaged' },
];

/** Without these the package does not work at all. */
const REQUIRED = [
  'package.json',
  'bin/modelium.js',
  'server/index.js',
  'server/app.js',
  'public/index.html',
  'public/app.js',
  'README.md',
  'LICENSE',
];

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const [tarball] = JSON.parse(raw);
const files = tarball.files.map((entry) => entry.path.replace(/\\/g, '/'));

const problems = [];

for (const file of files) {
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(file)) problems.push(`must not ship: ${file}  (${why})`);
  }
}

for (const needed of REQUIRED) {
  if (!files.includes(needed)) problems.push(`missing from the package: ${needed}`);
}

const megabytes = tarball.unpackedSize / 1024 / 1024;
if (megabytes > 5) {
  problems.push(`unpacked size is ${megabytes.toFixed(1)} MB — something unintended got in`);
}

console.log(`${files.length} files, ${(tarball.size / 1024).toFixed(0)} KB packed, ${megabytes.toFixed(2)} MB unpacked`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s) with the package:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('Package contents look right.');
