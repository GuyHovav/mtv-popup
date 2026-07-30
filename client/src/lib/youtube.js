const PATTERNS = [
  /youtube\.com\/watch\?.*?v=([\w-]{11})/,
  /youtu\.be\/([\w-]{11})/,
  /youtube\.com\/embed\/([\w-]{11})/,
  /youtube\.com\/shorts\/([\w-]{11})/,
  /youtube\.com\/live\/([\w-]{11})/,
];

export function parseVideoId(input) {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;

  for (const re of PATTERNS) {
    const match = trimmed.match(re);
    if (match) return match[1];
  }

  try {
    const url = new URL(trimmed);
    const v = url.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
  } catch {
    // not a parseable URL — fall through
  }

  // Bare 11-character video ID pasted directly
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

  return null;
}

export async function fetchOEmbed(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  let res;
  try {
    res = await fetch(oembedUrl);
  } catch (err) {
    const error = new Error('OEMBED_FAILED');
    error.cause = err;
    throw error;
  }

  if (!res.ok) {
    throw new Error('OEMBED_FAILED');
  }

  const data = await res.json();
  return { title: data.title, author: data.author_name };
}
