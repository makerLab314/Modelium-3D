import { requestText } from '../lib/http.js';
import { SourceError } from '../lib/errors.js';

export const id = 'printables';
export const label = 'Printables';
export const homepage = 'https://www.printables.com';

const MEDIA_HOST = 'https://media.printables.com/';

/**
 * Printables has no documented public search API and its GraphQL endpoint has
 * introspection disabled. The search page is server rendered by SvelteKit
 * though, and SvelteKit inlines every response it fetched during SSR into
 * <script type="application/json" data-sveltekit-fetched> tags. So instead of
 * scraping markup we lift the original GraphQL payload back out of the page,
 * which gives us clean structured data and survives CSS changes.
 */
const FETCHED_BLOB = /<script[^>]*data-sveltekit-fetched[^>]*>([\s\S]*?)<\/script>/g;

export function extractModels(html) {
  let best = null;
  let sawResultList = false;

  for (const match of html.matchAll(FETCHED_BLOB)) {
    let payload;
    try {
      payload = JSON.parse(decodeBlob(match[1]));
    } catch {
      continue;
    }

    const body = typeof payload?.body === 'string' ? safeParse(payload.body) : payload?.body;
    const result = body?.data?.result;
    if (!Array.isArray(result?.items)) continue;

    // A page with zero hits still ships the empty envelope, which is how we
    // tell "nothing matched" apart from "the page layout changed".
    sawResultList = true;
    const items = result.items;
    if (!items.length || items[0]?.__typename !== 'PrintType') continue;

    // A search page carries several result blobs (models, collections, users).
    // The model list is by far the longest one.
    if (!best || items.length > best.items.length) {
      best = { items, totalCount: result.totalCount ?? items.length };
    }
  }

  if (best) return best;
  return sawResultList ? { items: [], totalCount: 0 } : null;
}

export async function search(query, { limit, offset = 0, signal }) {
  const url = new URL('https://www.printables.com/search/models');
  url.searchParams.set('q', query);
  url.searchParams.set('ordering', 'best_match');
  if (offset > 0) url.searchParams.set('page', String(Math.floor(offset / limit) + 1));

  const html = await requestText(url.toString(), {
    signal,
    headers: { accept: 'text/html,application/xhtml+xml' },
  });

  const found = extractModels(html);
  if (!found) throw new SourceError('Could not read the search page layout', 'unavailable');

  return {
    total: found.totalCount,
    items: found.items.slice(0, limit).map(normalize).filter(Boolean),
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
    paid: Boolean(model.price) || Boolean(model.club),
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

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeBlob(text) {
  // SvelteKit escapes the closing tag sequence when inlining the payload.
  return text.replaceAll('\\u003C', '<').replaceAll('\\u003E', '>');
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
