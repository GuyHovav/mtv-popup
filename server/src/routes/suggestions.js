import { Router } from 'express';
import { fetchSuggestedVideos } from '../lib/suggestions.js';

const VIDEO_ID_RE = /^[\w-]{11}$/;

const router = Router();

router.get('/', async (req, res) => {
  const { videoId } = req.query;

  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'invalid_video_id' });
  }

  const suggestions = await fetchSuggestedVideos(videoId);
  return res.json({ suggestions });
});

export default router;
