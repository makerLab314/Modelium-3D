import { config } from '../config.js';
import { requestJson } from '../lib/http.js';
import { MissingCredentialsError, SourceError } from '../lib/errors.js';

export const id = 'thingiverse';
export const label = 'Thingiverse';
export const homepage = 'https://www.thingiverse.com';

const API = 'https://api.thingiverse.com';
const TOKEN_DOCS = 'https://www.thingiverse.com/apps/create';

/**
 * Thingiverse renders its search client side and its REST API refuses every
 * unauthenticated call, so this is the one source that needs a key. An app
 * token is free: create a "Desktop" app at the URL above, copy the App Token
 * and start the server with THINGIVERSE_TOKEN=... set.
 */
export function isConfigured() {
  return Boolean(config.thingiverseToken);
}

/**
 * `sort` accepts relevant, popular, newest, makes and text. The three used here
 * were each confirmed to change the order the API returns.
 */
const SORTS = new Map([
  ['relevance', 'relevant'],
  ['popular', 'popular'],
  ['newest', 'newest'],
]);

/**
 * `token` lets the settings panel verify a value the user just typed without
 * saving it first. Everything else uses the configured one.
 */
export async function search(query, { limit, offset = 0, signal, token, sort = 'relevance' }) {
  const credential = (token ?? config.thingiverseToken ?? '').trim();

  if (!credential) {
    throw new MissingCredentialsError(
      'Add a Thingiverse token in Settings to include this source',
      TOKEN_DOCS,
    );
  }

  // 50 is where the API stops honouring the parameter — asking for 100 still
  // returns 50. Capping at 30 (the previous value) handed Thingiverse six fewer
  // slots per page than the other two sources get, and left `offset` unable to
  // land on a page boundary for any limit that is not a multiple of 30.
  const perPage = Math.min(limit, 50);
  // The query is a path segment here, and encodeURIComponent leaves `.` alone —
  // so a bare `..` would normalize this authenticated request onto a different
  // endpoint. Escaping dots keeps it where it was aimed.
  const url = new URL(`${API}/search/${encodeURIComponent(query).replaceAll('.', '%2E')}/`);
  url.searchParams.set('type', 'things');
  url.searchParams.set('sort', SORTS.get(sort) ?? SORTS.get('relevance'));
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(Math.floor(offset / perPage) + 1));

  let payload;
  try {
    payload = await requestJson(url.toString(), {
      signal,
      headers: { authorization: `Bearer ${credential}` },
    });
  } catch (error) {
    // A rejected token is a setup problem, not an outage — say so, and point at
    // the page that issues a new one instead of leaving a bare 401.
    if (error instanceof SourceError && /\b401\b/.test(error.message)) {
      throw new MissingCredentialsError('Thingiverse rejected the token', TOKEN_DOCS);
    }
    throw error;
  }

  // The API returns {total, hits: []} for search, but older deployments and
  // some proxies hand back a bare array. Accept both.
  const hits = Array.isArray(payload) ? payload : payload?.hits;
  if (!Array.isArray(hits)) {
    throw new SourceError('Unexpected answer from the Thingiverse API', 'unavailable');
  }

  return {
    total: typeof payload?.total === 'number' ? payload.total : hits.length,
    items: hits.slice(0, limit).map(normalize).filter(Boolean),
  };
}

function normalize(thing) {
  if (!thing?.id) return null;

  return {
    sourceId: String(thing.id),
    title: thing.name ?? 'Untitled',
    url: thing.public_url || `https://www.thingiverse.com/thing:${thing.id}`,
    author: thing.creator?.name ?? null,
    authorUrl: thing.creator?.public_url ?? null,
    image: buildImage(thing),
    stats: {
      likes: numberOrNull(thing.like_count),
      downloads: numberOrNull(thing.download_count),
      makes: numberOrNull(thing.make_count),
      rating: null,
    },
    // `created_at` is the only date a *search* hit carries. `added` exists, but
    // only on /things/:id — reading just those two meant every search result
    // reached the merge with `publishedAt: null`, and sorting by Newest scores a
    // missing date as 0, so the whole source landed below every dated result
    // from the other two sites. Verified against the live API: 30/30 hits carry
    // `created_at`, 0/30 carry `added`.
    publishedAt: thing.created_at ?? thing.added ?? thing.published ?? null,
    nsfw: Boolean(thing.is_nsfw),
    paid: false,
  };
}

export function buildImage(thing) {
  const thumb = thing.thumbnail || thing.preview_image || thing.default_image?.url;
  const full =
    thing.preview_image ||
    thing.default_image?.sizes?.find((size) => size.type === 'display')?.url ||
    thumb;
  if (!thumb) return null;
  return { thumb, full: full ?? thumb };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
