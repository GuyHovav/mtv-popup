import { GoogleGenAI, Type, MediaResolution } from '@google/genai';
import { SYSTEM_PROMPT, buildUserPrompt, factsJsonSchema } from '../promptBuilder.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Prompt instructions alone ("generate exactly N facts") turned out not to
// be reliable for larger N — Gemini would quietly under-deliver (e.g. 18
// facts when 44 were asked for). minItems/maxItems on the schema enforces
// the count structurally instead of just requesting it in text.
function buildFactsSchema(factCount) {
  const plain = factsJsonSchema();
  return {
    type: Type.OBJECT,
    properties: {
      facts: {
        type: Type.ARRAY,
        minItems: factCount,
        maxItems: factCount,
        items: {
          type: Type.OBJECT,
          properties: {
            time_seconds: { type: Type.INTEGER },
            text: { type: Type.STRING },
          },
          required: plain.properties.facts.items.required,
        },
      },
    },
    required: plain.required,
  };
}

const TRANSIENT_STATUS_CODES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

// Gemini can take a public YouTube URL as actual video input, which is what
// lets facts reference things literally on screen ("that gold Cadillac...")
// with observed timestamps instead of guessed ones. Video input costs real
// tokens even at MEDIA_RESOLUTION_LOW (~100 tokens/second of video, so
// ~20 min ≈ 120k tokens), so cap how long a video gets attached — beyond
// the cap, generation falls back to the original text-only prompt.
const MAX_VIDEO_INPUT_SECONDS = 20 * 60;

// Hard cap on the single video-input attempt (see callGemini) — generous
// against observed ~10-25s generations, but strict enough to leave the
// text-only and OpenAI fallbacks room inside the 60s function budget.
const VIDEO_ATTEMPT_TIMEOUT_MS = 35000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestFacts({ title, author, durationSeconds, factCount, geniusContext, wikiContext, videoId, withVideo, maxAttempts = MAX_ATTEMPTS, attemptTimeoutMs }) {
  const prompt = buildUserPrompt({
    title,
    author,
    durationSeconds,
    factCount,
    geniusContext, wikiContext,
    videoAttached: withVideo,
  });

  const parts = withVideo
    ? [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } }, { text: prompt }]
    : [{ text: prompt }];

  let response;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const abortController = new AbortController();
    const abortTimer = attemptTimeoutMs ? setTimeout(() => abortController.abort(), attemptTimeoutMs) : null;
    try {
      // gemini-2.5-flash-lite: the cheapest/fastest tier in the 2.5 family —
      // plenty capable for short trivia generation, no need for -pro or
      // even standard -flash here.
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: buildFactsSchema(factCount),
          // Explicit ceiling since factCount can now reach 80 for long videos —
          // don't rely on the model's default output cap.
          maxOutputTokens: 16000,
          // Low resolution keeps video-input token cost roughly a third of
          // the default; balloon-worthy visuals (cars, outfits, locations)
          // survive the downsampling fine. Harmless on text-only requests.
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          abortSignal: abortController.signal,
        },
      });
      break;
    } catch (err) {
      // Gemini frequently returns 503 UNAVAILABLE under load — retry a
      // couple of times before giving up, rather than failing on the
      // first transient hiccup.
      const isTransient = TRANSIENT_STATUS_CODES.has(err?.status);
      if (isTransient && attempt < maxAttempts) {
        console.warn(`Gemini request failed (attempt ${attempt}/${maxAttempts}), retrying:`, err?.message || err);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
  }

  const candidate = response.candidates?.[0];
  const blockedReasons = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION']);
  if (!candidate || blockedReasons.has(candidate.finishReason)) {
    throw new Error(`Gemini declined/blocked the request (finishReason: ${candidate?.finishReason})`);
  }

  const text = response.text;
  if (!text) {
    throw new Error('No text in Gemini response');
  }

  const parsed = JSON.parse(text); // throws on malformed JSON — caller catches
  if (!Array.isArray(parsed.facts) || parsed.facts.length === 0) {
    throw new Error('Gemini returned an empty facts array');
  }

  return parsed.facts;
}

/**
 * Calls Gemini and returns { facts, videoGrounded }, or throws. Tries with
 * the YouTube video attached as real video input first (when the video is
 * short enough), so facts can describe what's actually on screen; if that
 * fails for any reason — region-locked/private video, YouTube-ingest
 * limits, an unsupported video — it retries once with the original
 * text-only prompt before the error propagates to the OpenAI fallback.
 * Transient errors (429/503) are retried within each mode.
 */
export async function callGemini({ videoId, title, author, durationSeconds, factCount, geniusContext, wikiContext }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // The video-input attempt is the expensive, failure-prone leg of the
  // chain, and everything after it (text-only Gemini with retries, then
  // OpenAI) still has to fit inside the serverless function's time budget.
  // So it gets exactly one attempt with a hard abort — a slow-failing
  // video ingest must degrade to text-only facts, not blow the whole
  // request past the platform timeout and surface as a user-facing error.
  const canAttachVideo = Boolean(videoId) && durationSeconds <= MAX_VIDEO_INPUT_SECONDS;
  if (canAttachVideo) {
    try {
      const facts = await requestFacts({
        title, author, durationSeconds, factCount, geniusContext, wikiContext, videoId,
        withVideo: true,
        maxAttempts: 1,
        attemptTimeoutMs: VIDEO_ATTEMPT_TIMEOUT_MS,
      });
      return { facts, videoGrounded: true };
    } catch (err) {
      console.warn('Gemini video-input request failed, retrying text-only:', err?.message || err);
    }
  }

  const facts = await requestFacts({ title, author, durationSeconds, factCount, geniusContext, wikiContext, videoId, withVideo: false });
  return { facts, videoGrounded: false };
}
