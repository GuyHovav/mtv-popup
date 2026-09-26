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
- HARD RULE on borrowed music: never claim this song samples, interpolates,
  covers, or is built on another specific track unless that exact
  relationship appears in the provided song context below. This is the
  single most common way plausible-sounding trivia turns out flat wrong —
  when in doubt, describe the sound ("that squelchy synth bass...") without
  attributing it to another song.
- Every fact that names a specific person, work, date, or number must be
  something you could defend: either it appears in the provided context, or
  it's a fact you are genuinely certain of about this exact song/artist. A
  vaguer true fact always beats a specific invented one — an invented
  "fact" on screen is the one thing this show can't survive.
- If real song context is provided below (Genius metadata — writer/producer
  credits, sample/interpolation/cover relationships, curated "about" text —
  and/or Wikipedia article intros for the song and artist), treat it
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
  in a row sound like the same template with different words swapped in.
- Don't repeat the same underlying piece of trivia twice in different words
  across the batch — each fact should add new information.
- Generic lead-ins like "Did you know...", "Fun fact:", "Believe it or
  not...", "Here's a fact..." are fine once, but overusing them makes the
  whole batch feel templated — use each at most once, and otherwise just
  start with the fact itself.`;

function formatMMSS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

// Most pop/rock songs follow a fairly conventional structure. This gives
// both the model (as a rough default in the prompt) and the deterministic
// post-processing safety net (repositionFactsByLanguage, below) the same
// shared notion of "where a chorus/bridge/etc. typically falls" for a song
// of this specific duration — a heuristic, not this song's actual
// structure, but better grounded than a blank guess.
function computeSectionWindows(durationSeconds) {
  const edgeWindow = Math.max(8, Math.round(durationSeconds * 0.12));
  return [
    { name: 'beginning', label: 'Intro/opening', start: 0, end: edgeWindow },
    { name: 'chorus', label: 'First chorus/hook', start: durationSeconds * 0.2, end: durationSeconds * 0.45 },
    { name: 'secondVerse', label: 'Second verse', start: durationSeconds * 0.4, end: durationSeconds * 0.55 },
    { name: 'bridge', label: 'Bridge', start: durationSeconds * 0.65, end: durationSeconds * 0.82 },
    { name: 'finalChorus', label: 'Final chorus/key change', start: durationSeconds * 0.78, end: durationSeconds * 0.92 },
    { name: 'ending', label: 'Outro/ending', start: durationSeconds - edgeWindow, end: durationSeconds },
  ];
}

export function buildUserPrompt({ title, author, durationSeconds, factCount, geniusContext, wikiContext, videoAttached }) {
  const avgGapSeconds = Math.round(durationSeconds / factCount);
  const geniusBlock = geniusContext
    ? `\n\nReal song metadata from Genius (credits, sample/interpolation relationships, curated "about" text — use this for specific, accurate facts):\n${geniusContext}\n`
    : '';
  const wikiBlock = wikiContext
    ? `\n\nBackground from Wikipedia (encyclopedic context on the song's history, chart performance, and the artist — use this for specific, accurate facts):\n${wikiContext}\n`
    : '';

  // With the actual video attached the model can see the real structure and
  // visuals, so it gets pushed toward what's literally on screen; the
  // conventional-structure heuristic only helps in the blind (text-only)
  // case, where it stays as before.
  const contextGuide = videoAttached
    ? `The actual video is attached — you can watch it. Use that directly:
- Make MOMENT-SPECIFIC facts about what is literally visible or audible on
  screen around that timestamp: props, cars, outfits, locations, dance
  moves, cameos, scene changes, instruments entering. Call the thing out
  ("that gold Cadillac...", "this diner scene...") and, when you have real
  trivia about it, attach it — a visual callout plus a true fact is the
  ideal balloon.
- Set each fact's time_seconds to when that thing is actually on screen.
  You are watching the video, so timestamps should be observed, not guessed.
- Cover the ENTIRE video, through its final minute — including any intro or
  outro skit, extended scene, or credits. Long unnarrated stretches are a
  failure; if the tail isn't the song, comment on what's happening in it.
- Still mix in GENERAL facts (artist, writing, chart history) between the
  visual ones, per the style rules.`
    : `Most pop/rock songs follow a conventional structure. As a rough default
when you don't have more specific knowledge of this song's actual
structure, moments typically fall around:
${computeSectionWindows(durationSeconds)
  .map((w) => `- ${w.label}: roughly ${formatMMSS(w.start)}-${formatMMSS(w.end)}`)
  .join('\n')}
(This is only a fallback convention, not a rule — if you have better,
specific knowledge of this particular song's real structure, use that
instead.)`;

  return `Song: "${title}"
Channel/Artist (from YouTube metadata): "${author}"
Video duration: ${durationSeconds} seconds (${formatMMSS(durationSeconds)})${geniusBlock}${wikiBlock}

${contextGuide}

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
  // A balloon shows for as long as its word count warrants (~11s for a
  // typical 2-sentence fact at slow-reader pace) plus a 1.5-2.5s gap: a
  // full cycle of roughly 13s. Target that density (classic Pop-up
  // Video's near-continuous pacing) — the spacing relaxation pass absorbs
  // any clustering, so denser is safe.
  return Math.min(80, Math.max(8, Math.round(durationSeconds / 13)));
}

// No LLM reliably keeps a fact's assigned `time_seconds` consistent with
// positional language in its own text (a fact can say "the ending" and land
// at 0:20 in a 4-minute song). Rather than trust any provider's numbers for
// these, detect the language deterministically and reassign the timestamp
// into the matching part of the timeline (using the same conventional-
// structure windows given to the model in buildUserPrompt, see
// computeSectionWindows above).
const BEGINNING_PATTERN =
  /\b(?:the beginning|beginning of the song|starts? (?:off|out)|starting (?:off|out)|right (?:away|from the start)|from the (?:very )?start|opens? (?:with|up)|(?:the )?opening(?: moments| seconds)?|(?:the )?intro(?:duction)?|kicks? off|kicking off|early on|first (?:few )?(?:seconds|moments))\b/i;
const ENDING_PATTERN =
  /\b(?:the ending|ending of the song|final(?:e|ly)?|(?:the )?closing(?: moments| seconds)?|(?:the )?outro|wraps? up|that's a wrap|conclu(?:des?|sion)|winds? down|fades? out|comes? to a close|last (?:few )?(?:seconds|moments|part|stretch)|as the song (?:ends|closes)|towards? the end\b)/i;
const FINAL_CHORUS_PATTERN = /\b(?:final chorus|last chorus|key change|modulat(?:es?|ion))\b/i;
const BRIDGE_PATTERN = /\b(?:the bridge|middle eight|middle-eight|breakdown|instrumental break)\b/i;
const SECOND_VERSE_PATTERN = /\b(?:second verse|verse two|verse 2)\b/i;
const CHORUS_PATTERN = /\b(?:the chorus|the hook|the drop|chorus kicks? in|hook kicks? in)\b/i;

// Checked in this order — most specific first, so a fact matching multiple
// categories lands in the more specific one rather than the most generic.
// `chorus` is deliberately generic and checked after secondVerse/bridge/
// finalChorus, so an unqualified "the chorus" only falls into this
// fallback (first-chorus-shaped) window when nothing more specific already
// matched — sidesteps having to determine *which* chorus occurrence a
// fact means.
const REPOSITION_CATEGORIES = [
  { name: 'ending', pattern: ENDING_PATTERN },
  { name: 'finalChorus', pattern: FINAL_CHORUS_PATTERN },
  { name: 'bridge', pattern: BRIDGE_PATTERN },
  { name: 'secondVerse', pattern: SECOND_VERSE_PATTERN },
  { name: 'chorus', pattern: CHORUS_PATTERN },
  { name: 'beginning', pattern: BEGINNING_PATTERN },
];

export function repositionFactsByLanguage(facts, durationSeconds) {
  const windowByName = new Map(computeSectionWindows(durationSeconds).map((w) => [w.name, w]));

  const matchedIndices = new Map(REPOSITION_CATEGORIES.map((c) => [c.name, []]));
  facts.forEach((fact, i) => {
    const text = fact.text || '';
    const category = REPOSITION_CATEGORIES.find((c) => c.pattern.test(text));
    if (category) matchedIndices.get(category.name).push(i);
  });

  const repositioned = [...facts];
  REPOSITION_CATEGORIES.forEach(({ name }) => {
    const indices = matchedIndices.get(name);
    if (indices.length === 0) return;

    const { start, end } = windowByName.get(name);
    // Nudge the two edge categories 2s away from the literal 0/duration
    // boundary — a fact at exactly 0:00 or the exact final second reads
    // oddly. Middle categories are already away from the true edges.
    const adjStart = name === 'beginning' ? Math.max(start, 2) : start;
    const adjEnd = name === 'ending' ? Math.min(end, durationSeconds - 2) : end;

    const span = Math.max(1, adjEnd - adjStart);
    indices.forEach((factIndex, order) => {
      const t = Math.round(adjStart + (span * order) / Math.max(1, indices.length));
      repositioned[factIndex] = { ...repositioned[factIndex], time_seconds: t };
    });
  });

  return repositioned.sort((a, b) => a.time_seconds - b.time_seconds);
}

// The model tends to cluster facts (several within a few seconds, then a
// long hole), and the client can only show one balloon per ~13s cycle.
// Dropping the clustered ones (the first version of this pass) traded lag
// for dead air — it left 30-40s holes. Instead, relax clusters forward:
// each fact keeps its own timestamp unless it crowds its predecessor, in
// which case it slides just far enough ahead. A visual fact can shift a
// little later than its moment (the client's stale-skip caps how far
// facts may run behind playback anyway), but every fact survives and the
// holes get filled. Facts pushed past the end of the video are dropped.
const MIN_FACT_SPACING_SECONDS = 12;

export function enforceMinSpacing(facts, durationSeconds, minGapSeconds = MIN_FACT_SPACING_SECONDS) {
  const relaxed = [];
  for (const fact of facts) {
    const prev = relaxed[relaxed.length - 1];
    const t = prev ? Math.max(fact.time_seconds, prev.time_seconds + minGapSeconds) : fact.time_seconds;
    if (t > durationSeconds - 2) break;
    relaxed.push(t === fact.time_seconds ? fact : { ...fact, time_seconds: t });
  }
  return relaxed;
}

function normalizeForComparison(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3); // cheap stopword-ish filter
}

function jaccardSimilarity(wordsA, wordsB) {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// 0.45 (was 0.5): rephrased restatements of the same fact were sliding
// under the old threshold.
const DUPLICATE_SIMILARITY_THRESHOLD = 0.45;

// The model occasionally restates the same underlying trivia twice in a
// long batch, just phrased differently. Drop later near-duplicates rather
// than trying to rewrite them — a batch with a few fewer, non-repetitive
// facts beats one padded with restatements.
export function removeDuplicateFacts(facts) {
  const kept = [];
  const keptWordSets = [];
  facts.forEach((fact) => {
    const words = normalizeForComparison(fact.text);
    const isDuplicate = keptWordSets.some((prev) => jaccardSimilarity(words, prev) >= DUPLICATE_SIMILARITY_THRESHOLD);
    if (!isDuplicate) {
      kept.push(fact);
      keptWordSets.push(words);
    }
  });
  return kept;
}

// Generic lead-ins read fine once but get repetitive fast across a long
// batch. Allow each at most once; strip it (and re-capitalize what's left)
// on later occurrences rather than dropping the fact entirely.
const GENERIC_OPENERS = [
  /^did you know[,:]?\s*/i,
  /^fun fact[,:]?\s*/i,
  /^believe it or not[,:]?\s*/i,
  /^here'?s? (?:a|the) (?:fun )?fact[,:]?\s*/i,
  /^trivia[,:]?\s*/i,
];
const MAX_OPENER_USES = 1;

export function diversifyOpeners(facts) {
  const openerUseCount = new Map();
  return facts.map((fact) => {
    const text = fact.text || '';
    const matchedOpener = GENERIC_OPENERS.find((pattern) => pattern.test(text));
    if (!matchedOpener) return fact;

    const uses = openerUseCount.get(matchedOpener) || 0;
    openerUseCount.set(matchedOpener, uses + 1);
    if (uses < MAX_OPENER_USES) return fact;

    const stripped = text.replace(matchedOpener, '').trim();
    if (!stripped) return fact; // safety: don't produce an empty fact
    const recapitalized = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    return { ...fact, text: recapitalized };
  });
}

// The observed worst hallucination class: confidently attributing this
// song's sound to a sample/interpolation of another specific track (the
// claim is precise, checkable, and usually wrong). The prompt forbids it
// unless the provided Genius/Wikipedia context states the relationship —
// and this pass enforces that deterministically: when the context never
// mentions borrowing at all, any sample/interpolation claim in the output
// is by definition invented, so the whole fact is dropped. When the
// context does mention borrowing we keep the facts; matching each claim to
// its exact source is beyond a regex, and the prompt has real data to work
// from in that case.
const BORROWING_CLAIM_PATTERN = /\b(?:sampl(?:es?|ed|ing)|interpolat(?:es?|ed|ion))\b/i;

export function dropUnsupportedBorrowingClaims(facts, supportContext) {
  if (BORROWING_CLAIM_PATTERN.test(supportContext || '')) return facts;
  return facts.filter((fact) => !BORROWING_CLAIM_PATTERN.test(fact.text || ''));
}

// The schema types time_seconds as an integer but nothing stops a model
// from placing a fact past the video's end (where it would silently never
// show) or at the literal first/last second (where it reads oddly). Clamp
// into the same 2s-inset range repositionFactsByLanguage uses for its edge
// windows.
export function clampFactTimes(facts, durationSeconds) {
  const min = Math.min(2, durationSeconds);
  const max = Math.max(min, durationSeconds - 2);
  return facts.map((fact) => ({
    ...fact,
    time_seconds: Math.min(max, Math.max(min, Math.round(fact.time_seconds || 0))),
  }));
}

/**
 * Runs every deterministic quality pass on raw LLM output, in order:
 * drop borrowed-music claims unsupported by the provided context, fix up
 * timestamps against positional language, thin out facts packed tighter
 * than the client's display cadence, clamp timestamps into the
 * video's duration, drop near-duplicate facts, then trim overused generic
 * lead-ins. Not applied to buildFallbackFacts's static templates — those
 * are already curated.
 *
 * When the facts came from a model that actually watched the video
 * (videoGrounded), the positional-language repositioning is skipped: those
 * timestamps are observed, and "correcting" them against a generic
 * pop-song-structure heuristic would break accurate ones (a video really
 * can show its outro imagery early). Clamping and dedup still apply.
 */
export function postProcessFacts(facts, durationSeconds, { videoGrounded = false, supportContext = '' } = {}) {
  const supported = dropUnsupportedBorrowingClaims(facts, supportContext);
  const repositioned = videoGrounded ? supported : repositionFactsByLanguage(supported, durationSeconds);
  const clamped = clampFactTimes(repositioned, durationSeconds).sort((a, b) => a.time_seconds - b.time_seconds);
  const deduped = removeDuplicateFacts(clamped);
  const spaced = enforceMinSpacing(deduped, durationSeconds);
  return diversifyOpeners(spaced);
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
