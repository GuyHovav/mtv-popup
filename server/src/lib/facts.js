import { callGemini } from './providers/gemini.js';
import { callOpenAI } from './providers/openai.js';
import { buildFallbackFacts, repositionFactsByLanguage, computeFactCount } from './promptBuilder.js';

export { computeFactCount };

/**
 * Tries Gemini first, falls back to OpenAI if Gemini fails outright
 * (quota, network, blocked/malformed response), and falls back to a small
 * set of generic hardcoded facts if both providers fail. Only the final
 * tier counts as `degraded` — a successful OpenAI response is just as
 * tailored as a Gemini one, so it's not a lesser experience for the visitor.
 */
export async function generateFacts({ title, author, durationSeconds, factCount, geniusContext }) {
  try {
    const facts = await callGemini({ title, author, durationSeconds, factCount, geniusContext });
    return { facts: repositionFactsByLanguage(facts, durationSeconds), degraded: false };
  } catch (err) {
    console.warn('Gemini failed, trying OpenAI fallback:', err?.message || err);
  }

  try {
    const facts = await callOpenAI({ title, author, durationSeconds, factCount, geniusContext });
    return { facts: repositionFactsByLanguage(facts, durationSeconds), degraded: false };
  } catch (err) {
    console.warn('OpenAI fallback also failed, using generic facts:', err?.message || err);
  }

  return { facts: buildFallbackFacts(durationSeconds), degraded: true };
}
