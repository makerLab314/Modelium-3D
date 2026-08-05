import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The settings module writes to lib/env.js's ENV_PATH, which is resolved at
// import time — so the redirect has to be in place before the import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelium-settings-'));
process.env.MODELIUM_ENV_FILE = path.join(dir, '.env');

const { describeSettings, saveSettings } = await import('../server/settings.js');
const { config } = await import('../server/config.js');

test.afterEach(() => {
  for (const key of ['THINGIVERSE_TOKEN', 'PER_SOURCE_LIMIT', 'HIDE_NSFW', 'PORT']) {
    delete process.env[key];
  }
});

test('a secret is reported as set, never as a value', async () => {
  await saveSettings({ THINGIVERSE_TOKEN: 'abcdef0123456789' });

  const field = describeSettings().fields.find((entry) => entry.key === 'THINGIVERSE_TOKEN');
  assert.equal(field.set, true);
  assert.equal(field.value, null);
  assert.equal(field.hint, '…6789');

  // And the full token is nowhere in the serialized payload.
  assert.doesNotMatch(JSON.stringify(describeSettings()), /abcdef0123456789/);
});

/**
 * In server mode this endpoint answers anyone who can reach the port, so the two
 * things it may not volunteer are the host's filesystem layout and a head start
 * on the token.
 */
test('redacted settings drop the file path and the secret tail', async () => {
  await saveSettings({ THINGIVERSE_TOKEN: 'abcdef0123456789' });

  const open = describeSettings();
  const redacted = describeSettings({ redact: true });

  assert.equal(typeof open.file, 'string');
  assert.equal(open.readOnly, false);
  assert.equal(redacted.file, null);
  assert.equal(redacted.readOnly, true);

  const field = redacted.fields.find((entry) => entry.key === 'THINGIVERSE_TOKEN');
  assert.equal(field.set, true, 'whether a token exists is still reported');
  assert.equal(field.hint, null, 'but not any part of it');
  assert.doesNotMatch(JSON.stringify(redacted), /6789/);
});

test('saving a token takes effect without a restart', async () => {
  await saveSettings({ THINGIVERSE_TOKEN: 'live-token' });
  assert.equal(config.thingiverseToken, 'live-token');

  await saveSettings({ THINGIVERSE_TOKEN: '' });
  assert.equal(config.thingiverseToken, '');
});

test('unknown keys are refused so a typo cannot write arbitrary variables', async () => {
  await assert.rejects(() => saveSettings({ PATH: '/tmp/evil' }), /Unknown setting/);
  await assert.rejects(() => saveSettings({ NODE_OPTIONS: '--inspect' }), /Unknown setting/);
  assert.equal(fs.readFileSync(process.env.MODELIUM_ENV_FILE, 'utf8').includes('PATH='), false);
});

test('numbers are range checked', async () => {
  await assert.rejects(() => saveSettings({ PER_SOURCE_LIMIT: '0' }), /between 1 and 100/);
  await assert.rejects(() => saveSettings({ PER_SOURCE_LIMIT: '101' }), /between 1 and 100/);
  await assert.rejects(() => saveSettings({ PER_SOURCE_LIMIT: 'lots' }), /must be a number/);

  await saveSettings({ PER_SOURCE_LIMIT: '12' });
  assert.equal(config.perSourceLimit, 12);
});

test('booleans are normalized to true/false', async () => {
  await saveSettings({ HIDE_NSFW: 'yes' });
  assert.equal(config.hideNsfw, true);

  await saveSettings({ HIDE_NSFW: 'off' });
  assert.equal(config.hideNsfw, false);
});

test('a restart-only field says so', async () => {
  assert.equal((await saveSettings({ PORT: '9000' })).restartRequired, true);
  assert.equal((await saveSettings({ PER_SOURCE_LIMIT: '20' })).restartRequired, false);
});

test('a non-object patch is refused', async () => {
  await assert.rejects(() => saveSettings(null), /Expected an object/);
  await assert.rejects(() => saveSettings(['THINGIVERSE_TOKEN']), /Expected an object/);
});

/**
 * Each save is a read-modify-write of the whole file. Overlapping them without a
 * queue means the second one reads the file before the first one wrote it, and
 * one of the two values disappears.
 */
test('overlapping saves both land instead of clobbering each other', async () => {
  await Promise.all([
    saveSettings({ PER_SOURCE_LIMIT: '42' }),
    saveSettings({ SOURCE_TIMEOUT_MS: '5000' }),
    saveSettings({ HIDE_NSFW: 'no' }),
  ]);

  const body = fs.readFileSync(process.env.MODELIUM_ENV_FILE, 'utf8');
  assert.match(body, /PER_SOURCE_LIMIT=42/);
  assert.match(body, /SOURCE_TIMEOUT_MS=5000/);
  assert.match(body, /HIDE_NSFW=false/);

  delete process.env.SOURCE_TIMEOUT_MS;
});

test('a rejected save does not poison the ones after it', async () => {
  await assert.rejects(() => saveSettings({ PER_SOURCE_LIMIT: '999' }));
  await saveSettings({ PER_SOURCE_LIMIT: '7' });
  assert.equal(config.perSourceLimit, 7);
});
