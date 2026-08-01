# Feed Genius song metadata into the trivia-fact prompt

## Context

The AI fact-writer (`server/src/lib/promptBuilder.js`) currently only sees
`{ title, author, durationSeconds, factCount }` and leans entirely on the
model's own training knowledge of the song/artist — it has no access to any
real, structured song data. Genius (genius.com) has exactly that: curated
"about" annotations, writer/producer credits, and structured sample/
interpolation/cover relationships — all better trivia fodder than the model
guessing, and (unlike a random YouTube description) generally moderated/
curated rather than boilerplate.

(This supersedes an earlier plan to use the YouTube video description for
the same purpose, which was scoped out in favor of Genius.)

Genius's API does **not** provide lyrics (access was revoked industry-wide
around 2016) — only a link to the lyrics page. Scraping that page would
violate Genius's ToS and is fragile. **Lyrics scraping is explicitly out of
scope** — this plan only uses Genius's structured metadata endpoints.

## Approach

Same shape as the app's existing multi-tier-fallback philosophy
(`server/src/lib/facts.js`'s Gemini → OpenAI → hardcoded-facts chain): fetch
Genius data server-side, fail soft to `null` on any problem, and never let
it block or break fact generation.

The real design problem isn't plumbing — it's **matching** a messy YouTube
`title`/`author` to the right Genius song. A wrong match is worse than no
match (it would feed the LLM a different song's trivia entirely), so this
needs a genuine confidence check, not just "take the first search hit."

### 1. New helper: `server/src/lib/genius.js`

Exports `fetchGeniusContext({ title, author })` → `Promise<string | null>`.

**Cleaning + query construction** — strip noise before searching:
- `cleanAuthor`: split camelCase channel names (`"RickAstleyVEVO"` →
  `"Rick Astley VEVO"`), strip a trailing `"- Topic"` (the reliable signal
  YouTube Music auto-generated channels give for the real artist name),
  strip `"VEVO"`/`"Official"` tokens.
- `cleanTitle`: strip bracketed/parenthetical noise (`"(Official Video)"`,
  `"(Lyrics)"`, `"[4K Remaster]"`), strip common bare noise phrases (official
  video/audio, lyric video, hd/4k, remaster), strip a trailing bare
  `feat./ft./featuring` clause.
- `buildSearchQuery(title, author)`: `${cleanAuthor} ${cleanTitle}`, capped
  to 200 chars (same spirit as `validate.js`'s `MAX_TEXT_LEN` pattern).

**Search + confidence check:**
- `GET /search?q=...` → take the first hit where `type === 'song'`.
- `isConfidentMatch(cleanedAuthor, hit.result.primary_artist.name)`:
  normalize both (lowercase, strip non-alphanumeric), bidirectional
  substring check. No fuzzy-matching dependency — deliberately simple.
- No hits, no song-type hit, or failed confidence check → return `null`
  (log at info level — this is an expected, routine outcome for obscure/
  garbled titles, not a warning-worthy failure).

**Fetch + format:**
- `GET /songs/:id?text_format=plain` (the `text_format=plain` param is
  important — without it, `description` comes back as a DOM/annotation
  structure instead of plain text).
- Pull: `description.plain` (capped ~800 chars), `release_date`,
  `writer_artists`/`producer_artists` (names, capped to 5 each), and
  `song_relationships` filtered to `samples`/`sampled_in`/`interpolates`/
  `interpolated_by`/`cover_of`/`covered_by` (capped to 6 entries) — this
  last one is the best trivia material since it's structured fact data, not
  prose the model has to extract facts from.
- Join into a compact text block, final cap ~1500 chars.
- **Verify exact field names against a live response before finalizing**
  (`song_relationships[].relationship_type` vs `.type` — docs are
  inconsistent here; confirm with a real `curl` call during implementation,
  fall back to `rel.relationship_type || rel.type` if needed).

**Error handling** — every path below resolves to `null`, nothing throws:
missing `GENIUS_ACCESS_TOKEN` (short-circuit, no network call — this is the
normal state for anyone who hasn't set it up), network error/timeout (use
an `AbortController` with a ~5s timeout on each fetch), non-2xx response,
malformed JSON, no hits, failed confidence check, missing song data, or any
unexpected shape error (wrap the whole function body in try/catch as a
last resort).

### 2. Thread `geniusContext` through the existing pipeline

Same insertion points used elsewhere in this codebase for optional context:
- `server/src/lib/facts.js` — `generateFacts({ ..., geniusContext })` passes
  it to both `callGemini(...)` and `callOpenAI(...)`.
- `server/src/lib/providers/gemini.js` / `openai.js` — destructure and
  forward `geniusContext` into `buildUserPrompt(...)`. No other changes.
- `server/src/lib/promptBuilder.js` — `buildUserPrompt` appends a block only
  when `geniusContext` is present:
  ```js
  const geniusBlock = geniusContext
    ? `\n\nReal song metadata from Genius (credits, sample/interpolation relationships, curated "about" text — use this for specific, accurate facts):\n${geniusContext}\n`
    : '';
  ```

### 3. `SYSTEM_PROMPT` addition (`promptBuilder.js`)

New bullet right after the existing "never fabricate precise statistics..."
line: when Genius metadata is present, treat it as verified/specific (not
something to hedge on) and prioritize weaving in samples/interpolations/
writer/producer credits from it; when absent, fall back to the existing
general/genre guidance.

### 4. Both duplicated route entrypoints get the identical edit

`server/src/routes/facts.js` and `api/facts.js` don't share routing code
(only the underlying lib) — both need the same insertion between validation
and `generateFacts`:
```js
const geniusContext = await fetchGeniusContext({ title, author });
const { facts, degraded } = await generateFacts({ title, author, durationSeconds, factCount, geniusContext });
```
Use the already-validated/sanitized `title`/`author` (post-`validateFactsRequest`).

### 5. `.env.example`

Add `GENIUS_ACCESS_TOKEN` (optional), with a one-line note: register a free
API client at genius.com/api-clients to get a Client Access Token — no
OAuth user flow needed, same operational shape as the existing
`GEMINI_API_KEY`/`OPENAI_API_KEY` entries.

## Files touched

- `server/src/lib/genius.js` (new)
- `server/src/lib/promptBuilder.js`
- `server/src/lib/facts.js`
- `server/src/lib/providers/gemini.js`
- `server/src/lib/providers/openai.js`
- `server/src/routes/facts.js`
- `api/facts.js`
- `.env.example`

## Manual setup step (outside this change)

Register an API client at genius.com/api-clients to get a Client Access
Token, add `GENIUS_ACCESS_TOKEN` to `server/.env` locally and to the Vercel
project's environment variables for production, then redeploy. Fact
generation works fine without it in the meantime (just without Genius
context).

## Verification

1. **Sanity-check the API directly first**, isolating Genius-API questions
   from app code: `curl -H "Authorization: Bearer $GENIUS_ACCESS_TOKEN"
   "https://api.genius.com/search?q=Rick+Astley+Never+Gonna+Give+You+Up"`,
   then a `/songs/:id?text_format=plain` call using the returned `id` —
   confirm `description.plain` and the exact `song_relationships` field
   names match what the code assumes.
2. **Confident match**: submit a well-known video (e.g. "Never Gonna Give
   You Up"). Confirm `fetchGeniusContext` returns a non-null block (check
   server logs / a temporary debug log) and that generated facts include
   something only Genius would supply (a producer credit, a sample/
   interpolation) — not just generic model knowledge.
3. **No confident match**: submit an obscure/ambiguous or garbled title/
   author pair. Confirm the "match rejected (low confidence)" info log
   fires (or a no-hits path), `fetchGeniusContext` resolves to `null`, and
   `/api/facts` still returns a normal, non-degraded response — identical
   behavior to before this feature existed.
4. **Token unset**: remove `GENIUS_ACCESS_TOKEN`, restart, submit any
   request — confirm no network call to `api.genius.com` happens at all and
   the whole request/response cycle is unchanged from the pre-Genius
   codebase.
5. **Parity check**: since `server/src/routes/facts.js` and `api/facts.js`
   are hand-duplicated, diff them after editing to confirm the Genius-
   related lines match (aside from the relative import path).
