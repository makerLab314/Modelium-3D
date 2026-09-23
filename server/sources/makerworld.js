import { requestJson } from '../lib/http.js';
import { SourceError } from '../lib/errors.js';

export const id = 'makerworld';
export const label = 'MakerWorld';
export const homepage = 'https://makerworld.com';

/**
 * The same search service the site uses, reached through the host Bambu
 * Studio and the Bambu Handy app talk to. No key is needed.
 *
 * Not `makerworld.com/api/...`: since September 2026 everything on
 * makerworld.com, the JSON API included, sits behind a Cloudflare managed
 * challenge (`403` with `cf-mitigated: challenge`) that a server side fetch
 * cannot clear. `api.bambulab.com` serves the identical payload unchallenged,
 * and honours `orderBy` and `offset` the same way.
 *
 * Note the `2`: the older `select/design` answered 200 with an empty hit list
 * once MakerWorld moved over, which looks exactly like "nothing matched". The
 * site also sends a `searchSessionId`, but that is analytics — omitting it
 * changes nothing about the results.
 */
const SEARCH = 'https://api.bambulab.com/v1/search-service/select/design2';

/**
 * `orderBy` takes a field name, and an unrecognised one is ignored rather than
 * rejected — the response still comes back 200, just in the default order, which
 * is why every value here was checked against a live call. Recognised:
 * `score` (default), `likeCount`, `downloadCount`, `collectionCount`,
 * `printCount`.
 *
 * There is deliberately no entry for `newest`: no date field is accepted.
 * `createTime`, `publishTime`, `updateTime`, `latest`, `new` and `recent` were
 * all tried and all silently fall back to `score`. MakerWorld therefore
 * contributes its most relevant hits to a Newest search, re-ordered by date in
 * lib/rank.js — which is why that merge fuses by position per source rather
 * than sorting one global list by date.
 */
const ORDERINGS = new Map([
  ['relevance', 'score'],
  ['popular', 'likeCount'],
  ['newest', 'score'],
]);

export async function search(query, { limit, offset = 0, signal, sort = 'relevance' }) {
  const url = new URL(SEARCH);
  url.searchParams.set('keyword', query);
  url.searchParams.set('orderBy', ORDERINGS.get(sort) ?? ORDERINGS.get('relevance'));
  url.searchParams.set('designType', '0');
  url.searchParams.set('isFromSearchList', 'false');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(Math.min(limit, 40)));

  const payload = await requestJson(url.toString(), { signal });

  // `hits: null` with a non-zero total is how the bot filter answers. Reporting
  // that as an empty result set would be a lie, so it is surfaced as blocked.
  const hits = payload?.hits;
  if (hits === null && Number(payload?.total) > 0) {
    throw new SourceError('MakerWorld returned no items for a non-empty result set', 'blocked');
  }
  if (!Array.isArray(hits)) {
    throw new SourceError('Unexpected answer from the MakerWorld API', 'unavailable');
  }

  return {
    total: typeof payload?.total === 'number' ? payload.total : hits.length,
    items: hits.slice(0, limit).map(normalize).filter(Boolean),
  };
}

function normalize(design) {
  if (!design?.id) return null;

  const slug = design.slug ? `-${design.slug}` : '';
  const handle = design.designCreator?.handle;

  return {
    sourceId: String(design.id),
    title: design.title || design.titleTranslated || 'Untitled',
    url: `https://makerworld.com/en/models/${design.id}${slug}`,
    author: design.designCreator?.name ?? null,
    authorUrl: handle ? `https://makerworld.com/en/@${handle}` : null,
    image: design.cover ? { thumb: design.cover, full: design.cover } : null,
    stats: {
      likes: numberOrNull(design.likeCount),
      downloads: numberOrNull(design.downloadCount),
      prints: numberOrNull(design.printCount),
      rating: null,
    },
    publishedAt: design.createTime || null,
    nsfw: Boolean(design.nsfw),
    paid: false,
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
