import { requestJson } from '../lib/http.js';
import { SourceError } from '../lib/errors.js';

export const id = 'makerworld';
export const label = 'MakerWorld';
export const homepage = 'https://makerworld.com';

/**
 * MakerWorld powers its own site with this endpoint, so no key is needed.
 *
 * Note the `2`: the older `select/design` still answers 200 but has returned an
 * empty hit list since MakerWorld moved the site over, which looks exactly like
 * "nothing matched". `select/design2` is what their search page calls now. The
 * site also sends a `searchSessionId`, but that is analytics — omitting it
 * changes nothing about the results.
 *
 * The HTML search page is not an option as a fallback: it sits behind a
 * Cloudflare interstitial that a server side fetch cannot clear. The JSON API
 * is not challenged.
 */
const SEARCH = 'https://makerworld.com/api/v1/search-service/select/design2';

export async function search(query, { limit, offset = 0, signal }) {
  const url = new URL(SEARCH);
  url.searchParams.set('keyword', query);
  url.searchParams.set('orderBy', 'score');
  url.searchParams.set('designType', '0');
  url.searchParams.set('isFromSearchList', 'false');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(Math.min(limit, 40)));

  const payload = await requestJson(url.toString(), {
    signal,
    headers: {
      referer: `https://makerworld.com/en/search/models?keyword=${encodeURIComponent(query)}`,
      origin: 'https://makerworld.com',
    },
  });

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
