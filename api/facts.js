import { validateFactsRequest, ValidationError } from '../server/src/lib/validate.js';
import { computeFactCount, generateFacts } from '../server/src/lib/facts.js';

// Vercel serverless function — mirrors server/src/routes/facts.js exactly,
// just on Vercel's plain (req, res) handler signature instead of an Express
// Router. Reuses the same framework-agnostic lib code as local dev; no
// Express dependency needed here.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let validated;
  try {
    validated = validateFactsRequest(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }

  const { videoId, title, author, durationSeconds } = validated;
  const factCount = computeFactCount(durationSeconds);

  try {
    const { facts, degraded } = await generateFacts({ title, author, durationSeconds, factCount });
    res.status(200).json({ videoId, facts, degraded });
  } catch (err) {
    console.error('Failed to generate facts:', err);
    res.status(err.status || 502).json({ error: 'generation_failed' });
  }
}
