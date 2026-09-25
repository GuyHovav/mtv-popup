import { Router } from 'express';
import { handleSearchRequest } from '../lib/handlers.js';

const router = Router();

router.get('/', async (req, res) => {
  const { status, body, headers } = await handleSearchRequest(req);
  return res.status(status).set(headers || {}).json(body);
});

export default router;
