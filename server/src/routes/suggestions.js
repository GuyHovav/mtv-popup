import { Router } from 'express';
import { handleSuggestionsRequest } from '../lib/handlers.js';

const router = Router();

router.get('/', async (req, res) => {
  const { status, body, headers } = await handleSuggestionsRequest(req);
  return res.status(status).set(headers || {}).json(body);
});

export default router;
