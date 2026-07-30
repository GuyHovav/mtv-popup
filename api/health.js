// Zero-dependency smoke-test endpoint — confirms the Vercel function runtime
// boots correctly, independent of the LLM call path in api/facts.js.
export default function handler(req, res) {
  res.status(200).json({ ok: true });
}
