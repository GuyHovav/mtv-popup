import { useEffect, useMemo, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 250;
const SEEK_THRESHOLD_SECONDS = 1.5;
const LOOKBACK_WINDOW_SECONDS = 2;
// How far past its timestamp a fact may still be shown before it's skipped
// as stale (see the catch-up loop below). Generous enough to absorb one
// long predecessor balloon, small enough that visual callouts still
// roughly match what's on screen.
const STALE_FACT_SECONDS = 25;
// ...and how far ahead of its timestamp a fact may show when the screen is
// free. Without this, a short balloon closes and the next one sits waiting
// for its exact second — dead air. Slightly early is harmless (visual
// callouts tend to describe scenes, which span seconds anyway).
const EARLY_SHOW_SECONDS = 8;
const MIN_GAP_MS = 1500;
const MAX_GAP_MS = 2500;
const YT_PLAYER_STATE_PLAYING = 1;

const SLOTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const COLORS = ['pink', 'cyan', 'yellow', 'purple', 'lime'];

let balloonIdCounter = 0;

function randomGapMs() {
  return MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
}

// How long a balloon stays up scales with how much there is to read,
// paced for a relatively slow reader (~140 wpm, i.e. ~420ms per word)
// plus a fixed beat to notice the balloon and find its text. A one-liner
// still hangs around long enough to register (floor), and even the
// longest fact can't park on screen forever (ceiling) — a tap dismisses
// early either way.
const BASE_DISPLAY_MS = 2500;
const PER_WORD_MS = 420;
const MIN_DISPLAY_MS = 6000;
const MAX_DISPLAY_MS = 18000;

export function displayDurationMs(text) {
  const wordCount = (text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.min(MAX_DISPLAY_MS, Math.max(MIN_DISPLAY_MS, BASE_DISPLAY_MS + wordCount * PER_WORD_MS));
}

/**
 * Shows exactly one "balloon" at a time, matching the classic Pop-up Video
 * pace: a fact is visible for as long as its word count warrants (see
 * displayDurationMs), then — a random 3-5s after it closes —
 * the next one appears. `time_seconds` still gates *which* fact is next
 * (advancing only once playback has reached it) and drives seek handling,
 * but the actual on-screen cadence is paced by the gap timer, not strictly
 * by matching each fact's timestamp to the second.
 */
export function useFactSync(player, facts) {
  const sortedFacts = useMemo(
    () => [...facts].sort((a, b) => a.time_seconds - b.time_seconds),
    [facts],
  );

  const nextIndexRef = useRef(0);
  const prevTimeRef = useRef(0);
  const readyAtRef = useRef(0); // Date.now() timestamp; next balloon can't show before this
  const slotIndexRef = useRef(0);
  const colorIndexRef = useRef(0);
  const activeRef = useRef(null);
  const dismissTimerRef = useRef(null);

  const [activeBalloon, setActiveBalloonState] = useState(null);

  function commitActive(next) {
    activeRef.current = next;
    setActiveBalloonState(next);
  }

  function clearDismissTimer() {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }

  // Reset all scheduling state whenever the fact list changes (new video).
  useEffect(() => {
    nextIndexRef.current = 0;
    prevTimeRef.current = 0;
    readyAtRef.current = Date.now();
    clearDismissTimer();
    commitActive(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedFacts]);

  useEffect(() => {
    if (!player) return undefined;

    function showFact(fact) {
      const slot = SLOTS[slotIndexRef.current % SLOTS.length];
      slotIndexRef.current += 1;
      const color = COLORS[colorIndexRef.current % COLORS.length];
      colorIndexRef.current += 1;
      const id = balloonIdCounter++;
      const durationMs = displayDurationMs(fact.text);

      commitActive({ id, text: fact.text, slot, color, durationMs });

      dismissTimerRef.current = setTimeout(() => {
        commitActive(null);
        readyAtRef.current = Date.now() + randomGapMs();
      }, durationMs);
    }

    const interval = setInterval(() => {
      if (typeof player.getPlayerState !== 'function') return;
      if (player.getPlayerState() !== YT_PLAYER_STATE_PLAYING) return;

      const currentTime = player.getCurrentTime();
      const prevTime = prevTimeRef.current;
      const isSeek = Math.abs(currentTime - prevTime) > SEEK_THRESHOLD_SECONDS;

      if (isSeek) {
        // Re-point at the first fact at/after the new position — this both
        // re-arms facts the user scrubbed back past, and skips facts behind
        // a forward scrub instead of dumping them all at once.
        let idx = sortedFacts.findIndex((f) => f.time_seconds >= currentTime - LOOKBACK_WINDOW_SECONDS);
        if (idx === -1) idx = sortedFacts.length;
        nextIndexRef.current = idx;
        clearDismissTimer();
        commitActive(null);
        readyAtRef.current = Date.now();
      } else {
        // A fact whose moment is long gone shouldn't show at all — a
        // "that's Rebecca Black!" balloon minutes after the cameo is worse
        // than silence. This also stops lag from compounding: without it,
        // one slow stretch delays every subsequent fact further.
        while (
          nextIndexRef.current < sortedFacts.length &&
          sortedFacts[nextIndexRef.current].time_seconds < currentTime - STALE_FACT_SECONDS
        ) {
          nextIndexRef.current += 1;
        }

        if (
          activeRef.current === null &&
          Date.now() >= readyAtRef.current &&
          nextIndexRef.current < sortedFacts.length &&
          sortedFacts[nextIndexRef.current].time_seconds <= currentTime + EARLY_SHOW_SECONDS
        ) {
          const fact = sortedFacts[nextIndexRef.current];
          nextIndexRef.current += 1;
          showFact(fact);
        }
      }

      prevTimeRef.current = currentTime;
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      clearDismissTimer();
    };
  }, [player, sortedFacts]);

  function dismissBalloon() {
    clearDismissTimer();
    commitActive(null);
    readyAtRef.current = Date.now() + randomGapMs();
  }

  return { activeBalloon, dismissBalloon };
}
