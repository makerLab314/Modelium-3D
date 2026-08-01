import assert from 'node:assert/strict';
import test from 'node:test';

import { dedupe, fuse, sortResults, titleRelevance } from '../server/lib/rank.js';

const item = (source, title, overrides = {}) => ({
  source,
  sourceLabel: source,
  title,
  url: `https://${source}.example/${title.replaceAll(' ', '-')}`,
  author: 'A Maker',
  stats: { likes: 10, downloads: 100 },
  publishedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

test('titleRelevance rewards exact and partial matches in that order', () => {
  const exact = titleRelevance('Voronoi Lamp', 'voronoi lamp');
  const partial = titleRelevance('Voronoi Lamp Shade With Base', 'voronoi lamp');
  const unrelated = titleRelevance('Cable Clip', 'voronoi lamp');

  assert.ok(exact > partial, 'an exact title should beat a longer one');
  assert.ok(partial > unrelated, 'a partial match should beat no match');
  assert.equal(unrelated, 0);
});

test('titleRelevance ignores case, punctuation and accents', () => {
  assert.ok(titleRelevance('VORONOI-LAMP!', 'voronoi lamp') > 0.9);
  assert.ok(titleRelevance('Cistecký Dragon', 'cistecky dragon') > 0.9);
});

test('fuse interleaves sources instead of letting the largest one win', () => {
  const big = { source: 'a', items: Array.from({ length: 8 }, (_, i) => item('a', `Model ${i}`)) };
  const small = { source: 'b', items: [item('b', 'Model 0')] };

  const order = sortResults(fuse([big, small], 'model 0'), 'relevance').map((r) => r.source);

  // Both top hits are equally relevant, so the small source has to reach rank 2.
  assert.deepEqual(order.slice(0, 2).sort(), ['a', 'b']);
});

test('fuse ranks the better title match above a merely popular one', () => {
  const lists = [
    {
      source: 'a',
      items: [
        item('a', 'Lamp Shade Collection', { stats: { likes: 9000, downloads: 90000 } }),
        item('a', 'Voronoi Lamp', { stats: { likes: 1, downloads: 1 } }),
      ],
    },
  ];

  const [first] = sortResults(fuse(lists, 'voronoi lamp'), 'relevance');
  assert.equal(first.title, 'Voronoi Lamp');
});

test('dedupe folds a cross posted model into one card with an also on link', () => {
  const merged = dedupe([
    { ...item('printables', 'Voronoi Lamp'), score: 2 },
    { ...item('makerworld', 'voronoi  lamp!'), score: 1 },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'printables');
  assert.deepEqual(
    merged[0].alsoOn.map((entry) => entry.source),
    ['makerworld'],
  );
  assert.ok(merged[0].score > 2, 'being listed twice should raise the score');
});

test('dedupe keeps two entries from the same site as two results', () => {
  const merged = dedupe([
    { ...item('printables', 'Bracket'), score: 2 },
    { ...item('printables', 'Bracket'), score: 1 },
  ]);

  assert.equal(merged.length, 2);
  assert.ok(merged.every((entry) => entry.alsoOn.length === 0));
});

test('dedupe treats the same title by different authors as different models', () => {
  const merged = dedupe([
    { ...item('printables', 'Bracket', { author: 'Ada' }), score: 2 },
    { ...item('makerworld', 'Bracket', { author: 'Grace' }), score: 1 },
  ]);

  assert.equal(merged.length, 2);
});

test('sortResults honours popular and newest', () => {
  const items = [
    { ...item('a', 'Old but loved', { stats: { likes: 900, downloads: 0 } }), score: 1, publishedAt: '2019-01-01T00:00:00Z' },
    { ...item('b', 'New and quiet', { stats: { likes: 1, downloads: 0 } }), score: 2, publishedAt: '2025-01-01T00:00:00Z' },
  ];

  assert.equal(sortResults(items, 'popular')[0].title, 'Old but loved');
  assert.equal(sortResults(items, 'newest')[0].title, 'New and quiet');
  assert.equal(sortResults(items, 'relevance')[0].title, 'New and quiet');
});
