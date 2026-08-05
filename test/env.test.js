import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadEnv, parseEnv, readEnvFile, updateEnvFile } from '../server/lib/env.js';

/** Each test gets its own throwaway file; nothing here touches the real .env. */
function tempFile(contents = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelium-env-'));
  const file = path.join(dir, '.env');
  if (contents) fs.writeFileSync(file, contents);
  return file;
}

test('parseEnv understands the shapes people actually type', () => {
  const parsed = parseEnv(
    [
      '# a comment',
      '',
      'PLAIN=value',
      '  SPACED  =  padded  ',
      'export EXPORTED=shell-style',
      'QUOTED="keeps spaces"',
      "SINGLE='literal $VALUE'",
      'TRAILING=value # not part of it',
      'HASH_IN_QUOTES="a#b"',
      'EMPTY=',
      'not a line at all',
    ].join('\r\n'),
  );

  assert.equal(parsed.PLAIN, 'value');
  assert.equal(parsed.SPACED, 'padded');
  assert.equal(parsed.EXPORTED, 'shell-style');
  assert.equal(parsed.QUOTED, 'keeps spaces');
  assert.equal(parsed.SINGLE, 'literal $VALUE');
  assert.equal(parsed.TRAILING, 'value');
  assert.equal(parsed.HASH_IN_QUOTES, 'a#b');
  assert.equal(parsed.EMPTY, '');
  assert.equal(Object.hasOwn(parsed, 'not a line at all'), false);
});

test('a missing file reads as empty rather than throwing', () => {
  assert.deepEqual(readEnvFile(path.join(os.tmpdir(), 'modelium-does-not-exist', '.env')), {});
});

test('real environment variables win over the file', () => {
  const file = tempFile('MODELIUM_TEST_A=from-file\nMODELIUM_TEST_B=from-file\n');
  process.env.MODELIUM_TEST_A = 'from-shell';
  delete process.env.MODELIUM_TEST_B;

  try {
    loadEnv(file);
    assert.equal(process.env.MODELIUM_TEST_A, 'from-shell');
    assert.equal(process.env.MODELIUM_TEST_B, 'from-file');
  } finally {
    delete process.env.MODELIUM_TEST_A;
    delete process.env.MODELIUM_TEST_B;
  }
});

test('updating a key rewrites it in place and leaves comments alone', () => {
  const file = tempFile(
    ['# Keep me', 'THINGIVERSE_TOKEN=old', '', '# And me', 'PORT=8787', ''].join('\n'),
  );

  updateEnvFile({ THINGIVERSE_TOKEN: 'new' }, file);
  const body = fs.readFileSync(file, 'utf8');

  assert.match(body, /# Keep me/);
  assert.match(body, /# And me/);
  assert.match(body, /^THINGIVERSE_TOKEN=new$/m);
  assert.doesNotMatch(body, /old/);
  assert.equal(readEnvFile(file).PORT, '8787');

  delete process.env.THINGIVERSE_TOKEN;
});

test('a new key is appended once, separated by a single blank line', () => {
  const file = tempFile('EXISTING=1\n');
  updateEnvFile({ ADDED_ONE: 'a', ADDED_TWO: 'b' }, file);

  const body = fs.readFileSync(file, 'utf8');
  assert.equal(body, 'EXISTING=1\n\nADDED_ONE=a\nADDED_TWO=b\n');

  delete process.env.ADDED_ONE;
  delete process.env.ADDED_TWO;
});

test('writing to a file that does not exist yet produces no leading blank line', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modelium-env-')), '.env');
  updateEnvFile({ THINGIVERSE_TOKEN: 'abc' }, file);

  assert.equal(fs.readFileSync(file, 'utf8'), 'THINGIVERSE_TOKEN=abc\n');
  delete process.env.THINGIVERSE_TOKEN;
});

test('clearing a value removes its line and unsets it', () => {
  const file = tempFile('A=1\nTHINGIVERSE_TOKEN=secret\nB=2\n');
  process.env.THINGIVERSE_TOKEN = 'secret';

  updateEnvFile({ THINGIVERSE_TOKEN: '' }, file);

  const body = fs.readFileSync(file, 'utf8');
  assert.equal(body, 'A=1\nB=2\n');
  assert.equal(process.env.THINGIVERSE_TOKEN, undefined);
});

test('values needing quotes round trip through a write and read', () => {
  const file = tempFile();
  updateEnvFile({ USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0) "quoted"' }, file);

  assert.equal(readEnvFile(file).USER_AGENT, 'Mozilla/5.0 (Windows NT 10.0) "quoted"');
  delete process.env.USER_AGENT;
});

/**
 * The file holds an API token, and `writeFileSync`'s `mode` is only honoured
 * when it creates the file. A `.env` copied from `.env.example` would otherwise
 * keep whatever permissions it arrived with.
 */
test('writing tightens the permissions of a file that already existed', { skip: process.platform === 'win32' && 'POSIX mode bits only' }, () => {
  const file = tempFile('A=1\n');
  fs.chmodSync(file, 0o644);

  updateEnvFile({ THINGIVERSE_TOKEN: 'secret' }, file);

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  delete process.env.THINGIVERSE_TOKEN;
});

test('a write leaves no temporary file behind', () => {
  const file = tempFile('A=1\n');
  updateEnvFile({ PORT: '9000' }, file);

  const stray = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(stray, [], 'the temporary file should have been renamed away');
  delete process.env.PORT;
});

test('a failing write leaves the previous contents intact', () => {
  const file = tempFile('THINGIVERSE_TOKEN=original\n');
  // A directory where the temporary file wants to go makes the write fail
  // after the original is already on disk — the case truncate-in-place lost.
  fs.mkdirSync(`${file}.tmp-${process.pid}`);

  assert.throws(() => updateEnvFile({ THINGIVERSE_TOKEN: 'replacement' }, file));
  assert.equal(fs.readFileSync(file, 'utf8'), 'THINGIVERSE_TOKEN=original\n');
});
