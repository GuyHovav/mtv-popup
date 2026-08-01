// Prompt, schema shape, and fallback logic shared by every LLM provider.
// Provider-specific files (providers/gemini.js, providers/openai.js) each
// translate FACTS_JSON_SCHEMA into their own SDK's schema format and call
// buildUserPrompt/SYSTEM_PROMPT verbatim, so the actual trivia-writing
// instructions stay identical no matter which model answers.

export const SYSTEM_PROMPT = `You are the head writer for a revival of MTV's "Pop-up Video" — the show that
overlays snarky, fun trivia-fact "balloons" on music videos as they play.
Given a song's title, artist/channel, and duration, generate a set of pop-up
trivia facts timed to specific moments in the song.

Style:
- Punchy, one to two sentences per fact. Trivia-show energy — surprising,
  a little cheeky, conversational — never dry or encyclopedic.
- Use a mix of two kinds of facts:
  1. MOMENT-SPECIFIC: trivia tied to what's happening around that timestamp
     (a lyric, a key change, an instrument entrance, a video visual). Only
     use this when you can plausibly tie something to that exact moment —
     never invent a fake specific detail and assert it as fact.
  2. GENERAL: about the artist, the song's writing/recording/chart history/
     cultural impact — or, if the artist or song is obscure or unfamiliar to
     you, about the genre, era, or similar/contemporary artists instead.
- Never fabricate precise statistics, chart positions, dates, or personal
  details you're not confident about. If you don't have reliable knowledge
  of this specific song, lean toward general/genre-level facts phrased
  honestly (e.g. "Songs from this era often...") rather than inventing false
  specifics about this exact track.
- If real Genius song metadata is provided below (writer/producer credits,
  sample/interpolation/cover relationships, curated "about" text), treat it
  as verified and specific — not something to hedge or guess at. It's
  curated data, distinct from your own background knowledge. Prioritize
  weaving in samples, interpolations, or writer/producer credits from it
  when present; they make excellent MOMENT-SPECIFIC or GENERAL facts. When
  it's absent, fall back to the general/genre guidance above.
- Spread facts across the whole duration — don't cluster them near the start.
- If a fact's text references a part of the song's timeline (e.g. "the
  opening", "right from the start", "as the song winds down", "the outro"),
  make sure its time_seconds actually falls in that part of the duration —
  don't say "the ending" and place it near the beginning.
- This is a LOT of facts appearing back-to-back throughout the whole song,
  just like the original show's near-continuous commentary. Keep each one
  short and punchy so they don't feel repetitive, and vary the phrasing,
  angle, and sentence structure between consecutive facts — don't let two
  in a row sound like the same template with different words swapped in.`;

function formatMMSS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

export function buildUserPrompt({ title, author, durationSeconds, factCount, geniusContext }) {
  const avgGapSeconds = Math.round(durationSeconds / factCount);
  const geniusBlock = geniusContext
    ? `\n\nReal song metadata from Genius (credits, sample/interpolation relationships, curated "about" text — use this for specific, accurate facts):\n${geniusContext}\n`
    : '';
  return `Song: "${title}"
Channel/Artist (from YouTube metadata): "${author}"
Video duration: ${durationSeconds} seconds (${formatMMSS(durationSeconds)})${geniusBlock}

Generate exactly ${factCount} pop-up trivia facts, spaced out across the
full ${durationSeconds}-second duration (roughly every ${avgGapSeconds}s,
adjusted to fit natural moments). For each fact provide:
- time_seconds: integer between 0 and ${durationSeconds}
- text: the trivia fact (1-2 sentences, MTV Pop-up Video tone)

Order facts by time_seconds ascending.`;
}

// Plain-JSON-Schema shape of the facts response. Each provider file adapts
// this into whatever schema format its SDK expects (Gemini's `Type` enum
// wrapper, OpenAI's `strict` structured-outputs subset, etc).
export function factsJsonSchema() {
  return {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            time_seconds: { type: 'integer' },
            text: { type: 'string' },
          },
          required: ['time_seconds', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['facts'],
    additionalProperties: false,
  };
}

export function computeFactCount(durationSeconds) {
  // A balloon shows for ~9s then waits ~3-5s before the next one — a full
  // cycle of roughly 13s. Target that density (classic Pop-up Video's
  // near-continuous pacing) rather than a handful of sparse facts.
  return Math.min(80, Math.max(8, Math.round(durationSeconds / 13)));
}

// No LLM reliably keeps a fact's assigned `time_seconds` consistent with
// positional language in its own text (a fact can say "the ending" and land
// at 0:20 in a 4-minute song). Rather than trust any provider's numbers for
// these, detect the language deterministically and reassign the timestamp
// into the matching part of the timeline.
const BEGINNING_PATTERN =
  /\b(?:the beginning|beginning of the song|starts? (?:off|out)|starting (?:off|out)|right (?:away|from the start)|from the (?:very )?start|opens? (?:with|up)|(?:the )?opening(?: moments| seconds)?|(?:the )?intro(?:duction)?|kicks? off|kicking off|early on|first (?:few )?(?:seconds|moments))\b/i;
const ENDING_PATTERN =
  /\b(?:the ending|ending of the song|final(?:e|ly)?|(?:the )?closing(?: moments| seconds)?|(?:the )?outro|wraps? up|that's a wrap|conclu(?:des?|sion)|winds? down|fades? out|comes? to a close|last (?:few )?(?:seconds|moments|part|stretch)|as the song (?:ends|closes)|towards? the end\b)/i;

export function repositionFactsByLanguage(facts, durationSeconds) {
  // Windows scale with song length: ~12% of the duration, floored so short
  // clips still get a sensible sliver at each end.
  const edgeWindow = Math.max(8, Math.round(durationSeconds * 0.12));
  const beginningCutoff = edgeWindow;
  const endingCutoff = durationSeconds - edgeWindow;

  const beginningIdx = [];
  const endingIdx = [];
  facts.forEach((fact, i) => {
    const text = fact.text || '';
    if (ENDING_PATTERN.test(text)) {
      endingIdx.push(i);
    } else if (BEGINNING_PATTERN.test(text)) {
      beginningIdx.push(i);
    }
  });

  const repositioned = [...facts];

  beginningIdx.forEach((factIndex, order) => {
    const span = Math.max(1, beginningCutoff - 2);
    const t = 2 + Math.round((span * order) / Math.max(1, beginningIdx.length));
    repositioned[factIndex] = { ...repositioned[factIndex], time_seconds: t };
  });

  endingIdx.forEach((factIndex, order) => {
    const span = Math.max(1, durationSeconds - 2 - endingCutoff);
    const t = endingCutoff + Math.round((span * order) / Math.max(1, endingIdx.length));
    repositioned[factIndex] = { ...repositioned[factIndex], time_seconds: t };
  });

  return repositioned.sort((a, b) => a.time_seconds - b.time_seconds);
}

export function buildFallbackFacts(durationSeconds) {
  const templates = [
    "Fun fact: the average pop song has been rewritten dozens of times before anyone hears it.",
    "Music trivia: the hook of a song is usually written before the verses that lead into it.",
    "Behind the scenes: most music videos are shot in a single day, often out of chronological order.",
    "Did you know? Many artists re-record vocal takes dozens of times to get just the right feel.",
    "Trivia: the average music video from this era took just two or three days to shoot.",
    "Fun fact: producers often mix a song dozens of times before landing on the final version.",
    "Did you know? Many iconic guitar solos started out as studio improvisation.",
    "Behind the scenes: album cover art is usually finalized long before the songs are even mixed.",
  ];
  const count = Math.min(templates.length, Math.max(4, Math.round(durationSeconds / 20)));
  const gap = durationSeconds / (count + 1);
  return Array.from({ length: count }, (_, i) => ({
    time_seconds: Math.round(gap * (i + 1)),
    text: templates[i % templates.length],
  }));
}
