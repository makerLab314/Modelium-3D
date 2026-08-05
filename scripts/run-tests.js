#!/usr/bin/env node

/**
 * Run the test files in one directory.
 *
 * `node --test "test/*.test.js"` looks like it should be enough, and it is on
 * Node 22 — but Node 20 has no glob support in the test runner and answers
 * `Could not find 'test/*.test.js'`. Letting the shell expand the glob instead
 * only moves the problem: it works in bash and not in PowerShell, and this is
 * developed on Windows.
 *
 * Listing the files here works on every supported Node and every shell, and it
 * keeps the unit tests and the live tests strictly apart — which matters,
 * because `node --test test/` would sweep test/live/ in with them and quietly
 * turn `npm test` into something that needs a network.
 *
 * Usage: node scripts/run-tests.js <directory> [extra node --test flags]
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const [directory = 'test', ...extra] = process.argv.slice(2);

let files;
try {
  files = readdirSync(directory)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join(directory, name));
} catch (error) {
  console.error(`Cannot read ${directory}: ${error.message}`);
  process.exit(1);
}

if (!files.length) {
  console.error(`No *.test.js files in ${directory}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...extra, ...files], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
