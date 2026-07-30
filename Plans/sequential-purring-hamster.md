# MTV Pop-up Video for YouTube

## Context

The user wants a web app that recreates MTV's classic "Pop-up Video" experience for any YouTube video: as a song plays, animated "balloon" callouts pop up over the video at specific timestamps with interesting trivia — either tied to that moment in the song, or general facts about the song/artist. The project directory is currently empty (greenfield, no existing code).

Key decisions locked in with the user:
- **Facts are AI-generated on demand** (not curated/hardcoded) — a backend calls the Claude API with the video's title/artist/duration and gets back a timestamped set of trivia facts, so it works for any arbitrary YouTube URL with no manual prep.
- **Frontend**: React + Vite SPA, plain CSS (no UI kit needed for the custom balloon popups).
- **Backend**: a small Node/Express server exists solely to keep the Anthropic API key server-side (never exposed to the browser), using the official `@anthropic-ai/sdk`.
- No YouTube Data API key needed — video title/author come from the no-auth oEmbed endpoint, and duration comes from the YouTube IFrame Player API itself once it loads client-side.
- No database, no auth, no deployment infra — this is a local hobby/demo project (`npm run dev` runs everything).

## Project Structure

npm workspaces monorepo, plain JavaScript, `concurrently` to run both dev servers with one command.

```
mtv-popup/
├── package.json                 # workspaces: ["client","server"]; "dev" script via concurrently
├── .gitignore
├── .env.example
├── README.md
├── client/                      # Vite + React SPA
│   ├── vite.config.js           # dev proxy: /api -> http://localhost:3001
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── components/
│       │   ├── UrlForm.jsx
│       │   ├── YouTubePlayer.jsx
│       │   ├── PopupLayer.jsx
│       │   └── Balloon.jsx
│       ├── hooks/
│       │   ├── useYouTubePlayer.js
│       │   └── useFactSync.js
│       ├── lib/
│       │   ├── youtube.js       # parseVideoId, fetchOEmbed
│       │   └── api.js           # postFacts()
│       └── styles/balloon.css
└── server/                      # Express API
    ├── .env                     # gitignored — ANTHROPIC_API_KEY
    └── src/
        ├── index.js             # express app, cors, json, dotenv, routes
        ├── routes/facts.js      # POST /api/facts
        └── lib/
            ├── anthropic.js     # Claude client, schema, prompts, generateFacts()
            └── validate.js
```

Root `package.json` runs both dev servers:
```json
{
  "private": true,
  "workspaces": ["client", "server"],
  "scripts": {
    "dev": "concurrently -n client,server -c blue,green \"npm run dev -w client\" \"npm run dev -w server\""
  },
  "devDependencies": { "concurrently": "^9" }
}
```

## Getting Video Info (no YouTube Data API key)

**Video ID parsing** (`client/src/lib/youtube.js`) handles `watch?v=`, `youtu.be/`, `embed/`, `shorts/`, `live/` and arbitrary extra query params via a small set of regexes plus a `URL().searchParams` fallback.

**Metadata via oEmbed** (no key required): `GET https://www.youtube.com/oembed?url=<encoded watch URL>&format=json` → `{ title, author_name }`. A non-OK response means private/unlisted/deleted/age-restricted — surface as a friendly error *before* attempting to mount the player.

**Duration** isn't in oEmbed — read it client-side via the IFrame Player API's `player.getDuration()`, polled after `onReady` until non-zero (cap the poll at ~5s, falling back to a default of 180s if it never resolves, so the app still works).

**Exact flow:**
1. User submits a URL → `parseVideoId()`. Invalid → inline error, stop.
2. `fetchOEmbed(videoId)` → title/author. Failure → "video not found/private/unavailable" error, stop.
3. Mount the YouTube IFrame Player with that video ID.
4. On `onReady`, poll `getDuration()` until it resolves.
5. Once `{title, author}` and `durationSeconds` are both available, `POST /api/facts`.
6. Store returned `facts` in React state and start the sync engine.

## Backend API — `POST /api/facts`

Request:
```json
{ "videoId": "dQw4w9WgXcQ", "title": "...", "author": "...", "durationSeconds": 213 }
```

Server-side validation (`server/src/lib/validate.js`): `videoId` matches `/^[\w-]{11}$/`; `title`/`author` non-empty, trimmed, capped ~300 chars (truncate, don't reject); `durationSeconds` finite, clamped to `[1, 21600]`.

Fact count scales with duration, bounded so short clips still feel populated and long videos don't get overwhelming/expensive:
```js
const factCount = Math.min(18, Math.max(6, Math.round(durationSeconds / 20)));
```

Success (`200`):
```json
{ "videoId": "dQw4w9WgXcQ", "facts": [ { "time_seconds": 14, "text": "..." }, ... ] }
```

Errors: `400 { "error": "invalid_video_id" | "invalid_duration" | "missing_fields" }` for bad input; `502 { "error": "generation_failed" }` only if the Claude call itself fails outright (network/5xx after SDK retries). A refused/empty/malformed Claude response is **not** a hard failure — the server substitutes a small hardcoded fallback fact set so the client never sees a broken response (see below). No auth/rate-limiting needed at this scale — the duration clamp and fact-count cap already bound per-request cost.

## Claude API Integration (`server/src/lib/anthropic.js`)

Uses `@anthropic-ai/sdk` (never raw HTTP). Model: `claude-opus-5`, `thinking` left unset (adaptive thinking is on by default when omitted on this model — appropriate here since this is generation, not hard reasoning), `output_config.effort: "medium"` for a good cost/quality balance (bump to `"high"` if generated facts feel thin).

**Structured output** via `output_config.format` (a `json_schema`) — avoids all freeform-text parsing:
```js
const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { time_seconds: { type: 'integer' }, text: { type: 'string' } },
        required: ['time_seconds', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
};
```
Note: the schema subset doesn't support `minItems`/`maxItems`, so the requested fact count is a prompt instruction, not a hard schema constraint.

**System prompt** casts Claude as the head writer for a Pop-up Video revival: punchy 1–2 sentence facts, trivia-show tone; a mix of moment-specific facts (only when plausibly tied to that timestamp — never invent fake specifics) and general artist/song/genre facts (falling back to genre/era-level facts when the specific song/artist is unfamiliar); explicit instruction never to fabricate precise stats/dates/chart positions; spread facts across the whole duration.

**User prompt** passes title, author, duration, and the target fact count, asking for `time_seconds` + `text` per fact, ordered ascending.

`generateFacts()` calls `client.messages.create(...)`, checks `stop_reason === 'refusal'` and JSON-parse failures, and falls back to `buildFallbackFacts(durationSeconds)` (a handful of generic hardcoded music-trivia lines spread across the duration) in either case, so the API contract's "always 200 with a real facts array" promise holds. `max_tokens: 4000` — no streaming needed at this size.

## Frontend Sync + Popup Engine

**`useYouTubePlayer.js`** — loads `iframe_api` once (singleton), creates the `YT.Player`, exposes `{ player, isReady, duration }`.

**`useFactSync(player, facts)`** — the core engine, polling `player.getCurrentTime()` every ~250ms while playing:
- Tracks a `shown` flag per fact and a small `activeBalloons` list (cap ~2 concurrent, queue a 3rd briefly rather than dropping it).
- **Seek detection**: if `currentTime` jumps by more than ~1.5s versus the expected elapsed time, treat it as a scrub. On seek, recompute every fact's `shown` flag directly from position (`shown = time_seconds < currentTime - epsilon`) — this single rule both re-arms facts the user scrubbed backward past, and skips/marks-shown any facts behind a forward scrub so they don't all fire at once. Clear `activeBalloons` on seek.
- **Normal tick**: trigger any unfired fact whose `time_seconds` has just been reached (small lookback window to absorb interval jitter), mark it shown, and add it to `activeBalloons` for ~6–7s before auto-dismissing (pop-out animation).

**Balloon visuals** (`Balloon.jsx` + `balloon.css`): rounded-rect callout with a CSS-triangle tail, positioned in one of 4 corner/edge slots (percentage offsets, capped `max-width` so it never covers the center of the video), pop-in animation (`scale(0.3) → 1.08 → 1` with a slight rotate wobble, bouncy easing, ~350–450ms) and a faster pop-out fade (~200ms). 4–5 color variants cycled/randomized so consecutive balloons look distinct.

**`PopupLayer.jsx`** — absolutely-positioned overlay above the (position:relative) player container; `pointer-events: none` on the wrapper, `auto` on individual balloons so they're click-dismissible without blocking video clicks.

## File Breakdown

**Client:**
| File | Purpose |
|---|---|
| `App.jsx` | Top-level state (videoId, meta, facts, loading/error); orchestrates the flow |
| `components/UrlForm.jsx` | URL input + submit + inline validation errors |
| `components/YouTubePlayer.jsx` | Renders the IFrame container, wires `useYouTubePlayer` |
| `components/PopupLayer.jsx` | Overlay rendering active balloons |
| `components/Balloon.jsx` | Single balloon (fact, color, slot, dismiss) |
| `hooks/useYouTubePlayer.js` | IFrame API loading + player lifecycle |
| `hooks/useFactSync.js` | Polling, seek detection, balloon scheduling |
| `lib/youtube.js` | `parseVideoId()`, `fetchOEmbed()` |
| `lib/api.js` | `postFacts(...)` |

**Server:**
| File | Purpose |
|---|---|
| `index.js` | Express setup: dotenv, cors, json, route mounting |
| `routes/facts.js` | `POST /api/facts` handler |
| `lib/anthropic.js` | Claude client, schema, prompts, `generateFacts()`, fallback facts |
| `lib/validate.js` | Request validation, typed errors with HTTP status |

## Environment/Config

`server/.env` (gitignored): `ANTHROPIC_API_KEY=sk-ant-...`, optional `PORT=3001`. Root `.env.example` documents the key. `.gitignore` covers `node_modules/`, `.env`, `client/dist/`. `client/vite.config.js` proxies `/api` → `http://localhost:3001` in dev so no CORS/base-URL config is needed on the client (Express `cors()` stays as a cheap safety net regardless).

## Build Sequence

1. Root scaffolding (`package.json` workspaces, `.gitignore`, `.env.example`).
2. `server/`: install `express cors dotenv @anthropic-ai/sdk`; minimal `index.js` + health check route.
3. `lib/anthropic.js` (schema/prompts/`generateFacts()`) — sanity-check standalone before wiring routes.
4. `routes/facts.js` + `validate.js`, mount in `index.js`.
5. Scaffold `client/` via Vite React template; strip boilerplate.
6. `lib/youtube.js` + `UrlForm.jsx` + `App.jsx` up through the oEmbed fetch — verify against a real URL.
7. `useYouTubePlayer.js` + `YouTubePlayer.jsx` — verify `onReady`/duration behavior.
8. Wire full flow: URL → oEmbed → player mount → duration → `POST /api/facts` → facts in state.
9. `useFactSync.js` with a `console.log` placeholder (no visuals yet) — verify trigger/seek logic against real playback.
10. Build `Balloon.jsx` + `PopupLayer.jsx` visuals/animations.
11. Polish: color-variant pool, slot-collision handling, error-state UI (invalid URL, private/unavailable video, degraded-facts banner).
12. `README.md` with setup + `.env` instructions.

**Known edge cases to handle:** embed-disabled videos (YouTube error codes 101/150 — player mounts but can't play, needs a friendly error), `getDuration()` timing (must wait for ready/cued state, not call immediately), oEmbed failures on private/age-restricted/deleted videos (must be caught before mounting the player).

## Verification

- `npm install` at the root, then `npm run dev` should start both the Vite dev server and the Express API concurrently with no errors.
- Manually test the end-to-end flow with a real, well-known YouTube music video URL: paste URL → see loading state → video mounts and plays → balloons pop up at scattered timestamps with plausible, on-tone trivia → balloons auto-dismiss → scrubbing backward re-triggers passed facts, scrubbing forward skips intervening ones without dumping them all at once.
- Test error paths: a non-YouTube URL (inline validation error before any network call), a private/deleted video ID (oEmbed failure surfaced as a friendly message), a legitimate but obscure/unknown video (facts should still generate — general/genre-level trivia rather than a broken response).
- Check the server terminal for any Claude API errors (auth, refusal, malformed JSON) and confirm the fallback-facts path kicks in gracefully rather than surfacing a 502 to the user in those cases.
- Confirm `ANTHROPIC_API_KEY` never appears in any client-side network request (check the browser Network tab — only `/api/facts` should be called from the browser, never `api.anthropic.com` directly).
