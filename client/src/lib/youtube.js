const PATTERNS = [
  /youtube\.com\/watch\?.*?v=([\w-]{11})/,
  /youtu\.be\/([\w-]{11})/,
  /youtube\.com\/embed\/([\w-]{11})/,
  /youtube\.com\/shorts\/([\w-]{11})/,
  /youtube\.com\/live\/([\w-]{11})/,
];

// Sharing from an autoplay mix/radio yields a playlist URL with no `v=` at
// all (youtube.com/playlist?list=RD<videoId>&playnext=1). Mix playlist IDs
// embed their seed video's ID right after the prefix, so it can still be
// recovered. Longest prefix first — 'RD' is a prefix of the others. Curated
// playlists (RDCLAK5uy…, RDEM…, PL…) carry no video ID, so their remainder
// fails the 11-character check and they correctly yield null.
const MIX_PREFIXES = ['RDAMVM', 'RDMM', 'RD'];

function videoIdFromPlaylistId(listId) {
  if (!listId) return null;
  for (const prefix of MIX_PREFIXES) {
    if (listId.startsWith(prefix)) {
      const rest = listId.slice(prefix.length);
      if (/^[\w-]{11}$/.test(rest)) return rest;
    }
  }
  return null;
}

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
    // Checked after `v=`: a video shared from within a playlist carries both,
    // and the explicit `v=` is the video actually being watched.
    const fromMix = videoIdFromPlaylistId(url.searchParams.get('list'));
    if (fromMix) return fromMix;
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
