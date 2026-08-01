import { requestJson } from '../lib/http.js';
import { SourceError } from '../lib/errors.js';

export const id = 'makerworld';
export const label = 'MakerWorld';
export const homepage = 'https://makerworld.com';

const SEARCH = 'https://makerworld.com/api/v1/search-service/select/design';

/**
 * MakerWorld powers its own site with this endpoint, so no key is needed.
 * It does sit behind a bot filter that reacts to the caller's network, which
 * is why a request can come back reachable but empty. That case is reported
 * as such instead of being dressed up as "no results".
 */
export async function search(query, { limit, signal }) {
  const url = new URL(SEARCH);
  url.searchParams.set('keyword', query);
  url.searchParams.set('offset', '0');
  url.searchParams.set('limit', String(Math.min(limit, 40)));

  const payload = await requestJson(url.toString(), {
    signal,
    headers: { referer: `https://makerworld.com/en/search/models?keyword=${encodeURIComponent(query)}` },
  });

  const hits = payload?.hits;
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
