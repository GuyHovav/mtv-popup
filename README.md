# Pop-up Video

A tiny recreation of MTV's *Pop-up Video* for any YouTube video: paste a link, and
AI-generated trivia "balloons" pop up over the video at scattered timestamps as it plays.

## How it works

- **Client** (`client/`): a Vite + React app. It parses the YouTube URL, fetches the
  video's title/author via YouTube's public oEmbed endpoint (no API key needed),
  embeds the video with the YouTube IFrame Player API, and once the player reports
  its duration, asks the backend for a set of trivia facts.
- **Server** (`server/`): a small Express API (`POST /api/facts`) that calls the
  Gemini API (`gemini-2.5-flash-lite`) to generate a JSON list of `{ time_seconds, text }`
  facts for the given song/video, so your Gemini API key never touches the browser.

## Setup

```bash
npm install
cp .env.example server/.env
# edit server/.env and set GEMINI_API_KEY=... (get a free key at https://aistudio.google.com/apikey)
npm run dev
```

This starts the Vite dev server (usually http://localhost:5173) and the Express API
(http://localhost:3001) together. The client proxies `/api/*` requests to the server
in dev, so just open the Vite URL in your browser.

## Notes

- No YouTube Data API key is required.
- No database, auth, or deployment config — this is a local demo project.
- If Gemini can't generate confident, specific trivia for an obscure video, or
  declines the request, the backend falls back to general music trivia rather
  than failing outright.
