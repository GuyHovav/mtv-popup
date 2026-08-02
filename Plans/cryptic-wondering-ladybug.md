# Suggested Videos section (click to play in-app)

## Context

The app currently only loads a video when the user pastes a URL into
`UrlForm` (or via the Android share-intent flow in `App.jsx`). There's no
way to discover a next video without leaving the app. The goal: show a
row of other videos the user can click, which loads and plays instantly
in-app — exactly like submitting a URL does today.

**Important constraint discovered during planning:** YouTube's "related to
this video" API (`search.list`'s `relatedToVideoId` parameter) was
deprecated industry-wide around 2020 and no longer returns results for
API keys — there is no way to get YouTube's actual recommendation
algorithm output via the public API. The practical alternative — and a
good thematic fit for a music trivia app — is showing **other videos from
the same channel/artist** via `search.list` with a `channelId` filter.
This is fully supported and reliable, just not "true" algorithmic
suggestions.

**Quota note (confirmed with user, no caching in v1):** `search.list`
costs 100 quota units per call against a free 10,000 units/day budget —
roughly ~90-100 video loads/day before hitting the ceiling, once you also
count the 1-unit `videos.list` lookup needed per load. Accepted for now
given current traffic; revisit with a caching layer (would need an
external store like Vercel KV/Redis, since serverless functions can't
reliably cache in-memory across invocations) only if usage grows enough
to matter.

This also means the app needs a **new `YOUTUBE_API_KEY`** env var — not
currently configured anywhere (the earlier idea to feed YouTube
descriptions into the AI prompt was shelved in favor of Genius, so this
key was never added). The suggestions feature won't work without it, but
— matching this app's established graceful-degradation pattern — the app
functions normally without the key configured; the suggestions section
just doesn't render.

## Approach

### Server: new `/api/suggestions` endpoint (mirrors the `/api/facts` pattern exactly)

**New shared helper: `server/src/lib/suggestions.js`**, exporting
`fetchSuggestedVideos(videoId)` → `Promise<Array<{videoId, title, thumbnailUrl, channelTitle}>>` (always resolves, empty array on any failure, never throws — same contract as `genius.js`'s `fetchGeniusContext`):
1. Short-circuit to `[]` if `YOUTUBE_API_KEY` isn't set.
2. `GET videos.list?part=snippet&id=<videoId>&key=...` (1 quota unit) to get
   `snippet.channelId` for the currently playing video.
3. `GET search.list?part=snippet&channelId=<channelId>&type=video&order=viewCount&videoDuration=medium&maxResults=10&key=...`
   (100 quota units) — `order=viewCount` surfaces the channel's most
   popular uploads (better music-discovery fit than raw recency);
   `videoDuration=medium` (4-20 min) filters out Shorts and long-form
   livestreams/full-album uploads that would clutter a "songs by this
   artist" row.
4. Filter out the current `videoId` from the results (a channel's own
   video is very likely to appear in its own search results).
5. Map each result to `{ videoId: item.id.videoId, title: item.snippet.title, thumbnailUrl: item.snippet.thumbnails.medium.url, channelTitle: item.snippet.channelTitle }` — no extra oEmbed calls needed, `search.list`'s snippet already has everything a card needs.
6. Wrap the whole thing in try/catch like `genius.js` — any network error,
   non-2xx, empty channel, etc. resolves to `[]`.

**New route files**, following the exact `facts.js`/`api/facts.js` dual-entrypoint pattern (Express route for local dev, Vercel serverless mirror for production — these don't share routing code, only the underlying lib, so both need the same logic):
- `server/src/routes/suggestions.js` — `GET /api/suggestions?videoId=...`, validates `videoId` against the same `/^[\w-]{11}$/` pattern used in `validate.js`, calls `fetchSuggestedVideos`, responds `{ suggestions }`.
- `api/suggestions.js` — identical logic, Vercel handler signature, importing from `../server/src/lib/suggestions.js`.
- `server/src/index.js` — mount: `app.use('/api/suggestions', suggestionsRouter)`.

**`.env.example`** — add `YOUTUBE_API_KEY` (optional/graceful-degradation framing, same style as `GENIUS_ACCESS_TOKEN`'s entry), noting it's required specifically for the Suggested Videos feature to actually produce results.

### Client: reuse the existing video-load pipeline, no new "load video" logic needed

This is the key simplification: `App.jsx`'s existing `handleSubmit(videoId)`
(lines 46-58) already takes a bare video ID and runs the full pipeline
(fetch oEmbed → set state → `'loading-player'` → player mounts → `'fetching-facts'` → `postFacts` → `'ready'`). It's already called two ways today: from `UrlForm`'s `onSubmit` prop, and directly from the share-intent `useEffect` on mount. A suggestion click is a third caller of the exact same function — **no refactor required**.

1. **`client/src/lib/api.js`** — add `fetchSuggestions(videoId)`, a `GET /api/suggestions?videoId=...` call returning `{ suggestions: [] }` on any non-OK response (never throws — the client should treat a failed suggestions fetch the same as "no suggestions available," not an app-level error).

2. **New component `client/src/components/SuggestedVideos.jsx`** — takes `{ videos, onSelect }`, renders nothing if `videos.length === 0`, otherwise a horizontally-scrollable row of cards (thumbnail + title + channel name), each calling `onSelect(video.videoId)` on click. Small, single-purpose component matching the existing style of `Balloon.jsx`/`PopupLayer.jsx`.

3. **`client/src/App.jsx`**:
   - New state: `const [suggestions, setSuggestions] = useState([]);`
   - New `useEffect` gated on `status === 'ready'`, depending on `[videoId, status]`, following the exact same guard/`cancelled`-flag pattern as the existing `postFacts` effect (lines 93-119) — calls `fetchSuggestions(videoId)`, sets `suggestions` on success, leaves it `[]` on failure (no error state change — this is a non-critical enhancement, never surfaces as an app error).
   - Clear `suggestions` back to `[]` at the top of `handleSubmit` (so stale suggestions from the previous video don't flash while the next one loads) and in `reset()`.
   - Render `<SuggestedVideos videos={suggestions} onSelect={handleSubmit} />` as a new **top-level child of `.app`**, placed after the `.video-stage` block, gated on `status === 'ready'`. Passing `handleSubmit` directly as `onSelect` is what makes clicking a suggestion behave identically to submitting a URL.
   - Add `import './styles/suggestions.css';` alongside the existing `app.css`/`balloon.css` imports (`App.jsx:8-9`).

4. **New `client/src/styles/suggestions.css`** — horizontal-scroll row styling (flex row, `overflow-x: auto`, card min-width, thumbnail `aspect-ratio: 16/9`, consistent with the existing dark theme via `--color-surface`/`--color-border`/`--color-text-muted` custom properties already defined in `index.css`).

**No changes needed to the landscape-fullscreen "cinema mode" CSS**
(`app.css`'s `@media (orientation: landscape) and (pointer: coarse)` block) — confirmed its hiding rule is `.app:has(.video-stage) > *:not(.video-stage) { display: none; }`, a structural selector that automatically catches any new top-level `.app` child, including the new suggestions section, with zero extra work.

## Files touched

- `server/src/lib/suggestions.js` (new)
- `server/src/routes/suggestions.js` (new)
- `api/suggestions.js` (new)
- `server/src/index.js` (mount the new route)
- `.env.example` (`YOUTUBE_API_KEY`)
- `client/src/lib/api.js` (`fetchSuggestions`)
- `client/src/components/SuggestedVideos.jsx` (new)
- `client/src/styles/suggestions.css` (new)
- `client/src/App.jsx` (state, effect, render, cleanup)

## Verification

1. **Server, real key**: set `YOUTUBE_API_KEY` in `server/.env`, call
   `fetchSuggestedVideos(videoId)` directly for a well-known music video
   (e.g. Rick Astley's), confirm it returns other videos from that same
   channel with sensible titles/thumbnails, and confirm the current video
   itself is excluded from the results.
2. **Server, no key**: unset `YOUTUBE_API_KEY`, confirm `fetchSuggestedVideos`
   resolves to `[]` with no network call and no thrown error — matches
   the `genius.js` graceful-degradation pattern.
3. **Route parity**: diff `server/src/routes/suggestions.js` and
   `api/suggestions.js` after implementation to confirm the logic is
   identical aside from the relative import path (same check done for
   `facts.js`/`api/facts.js`).
4. **End-to-end in the browser**: `npm run dev`, load a video, confirm a
   row of suggested videos appears once the video reaches `'ready'` status,
   click one, and confirm it loads and plays exactly as if the URL had
   been pasted (trivia facts fetch again for the new video, `PopupLayer`
   still works, etc.).
5. **Cinema mode regression check**: rotate to landscape on a touch device/emulated device, confirm the suggestions row disappears along with the rest of the UI (already covered by the existing structural CSS selector, but worth a visual confirmation).
6. **Mobile/dev-tools check for the API key requirement**: confirm the app behaves identically to today (no errors, no visual gap) when `YOUTUBE_API_KEY` is unset — the suggestions section should simply not appear.
