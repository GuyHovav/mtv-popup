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

export async function fetchSuggestions(videoId) {
  try {
    const res = await fetch(`/api/suggestions?videoId=${encodeURIComponent(videoId)}`);
    if (!res.ok) return { suggestions: [] };
    return res.json(); // { suggestions }
  } catch {
    return { suggestions: [] };
  }
}

export async function searchVideos(query) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return { results: [] };
    return res.json(); // { results }
  } catch {
    return { results: [] };
  }
}
