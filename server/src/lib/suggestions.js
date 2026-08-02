// Optional context source: "more videos from this channel/artist," shown
// in the app as a clickable Suggested Videos row. YouTube deprecated the
// "related to this video" search API around 2020 (relatedToVideoId no
// longer returns results), so this is the practical alternative — reliable
// and thematically fitting for a music trivia app, just not YouTube's own
// recommendation algorithm.
//
// A failed/empty lookup should never break the app — the section just
// doesn't render — so every path here fails soft to `[]`, same contract as
// genius.js's fetchGeniusContext.

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESULTS = 10;

async function youtubeFetch(path) {
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

/**
 * Looks up other videos from the same channel as `videoId` — a proxy for
 * "suggested videos" now that YouTube's actual related-video API is gone.
 * Always resolves; returns [] on any missing key/network/quota failure.
 */
export async function fetchSuggestedVideos(videoId) {
  if (!process.env.YOUTUBE_API_KEY) {
    return [];
  }

  try {
    const videoData = await youtubeFetch(`/videos?part=snippet&id=${encodeURIComponent(videoId)}`);
    const channelId = videoData?.items?.[0]?.snippet?.channelId;
    if (!channelId) return [];

    // order=viewCount surfaces the channel's most popular uploads (better
    // discovery fit than raw recency); videoDuration=medium (4-20 min)
    // filters out Shorts and long-form livestreams/full-album uploads.
    const searchData = await youtubeFetch(
      `/search?part=snippet&channelId=${encodeURIComponent(channelId)}&type=video&order=viewCount&videoDuration=medium&maxResults=${MAX_RESULTS}`,
    );
    const items = searchData?.items;
    if (!Array.isArray(items)) return [];

    return items
      .filter((item) => item.id?.videoId && item.id.videoId !== videoId)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet?.title || '',
        thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
        channelTitle: item.snippet?.channelTitle || '',
      }))
      .filter((video) => video.title && video.thumbnailUrl);
  } catch (err) {
    console.warn('Unexpected error fetching suggested videos:', err?.message || err);
    return [];
  }
}
