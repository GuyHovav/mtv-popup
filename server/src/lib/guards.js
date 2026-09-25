// Shared limiter/cache instances used by both the Express routes (local
// dev) and the Vercel serverless functions (production) — a single module
// so both runtimes get identical policy without duplicating numbers.

import { createTtlCache } from './cache.js';
import { createRateLimiter, clientKeyFromRequest } from './rateLimit.js';

export { clientKeyFromRequest };

// A fact batch for a video doesn't go stale — cache for hours and let LRU
// eviction handle memory. ~500 batches of ≤80 short facts is a few MB.
export const factsCache = createTtlCache({ ttlMs: 6 * 60 * 60 * 1000, maxEntries: 500 });

// Facts: each miss is an LLM call (now potentially with video input), so
// keep this tight — a real visitor triggers roughly one per video watched.
export const factsLimiter = createRateLimiter({ limit: 8, windowMs: 60 * 1000 });

// Search + suggestions share one budget: both spend the same YouTube Data
// API quota (search.list = 100 units against a 10k/day default).
export const youtubeLimiter = createRateLimiter({ limit: 20, windowMs: 60 * 1000 });

// Duration is bucketed so tiny player-reported jitter between sessions
// still shares a cache entry, while a deliberately absurd duration for a
// real videoId only poisons its own bucket, not the one legit visitors hit.
export function factsCacheKey(videoId, durationSeconds) {
  return `${videoId}:${Math.round(durationSeconds / 15)}`;
}
