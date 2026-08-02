import { config } from './config.js';
import { TtlCache } from './lib/cache.js';
import { SourceError } from './lib/errors.js';
import { dedupe, fuse, sortResults, SORT_MODES } from './lib/rank.js';
import { getSource, sourceIds } from './sources/index.js';

const cache = new TtlCache({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries });

export { SORT_MODES };

/**
 * Query one source and never throw: a dead source must not take the other two
 * down with it. The returned report is what the UI shows in the source rail.
 */
export async function searchSource(sourceId, query, { signal, page = 1 } = {}) {
  const source = getSource(sourceId);
  if (!source) {
    return report(sourceId, sourceId, 'error', { message: 'Unknown source' });
  }

  const limit = config.perSourceLimit;
  const cacheKey = `${sourceId}::${query.toLowerCase()}::${page}::${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  const startedAt = Date.now();

  try {
    const { items, total } = await source.search(query, {
      limit,
      offset: (page - 1) * limit,
      signal,
    });

    const visible = config.hideNsfw ? items.filter((item) => !item.nsfw) : items;
    const decorated = visible.map((item) => ({
      ...item,
      id: `${source.id}:${item.sourceId}`,
      source: source.id,
      sourceLabel: source.label,
    }));

    const result = report(source.id, source.label, 'ok', {
      items: decorated,
      total: total ?? decorated.length,
      tookMs: Date.now() - startedAt,
    });

    return cache.set(cacheKey, result);
  } catch (error) {
    const known = error instanceof SourceError;
    return report(source.id, source.label, known ? error.kind : 'error', {
      message: known ? error.message : `Unexpected failure: ${error.message}`,
      docsUrl: error.docsUrl ?? null,
      tookMs: Date.now() - startedAt,
    });
  }
}

/** Fuse a set of per source reports into the final result list. */
export function merge(reports, query, sort = 'relevance', page = 1) {
  const answered = reports.filter((report) => report.status === 'ok');
  const lists = answered.map((report) => ({ source: report.source, items: report.items }));

  const results = sortResults(dedupe(fuse(lists, query)), sort);

  // Offer another page only while at least one site still has stock: it filled
  // the page it was asked for *and* claims a larger total.
  const hasMore = answered.some(
    (report) => report.items.length >= config.perSourceLimit && report.total > page * config.perSourceLimit,
  );

  return {
    sort: SORT_MODES.includes(sort) ? sort : 'relevance',
    page,
    hasMore,
    sources: reports.map(({ items, ...rest }) => ({ ...rest, count: items.length })),
    results,
  };
}

export function resolveSources(requested) {
  if (!requested?.length) return sourceIds;
  const wanted = requested.map((id) => String(id).trim().toLowerCase()).filter(Boolean);
  const valid = wanted.filter((id) => sourceIds.includes(id));
  return valid.length ? valid : sourceIds;
}

function report(source, sourceLabel, status, extra = {}) {
  return {
    source,
    sourceLabel,
    status,
    items: [],
    total: 0,
    message: null,
    docsUrl: null,
    tookMs: 0,
    cached: false,
    ...extra,
  };
}
