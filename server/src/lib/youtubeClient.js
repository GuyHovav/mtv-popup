// Shared low-level helper for calling the YouTube Data API v3, used by
// both suggestions.js (channel-based "more like this") and search.js
// (text search) — both are just different search.list query shapes
// hitting the same endpoint with the same auth/error-handling needs.

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const FETCH_TIMEOUT_MS = 5000;

export function hasYouTubeApiKey() {
  return Boolean(process.env.YOUTUBE_API_KEY);
}

export async function youtubeFetch(path) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${YOUTUBE_API_BASE}${path}${path.includes('?') ? '&' : '?'}key=${apiKey}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`YouTube Data API ${path} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`YouTube Data API request failed (${path}):`, err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Maps a search.list `items` array into the shape both features render as
// cards, optionally excluding one videoId (the currently playing video,
// for the "more like this" case — search.js doesn't need this).
export function mapSearchItems(items, excludeVideoId) {
  return items
    .filter((item) => item.id?.videoId && item.id.videoId !== excludeVideoId)
    .map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet?.title || '',
      thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
      channelTitle: item.snippet?.channelTitle || '',
    }))
    .filter((video) => video.title && video.thumbnailUrl);
}
