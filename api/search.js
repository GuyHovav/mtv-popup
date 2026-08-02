import { searchVideos } from '../server/src/lib/search.js';

// Vercel serverless function — mirrors server/src/routes/search.js
// exactly, just on Vercel's plain (req, res) handler signature instead of
// an Express Router. Reuses the same framework-agnostic lib code as local
// dev; no Express dependency needed here.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { q } = req.query;

  if (typeof q !== 'string' || q.trim().length === 0) {
    res.status(400).json({ error: 'missing_query' });
    return;
  }

  const results = await searchVideos(q);
  res.status(200).json({ results });
}
