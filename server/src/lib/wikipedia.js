// Free knowledge layer: looks the song and artist up on English Wikipedia
// (no API key, generous limits) and feeds the article intros into the
// trivia prompt. This is what separates "the model vaguely remembers this
// song" from facts with real history, chart performance, and recording
// detail behind them — especially for artists outside the model's
// strongest knowledge.
//
// Same contract as genius.js's fetchGeniusContext: a wrong article would
// be worse than none (it would ground the LLM in a different song
// entirely), so every step fails soft to null and matches are only
// accepted with a confidence check. Never throws.

import { cleanAuthor, cleanTitle, normalize } from './genius.js';

const SEARCH_API = 'https://en.wikipedia.org/w/api.php';
const SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const FETCH_TIMEOUT_MS = 5000;
// Wikipedia's API etiquette asks for an identifying User-Agent.
const USER_AGENT = 'mtv-popup/1.0 (https://github.com/GuyHovav/mtv-popup)';

const MAX_SONG_EXTRACT_LEN = 900;
const MAX_ARTIST_EXTRACT_LEN = 500;
const MAX_CONTEXT_LEN = 1500;

async function wikiFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`Wikipedia API returned ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('Wikipedia API request failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function searchUrl(query) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '5',
    format: 'json',
    origin: '*',
  });
  return `${SEARCH_API}?${params}`;
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, '');
}

// YouTube music titles are usually "Artist - Title" (or occasionally
// "Title - Artist" / "Artist | Title"); Wikipedia article titles are just
// the song name. Drop the separator segments that match the artist so
// "Bruno Mars - 24K Magic" compares as "24K Magic" against
// "24K Magic (song)". If everything (or nothing) matches the artist, fall
// back to the whole cleaned title.
export function extractSongTitle(title, artist) {
  const cleaned = cleanTitle(title);
  const parts = cleaned.split(/\s*(?:[-–—|:]\s+|\s+[-–—|]\s*)/).filter((p) => p.trim());
  if (parts.length < 2) return cleaned;

  const artistNorm = normalize(artist);
  const nonArtistParts = parts.filter((p) => {
    const n = normalize(p);
    if (!artistNorm || n.length === 0) return true;
    return !(n === artistNorm || artistNorm.includes(n) || n.includes(artistNorm));
  });
  if (nonArtistParts.length === 0 || nonArtistParts.length === parts.length) return cleaned;
  return nonArtistParts.join(' ').replace(/\s+/g, ' ').trim();
}

// Song articles are commonly titled `Title (song)` / `Title (Artist song)`,
// or just `Title` when the song is the primary topic. Accept a hit only
// when its title contains the cleaned song title AND either the article
// title is explicitly song-disambiguated or the search snippet mentions
// the artist — otherwise "Yellow" by an obscure band happily matches the
// Coldplay article.
export function pickSongHit(hits, songTitle, artist) {
  const wantTitle = normalize(songTitle);
  const wantArtist = normalize(artist);
  if (wantTitle.length < 2) return null;

  const candidates = hits.filter((h) => normalize(h.title || '').includes(wantTitle));

  // Pass 1: an explicitly song-disambiguated article wins outright.
  const songArticle = candidates.find((h) => /\(.*song\)$/i.test(h.title || ''));
  if (songArticle) return songArticle;

  // Pass 2: an undisambiguated title whose snippet mentions the artist —
  // the song as primary topic. A title disambiguated as anything else
  // ("(album)", "(tour)", "(film)") is specifically NOT the song article,
  // even though its snippet very likely mentions the artist too.
  return (
    candidates.find((h) => {
      if (/\([^)]*\)\s*$/.test(h.title || '')) return false;
      const snippet = normalize(stripHtml(h.snippet));
      return wantArtist.length >= 2 && snippet.includes(wantArtist);
    }) || null
  );
}

// For the artist page, require a near-exact title match plus a musical
// word in the snippet — "Prince" should match the musician's article, but
// a channel named after some common word shouldn't drag in an unrelated
// biography or place.
const MUSICAL_SNIPPET = /\b(singer|songwriter|musician|band|rapper|record|music|dj|producer|composer|group)\b/i;

export function pickArtistHit(hits, artist) {
  const want = normalize(artist);
  if (want.length < 2) return null;

  for (const hit of hits) {
    const hitTitle = normalize((hit.title || '').replace(/\([^)]*\)$/, ''));
    if (hitTitle !== want) continue;
    if (MUSICAL_SNIPPET.test(stripHtml(hit.snippet))) return hit;
  }
  return null;
}

async function fetchExtract(pageTitle) {
  const data = await wikiFetch(`${SUMMARY_API}/${encodeURIComponent(pageTitle)}`);
  const extract = data?.extract?.trim();
  // Disambiguation pages have summaries too — those are lists, not facts.
  if (!extract || data?.type === 'disambiguation') return null;
  return extract;
}

/**
 * Looks up {title, author} on English Wikipedia and returns a compact text
 * block with the song article's intro (and the artist article's intro when
 * confidently found), or null. Never throws.
 */
export async function fetchWikipediaContext({ title, author }) {
  try {
    const artist = cleanAuthor(author);
    const song = extractSongTitle(title, artist);
    if (!song) return null;

    const [songSearch, artistSearch] = await Promise.all([
      wikiFetch(searchUrl(`${song} ${artist} song`.trim())),
      artist ? wikiFetch(searchUrl(artist)) : Promise.resolve(null),
    ]);

    const songHit = pickSongHit(songSearch?.query?.search || [], song, artist);
    const artistHit = pickArtistHit(artistSearch?.query?.search || [], artist);
    if (!songHit && !artistHit) return null;

    const [songExtract, artistExtract] = await Promise.all([
      songHit ? fetchExtract(songHit.title) : Promise.resolve(null),
      artistHit ? fetchExtract(artistHit.title) : Promise.resolve(null),
    ]);

    const lines = [];
    if (songExtract) {
      lines.push(`Wikipedia on the song ("${songHit.title}"): ${songExtract.slice(0, MAX_SONG_EXTRACT_LEN)}`);
    }
    if (artistExtract) {
      lines.push(`Wikipedia on the artist ("${artistHit.title}"): ${artistExtract.slice(0, MAX_ARTIST_EXTRACT_LEN)}`);
    }
    if (lines.length === 0) return null;

    return lines.join('\n\n').slice(0, MAX_CONTEXT_LEN);
  } catch (err) {
    console.warn('Unexpected error building Wikipedia context:', err?.message || err);
    return null;
  }
}
