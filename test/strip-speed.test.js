import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripForSpeech } from '../src/tts.js';
import { stripCodexMetadata } from '../src/codex.js';

// A line-start rule written as ^\s* can run across every blank line below it
// under the m flag, from every line start: quadratic. A reply padded with
// whitespace-only lines took seconds to clean before a word was spoken.
const padded = '\t\t\n'.repeat(60000) + 'The actual reply.';

function timed(fn) {
  const start = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

test('cleanup stays fast on thousands of blank lines', () => {
  const { out, ms } = timed(() => stripForSpeech(padded));
  assert.ok(ms < 1000, `stripForSpeech took ${Math.round(ms)} ms`);
  assert.match(out, /The actual reply\./);
});

test('Codex metadata cleanup stays fast on thousands of blank lines', () => {
  const { ms } = timed(() => stripCodexMetadata(padded));
  assert.ok(ms < 1000, `stripCodexMetadata took ${Math.round(ms)} ms`);
});

test('quotes, rules and app directives are still removed', () => {
  assert.equal(stripForSpeech('> quoted line').trim(), 'quoted line');
  assert.doesNotMatch(stripForSpeech('Above.\n\n- - -\n\nBelow.'), /-/);
  assert.equal(stripCodexMetadata('Done.\n  ::git-stage{cwd="C:/x"}  \nNext.'), 'Done.\n \nNext.');
});
