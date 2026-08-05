/**
 * Live structure canary.
 *
 * These are the only tests that talk to the real sites. They exist to answer
 * one question: do Printables, MakerWorld and Thingiverse still return data in
 * the shape the adapters read? Every one of the three has broken silently
 * before — MakerWorld's old endpoint kept answering 200 with an empty list for
 * weeks — so the assertions are deliberately about *structure*, never about
 * which models come back or how many.
 *
 * Run with `npm run test:live`. CI runs them on a schedule, and a failure here
 * means a site changed, not that the code regressed.
 *
 * Thingiverse needs a token. Without THINGIVERSE_TOKEN in the environment its
 * checks skip rather than fail, so CI needs no secret to be useful.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as makerworld from '../../server/sources/makerworld.js';
import * as printables from '../../server/sources/printables.js';
import * as thingiverse from '../../server/sources/thingiverse.js';

/** A term every one of the three is guaranteed to have plenty of. */
const QUERY = 'benchy';

/**
 * The fields the UI actually depends on. `image` and `author` are allowed to be
 * null on an individual model, so they are checked for presence of the key, not
 * for a value.
 */
function assertShape(item, source) {
  const where = `${source} result`;

  assert.equal(typeof item.sourceId, 'string', `${where}: sourceId must be a string`);
  assert.ok(item.sourceId.length, `${where}: sourceId must not be empty`);

  assert.equal(typeof item.title, 'string', `${where}: title must be a string`);
  assert.ok(item.title.length, `${where}: title must not be empty`);

  assert.match(item.url, /^https:\/\//, `${where}: url must be an absolute https link`);

  assert.ok('author' in item, `${where}: author key missing`);
  assert.ok('image' in item, `${where}: image key missing`);
  assert.ok('publishedAt' in item, `${where}: publishedAt key missing`);

  assert.equal(typeof item.stats, 'object', `${where}: stats must be an object`);
  assert.ok(item.stats !== null, `${where}: stats must not be null`);

  if (item.image) {
    assert.match(item.image.thumb, /^https:\/\//, `${where}: image.thumb must be absolute`);
    assert.match(item.image.full, /^https:\/\//, `${where}: image.full must be absolute`);
  }
}

/** At least one model should carry each of these, or the site changed a field name. */
function assertSomeStats(items, keys, source) {
  for (const key of keys) {
    const present = items.some((item) => typeof item.stats[key] === 'number');
    assert.ok(present, `${source}: no result carried a numeric stats.${key} — field renamed?`);
  }
}

test('Printables still answers searchPrints2 with the fields the adapter reads', async () => {
  const { items, total } = await printables.search(QUERY, { limit: 12 });

  assert.ok(items.length > 0, 'Printables returned no items — schema or endpoint changed');
  assert.equal(typeof total, 'number');

  items.forEach((item) => assertShape(item, 'printables'));
  assert.ok(
    items.every((item) => item.url.startsWith('https://www.printables.com/model/')),
    'Printables model URLs no longer match the expected pattern',
  );
  assertSomeStats(items, ['likes', 'downloads'], 'printables');
});

/**
 * Introspection is disabled, so a renamed field is not a warning — it is a hard
 * error on the whole query. `club` already became `premium` once; this is the
 * check that turns the next rename into a red build instead of a silent wrong
 * answer, and it fails loudly because `readResult` refuses a payload carrying
 * `errors`.
 */
test('Printables still accepts every field the query asks for', async () => {
  const { items } = await printables.search(QUERY, { limit: 3 });

  assert.ok(
    items.every((item) => typeof item.paid === 'boolean'),
    'the paid flag lost its backing fields (price / premium)',
  );
});

test('Printables paginates by offset', async () => {
  const first = await printables.search(QUERY, { limit: 6, offset: 0 });
  const second = await printables.search(QUERY, { limit: 6, offset: 6 });

  assert.ok(second.items.length > 0, 'Printables returned nothing for the second page');

  const firstIds = new Set(first.items.map((item) => item.sourceId));
  const overlap = second.items.filter((item) => firstIds.has(item.sourceId));
  assert.ok(
    overlap.length < second.items.length,
    'Printables ignored offset — every second-page hit repeated the first page',
  );
});

test('MakerWorld still answers on select/design2 with a populated hit list', async () => {
  const { items, total } = await makerworld.search(QUERY, { limit: 12 });

  // The exact failure that went unnoticed: a 200 with nothing in it.
  assert.ok(items.length > 0, 'MakerWorld returned no items — endpoint likely retired again');
  assert.ok(total > 0, 'MakerWorld reported a zero total for a common term');

  items.forEach((item) => assertShape(item, 'makerworld'));
  assert.ok(
    items.every((item) => item.url.startsWith('https://makerworld.com/en/models/')),
    'MakerWorld model URLs no longer match the expected pattern',
  );
  assertSomeStats(items, ['likes', 'downloads'], 'makerworld');
});

test('MakerWorld paginates by offset', async () => {
  const first = await makerworld.search(QUERY, { limit: 6, offset: 0 });
  const second = await makerworld.search(QUERY, { limit: 6, offset: 6 });

  assert.ok(second.items.length > 0, 'MakerWorld returned nothing for the second page');

  const firstIds = new Set(first.items.map((item) => item.sourceId));
  const overlap = second.items.filter((item) => firstIds.has(item.sourceId));
  assert.ok(
    overlap.length < second.items.length,
    'MakerWorld ignored offset — every second-page hit repeated the first page',
  );
});

test('Thingiverse still answers the search API in the documented shape', async (t) => {
  if (!thingiverse.isConfigured()) {
    return t.skip('THINGIVERSE_TOKEN not set');
  }

  const { items, total } = await thingiverse.search(QUERY, { limit: 12 });

  assert.ok(items.length > 0, 'Thingiverse returned no items');
  assert.equal(typeof total, 'number');

  items.forEach((item) => assertShape(item, 'thingiverse'));
  assert.ok(
    items.every((item) => item.url.includes('thingiverse.com')),
    'Thingiverse model URLs no longer match the expected pattern',
  );
});
