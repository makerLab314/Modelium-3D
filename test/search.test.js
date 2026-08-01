import assert from 'node:assert/strict';
import test from 'node:test';

import { config } from '../server/config.js';
import { merge, resolveSources, searchSource } from '../server/search.js';
import { describeSources, sourceIds } from '../server/sources/index.js';

const okReport = (source, items) => ({
  source,
  sourceLabel: source,
  status: 'ok',
  items,
  total: items.length,
  message: null,
  docsUrl: null,
  tookMs: 10,
  cached: false,
});

const hit = (source, title) => ({
  id: `${source}:1`,
  source,
  sourceLabel: source,
  title,
  url: `https://${source}.example/1`,
  author: 'A Maker',
  image: { thumb: 't', full: 'f' },
  stats: { likes: 5, downloads: 50 },
  publishedAt: '2024-01-01T00:00:00Z',
});

test('resolveSources falls back to every source for empty or unknown input', () => {
  assert.deepEqual(resolveSources([]), sourceIds);
  assert.deepEqual(resolveSources(undefined), sourceIds);
  assert.deepEqual(resolveSources(['nope']), sourceIds);
  assert.deepEqual(resolveSources([' Printables ']), ['printables']);
});

test('merge reports a failed source without dropping the healthy ones', () => {
  const merged = merge(
    [
      okReport('printables', [hit('printables', 'Voronoi Lamp')]),
      {
        source: 'makerworld',
        sourceLabel: 'MakerWorld',
        status: 'blocked',
        items: [],
        total: 0,
        message: 'Upstream answered 403',
        docsUrl: null,
        tookMs: 5,
        cached: false,
      },
    ],
    'voronoi lamp',
  );

  assert.equal(merged.results.length, 1);
  assert.equal(merged.sources.length, 2);

  const blocked = merged.sources.find((source) => source.source === 'makerworld');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.count, 0);
  assert.equal(blocked.message, 'Upstream answered 403');
  // The payload sent to the browser carries counts, not the raw item arrays.
  assert.equal(blocked.items, undefined);
});

test('merge falls back to relevance for an unknown sort mode', () => {
  const merged = merge([okReport('printables', [hit('printables', 'Lamp')])], 'lamp', 'sideways');
  assert.equal(merged.sort, 'relevance');
});

test('a source that needs credentials says so instead of failing silently', async () => {
  const token = config.thingiverseToken;
  config.thingiverseToken = '';

  try {
    const report = await searchSource('thingiverse', 'benchy');

    assert.equal(report.status, 'needs-key');
    assert.match(report.message, /THINGIVERSE_TOKEN/);
    assert.equal(report.docsUrl, 'https://www.thingiverse.com/apps/create');
    assert.deepEqual(report.items, []);
  } finally {
    config.thingiverseToken = token;
  }
});

test('an unknown source id is answered, not thrown', async () => {
  const report = await searchSource('sketchfab', 'benchy');
  assert.equal(report.status, 'error');
  assert.deepEqual(report.items, []);
});

test('the registry advertises which sources are ready to use', () => {
  const described = describeSources();

  assert.deepEqual(
    described.map((source) => source.id),
    sourceIds,
  );
  assert.ok(described.every((source) => source.homepage.startsWith('https://')));
  assert.equal(described.find((source) => source.id === 'printables').configured, true);
});
