import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserPrompt,
  clampFactTimes,
  postProcessFacts,
  repositionFactsByLanguage,
  removeDuplicateFacts,
  computeFactCount,
} from '../src/lib/promptBuilder.js';

const DURATION = 240;

test('clampFactTimes keeps facts inside the playable range', () => {
  const clamped = clampFactTimes(
    [
      { time_seconds: -5, text: 'too early' },
      { time_seconds: 0, text: 'at zero' },
      { time_seconds: 120, text: 'fine' },
      { time_seconds: 9999, text: 'past the end' },
    ],
    DURATION,
  );
  assert.deepEqual(
    clamped.map((f) => f.time_seconds),
    [2, 2, 120, DURATION - 2],
  );
});

test('repositionFactsByLanguage moves "the ending" language late', () => {
  const facts = [
    { time_seconds: 20, text: 'As the song winds down, note the fade-out.' },
    { time_seconds: 30, text: 'A neutral fact with no positional language.' },
  ];
  const result = repositionFactsByLanguage(facts, DURATION);
  const moved = result.find((f) => f.text.includes('winds down'));
  assert.ok(moved.time_seconds > DURATION * 0.8, `expected late timestamp, got ${moved.time_seconds}`);
  const untouched = result.find((f) => f.text.startsWith('A neutral'));
  assert.equal(untouched.time_seconds, 30);
});

test('postProcessFacts skips repositioning for video-grounded facts', () => {
  // A grounded fact can legitimately show outro-flavored language early —
  // the model watched the video, so its timestamp wins.
  const facts = [{ time_seconds: 20, text: 'The outro imagery actually appears here, early on.' }];
  const grounded = postProcessFacts(facts, DURATION, { videoGrounded: true });
  assert.equal(grounded[0].time_seconds, 20);

  const blind = postProcessFacts(facts, DURATION, { videoGrounded: false });
  assert.notEqual(blind[0].time_seconds, 20);
});

test('postProcessFacts still clamps video-grounded timestamps', () => {
  const facts = [{ time_seconds: 5000, text: 'A fact past the end of the video.' }];
  const result = postProcessFacts(facts, DURATION, { videoGrounded: true });
  assert.equal(result[0].time_seconds, DURATION - 2);
});

test('removeDuplicateFacts drops near-identical restatements', () => {
  const facts = [
    { time_seconds: 10, text: 'The chorus was recorded in a single legendary late-night take.' },
    { time_seconds: 90, text: 'That legendary chorus was recorded in a single late-night take.' },
    { time_seconds: 150, text: 'The director previously shot commercials for sneakers.' },
  ];
  const result = removeDuplicateFacts(facts);
  assert.equal(result.length, 2);
});

test('buildUserPrompt switches guidance based on videoAttached', () => {
  const base = { title: 'Song', author: 'Artist', durationSeconds: DURATION, factCount: 10 };
  const withVideo = buildUserPrompt({ ...base, videoAttached: true });
  assert.match(withVideo, /video is attached/);
  assert.doesNotMatch(withVideo, /conventional structure/);

  const withoutVideo = buildUserPrompt({ ...base, videoAttached: false });
  assert.match(withoutVideo, /conventional structure/);
  assert.doesNotMatch(withoutVideo, /video is attached/);
});

test('computeFactCount stays within its bounds', () => {
  assert.equal(computeFactCount(30), 8);
  assert.equal(computeFactCount(21600), 80);
});

test('dropUnsupportedBorrowingClaims removes sample claims when context is silent', async () => {
  const { dropUnsupportedBorrowingClaims } = await import('../src/lib/promptBuilder.js');
  const facts = [
    { time_seconds: 10, text: 'That synth hook is a sample from a 1981 Tom Tom Club track.' },
    { time_seconds: 20, text: 'The video was shot in West London.' },
    { time_seconds: 30, text: 'This melody interpolates an older disco hit.' },
  ];
  const noContext = dropUnsupportedBorrowingClaims(facts, 'Wikipedia on the song: a 1987 pop song.');
  assert.deepEqual(noContext.map((f) => f.time_seconds), [20]);

  // When the provided context itself documents borrowing, claims survive.
  const withContext = dropUnsupportedBorrowingClaims(facts, 'Samples/Interpolations/Covers:\n- samples: "Genius of Love"');
  assert.equal(withContext.length, 3);

  // Empty/absent context also strips the claims.
  assert.equal(dropUnsupportedBorrowingClaims(facts, '').length, 1);
});

test('postProcessFacts applies the borrowing filter via supportContext', () => {
  const facts = [
    { time_seconds: 50, text: 'This track famously samples an obscure funk record.' },
    { time_seconds: 100, text: 'A perfectly ordinary fact about the artist.' },
  ];
  const result = postProcessFacts(facts, 240, { supportContext: 'Wikipedia on the artist: a singer.' });
  assert.equal(result.length, 1);
  assert.match(result[0].text, /ordinary fact/);
});

test('enforceMinSpacing thins facts packed tighter than the display cadence', async () => {
  const { enforceMinSpacing } = await import('../src/lib/promptBuilder.js');
  const dense = Array.from({ length: 10 }, (_, i) => ({ time_seconds: 5 + i * 10, text: `fact ${i}` }));
  const spaced = enforceMinSpacing(dense, 14);
  assert.ok(spaced.length < dense.length);
  for (let i = 1; i < spaced.length; i += 1) {
    assert.ok(spaced[i].time_seconds - spaced[i - 1].time_seconds >= 14);
  }
  // Already-sparse facts pass through untouched.
  const sparse = [{ time_seconds: 10, text: 'a' }, { time_seconds: 40, text: 'b' }];
  assert.deepEqual(enforceMinSpacing(sparse, 14), sparse);
});
