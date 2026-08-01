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

const RRF_K = 12;

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

/** Share of query words present in the title, with a bonus for an exact hit. */
export function titleRelevance(title, query) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return 0;

  const normalizedTitle = normalizeTitle(title);
  const titleTokens = new Set(normalizedTitle.split(' '));

  let matched = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) matched += 1;
    else if (token.length > 3 && normalizedTitle.includes(token)) matched += 0.5;
  }

  let score = matched / queryTokens.length;
  if (normalizedTitle === normalizeTitle(query)) score += 0.5;
  else if (normalizedTitle.startsWith(normalizeTitle(query))) score += 0.2;

  return score;
}

/** 0..1 popularity inside one source, so a big site cannot drown a small one. */
function popularityWithinSource(items) {
  const weights = items.map((item) => {
    const likes = item.stats?.likes ?? 0;
    const downloads = item.stats?.downloads ?? 0;
    return Math.log10(1 + likes * 3 + downloads);
  });
  const max = Math.max(...weights, 0);
  return weights.map((weight) => (max > 0 ? weight / max : 0));
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
      const score = rrf * 10 + relevance * 1.2 + popularity[index] * 0.35;
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

const COMPARATORS = {
  relevance: (a, b) => b.score - a.score,
  popular: (a, b) => popularity(b) - popularity(a),
  newest: (a, b) => timestamp(b) - timestamp(a),
};

export const SORT_MODES = Object.keys(COMPARATORS);

export function sortResults(items, mode = 'relevance') {
  const comparator = COMPARATORS[mode] ?? COMPARATORS.relevance;
  return [...items].sort((a, b) => comparator(a, b) || b.score - a.score);
}

function popularity(item) {
  return (item.stats?.likes ?? 0) * 3 + (item.stats?.downloads ?? 0);
}

function timestamp(item) {
  const value = Date.parse(item.publishedAt ?? '');
  return Number.isFinite(value) ? value : 0;
}
