# Better Genius matching for covers, multi-candidate scoring, and anti-repetition

## Context

Four follow-up improvements from a brainstorm on making facts better/more
interesting/more precise:
1. Better Genius matching for cover/live uploads
2. Checking multiple Genius search candidates instead of just the top hit
3. An anti-repetition pass (facts restating the same trivia twice in one batch)
4. Avoiding repeated opening phrases ("Did you know...", "Fun fact...")

The first two are really one underlying fix to `server/src/lib/genius.js`'s
matching logic; the last two are a new deterministic post-processing step
alongside the existing `repositionFactsByLanguage` in
`server/src/lib/promptBuilder.js`. No new APIs, no new env vars, no extra
LLM round-trips — same "prompt guidance + deterministic safety net"
philosophy already used for fact timing.

## Part 1: Genius matching (covers + multi-candidate)

**Current gap.** `fetchGeniusContext` only ever looks at the *first*
`type === 'song'` hit from Genius's search, and rejects it unless the
YouTube channel name (`cleanAuthor(author)`) matches that hit's
`primary_artist.name`. That assumption breaks specifically for **cover
videos**: a cover channel's name (e.g. a random YouTuber) has nothing to do
with the original artist Genius actually indexes, so a legitimate, useful
match gets thrown away. "Live" versions don't have this problem — the
uploading channel is normally still the real artist, and
`cleanTitle` already strips bracketed content like `"(Live at Wembley)"`
via its existing strip-everything-in-brackets regex, so no changes are
needed there.

**Fix — detect covers and adapt both the query and the confidence check:**

In `server/src/lib/genius.js`, add:
```js
const COVER_PATTERN = /\bcover(?:\s+version)?\b/i;
const ORIGINAL_ARTIST_PATTERN = /\boriginally\s+(?:by|performed\s+by)\s+([^()[\]]+)/i;
```
- `isCover = COVER_PATTERN.test(title)` — whole-word match, won't false-positive on "recover"/"discover".
- `statedOriginalArtist`: if the title explicitly says "originally by X" /
  "originally performed by X", extract and `cleanAuthor(X)` it — a strong,
  free signal when present.
- Effective search/match artist: `statedOriginalArtist || (isCover ? null : cleanAuthor(author))`.
  When it's `null` (an unresolved cover — no stated original artist), build
  the search query from **title only**, skipping the channel name, since
  including a random cover channel's name as a search term just adds noise
  when we know it isn't the real artist.

**Fix — check multiple candidates, with a title-similarity fallback pass:**

Take up to the top 5 `type === 'song'` hits (already returned by the same
single `/search` call — no extra request) instead of just the first:
```js
const songHits = hits.filter((h) => h.type === 'song').slice(0, 5);
```
Add a title-similarity helper alongside the existing `isConfidentMatch`
(same dependency-free normalize-and-substring approach):
```js
function isConfidentTitleMatch(cleanedTitle, hitTitle) {
  const a = normalize(cleanedTitle);
  const b = normalize(hitTitle);
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}
```
Then, in order:
1. **Pass 1 (artist-based):** if there's an effective artist to check
   (`statedOriginalArtist` or a non-cover `cleanAuthor(author)`), scan
   `songHits` in order and accept the first one where
   `isConfidentMatch(effectiveArtist, hit.result.primary_artist.name)`
   passes — same logic as today, just checked across up to 5 hits instead
   of 1.
2. **Pass 2 (title-based fallback):** if pass 1 found nothing (including
   the unresolved-cover case where there's no artist to check at all), scan
   the *same* `songHits` again and accept the first where
   `isConfidentTitleMatch(cleanTitle(title), hit.result.title)` passes.
   This generalizes the cover fix beyond just titles that literally say
   "(Cover)" — it also helps the common case of a cover video with no
   qualifier at all, where the artist check was always going to fail.
3. If neither pass finds anything, return `null` — unchanged
   graceful-degradation behavior, just harder to end up there needlessly.

This replaces the current single `hits.find(...)` + one confidence check
with the above two-pass, multi-candidate logic. Everything else in
`fetchGeniusContext` (fetching `/songs/:id`, `formatGeniusContext`, all
error handling) is unchanged.

## Part 2: Anti-repetition + opening-phrase variety

New deterministic post-processing in `server/src/lib/promptBuilder.js`,
applied only to real LLM output (not `buildFallbackFacts`'s static
templates, which are already curated and don't need it). Wrap it in one
exported function so `facts.js` only has to change its two call sites from
`repositionFactsByLanguage(facts, durationSeconds)` to
`postProcessFacts(facts, durationSeconds)`:

```js
export function postProcessFacts(facts, durationSeconds) {
  const repositioned = repositionFactsByLanguage(facts, durationSeconds);
  const deduped = removeDuplicateFacts(repositioned);
  return diversifyOpeners(deduped);
}
```

**Duplicate removal** — a simple, dependency-free word-overlap check
(same "no fuzzy-matching library" constraint used in `genius.js`):
```js
function normalizeForComparison(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3); // cheap stopword-ish filter
}

function jaccardSimilarity(wordsA, wordsB) {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
```
`removeDuplicateFacts(facts)` walks the list, keeping a fact only if its
word-set similarity to every already-kept fact is below a threshold
(~0.5). Dropped facts just mean a batch occasionally ends up with fewer
than `factCount` facts — an accepted trade-off, same spirit as dropping a
low-confidence Genius match rather than guessing wrong.

**Opening-phrase variety** — deterministic correction, no second LLM call:
```js
const GENERIC_OPENERS = [
  /^did you know[,:]?\s*/i,
  /^fun fact[,:]?\s*/i,
  /^believe it or not[,:]?\s*/i,
  /^here'?s? (?:a|the) (?:fun )?fact[,:]?\s*/i,
  /^trivia[,:]?\s*/i,
];
const MAX_OPENER_USES = 1;
```
`diversifyOpeners(facts)` tracks how many times each opener pattern has
already been used; the first use of a given opener passes through
unchanged, but subsequent uses get that boilerplate lead-in phrase
stripped and the remaining sentence re-capitalized (e.g. a fact starting
"Fun fact: the producer also..." becomes "The producer also..." on its
second occurrence) — trims the repetitive framing without needing to
regenerate content.

**Also strengthen `SYSTEM_PROMPT`** with an explicit instruction naming
these same opener phrases and capping their use, right after the existing
"vary the phrasing..." bullet — so the deterministic pass has less work to
do in practice, same "prompt guidance + safety net" pairing used
elsewhere.

## Files touched

- `server/src/lib/genius.js` — cover detection, multi-candidate + two-pass
  matching (only `fetchGeniusContext` and its helpers change)
- `server/src/lib/promptBuilder.js` — new `postProcessFacts`,
  `removeDuplicateFacts`, `diversifyOpeners`; small `SYSTEM_PROMPT` addition
- `server/src/lib/facts.js` — swap `repositionFactsByLanguage(...)` for
  `postProcessFacts(...)` at both call sites (Gemini success, OpenAI success)

## Verification

1. **Genius matching** — exercise `fetchGeniusContext` directly (same
   manual-node-script approach used for the original Genius integration)
   against: a normal official upload (unchanged behavior — still matches
   via pass 1), a title containing "(Cover)" with an unrelated channel name
   (should now match via the title-only query + pass 2, where it
   previously returned `null`), a title with an explicit "originally by X"
   credit (should match using the extracted artist), and a garbled/no-match
   case (should still cleanly return `null`).
2. **Post-processing** — feed `postProcessFacts` a hand-built facts array
   containing two near-duplicate facts (same underlying trivia, different
   wording) and confirm one is dropped; feed it a batch where 3+ facts
   start with "Did you know" and confirm only the first is left as-is while
   the rest have the opener stripped and are still readable, correctly
   capitalized sentences.
3. **End-to-end** — run `generateFacts` against a couple of real videos
   locally (a normal upload and, if available, a well-known cover video)
   and confirm the output reads more varied and, for the cover case, that
   Genius context now shows up where it didn't before.
