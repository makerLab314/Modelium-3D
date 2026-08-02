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

test('a secret is reported as set, never as a value', () => {
  saveSettings({ THINGIVERSE_TOKEN: 'abcdef0123456789' });

  const field = describeSettings().fields.find((entry) => entry.key === 'THINGIVERSE_TOKEN');
  assert.equal(field.set, true);
  assert.equal(field.value, null);
  assert.equal(field.hint, '…6789');

  // And the full token is nowhere in the serialized payload.
  assert.doesNotMatch(JSON.stringify(describeSettings()), /abcdef0123456789/);
});

test('saving a token takes effect without a restart', () => {
  saveSettings({ THINGIVERSE_TOKEN: 'live-token' });
  assert.equal(config.thingiverseToken, 'live-token');

  saveSettings({ THINGIVERSE_TOKEN: '' });
  assert.equal(config.thingiverseToken, '');
});

test('unknown keys are refused so a typo cannot write arbitrary variables', () => {
  assert.throws(() => saveSettings({ PATH: '/tmp/evil' }), /Unknown setting/);
  assert.throws(() => saveSettings({ NODE_OPTIONS: '--inspect' }), /Unknown setting/);
  assert.equal(fs.readFileSync(process.env.MODELIUM_ENV_FILE, 'utf8').includes('PATH='), false);
});

test('numbers are range checked', () => {
  assert.throws(() => saveSettings({ PER_SOURCE_LIMIT: '0' }), /between 1 and 100/);
  assert.throws(() => saveSettings({ PER_SOURCE_LIMIT: '101' }), /between 1 and 100/);
  assert.throws(() => saveSettings({ PER_SOURCE_LIMIT: 'lots' }), /must be a number/);

  saveSettings({ PER_SOURCE_LIMIT: '12' });
  assert.equal(config.perSourceLimit, 12);
});

test('booleans are normalized to true/false', () => {
  saveSettings({ HIDE_NSFW: 'yes' });
  assert.equal(config.hideNsfw, true);

  saveSettings({ HIDE_NSFW: 'off' });
  assert.equal(config.hideNsfw, false);
});

test('a restart-only field says so', () => {
  assert.equal(saveSettings({ PORT: '9000' }).restartRequired, true);
  assert.equal(saveSettings({ PER_SOURCE_LIMIT: '20' }).restartRequired, false);
});

test('a non-object patch is refused', () => {
  assert.throws(() => saveSettings(null), /Expected an object/);
  assert.throws(() => saveSettings(['THINGIVERSE_TOKEN']), /Expected an object/);
});
