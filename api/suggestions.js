import { fetchSuggestedVideos } from '../server/src/lib/suggestions.js';

const VIDEO_ID_RE = /^[\w-]{11}$/;

// Vercel serverless function — mirrors server/src/routes/suggestions.js
// exactly, just on Vercel's plain (req, res) handler signature instead of
// an Express Router. Reuses the same framework-agnostic lib code as local
// dev; no Express dependency needed here.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { videoId } = req.query;

  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
    res.status(400).json({ error: 'invalid_video_id' });
    return;
  }

  const suggestions = await fetchSuggestedVideos(videoId);
  res.status(200).json({ suggestions });
}
