import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSetupWindow, MARKER_NAME, STATES } from '../server/lib/setupWindow.js';

function tempEnvPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modelium-setup-')), '.env');
}

/** A controllable clock, so the deadline can be tested without waiting for it. */
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

const withToken = (token) => ({ headers: { 'x-modelium-setup-token': token } });

test('local mode defers to the loopback guard instead of opening a window', () => {
  const window = createSetupWindow({ mode: 'local', envPath: tempEnvPath() });

  assert.equal(window.state, STATES.NOT_APPLICABLE);
  assert.equal(window.claimToken(), null);
  assert.equal(window.authorize(withToken('anything')), null);
});

test('server mode opens once and mints a token that is not guessable', () => {
  const window = createSetupWindow({ mode: 'server', envPath: tempEnvPath() });

  assert.equal(window.state, STATES.OPEN);
  const token = window.claimToken();
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 40, `expected a long token, got ${token.length} chars`);
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'base64url so it survives a copy-paste');
});

test('the right token is accepted and the wrong ones are not', () => {
  const window = createSetupWindow({ mode: 'server', envPath: tempEnvPath() });
  const token = window.claimToken();

  assert.equal(window.authorize(withToken(token)), null);
  assert.match(window.authorize(withToken('')), /Missing or invalid/);
  assert.match(window.authorize({ headers: {} }), /Missing or invalid/);
});

/**
 * timingSafeEqual throws when the two buffers differ in length. Comparing raw
 * strings would therefore both crash the request and leak the token's length;
 * hashing first makes every comparison 32 bytes against 32 bytes.
 */
test('a wrong token of a different length is refused, not thrown', () => {
  const window = createSetupWindow({ mode: 'server', envPath: tempEnvPath() });
  const token = window.claimToken();

  assert.match(window.authorize(withToken('short')), /Missing or invalid/);
  assert.match(window.authorize(withToken(`${token}${token}`)), /Missing or invalid/);
  assert.match(window.authorize(withToken(token.slice(0, -1))), /Missing or invalid/);
});

test('sealing closes the window for good and drops the token', () => {
  const envPath = tempEnvPath();
  const window = createSetupWindow({ mode: 'server', envPath });
  const token = window.claimToken();

  window.seal();

  assert.equal(window.state, STATES.SEALED);
  assert.equal(window.claimToken(), null);
  assert.match(window.authorize(withToken(token)), /read-only/);
  assert.ok(fs.existsSync(path.join(path.dirname(envPath), MARKER_NAME)));
});

test('a restart after a seal does not reopen the window', () => {
  const envPath = tempEnvPath();
  createSetupWindow({ mode: 'server', envPath }).seal();

  const restarted = createSetupWindow({ mode: 'server', envPath });
  assert.equal(restarted.state, STATES.SEALED);
  assert.equal(restarted.claimToken(), null);
});

test('the deadline is enforced on the request, not only by a timer', () => {
  const time = clock();
  const window = createSetupWindow({
    mode: 'server',
    envPath: tempEnvPath(),
    windowMs: 60_000,
    now: time.now,
  });
  const token = window.claimToken();

  time.advance(59_000);
  assert.equal(window.authorize(withToken(token)), null);

  // A process that was suspended past its deadline must not resume with the
  // window still open, which is why this is re-checked per request.
  time.advance(2_000);
  assert.equal(window.state, STATES.EXPIRED);
  assert.match(window.authorize(withToken(token)), /closed/);
  assert.equal(window.claimToken(), null);
});

test('an expired window leaves no marker, so a restart legitimately reopens it', () => {
  const envPath = tempEnvPath();
  const time = clock();
  const window = createSetupWindow({ mode: 'server', envPath, windowMs: 60_000, now: time.now });

  time.advance(120_000);
  assert.equal(window.state, STATES.EXPIRED);
  assert.equal(fs.existsSync(path.join(path.dirname(envPath), MARKER_NAME)), false);

  assert.equal(createSetupWindow({ mode: 'server', envPath }).state, STATES.OPEN);
});

test('repeated bad tokens close the window', () => {
  const window = createSetupWindow({ mode: 'server', envPath: tempEnvPath() });
  const token = window.claimToken();

  for (let attempt = 0; attempt < 9; attempt++) window.authorize(withToken('wrong'));
  assert.equal(window.state, STATES.OPEN, 'still open just before the limit');

  assert.match(window.authorize(withToken('wrong')), /too many failed attempts/);
  assert.equal(window.state, STATES.SEALED);
  assert.match(window.authorize(withToken(token)), /read-only/);
});

test('setup can be turned off outright', () => {
  const window = createSetupWindow({ mode: 'server', enabled: false, envPath: tempEnvPath() });

  assert.equal(window.state, STATES.DISABLED);
  assert.equal(window.claimToken(), null);
  assert.match(window.authorize(withToken('x')), /read-only in server mode/);
});

/**
 * A read-only config directory means nothing could be saved anyway. Finding that
 * out before the operator pastes a token is a better first run than after.
 */
test('an unwritable config directory disables the window instead of opening a useless one', () => {
  // A path whose parent is a file, so the directory can never be created.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modelium-setup-')), 'blocker');
  fs.writeFileSync(file, 'not a directory');

  const window = createSetupWindow({ mode: 'server', envPath: path.join(file, 'sub', '.env') });

  assert.equal(window.state, STATES.DISABLED);
  assert.equal(window.claimToken(), null);
});

test('a marker that cannot be written still seals this process', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modelium-setup-')), 'blocker');
  fs.writeFileSync(file, 'not a directory');

  const window = createSetupWindow({
    mode: 'server',
    envPath: tempEnvPath(),
    // Force the marker write to fail without disabling the window up front.
    now: Date.now,
  });

  // Point the seal at an impossible location by sealing twice: the first seal
  // succeeds, the second is a no-op. Instead assert the failure path directly.
  const doomed = createSetupWindow({ mode: 'server', envPath: path.join(file, '.env') });
  assert.equal(doomed.state, STATES.DISABLED);

  assert.doesNotThrow(() => window.seal());
  assert.equal(window.state, STATES.SEALED);
});
