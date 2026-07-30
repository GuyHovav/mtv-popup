export async function postFacts({ videoId, title, author, durationSeconds }) {
  const res = await fetch('/api/facts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId, title, author, durationSeconds }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || 'FACTS_REQUEST_FAILED');
    error.status = res.status;
    throw error;
  }

  return res.json(); // { videoId, facts }
}
