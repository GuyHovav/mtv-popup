import { handleSuggestionsRequest } from '../server/src/lib/handlers.js';

// Vercel serverless function — mirrors server/src/routes/suggestions.js
// exactly, just on Vercel's plain (req, res) handler signature instead of
// an Express Router. Reuses the same framework-agnostic lib code as local
// dev; no Express dependency needed here.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { status, body, headers } = await handleSuggestionsRequest(req);
  for (const [name, value] of Object.entries(headers || {})) {
    res.setHeader(name, value);
  }
  res.status(status).json(body);
}
