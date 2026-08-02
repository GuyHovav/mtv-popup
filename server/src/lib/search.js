import { youtubeFetch, hasYouTubeApiKey, mapSearchItems } from './youtubeClient.js';

const MAX_RESULTS = 10;
const MAX_QUERY_LEN = 200;

/**
 * Text search for videos, powering the URL field's search mode. Always
 * resolves; returns [] on any missing key/empty query/network failure.
 * No videoDuration/order filter (unlike suggestions.js's channel lookup)
 * — a general search shouldn't silently exclude Shorts or sort away
 * relevance, since query intent here is broader than "songs by one artist."
 */
export async function searchVideos(query) {
  if (!hasYouTubeApiKey()) return [];

  const trimmed = (query || '').trim().slice(0, MAX_QUERY_LEN);
  if (!trimmed) return [];

  try {
    const searchData = await youtubeFetch(
      `/search?part=snippet&q=${encodeURIComponent(trimmed)}&type=video&maxResults=${MAX_RESULTS}`,
    );
    const items = searchData?.items;
    if (!Array.isArray(items)) return [];

    return mapSearchItems(items);
  } catch (err) {
    console.warn('Unexpected error searching videos:', err?.message || err);
    return [];
  }
}
