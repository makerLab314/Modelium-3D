/**
 * Merging three result lists is the actual hard part of a federated search.
 * Each site ranks by its own relevance model and none of them expose a score
 * we could compare, so the only thing all three agree on is *position*.
 *
 * The merge therefore uses Reciprocal Rank Fusion (position based, scale free)
 * and nudges it with two signals we can compute ourselves: how well the title
 * matches the query, and how popular the model is relative to the other hits
 * from the same site.
 */

/**
 * Reciprocal Rank Fusion constant. Smaller means the first few positions in each
 * list are spread further apart, which is what keeps every site's own top hit in
 * contention with every other site's.
 */
const RRF_K = 8;

/**
 * How much each signal can move a result.
 *
 * `rrf` spans 8/9 = 0.889 at position 1 down to 8/44 = 0.182 at position 36, so
 * 0.71 separates a site's best hit from its worst. `relevance` runs 0..1.15,
 * which still lets a perfect title match climb past a site's own number one —
 * that is intended, since a literal title is strong evidence — but it is now the
 * same order of magnitude as the fusion term rather than double it.
 *
 * The ratio is what matters, and it was measured rather than guessed. With the
 * previous weights (RRF_K 12, rrf 10, relevance 1.2 over an *uncapped* 0..1.5
 * relevance) an exact title match was worth 1.8 against an RRF span of 0.56, so
 * four results literally named "Voronoi Lamp" sitting at positions 11 to 13 of
 * one site outranked another site's number one. Over a 38 query live sample that
 * left the other famous site — the site whose titles are the most descriptive, and so the
 * one a title-only signal punishes hardest — with 19% of the top 20 against
 * Printables' 43%, first appearing at rank 6.1 on average and as far down as 33.
 * It now averages 5.2 with a worst case of 27.
 *
 * Sweeping RRF_K over 4..12 and `relevance` over 0.6..1.2 moves the other famous site's
 * share by two points either way, so these are a reasonable middle rather than
 * a tuned optimum. The cap in titleRelevance is what actually mattered.
 */
const WEIGHTS = {
  rrf: 8,
  relevance: 1,
  popularity: 0.3,
};

export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenize(text) {
  return normalizeTitle(text).split(' ').filter(Boolean);
}

/**
 * Share of query words present in the title, 0..1, plus a small bonus for a
 * title that is nothing but the query.
 *
 * The coverage term is clamped. Without the clamp a half-match counted twice —
 * once as a token hit and once as a substring — could push a single title above
 * the whole range the fusion term can express, and the bonuses were large enough
 * (+0.5 exact, +0.2 prefix) to do the same on their own. Both now sit inside the
 * RRF span rather than swamping it; see WEIGHTS.
 */
export function titleRelevance(title, query) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return 0;

  const normalizedQuery = normalizeTitle(query);
  const normalizedTitle = normalizeTitle(title);
  const titleTokens = new Set(normalizedTitle.split(' '));

  let matched = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) matched += 1;
    else if (token.length > 3 && normalizedTitle.includes(token)) matched += 0.5;
  }

  const coverage = Math.min(1, matched / queryTokens.length);

  if (normalizedTitle === normalizedQuery) return coverage + 0.15;
  // The trailing space matters: "lamp shade" must not read as a prefix hit for
  // the query "lamp s".
  if (normalizedTitle.startsWith(`${normalizedQuery} `)) return coverage + 0.07;
  return coverage;
}

/** Raw popularity of one item, on the scale the sites report. */
function rawPopularity(item) {
  return (item.stats?.likes ?? 0) * 3 + (item.stats?.downloads ?? 0);
}

/**
 * 0..1 popularity inside one source, so a big site cannot drown a small one.
 *
 * A source that reports no counts at all scores a flat 0.5 rather than 0. Zero
 * would have been a silent penalty on the whole site for a field it simply does
 * not return — which is exactly how Thingiverse behaves: its search hits carry
 * `like_count` but no `download_count`, so anything keyed to downloads alone
 * would read every one of its results as unpopular.
 */
function popularityWithinSource(items) {
  const weights = items.map((item) => Math.log10(1 + rawPopularity(item)));
  const max = Math.max(...weights, 0);
  return weights.map((weight) => (max > 0 ? weight / max : 0.5));
}

/**
 * Turn per source lists into one scored list.
 * @param {Array<{source: string, items: object[]}>} lists
 * @param {string} query
 */
export function fuse(lists, query) {
  const scored = [];

  for (const list of lists) {
    const popularity = popularityWithinSource(list.items);

    list.items.forEach((item, index) => {
      const rrf = 1 / (RRF_K + index + 1);
      const relevance = titleRelevance(item.title, query);
      const score =
        rrf * WEIGHTS.rrf + relevance * WEIGHTS.relevance + popularity[index] * WEIGHTS.popularity;
      scored.push({ ...item, score, sourceRank: index + 1 });
    });
  }

  return scored;
}

/**
 * Creators cross post the same model, so collapse identical title plus author
 * pairs into one card and remember where else it lives.
 */
export function dedupe(items) {
  const groups = new Map();

  for (const item of items) {
    const key = `${normalizeTitle(item.title)}::${normalizeTitle(item.author ?? '')}`;
    if (groups.has(key)) groups.get(key).push(item);
    else groups.set(key, [item]);
  }

  const merged = [];

  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => b.score - a.score);
    const [winner, ...rest] = ranked;

    // Only fold copies that live on *another* site. If one site lists the same
    // title twice that is its own catalogue, and hiding one of them would be
    // us second guessing that site's search.
    const crossSite = new Map();
    for (const other of rest) {
      if (other.source === winner.source || crossSite.has(other.source)) {
        merged.push({ ...other, alsoOn: [] });
        continue;
      }
      crossSite.set(other.source, {
        source: other.source,
        sourceLabel: other.sourceLabel,
        url: other.url,
      });
    }

    merged.push({
      ...winner,
      // A model that exists on several sites is a stronger hit, not a weaker one.
      score: crossSite.size ? winner.score + 0.15 : winner.score,
      alsoOn: [...crossSite.values()],
    });
  }

  return merged;
}

/**
 * A Map rather than an object literal, because `mode` reaches this from a query
 * string.
 *
 * As a plain object, `KEYS[mode]` also answers for everything on
 * Object.prototype. `?sort=__proto__` returns Object.prototype itself — not
 * nullish, so the `??` below would not catch it — and calling it throws
 * "not a function", which is a 500 rather than a bad request. `constructor` and
 * `toString` answer with real functions and quietly sort by nothing.
 *
 * app.js does check the parameter against SORT_MODES before it ever gets here,
 * so none of that is reachable today. This is about the next caller.
 */
const KEYS = new Map([
  ['relevance', null],
  ['popular', rawPopularity],
  ['newest', timestamp],
]);

export const SORT_MODES = [...KEYS.keys()];

/**
 * Order the merged list.
 *
 * `relevance` is the fused score and nothing else. The other two do *not* sort
 * one global list by likes or by date, because those numbers are not comparable
 * across sites: each site is re-ranked by the key on its own, and the three
 * lists are then fused by position exactly the way relevance is.
 *
 * The reason is the same one that motivates this whole module. Sorting globally
 * by date gave the other famous site 88% of the top 20 for every query in a 38 query
 * sample and Thingiverse 2%, not because the other famous site's hits were better but
 * because it uploads more per day than the other two combined — and a site that
 * cannot report a date at all (Thingiverse's search hits could not, until the
 * adapter was fixed to read `created_at`) landed below *every* dated result
 * from the other two, 71 rows down. Fusing by position keeps each site's newest
 * in contention while still leading with the genuinely newest of the three,
 * since the actual key breaks the tie between equal positions.
 */
export function sortResults(items, mode = 'relevance') {
  const keyOf = KEYS.get(mode) ?? null;
  if (!keyOf) return [...items].sort((a, b) => b.score - a.score);

  const positions = positionsWithinSource(items, keyOf);

  return [...items].sort(
    (a, b) =>
      1 / (RRF_K + positions.get(b) + 1) - 1 / (RRF_K + positions.get(a) + 1) ||
      keyOf(b) - keyOf(a) ||
      b.score - a.score,
  );
}

/** Where each item lands in its own source's list once that list is keyed. */
function positionsWithinSource(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.source);
    if (group) group.push(item);
    else groups.set(item.source, [item]);
  }

  const positions = new Map();
  for (const group of groups.values()) {
    [...group]
      .sort((a, b) => keyOf(b) - keyOf(a) || b.score - a.score)
      .forEach((item, index) => positions.set(item, index));
  }
  return positions;
}

function timestamp(item) {
  const value = Date.parse(item.publishedAt ?? '');
  return Number.isFinite(value) ? value : 0;
}
