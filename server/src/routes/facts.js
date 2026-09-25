import { Router } from 'express';
import { handleFactsRequest } from '../lib/handlers.js';

const router = Router();

router.post('/', async (req, res) => {
  const { status, body, headers } = await handleFactsRequest(req);
  return res.status(status).set(headers || {}).json(body);
});

export default router;
