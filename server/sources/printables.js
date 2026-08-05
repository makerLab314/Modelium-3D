import { requestJson } from '../lib/http.js';
import { SourceError } from '../lib/errors.js';

export const id = 'printables';
export const label = 'Printables';
export const homepage = 'https://www.printables.com';

const MEDIA_HOST = 'https://media.printables.com/';

/**
 * Printables has no documented public API, but the one its own frontend talks to
 * accepts plain queries: no key, no persisted-query allowlist. Introspection is
 * disabled, which only means the schema has to be read out of the site's own
 * bundles rather than asked for.
 *
 * This replaced an earlier approach that lifted the payload back out of the
 * server rendered search page. Same data, but that page answers with a ~18 KB
 * `Link` header of preload hints, which is over Node's default limit and forced
 * the whole process to run with --max-http-header-size. The API sends ~600
 * bytes of headers and a fortieth of the body.
 */
const ENDPOINT = 'https://api.printables.com/graphql/';

/**
 * `ordering` is a SearchChoicesEnum and accepts exactly: best_match, latest,
 * popular, rating. We always ask for best_match and sort locally, because the
 * merge fuses three sites by rank (see lib/rank.js) and that only works while
 * every list is ordered by the same idea of relevance.
 */
const SEARCH_QUERY = `query SearchModels($query: String!, $limit: Int, $offset: Int) {
  result: searchPrints2(
    query: $query
    printType: print
    limit: $limit
    offset: $offset
    ordering: best_match
  ) {
    totalCount
    items {
      id
      name
      slug
      ratingAvg
      likesCount
      downloadCount
      datePublished
      firstPublish
      nsfw
      price
      premium
      image {
        filePath
      }
      user {
        handle
        publicUsername
      }
    }
  }
}`;

/**
 * Pull the result list out of a GraphQL response, or explain why there is none.
 * Exported for the tests: this is the part that goes quiet rather than loud when
 * the schema drifts.
 *
 * @returns {{ items: unknown[], totalCount: number }}
 */
export function readResult(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    const detail = payload.errors
      .map((error) => error?.message)
      .filter(Boolean)
      .join('; ');
    throw new SourceError(
      detail ? `Printables rejected the query: ${detail}` : 'Printables rejected the query',
      'unavailable',
    );
  }

  const result = payload?.data?.result;
  if (!result || !Array.isArray(result.items)) {
    throw new SourceError('Unexpected answer from the Printables API', 'unavailable');
  }

  // An empty list with a zero total is a real "nothing matched", not a break.
  return { items: result.items, totalCount: result.totalCount ?? result.items.length };
}

export async function search(query, { limit, offset = 0, signal }) {
  const payload = await requestJson(ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      origin: homepage,
      referer: `${homepage}/`,
    },
    body: JSON.stringify({
      operationName: 'SearchModels',
      query: SEARCH_QUERY,
      variables: { query, limit: Math.min(limit, 100), offset },
    }),
  });

  const { items, totalCount } = readResult(payload);

  return {
    total: totalCount,
    items: items.slice(0, limit).map(normalize).filter(Boolean),
  };
}

function normalize(model) {
  if (!model?.id) return null;

  const slug = model.slug ? `-${model.slug}` : '';
  const handle = model.user?.handle ?? '';

  return {
    sourceId: String(model.id),
    title: model.name ?? 'Untitled',
    url: `https://www.printables.com/model/${model.id}${slug}`,
    author: model.user?.publicUsername || handle || null,
    authorUrl: handle ? `https://www.printables.com/@${handle}` : null,
    image: buildImage(model.image?.filePath),
    stats: {
      likes: numberOrNull(model.likesCount),
      downloads: numberOrNull(model.downloadCount),
      rating: model.ratingAvg ? Number.parseFloat(model.ratingAvg) || null : null,
    },
    publishedAt: model.firstPublish ?? model.datePublished ?? null,
    nsfw: Boolean(model.nsfw),
    // `club` was renamed to `premium`; asking for the old name is now a hard
    // GraphQL error, which is what the live structure test watches for.
    paid: Boolean(model.price) || Boolean(model.premium),
  };
}

/**
 * Printables serves resized derivatives next to the original. The folder after
 * the size carries the *original* extension, and the derivative itself is
 * always webp:
 *   media/prints/<id>/images/<hash>/benchy.jpg
 *   media/prints/<id>/images/<hash>/thumbs/inside/640x480/jpg/benchy.webp
 */
export function buildImage(filePath) {
  if (!filePath) return null;
  const slash = filePath.lastIndexOf('/');
  if (slash === -1) return { thumb: MEDIA_HOST + filePath, full: MEDIA_HOST + filePath };

  const dir = filePath.slice(0, slash);
  const file = filePath.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  if (dot === -1) return { thumb: MEDIA_HOST + filePath, full: MEDIA_HOST + filePath };

  const base = file.slice(0, dot);
  const extension = file.slice(dot + 1).toLowerCase();
  const thumb = (size) =>
    `${MEDIA_HOST}${dir}/thumbs/inside/${size}/${extension}/${base}.webp`;

  return { thumb: thumb('640x480'), full: thumb('1280x960') };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
