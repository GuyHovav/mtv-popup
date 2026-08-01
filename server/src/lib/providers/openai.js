import OpenAI from 'openai';
import { SYSTEM_PROMPT, buildUserPrompt, factsJsonSchema } from '../promptBuilder.js';

// Constructed lazily (inside callOpenAI, after the key-presence check) —
// unlike the Gemini SDK, OpenAI's client throws immediately at construction
// if no key is set, which would crash the whole server at startup for
// anyone who leaves this (optional) provider unconfigured.
let client = null;

// OpenAI's strict structured outputs don't support minItems/maxItems either
// (same limitation we hit with Gemini) — this is a secondary fallback path,
// so an imperfect count here is an acceptable trade-off.
function buildResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'trivia_facts',
      strict: true,
      schema: factsJsonSchema(),
    },
  };
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 503]);
const MAX_ATTEMPTS = 2; // this is already a fallback path — fail fast to the final tier
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls OpenAI and returns a facts array, or throws. Used as the fallback
 * when Gemini fails outright.
 */
export async function callOpenAI({ title, author, durationSeconds, factCount, geniusContext }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  let response;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await client.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ title, author, durationSeconds, factCount, geniusContext }) },
        ],
        response_format: buildResponseFormat(),
      });
      break;
    } catch (err) {
      const isTransient = TRANSIENT_STATUS_CODES.has(err?.status);
      if (isTransient && attempt < MAX_ATTEMPTS) {
        console.warn(`OpenAI request failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`, err?.message || err);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }

  const choice = response.choices?.[0];
  if (!choice || choice.finish_reason === 'content_filter') {
    throw new Error(`OpenAI declined/filtered the request (finish_reason: ${choice?.finish_reason})`);
  }

  const text = choice.message?.content;
  if (!text) {
    throw new Error('No content in OpenAI response');
  }

  const parsed = JSON.parse(text); // throws on malformed JSON — caller catches
  if (!Array.isArray(parsed.facts) || parsed.facts.length === 0) {
    throw new Error('OpenAI returned an empty facts array');
  }

  return parsed.facts;
}
