import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSongHit, pickArtistHit } from '../src/lib/wikipedia.js';
import { buildUserPrompt } from '../src/lib/promptBuilder.js';

test('pickSongHit accepts a song-disambiguated article title', () => {
  const hits = [
    { title: 'Uptown Funk', snippet: '"<span>Uptown Funk</span>" is a song by Mark Ronson featuring Bruno Mars' },
  ];
  assert.equal(pickSongHit(hits, 'Uptown Funk', 'Mark Ronson')?.title, 'Uptown Funk');
});

test('pickSongHit accepts a plain title when the snippet mentions the artist', () => {
  const hits = [{ title: 'Yellow (Coldplay song)', snippet: 'song by the British rock band Coldplay' }];
  assert.equal(pickSongHit(hits, 'Yellow', 'Coldplay')?.title, 'Yellow (Coldplay song)');
});

test('pickSongHit rejects a same-titled article by a different artist', () => {
  // An obscure band's "Yellow" must not ground facts in Coldplay's article.
  const hits = [{ title: 'Yellow', snippet: 'Yellow is a primary colour between green and orange' }];
  assert.equal(pickSongHit(hits, 'Yellow', 'Some Garage Band'), null);
});

test('pickSongHit rejects hits whose title does not contain the song title', () => {
  const hits = [{ title: 'Bruno Mars discography', snippet: 'songs by Bruno Mars (song)' }];
  assert.equal(pickSongHit(hits, '24K Magic', 'Bruno Mars'), null);
});

test('pickArtistHit requires an exact-ish title plus a musical snippet', () => {
  const hits = [
    { title: 'Prince (musician)', snippet: 'American singer, songwriter, and record producer' },
  ];
  assert.equal(pickArtistHit(hits, 'Prince')?.title, 'Prince (musician)');

  const nonMusical = [{ title: 'Prince', snippet: 'A prince is a male ruler or member of a royal family' }];
  assert.equal(pickArtistHit(nonMusical, 'Prince'), null);

  const wrongTitle = [{ title: 'Prince Harry', snippet: 'British singer of royal music' }];
  assert.equal(pickArtistHit(wrongTitle, 'Prince'), null);
});

test('buildUserPrompt includes the Wikipedia block only when context is given', () => {
  const base = { title: 'Song', author: 'Artist', durationSeconds: 240, factCount: 10 };
  const withWiki = buildUserPrompt({ ...base, wikiContext: 'Wikipedia on the song: released in 1999.' });
  assert.match(withWiki, /Background from Wikipedia/);
  assert.match(withWiki, /released in 1999/);

  const withoutWiki = buildUserPrompt(base);
  assert.doesNotMatch(withoutWiki, /Background from Wikipedia/);
});

test('extractSongTitle strips the artist segment from YouTube-style titles', async () => {
  const { extractSongTitle } = await import('../src/lib/wikipedia.js');
  assert.equal(extractSongTitle('Bruno Mars - 24K Magic (Official Music Video)', 'Bruno Mars'), '24K Magic');
  assert.equal(extractSongTitle('Toto - Africa (Official HD Video)', 'Toto'), 'Africa');
  // "Title - Artist" order works too.
  assert.equal(extractSongTitle('Africa - Toto', 'Toto'), 'Africa');
  // No separator, or no artist match: whole cleaned title survives.
  assert.equal(extractSongTitle('Bohemian Rhapsody', 'Queen'), 'Bohemian Rhapsody');
  assert.equal(extractSongTitle('Daft Punk - Around the World', 'RandomChannel'), 'Daft Punk - Around the World');
});

test('pickSongHit prefers the (song) article over the same-named (album)', () => {
  const hits = [
    { title: '24K Magic (album)', snippet: '24K Magic is the third studio album by Bruno Mars' },
    { title: '24K Magic (song)', snippet: '"24K Magic" is a song by Bruno Mars' },
  ];
  assert.equal(pickSongHit(hits, '24K Magic', 'Bruno Mars')?.title, '24K Magic (song)');
});

test('pickSongHit rejects a non-song disambiguation even when the artist matches', () => {
  const hits = [{ title: '24K Magic (album)', snippet: 'third studio album by Bruno Mars' }];
  assert.equal(pickSongHit(hits, '24K Magic', 'Bruno Mars'), null);
});
