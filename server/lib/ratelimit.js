/**
 * A token bucket per caller.
 *
 * The endpoint worth protecting is `/api/search`: one request fans out to three
 * upstream sites, so an unthrottled server is an amplifier pointed at somebody
 * else's rate limits — and those three sites see *our* address, not the
 * caller's. `/img` matters for the same reason.
 *
 * In `local` mode the limits are lifted almost entirely. A single person on
 * their own machine should never meet a limiter, and one that fires during
 * normal use is one the user will (rightly) rip out.
 */

/** Bounded so that a flood of spoofed sources cannot turn the limiter into the leak. */
const MAX_TRACKED = 5000;

export function createRateLimiter({ capacity, refillPerSecond, enabled = true, now = Date.now }) {
  /** @type {Map<string, { tokens: number, seen: number }>} */
  const buckets = new Map();

  function sweep() {
    // Map preserves insertion order, so the oldest keys come out first. A bucket
    // that has refilled completely carries no state worth keeping.
    for (const [key, bucket] of buckets) {
      if (buckets.size <= MAX_TRACKED / 2) break;
      if (bucket.tokens >= capacity) buckets.delete(key);
    }
    while (buckets.size > MAX_TRACKED) {
      buckets.delete(buckets.keys().next().value);
    }
  }

  return {
    /**
     * @returns {{ ok: true } | { ok: false, retryAfter: number }}
     */
    take(key) {
      if (!enabled) return { ok: true };

      const at = now();
      let bucket = buckets.get(key);

      if (!bucket) {
        bucket = { tokens: capacity, seen: at };
        if (buckets.size >= MAX_TRACKED) sweep();
        buckets.set(key, bucket);
      }

      const elapsed = Math.max(0, at - bucket.seen) / 1000;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
      bucket.seen = at;

      if (bucket.tokens < 1) {
        return { ok: false, retryAfter: Math.ceil((1 - bucket.tokens) / refillPerSecond) };
      }

      bucket.tokens -= 1;
      return { ok: true };
    },

    get size() {
      return buckets.size;
    },
  };
}

/**
 * Identify the caller by the socket address only.
 *
 * Not by X-Forwarded-For: it is set by whoever is upstream of us, and when that
 * is the attacker it turns the limiter into a way to exhaust the tracking map.
 * Behind a reverse proxy every caller therefore shares one bucket — which is why
 * the limits are per-class rather than tight.
 */
export function callerOf(req) {
  return req.socket?.remoteAddress ?? 'unknown';
}
