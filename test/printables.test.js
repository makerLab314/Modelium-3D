import assert from 'node:assert/strict';
import test from 'node:test';

import { buildImage, readResult, search } from '../server/sources/printables.js';
import { emptyResponse, errorResponse, models, response } from './fixtures/printables-search.js';

/**
 * Stand in for the network so the adapter can be driven end to end. Returns the
 * request the adapter made, which is the half worth asserting on: the query
 * document and the variables are what break when the schema moves.
 */
function withStubbedFetch(payload, run, { status = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return (async () => {
    try {
      return { result: await run(), calls };
    } finally {
      globalThis.fetch = original;
    }
  })();
}

test('readResult pulls the aliased result list out of a GraphQL answer', () => {
  const found = readResult(response);

  assert.equal(found.totalCount, 3709);
  assert.equal(found.items.length, models.length);
  assert.equal(found.items[0].name, 'Voronoi Lamp');
});

test('readResult reads an empty list as zero results, not as a broken schema', () => {
  assert.deepEqual(readResult(emptyResponse), { items: [], totalCount: 0 });
});

test('readResult turns GraphQL errors into a source failure that names the field', () => {
  assert.throws(
    () => readResult(errorResponse),
    (error) => error.kind === 'unavailable' && /Cannot query field 'club'/.test(error.message),
  );
});

test('readResult refuses a payload without a result list instead of returning nothing', () => {
  for (const payload of [null, {}, { data: {} }, { data: { result: {} } }]) {
    assert.throws(() => readResult(payload), /Unexpected answer/);
  }
});

test('search posts the documented query and passes limit and offset through', async () => {
  const { result, calls } = await withStubbedFetch(response, () =>
    search('voronoi lamp', { limit: 2, offset: 36 }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.printables.com/graphql/');
  assert.equal(calls[0].options.method, 'POST');

  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.variables, { query: 'voronoi lamp', limit: 2, offset: 36 });
  assert.match(body.query, /searchPrints2/);
  assert.match(body.query, /ordering: best_match/);

  // The total is the site's, the item count is what we asked for.
  assert.equal(result.total, 3709);
  assert.equal(result.items.length, 2);
});

test('search caps the requested limit at the 100 the API allows', async () => {
  const { calls } = await withStubbedFetch(response, () => search('lamp', { limit: 500 }));
  assert.equal(JSON.parse(calls[0].options.body).variables.limit, 100);
});

test('search normalizes a model into the shared shape', async () => {
  const { result } = await withStubbedFetch(response, () => search('lamp', { limit: 10 }));
  const [first] = result.items;

  assert.equal(first.sourceId, '3161');
  assert.equal(first.title, 'Voronoi Lamp');
  assert.equal(first.url, 'https://www.printables.com/model/3161-voronoi-lamp');
  assert.equal(first.author, 'A Maker');
  assert.equal(first.authorUrl, 'https://www.printables.com/@maker');
  assert.equal(first.stats.likes, 120);
  assert.equal(first.stats.downloads, 3400);
  assert.equal(first.stats.rating, 4.5);
  assert.equal(first.publishedAt, '2023-11-05T09:00:00+00:00');
  assert.equal(first.nsfw, false);
  assert.equal(first.paid, false);
});

/**
 * The field this asserts on used to be called `club`. Asking for the old name is
 * now a hard GraphQL error, so a silent regression here would show up as every
 * paid model looking free.
 */
test('search reads the paid flag from premium, not from the retired club field', async () => {
  const { result } = await withStubbedFetch(response, () => search('lamp', { limit: 10 }));

  assert.equal(result.items.find((item) => item.sourceId === '9002').paid, true);
  assert.equal(result.items.find((item) => item.sourceId === '3161').paid, false);
});

test('search keeps a model whose image and author are missing', async () => {
  const { result } = await withStubbedFetch(response, () => search('lamp', { limit: 10 }));
  const bare = result.items.find((item) => item.sourceId === '9001');

  assert.equal(bare.image, null);
  assert.equal(bare.author, null);
  assert.equal(bare.authorUrl, null);
});

test('buildImage points at the webp derivative and keeps the original extension', () => {
  const image = buildImage('media/prints/3161/images/abc/benchy.png');

  assert.equal(
    image.thumb,
    'https://media.printables.com/media/prints/3161/images/abc/thumbs/inside/640x480/png/benchy.webp',
  );
  assert.ok(image.full.includes('/1280x960/png/'));
});

test('buildImage tolerates a missing or extensionless path', () => {
  assert.equal(buildImage(null), null);
  assert.equal(
    buildImage('media/prints/3161/images/abc/benchy').thumb,
    'https://media.printables.com/media/prints/3161/images/abc/benchy',
  );
});
