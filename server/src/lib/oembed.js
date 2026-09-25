// Server-side lookup of a video's real title/author via YouTube's public
// oEmbed endpoint (no API key needed) — the same call the client already
// makes for its own display. Doing it again server-side means the LLM
// prompt and the facts cache are keyed to YouTube's metadata for the
// validated videoId, not to whatever title/author a request body claims —
// closing off both prompt injection and cache poisoning via forged fields.
//
// Fails soft to null (timeout, network, region-blocked video): the caller
// then falls back to the client-supplied metadata, which is the pre-existing
// behavior and only as trustworthy as it always was.

const FETCH_TIMEOUT_MS = 5000;

export async function fetchVideoMeta(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(oembedUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.title !== 'string' || typeof data?.author_name !== 'string') return null;
    return { title: data.title, author: data.author_name };
  } catch (err) {
    console.warn('Server-side oEmbed lookup failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
