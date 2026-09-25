// Framework-agnostic request handlers, one per endpoint. Each takes the
// minimal request shape both runtimes share (body/query/headers, per
// Express and Vercel's Node helpers alike) and returns
// { status, body, headers? } for the thin wrappers in server/src/routes/
// and api/ to translate. This keeps the guard flow — cache check, rate
// limit, server-side metadata lookup — defined exactly once.

import { validateFactsRequest, ValidationError } from './validate.js';
import { computeFactCount, generateFacts } from './facts.js';
import { fetchGeniusContext } from './genius.js';
import { fetchWikipediaContext } from './wikipedia.js';
import { fetchVideoMeta } from './oembed.js';
import { searchVideos } from './search.js';
import { fetchSuggestedVideos } from './suggestions.js';
import {
  factsCache,
  factsCacheKey,
  factsLimiter,
  youtubeLimiter,
  clientKeyFromRequest,
} from './guards.js';

export async function handleFactsRequest(req) {
  let validated;
  try {
    validated = validateFactsRequest(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return { status: err.status, body: { error: err.message } };
    }
    throw err;
  }

  const { videoId, durationSeconds } = validated;

  // Cache before rate limit: a hit costs nothing, so it shouldn't burn
  // (or be blocked by) anyone's request budget.
  const cacheKey = factsCacheKey(videoId, durationSeconds);
  const cached = factsCache.get(cacheKey);
  if (cached) {
    return { status: 200, body: cached };
  }

  if (!factsLimiter.isAllowed(clientKeyFromRequest(req))) {
    return { status: 429, body: { error: 'rate_limited' } };
  }

  // Prefer YouTube's own metadata for the validated videoId over whatever
  // the request body claims — see oembed.js. The body's fields remain the
  // fallback when the lookup fails, preserving the original behavior.
  const meta = await fetchVideoMeta(videoId);
  const title = meta?.title || validated.title;
  const author = meta?.author || validated.author;

  const factCount = computeFactCount(durationSeconds);
  // Both context sources fail soft to null and are independent — fetch in
  // parallel so the free knowledge layer doesn't add latency on top of
  // Genius.
  const [geniusContext, wikiContext] = await Promise.all([
    fetchGeniusContext({ title, author }),
    fetchWikipediaContext({ title, author }),
  ]);

  try {
    const { facts, degraded, videoGrounded } = await generateFacts({
      videoId,
      title,
      author,
      durationSeconds,
      factCount,
      geniusContext,
      wikiContext,
    });
    const body = { videoId, facts, degraded, videoGrounded };
    // Degraded batches are the generic hardcoded templates — don't let a
    // transient provider outage pin generic facts onto a video for hours.
    if (!degraded) {
      factsCache.set(cacheKey, body);
    }
    return { status: 200, body };
  } catch (err) {
    console.error('Failed to generate facts:', err);
    return { status: err.status || 502, body: { error: 'generation_failed' } };
  }
}

// s-maxage lets Vercel's CDN cache these GETs per-URL (so per query/videoId)
// without any storage of our own; stale-while-revalidate keeps responses
// snappy when an entry expires. Express sends the header too, where it's
// simply inert without a CDN in front.
const SEARCH_CACHE_HEADER = { 'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400' };
const SUGGESTIONS_CACHE_HEADER = { 'Cache-Control': 's-maxage=86400, stale-while-revalidate=604800' };

export async function handleSearchRequest(req) {
  const q = req.query?.q;
  if (typeof q !== 'string' || q.trim().length === 0) {
    return { status: 400, body: { error: 'missing_query' } };
  }

  if (!youtubeLimiter.isAllowed(clientKeyFromRequest(req))) {
    return { status: 429, body: { error: 'rate_limited' } };
  }

  const results = await searchVideos(q);
  return { status: 200, body: { results }, headers: SEARCH_CACHE_HEADER };
}

const VIDEO_ID_RE = /^[\w-]{11}$/;

export async function handleSuggestionsRequest(req) {
  const videoId = req.query?.videoId;
  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
    return { status: 400, body: { error: 'invalid_video_id' } };
  }

  if (!youtubeLimiter.isAllowed(clientKeyFromRequest(req))) {
    return { status: 429, body: { error: 'rate_limited' } };
  }

  const suggestions = await fetchSuggestedVideos(videoId);
  return { status: 200, body: { suggestions }, headers: SUGGESTIONS_CACHE_HEADER };
}
