# Improve fact-timestamp accuracy using existing data only

## Context

Fact timing today is essentially a guess: the LLM is told to "spread facts
across the whole duration" (`server/src/lib/promptBuilder.js`'s
`buildUserPrompt`), and the only correctness check afterward is
`repositionFactsByLanguage`, which recognizes just two categories of
positional language — "beginning" and "ending" — and snaps those facts into
the first/last ~12% of the song. Anything a fact says about the middle of
the song (a chorus, a bridge, a second verse, a key change) currently has
no grounding at all; the model's `time_seconds` for those is untethered
from any real structural signal.

We considered pulling real timing data from YouTube captions/lyrics, but
that requires an OAuth-gated endpoint that doesn't work for arbitrary
third-party videos, or an undocumented endpoint with the same ToS-risk
profile already ruled out for Genius lyrics. This plan instead squeezes
more accuracy out of data we already have — no new API, no new data
source — by leaning on the fact that most pop/rock songs follow a fairly
conventional structure (intro → verse → chorus → verse → chorus → bridge →
final chorus → outro), and using that as a heuristic on both ends of the
pipeline:
1. Tell the model this structure up front (as rough mm:ss guidance for
   *this* song's specific duration), so its initial placement starts more
   grounded.
2. Extend the deterministic post-processing safety net to recognize more
   structural language (not just beginning/ending) and correct the
   timestamp into the right proportional window — the same mechanism
   already proven out for beginning/ending, generalized to more categories.

This is explicitly a heuristic based on typical structure, not the actual
structure of any specific song — it'll be right more often, not always.

## Approach

All changes are confined to `server/src/lib/promptBuilder.js`.

### 1. Generalize `repositionFactsByLanguage` into a category table

Refactor the current beginning/ending-only logic into a small ordered list
of `{ pattern, window }` entries, checked in priority order (most specific
first, so a fact matching multiple categories lands in the most specific
one rather than the most generic):

| Category (checked in this order) | Example trigger language | Window (fraction of duration) |
|---|---|---|
| `ending` (existing) | "the ending", "outro", "winds down", "fades out" | last ~12% (min 8s) — unchanged |
| `finalChorus` (new) | "final chorus", "last chorus", "key change", "modulates" | 0.78–0.92 |
| `bridge` (new) | "the bridge", "middle eight", "breakdown", "instrumental break" | 0.65–0.82 |
| `secondVerse` (new) | "second verse", "verse two" | 0.40–0.55 |
| `chorus` (new, generic/first) | "the chorus", "the hook", "the drop" | 0.20–0.45 |
| `beginning` (existing) | "the beginning", "opening", "intro", "kicks off" | first ~12% (min 8s) — unchanged |

Key design point: `chorus` is deliberately generic and checked *after* the
more specific `secondVerse`/`bridge`/`finalChorus` patterns, so an
unqualified "the chorus" only falls into the generic (first-chorus-shaped)
window when nothing more specific already matched — this sidesteps needing
to determine *which* chorus occurrence a fact means.

The `beginning`/`ending` categories keep their existing seconds-based
`edgeWindow` computation (`Math.max(8, Math.round(durationSeconds * 0.12))`)
so short clips still get a sensible floor — unchanged behavior, just
reframed as two entries in the same table. New middle categories use plain
duration fractions (no floor needed; they're already away from the edges).

Multiple facts matching the same category still distribute evenly across
that category's window, reusing the existing span/order distribution
formula — just generalized to loop over the table instead of two
hand-written blocks.

### 2. Give the model the same structural guidance up front

In `buildUserPrompt` (`server/src/lib/promptBuilder.js:54`), add a compact
block computed from the video's actual `durationSeconds`, translating the
same window table into concrete mm:ss ranges (reusing the existing
`formatMMSS` helper) — e.g. roughly "first chorus/hook typically falls
around mm:ss–mm:ss for a song this length" for each category. This is
explicitly framed to the model as a rough convention, not a rule, so it
doesn't override genuine moment-specific knowledge the model actually has
about the song (e.g. from Genius context) — it's a fallback default for
when the model doesn't have anything better to place a fact against.

### 3. No other files change

`server/src/lib/facts.js`, the provider files, and both route entrypoints
are untouched — `repositionFactsByLanguage` is already called from
`facts.js` after every successful provider response, so the improved
version applies automatically everywhere it's already used.

## Verification

Since this is pure/deterministic logic with no external calls, verify by
exercising the functions directly with representative fact arrays (similar
to how `genius.js`'s helpers were manually checked earlier):
1. Construct a fake `facts` array covering each category (beginning,
   chorus, second verse, bridge, final chorus, ending, and one with no
   positional language at all) with deliberately wrong `time_seconds`
   values, run it through `repositionFactsByLanguage(facts, durationSeconds)`
   for a a few durations (e.g. 60s, 210s, 400s), and confirm each fact lands
   in its expected proportional window and the array stays sorted by
   `time_seconds`.
2. Confirm a fact matching multiple categories (e.g. mentions both "bridge"
   and "chorus") lands in the more specific category per the priority
   order.
3. Confirm facts with no positional language at all are left at their
   original `time_seconds` (unchanged pass-through).
4. Print `buildUserPrompt(...)` for a couple of durations and eyeball that
   the new structural guidance block reads sensibly and its mm:ss ranges
   match the same windows used in `repositionFactsByLanguage`.
5. As a real end-to-end sanity check, submit a real video through the
   local dev server (or hit the live `/api/facts` endpoint as done for the
   Genius verification) and spot-check that facts mentioning "chorus" /
   "bridge" / etc. land in plausible parts of the timeline.
