// Optional context source: looks up a song on Genius (genius.com) to feed
// real writer/producer credits, sample/interpolation/cover relationships,
// and a curated "about" blurb into the trivia prompt. Genius's API does not
// provide lyrics (access was revoked industry-wide around 2016) — only a
// link to the lyrics page — so this deliberately sticks to metadata.
//
// A wrong song match would be worse than no match at all (it'd feed the LLM
// a different song's trivia entirely), so every step here is built to fail
// soft to `null` rather than guess: missing token, network error, no search
// hits, or a low-confidence artist match should all just mean "proceed
// without Genius context," exactly like the Gemini/OpenAI fallback chain
// this feeds into.

const GENIUS_BASE = 'https://api.genius.com';
const FETCH_TIMEOUT_MS = 5000;
const MAX_QUERY_LEN = 200;
const MAX_DESCRIPTION_LEN = 800;
const MAX_CONTEXT_LEN = 1500;

const RELEVANT_RELATIONSHIP_TYPES = new Set([
  'samples',
  'sampled_in',
  'interpolates',
  'interpolated_by',
  'cover_of',
  'covered_by',
]);

function cleanAuthor(author) {
  let a = author || '';
  // Split camelCase channel names ("RickAstleyVEVO" -> "Rick Astley VEVO")
  // so the word-boundary strips below actually have something to match.
  a = a.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  // YouTube Music auto-generated channels reliably suffix the real artist
  // name with "- Topic".
  a = a.replace(/\s*-\s*topic\s*$/i, '');
  a = a.replace(/\bvevo\b/gi, '');
  a = a.replace(/\bofficial\b/gi, '');
  return a.replace(/\s+/g, ' ').trim();
}

function cleanTitle(title) {
  let t = title || '';
  // Strip bracketed/parenthetical noise: "(Official Video)", "[4K Remaster]".
  t = t.replace(/[([][^)\]]*[)\]]/g, ' ');
  // Strip the same noise when it isn't bracketed.
  t = t.replace(/\b(official\s+(music\s+)?video|official\s+audio|lyric\s+video|lyrics|visualizer|hd|4k|remaster(?:ed)?)\b/gi, ' ');
  // Strip a trailing bare "feat./ft./featuring X" credit.
  t = t.replace(/\s+(feat\.?|ft\.?|featuring)\s+.+$/i, '');
  return t.replace(/\s+/g, ' ').trim();
}

// A cover's uploading channel has nothing to do with the original artist
// Genius indexes, so the normal artist-match assumption breaks for these —
// detect the signal so the query/confidence check can adapt.
const COVER_PATTERN = /\bcover(?:\s+version)?\b/i;
const ORIGINAL_ARTIST_PATTERN = /\boriginally\s+(?:by|performed\s+by)\s+([^()[\]]+)/i;

// Cover-aware query: when the video is a cover with no stated original
// artist, the channel name is noise, not signal — search on title alone.
function buildSearchQuery(title, author, effectiveArtist, isCover) {
  if (isCover && !effectiveArtist) {
    return cleanTitle(title).slice(0, MAX_QUERY_LEN);
  }
  return `${effectiveArtist || cleanAuthor(author)} ${cleanTitle(title)}`.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LEN);
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isConfidentMatch(cleanedAuthor, hitArtistName) {
  const a = normalize(cleanedAuthor);
  const b = normalize(hitArtistName);
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

// Fallback confidence signal for when there's no reliable artist to check
// against (an unresolved cover) — require a strong title match instead.
function isConfidentTitleMatch(cleanedTitle, hitTitle) {
  const a = normalize(cleanedTitle);
  const b = normalize(hitTitle);
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

async function geniusFetch(path) {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GENIUS_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`Genius API ${path} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`Genius API request failed (${path}):`, err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatGeniusContext(song) {
  const lines = [];
  lines.push(`Genius entry: "${song.title}" by ${song.primary_artist?.name || 'unknown artist'}`);

  const description = song.description?.plain?.trim();
  if (description) {
    lines.push(`About: ${description.slice(0, MAX_DESCRIPTION_LEN)}`);
  }

  if (song.release_date) {
    lines.push(`Released: ${song.release_date}`);
  }

  const writers = (song.writer_artists || []).map((a) => a.name).filter(Boolean);
  if (writers.length) {
    lines.push(`Writers: ${writers.slice(0, 5).join(', ')}`);
  }

  const producers = (song.producer_artists || []).map((a) => a.name).filter(Boolean);
  if (producers.length) {
    lines.push(`Producers: ${producers.slice(0, 5).join(', ')}`);
  }

  const relationships = (song.song_relationships || [])
    .filter((rel) => RELEVANT_RELATIONSHIP_TYPES.has(rel.relationship_type || rel.type))
    .flatMap((rel) => {
      const type = (rel.relationship_type || rel.type || '').replace(/_/g, ' ');
      return (rel.songs || []).map((s) => `${type}: "${s.title}" by ${s.artist_names}`);
    });
  if (relationships.length) {
    lines.push(`Samples/Interpolations/Covers:\n- ${relationships.slice(0, 6).join('\n- ')}`);
  }

  return lines.join('\n').slice(0, MAX_CONTEXT_LEN);
}

/**
 * Looks up {title, author} on Genius and returns a compact text block of
 * real song metadata (credits, sample/interpolation/cover relationships,
 * curated "about" text), or `null` if unavailable/unconfident/unconfigured.
 * Never throws.
 */
export async function fetchGeniusContext({ title, author }) {
  if (!process.env.GENIUS_ACCESS_TOKEN) {
    return null;
  }

  try {
    const isCover = COVER_PATTERN.test(title);
    const originalArtistMatch = title.match(ORIGINAL_ARTIST_PATTERN);
    const statedOriginalArtist = originalArtistMatch ? cleanAuthor(originalArtistMatch[1]) : null;
    const effectiveArtist = statedOriginalArtist || (isCover ? null : cleanAuthor(author));

    const query = buildSearchQuery(title, author, effectiveArtist, isCover);
    if (!query) return null;

    const searchData = await geniusFetch(`/search?q=${encodeURIComponent(query)}`);
    const hits = searchData?.response?.hits;
    if (!Array.isArray(hits) || hits.length === 0) return null;

    const songHits = hits.filter((h) => h.type === 'song' && h.result).slice(0, 5);
    if (songHits.length === 0) return null;

    const cleanedTitle = cleanTitle(title);

    // Pass 1: artist-based match, when there's a reliable artist to check.
    let matchedHit = null;
    if (effectiveArtist) {
      matchedHit = songHits.find((h) => isConfidentMatch(effectiveArtist, h.result.primary_artist?.name || ''));
    }

    // Pass 2: title-based fallback (covers a title-labeled cover with no
    // stated original artist, and unlabeled covers where the artist check
    // was always going to fail).
    if (!matchedHit) {
      matchedHit = songHits.find((h) => isConfidentTitleMatch(cleanedTitle, h.result.title || ''));
    }

    if (!matchedHit) {
      console.info(`Genius match rejected (no confident candidate among top ${songHits.length}): "${query}"`);
      return null;
    }

    const songId = matchedHit.result.id;
    const songData = await geniusFetch(`/songs/${songId}?text_format=plain`);
    const song = songData?.response?.song;
    if (!song) return null;

    return formatGeniusContext(song);
  } catch (err) {
    console.warn('Unexpected error building Genius context:', err?.message || err);
    return null;
  }
}
