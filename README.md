# Pop-up Video

A tiny recreation of MTV's *Pop-up Video* for any YouTube video: paste a link, and
AI-generated trivia "balloons" pop up over the video at a near-continuous pace as it plays.

## How it works

- **Client** (`client/`): a Vite + React app. It parses the YouTube URL, fetches the
  video's title/author via YouTube's public oEmbed endpoint (no API key needed),
  embeds the video with the YouTube IFrame Player API, and once the player reports
  its duration, asks the backend for a set of trivia facts.
- **Server** (`server/` locally, `api/` in production): a single `POST /api/facts`
  endpoint that calls Gemini (`gemini-2.5-flash-lite`) to generate a JSON list of
  `{ time_seconds, text }` facts, falling back to OpenAI (`gpt-4.1-mini`) if Gemini
  fails outright, and finally to a small set of generic hardcoded facts if both
  providers fail — so your API keys never touch the browser, and a provider hiccup
  never surfaces as a broken experience.
- `server/src/lib/` holds all the actual logic (prompt building, provider calls,
  fallback, positional-language correction) and has zero Express dependency —
  `server/src/routes/facts.js` is just the local-dev Express wrapper around it, and
  `api/facts.js` is the equivalent Vercel serverless function wrapper used in production.

## Local setup

```bash
npm install
cp .env.example server/.env
# edit server/.env and set GEMINI_API_KEY=... (get a free key at https://aistudio.google.com/apikey)
# OPENAI_API_KEY is optional — only used as a fallback if Gemini fails
npm run dev
```

This starts the Vite dev server (usually http://localhost:5173) and the Express API
(http://localhost:3001) together. The client proxies `/api/*` requests to the server
in dev, so just open the Vite URL in your browser.

## Deploying (GitHub → Vercel)

1. Push this repo to GitHub, then import it in the [Vercel dashboard](https://vercel.com/new).
   Keep the project's Root Directory as the repo root (not `client/`) — `vercel.json`
   and `api/` both live there.
2. In the Vercel project's Environment Variables, add `GEMINI_API_KEY` and
   `OPENAI_API_KEY` for **both Production and Preview**. This is the only place
   these secrets live in production — there's no `.env` file involved.
3. Deploy. Vercel's own GitHub integration auto-deploys on every push from here —
   no GitHub Actions needed for this part.

`vercel.json` builds the client (`npm run build -w client`) as the static site and
serves `api/*.js` as serverless functions reusing `server/src/lib/` directly.

## Android app (Capacitor + GitHub Actions)

`client/` is wrapped with [Capacitor](https://capacitorjs.com) as a thin native
shell that loads the **live deployed site** in a WebView (`client/capacitor.config.json`
→ `server.url`) — not a bundled copy, so the app always shows the latest deploy with
no separate rebuild-and-resync step. Update that URL to your real Vercel production
domain before building.

Release builds are signed and published via `.github/workflows/android-release.yml`:

1. Generate a signing keystore once (see the workflow file for the `keytool` command)
   and store it — base64-encoded — plus its passwords as four GitHub secrets:
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
   `ANDROID_KEY_PASSWORD`. **Back up the keystore file and passwords somewhere
   durable and personal** — GitHub Secrets are write-only, and losing this key
   means all future releases need a new package ID, breaking upgrade-in-place
   for anyone who already installed a build.
2. Test the pipeline via `gh workflow run android-release.yml` (or the Actions tab)
   before ever pushing a real tag — this uploads the APK as a downloadable
   workflow artifact without creating a release.
3. Cut a real release by pushing a semver tag: `git tag v1.0.0 && git push origin v1.0.0`.
   This builds a signed release APK and attaches it to a new GitHub Release.

## Notes

- No YouTube Data API key is required.
- No database or auth — this is still a small, stateless demo project; every
  visit is a fresh session with nothing saved.
- If both LLM providers decline, error, or fail to parse, the backend falls back
  to general music trivia rather than failing outright.
