import { Router } from 'express';
import { searchVideos } from '../lib/search.js';

const router = Router();

router.get('/', async (req, res) => {
  const { q } = req.query;

  if (typeof q !== 'string' || q.trim().length === 0) {
    return res.status(400).json({ error: 'missing_query' });
  }

  const results = await searchVideos(q);
  return res.json({ results });
});

export default router;
