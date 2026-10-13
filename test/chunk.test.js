import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkForSpeech } from '../src/chunk.js';

test('empty / nullish -> no chunks', () => {
  assert.deepEqual(chunkForSpeech(''), []);
  assert.deepEqual(chunkForSpeech(null), []);
});

test('single sentence -> one chunk', () => {
  assert.deepEqual(chunkForSpeech('Hello there.'), ['Hello there.']);
});

test('first sentence is always its own chunk (fast start)', () => {
  const out = chunkForSpeech('One. Two. Three. Four.');
  assert.equal(out[0], 'One.');
  assert.ok(out.length >= 2);
});

test('later sentences group up to maxChunk', () => {
  const out = chunkForSpeech('A. Two three. Four five six.', { maxChunk: 300 });
  assert.equal(out[0], 'A.');
  // remaining two short sentences fit together
  assert.equal(out[1], 'Two three. Four five six.');
});

test('a sentence longer than maxChunk is hard-split on word boundaries', () => {
  const long = 'word '.repeat(200).trim() + '.'; // ~1000 chars, no internal breaks
  const out = chunkForSpeech(long, { maxChunk: 100 });
  assert.ok(out.length > 1);
  for (const c of out) assert.ok(c.length <= 100, `chunk too long: ${c.length}`);
});

test('reassembled chunks preserve the words in order', () => {
  const text = 'First sentence here. Second one follows. And a third to finish.';
  const out = chunkForSpeech(text);
  const rejoined = out.join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(rejoined, text);
});

// A period inside a token is not the end of a sentence. Coding replies are full
// of them, and the first chunk plays on its own, so the first thing heard was
// "I updated src/state." and then "js and bumped the version to 0. 7. 0".
test('file names, versions, decimals and abbreviations stay in one piece', () => {
  assert.deepEqual(
    chunkForSpeech('I updated src/state.js and bumped the version to 0.7.0, so tests pass. Next we ship.'),
    ['I updated src/state.js and bumped the version to 0.7.0, so tests pass.', 'Next we ship.']
  );
  assert.deepEqual(
    chunkForSpeech('It waits 2.5 seconds, e.g. while the player starts, i.e. once. Then it plays.'),
    ['It waits 2.5 seconds, e.g. while the player starts, i.e. once.', 'Then it plays.']
  );
  assert.deepEqual(chunkForSpeech('See README.md for details.'), ['See README.md for details.']);
});

test('a sentence still ends before a quote, a digit or a capital in any script', () => {
  assert.deepEqual(chunkForSpeech('Done! "Next" is up. 3 tests ran. Éclair time?', { maxChunk: 15 }), [
    'Done!',
    '"Next" is up.',
    '3 tests ran.',
    'Éclair time?',
  ]);
});

test('text with no sentence terminators still chunks', () => {
  const out = chunkForSpeech('just a fragment with no punctuation at all');
  assert.deepEqual(out, ['just a fragment with no punctuation at all']);
});
