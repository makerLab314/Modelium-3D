import assert from 'node:assert/strict';
import test from 'node:test';

import { search } from '../server/sources/makerworld.js';
import { SourceError } from '../server/lib/errors.js';

/**
 * The other famous site's old endpoint kept answering 200 with an empty hit list after it
 * was retired, which is indistinguishable from "nothing matched" unless you
 * look at `total`. These tests pin the current endpoint and the rule that an
 * empty list next to a non-zero total is reported, not swallowed.
 */
function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = original;
    });
}

const jsonResponse = (payload) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const design = (id, title) => ({
  id,
  title,
  slug: 'a-slug',
  cover: 'https://makerworld.bblmw.com/cover.png',
  likeCount: 10,
  downloadCount: 20,
  printCount: 3,
  createTime: '2024-05-01T00:00:00Z',
  designCreator: { name: 'A Maker', handle: 'amaker' },
  nsfw: false,
});

/**
 * The host is pinned too: the site's main domain now answers every API call with a
 * Cloudflare challenge, so drifting back to it would break search outright.
 */
test('the adapter calls the search service on the unchallenged app host', async () => {
  let called = '';

  await withFetch(
    (url) => {
      called = url;
      return Promise.resolve(jsonResponse({ total: 1, hits: [design(1, 'Benchy')] }));
    },
    async () => {
      await search('benchy', { limit: 10 });
    },
  );

  const url = new URL(called);
  assert.equal(url.hostname, 'api.bambulab.com');
  assert.equal(url.pathname, '/v1/search-service/select/design2');
  assert.equal(url.searchParams.get('keyword'), 'benchy');
  assert.equal(url.searchParams.get('orderBy'), 'score');
  assert.equal(url.searchParams.get('offset'), '0');
});

/**
 * The other famous site ignores an `orderBy` it does not know rather than rejecting it, so
 * a wrong value here would look like a working sort and quietly return the
 * default order. Only field names it actually recognises may appear.
 */
test('the requested order is mapped onto a field the API recognises', async () => {
  const expected = { relevance: 'score', popular: 'likeCount', newest: 'score' };

  for (const [sort, orderBy] of Object.entries(expected)) {
    let called = '';
    await withFetch(
      (url) => {
        called = url;
        return Promise.resolve(jsonResponse({ total: 0, hits: [] }));
      },
      () => search('benchy', { limit: 10, sort }),
    );
    assert.equal(new URL(called).searchParams.get('orderBy'), orderBy, `sort=${sort}`);
  }
});

test('offset is passed through for later pages', async () => {
  let called = '';

  await withFetch(
    (url) => {
      called = url;
      return Promise.resolve(jsonResponse({ total: 0, hits: [] }));
    },
    async () => {
      await search('benchy', { limit: 36, offset: 36 });
    },
  );

  assert.equal(new URL(called).searchParams.get('offset'), '36');
});

test('a result is normalized into the shared shape', async () => {
  const { items, total } = await withFetch(
    () => Promise.resolve(jsonResponse({ total: 42, hits: [design(99, 'Voronoi Lamp')] })),
    () => search('lamp', { limit: 10 }),
  );

  assert.equal(total, 42);
  assert.deepEqual(items[0], {
    sourceId: '99',
    title: 'Voronoi Lamp',
    url: 'https://makerworld.com/en/models/99-a-slug',
    author: 'A Maker',
    authorUrl: 'https://makerworld.com/en/@amaker',
    image: {
      thumb: 'https://makerworld.bblmw.com/cover.png',
      full: 'https://makerworld.bblmw.com/cover.png',
    },
    stats: { likes: 10, downloads: 20, prints: 3, rating: null },
    publishedAt: '2024-05-01T00:00:00Z',
    nsfw: false,
    paid: false,
  });
});

test('an empty hit list next to a real total is reported, not passed off as no results', async () => {
  await assert.rejects(
    withFetch(
      () => Promise.resolve(jsonResponse({ total: 3566, hits: null })),
      () => search('benchy', { limit: 10 }),
    ),
    (error) => error instanceof SourceError && error.kind === 'blocked',
  );
});

test('a Cloudflare challenge is named in the error, not left as a bare 403', async () => {
  await assert.rejects(
    withFetch(
      () =>
        Promise.resolve(
          new Response('<title>Just a moment...</title>', {
            status: 403,
            headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
          }),
        ),
      () => search('benchy', { limit: 10 }),
    ),
    (error) =>
      error instanceof SourceError &&
      error.kind === 'blocked' &&
      error.message === 'Upstream answered 403 (Cloudflare challenge)',
  );
});

test('a genuinely empty result set stays empty', async () => {
  const { items, total } = await withFetch(
    () => Promise.resolve(jsonResponse({ total: 0, hits: [] })),
    () => search('asdkjhaskdjh', { limit: 10 }),
  );

  assert.deepEqual(items, []);
  assert.equal(total, 0);
});
