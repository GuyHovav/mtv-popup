import { GoogleGenAI, Type } from '@google/genai';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls Gemini and returns a facts array, or throws. Retries transient
 * errors (429/503) a few times before giving up.
 */
export async function callGemini({ title, author, durationSeconds, factCount }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  let response;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // gemini-2.5-flash-lite: the cheapest/fastest tier in the 2.5 family —
      // plenty capable for short trivia generation, no need for -pro or
      // even standard -flash here.
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: buildUserPrompt({ title, author, durationSeconds, factCount }),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: buildFactsSchema(factCount),
          // Explicit ceiling since factCount can now reach 80 for long videos —
          // don't rely on the model's default output cap.
          maxOutputTokens: 16000,
        },
      });
      break;
    } catch (err) {
      // Gemini frequently returns 503 UNAVAILABLE under load — retry a
      // couple of times before giving up, rather than failing on the
      // first transient hiccup.
      const isTransient = TRANSIENT_STATUS_CODES.has(err?.status);
      if (isTransient && attempt < MAX_ATTEMPTS) {
        console.warn(`Gemini request failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`, err?.message || err);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
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
