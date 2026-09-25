// Fixed-window per-client rate limiter for the public API endpoints. The
// facts endpoint spends LLM tokens and the search/suggestions endpoints
// spend YouTube Data API quota (search.list is 100 units per call against
// a 10k/day default), so leaving them unmetered lets any third party drain
// both by hitting the deployed URLs directly.
//
// Same in-memory trade-off as cache.js: per-instance state means a
// determined attacker spread across many cold instances isn't fully
// stopped, but the common cases — a scraper hammering one warm instance, a
// runaway client loop — are. Good enough for a keyless demo; anything
// stronger needs shared state (KV/Redis) this project intentionally avoids.

export function createRateLimiter({ limit, windowMs }) {
  const windows = new Map(); // key -> { count, windowStart }

  function isAllowed(key) {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      windows.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  // Drop expired windows occasionally so the map doesn't grow unbounded
  // with one-off IPs over a long-lived local dev server.
  function prune() {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (now - entry.windowStart >= windowMs) windows.delete(key);
    }
  }

  return { isAllowed, prune, size: () => windows.size };
}

// Works for both runtimes: Vercel puts the real client IP in
// x-forwarded-for (first hop), Express exposes req.ip (and also sees
// x-forwarded-for first when behind a proxy in local-ish setups).
export function clientKeyFromRequest(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
