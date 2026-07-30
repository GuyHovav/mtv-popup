import { Router } from 'express';
import { validateFactsRequest, ValidationError } from '../lib/validate.js';
import { computeFactCount, generateFacts } from '../lib/facts.js';

const router = Router();

router.post('/', async (req, res) => {
  let validated;
  try {
    validated = validateFactsRequest(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  const { videoId, title, author, durationSeconds } = validated;
  const factCount = computeFactCount(durationSeconds);

  try {
    const { facts, degraded } = await generateFacts({ title, author, durationSeconds, factCount });
    return res.json({ videoId, facts, degraded });
  } catch (err) {
    console.error('Failed to generate facts:', err);
    return res.status(err.status || 502).json({ error: 'generation_failed' });
  }
});

export default router;
