import assert from 'node:assert/strict';
import test from 'node:test';

import { dedupe, fuse, sortResults, SORT_MODES, titleRelevance } from '../server/lib/rank.js';

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

/* --- source fairness ---------------------------------------------------- */

/**
 * The bug this whole group exists for: Thingiverse showed up no earlier than
 * rank 16, and under Newest not until rank 71, so the first two pages were only
 * ever Printables and the other famous site.
 */

const dated = (source, title, date, stats = { likes: 10, downloads: 10 }) => ({
  ...item(source, title, { stats }),
  publishedAt: date,
});

test('a site whose titles are verbose still reaches the first page', () => {
  // Every site's top hit is equally good; only the wording differs. This is the
  // shape the other famous site results take — descriptive titles where the other two are
  // terse — and it used to cost the site the whole top of the list.
  const terse = {
    source: 'terse',
    items: Array.from({ length: 20 }, () => item('terse', 'Voronoi Lamp')),
  };
  const verbose = {
    source: 'verbose',
    items: Array.from({ length: 20 }, (_, i) =>
      item('verbose', `Voronoi Lamp for the P1S with an E27 mount, variant ${i}`),
    ),
  };

  const order = sortResults(fuse([terse, verbose], 'voronoi lamp'), 'relevance');
  const first = order.findIndex((entry) => entry.source === 'verbose');

  assert.ok(first < 5, `the verbose site first appeared at rank ${first + 1}, expected inside the top 5`);
});

test('an exact title match cannot outrank a whole site from deep in a list', () => {
  // Position 15 of one site against position 1 of another. The literal title
  // deserves a lift, not a win: the other site's own engine ranked its hit first
  // and that is the stronger signal.
  const lists = [
    {
      source: 'literal',
      items: Array.from({ length: 20 }, () => item('literal', 'Cable Clip')),
    },
    {
      source: 'other',
      items: [item('other', 'Cable Clip Set for Desk Edges'), ...Array.from({ length: 19 }, () => item('other', 'Unrelated'))],
    },
  ];

  const order = sortResults(fuse(lists, 'cable clip'), 'relevance');
  const deep = order.findIndex((entry) => entry.source === 'literal' && entry.sourceRank === 15);
  const rivalTop = order.findIndex((entry) => entry.source === 'other' && entry.sourceRank === 1);

  assert.ok(deep > rivalTop, "a site's 15th hit should not outrank another site's first");
});

test('titleRelevance cannot exceed the range the fusion term can answer', () => {
  // An uncapped score was the actual defect: a token counted as both an exact
  // hit and a substring, plus a +0.5 exact-title bonus, reached 1.5 against a
  // fusion span of 0.56.
  const scores = [
    titleRelevance('Voronoi Lamp', 'voronoi lamp'),
    titleRelevance('Lamp Lamp Lamp Lamp', 'lamp'),
    titleRelevance('Voronoi Lamp Voronoi Lamp', 'voronoi lamp voronoi lamp'),
  ];

  assert.ok(Math.max(...scores) <= 1.15, `titleRelevance reached ${Math.max(...scores)}`);
});

test('a source that reports no counts is not read as unpopular', () => {
  // Thingiverse search hits carry no download_count. Scoring a missing field as
  // zero is a silent penalty on every result the site returns.
  const withStats = {
    source: 'rich',
    items: [item('rich', 'Bracket', { stats: { likes: 100, downloads: 1000 } })],
  };
  const withNone = {
    source: 'bare',
    items: [item('bare', 'Bracket', { stats: {} })],
  };

  const [rich] = fuse([withStats], 'bracket');
  const [bare] = fuse([withNone], 'bracket');

  assert.ok(bare.score > rich.score - 0.2, 'a source without counts was penalised for the missing field');
});

test('newest interleaves the sites instead of handing the page to the busiest one', () => {
  // A site that publishes constantly against one with an older catalogue. Sorted
  // globally by date the busy site takes every slot; fused by position each site
  // contributes its own newest.
  const busy = Array.from({ length: 12 }, (_, i) =>
    dated('busy', `Fresh ${i}`, `2026-08-${String(10 - i).padStart(2, '0')}T00:00:00Z`),
  );
  const slow = Array.from({ length: 12 }, (_, i) => dated('slow', `Older ${i}`, `2019-0${(i % 9) + 1}-01T00:00:00Z`));

  const order = sortResults(fuse([{ source: 'busy', items: busy }, { source: 'slow', items: slow }], 'fresh'), 'newest');

  assert.equal(order[0].source, 'busy', 'the genuinely newest model should still lead');
  const firstSlow = order.findIndex((entry) => entry.source === 'slow');
  assert.ok(firstSlow < 4, `the slower site first appeared at rank ${firstSlow + 1}`);
});

test('a source that reports no dates at all is not pushed below every dated result', () => {
  // The exact failure mode: undated items score 0 for time, so a global date
  // sort buried the whole source. Position fusion keeps it in the running.
  const withDates = Array.from({ length: 12 }, (_, i) =>
    dated('dated', `Model ${i}`, `2026-0${(i % 9) + 1}-01T00:00:00Z`),
  );
  const undated = Array.from({ length: 12 }, (_, i) => dated('undated', `Model ${i}`, null));

  const order = sortResults(
    fuse([{ source: 'dated', items: withDates }, { source: 'undated', items: undated }], 'model'),
    'newest',
  );

  const first = order.findIndex((entry) => entry.source === 'undated');
  assert.ok(first < 4, `the undated source first appeared at rank ${first + 1}, expected inside the top 4`);
});

test('popular does not let one site’s scale drown another’s', () => {
  // Thingiverse counts likes in the tens of thousands where the other famous site counts
  // them in the hundreds. Comparing the raw numbers is comparing nothing.
  const huge = Array.from({ length: 12 }, (_, i) =>
    item('huge', `Model ${i}`, { stats: { likes: 40000 - i * 100, downloads: 0 } }),
  );
  const small = Array.from({ length: 12 }, (_, i) =>
    item('small', `Model ${i}`, { stats: { likes: 400 - i * 10, downloads: 0 } }),
  );

  const order = sortResults(
    fuse([{ source: 'huge', items: huge }, { source: 'small', items: small }], 'model'),
    'popular',
  );

  const first = order.findIndex((entry) => entry.source === 'small');
  assert.ok(first < 4, `the smaller-scale site first appeared at rank ${first + 1}`);
});

test('every sort mode puts each answering source on the first page', () => {
  const lists = ['printables', 'makerworld', 'thingiverse'].map((source, index) => ({
    source,
    items: Array.from({ length: 30 }, (_, i) =>
      dated(source, `${source} model ${i}`, `202${index + 2}-0${(i % 9) + 1}-01T00:00:00Z`, {
        likes: (index + 1) * 100 - i,
        downloads: index === 2 ? undefined : (index + 1) * 500 - i,
      }),
    ),
  }));

  for (const mode of SORT_MODES) {
    const order = sortResults(dedupe(fuse(lists, 'model')), mode);
    for (const source of ['printables', 'makerworld', 'thingiverse']) {
      const first = order.findIndex((entry) => entry.source === source);
      assert.ok(
        first >= 0 && first < 12,
        `sort=${mode}: ${source} first appeared at rank ${first + 1}, expected inside the top 12`,
      );
    }
  }
});

test('an unknown sort mode falls back to relevance rather than throwing', () => {
  const lists = [{ source: 'a', items: [item('a', 'Bracket'), item('a', 'Other')] }];
  const scored = fuse(lists, 'bracket');

  for (const mode of ['__proto__', 'constructor', 'toString', 'nonsense', undefined]) {
    const order = sortResults(scored, mode);
    assert.equal(order.length, 2, `sort=${String(mode)} lost results`);
    assert.equal(order[0].title, 'Bracket', `sort=${String(mode)} did not fall back to relevance`);
  }
});
