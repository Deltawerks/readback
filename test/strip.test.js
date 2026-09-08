import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripForSpeech, truncateForSpeech } from '../src/tts.js';

test('drops fenced code blocks', () => {
  const md = 'Here is the fix:\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nDone.';
  const out = stripForSpeech(md);
  assert.ok(!out.includes('const x'));
  assert.ok(out.includes('Here is the fix'));
  assert.ok(out.includes('Done'));
});

test('pure code block yields empty output', () => {
  const md = '```python\nprint("hi")\nfor i in range(10):\n    pass\n```';
  assert.equal(stripForSpeech(md), '');
});

test('links become their text, urls become "link"', () => {
  assert.equal(stripForSpeech('See [the docs](https://x.com/y).'), 'See the docs.');
  assert.equal(stripForSpeech('Go to https://example.com now'), 'Go to link now');
});

test('strips headers, bold, italic and bullet markers', () => {
  const md = '## Title\n\n- **bold** item\n- _italic_ item';
  const out = stripForSpeech(md);
  assert.ok(!out.includes('#'));
  assert.ok(!out.includes('*'));
  assert.ok(!out.includes('_'));
  assert.ok(out.includes('bold item'));
  assert.ok(out.includes('italic item'));
});

test('inline code keeps its content', () => {
  assert.equal(stripForSpeech('Run `npm install` first.'), 'Run npm install first.');
});

test('strips emoji but keeps dashes, quotes and ellipsis', () => {
  const out = stripForSpeech('Nice work 🎯 — it’s “done”…');
  assert.ok(!/🎯/u.test(out));
  assert.ok(out.includes('—'));
  assert.ok(out.includes('“done”'));
  assert.ok(out.includes('…'));
});

test('empty / nullish input is safe', () => {
  assert.equal(stripForSpeech(''), '');
  assert.equal(stripForSpeech(null), '');
  assert.equal(stripForSpeech(undefined), '');
});

test('truncateForSpeech leaves short text untouched', () => {
  assert.equal(truncateForSpeech('short', 100), 'short');
});

test('truncateForSpeech cuts long text and adds a tail note', () => {
  const long = 'word '.repeat(500);
  const out = truncateForSpeech(long, 100);
  assert.ok(out.length <= 140);
  assert.ok(out.endsWith('the rest is on screen.'));
});

// I9: the table-separator rule used to backtrack cubically across overlapping
// whitespace classes, so 3000 spaces took ten seconds. It runs on every reply
// in the worker and on /api/say in the panel, before any length cap.
test('a long whitespace run does not stall the stripper', () => {
  const md = ' '.repeat(5000) + 'x';
  const started = Date.now();
  const out = stripForSpeech(md);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `stripForSpeech took ${elapsed} ms on 5000 spaces`);
  assert.equal(out, 'x');
});

test('table separator rows are still dropped', () => {
  const out = stripForSpeech('| Name | Age |\n|------|-----|\n| Ada | 36 |');
  assert.ok(!out.includes('-'), `separator row survived: ${out}`);
  assert.ok(out.includes('Name'));
  assert.ok(out.includes('Ada'));
});

// I15: a hard line break inside a paragraph is where the text was wrapped, not
// where the sentence ended. Reading a full stop there also chunks there.
test('a wrapped paragraph is read as one sentence', () => {
  const md =
    'The panel is loopback-only and rejects cross-origin\nrequests, so nothing loads from the\ninternet at all.';
  assert.equal(
    stripForSpeech(md),
    'The panel is loopback-only and rejects cross-origin requests, so nothing loads from the internet at all.'
  );
});

test('blank lines, list items and finished sentences still break', () => {
  assert.equal(stripForSpeech('First idea.\nSecond idea.'), 'First idea. Second idea.');
  assert.equal(stripForSpeech('A paragraph\n\nAnother paragraph'), 'A paragraph. Another paragraph');
  assert.equal(stripForSpeech('Steps to take\n- one thing\n- two thing'), 'Steps to take. one thing. two thing');
  assert.equal(stripForSpeech('## Heading\nBody text here'), 'Heading. Body text here');
});

// I16: the italic rule ate the underscores out of every snake_case identifier,
// so "read_state_file" was spoken as "readstatefile".
test('snake_case identifiers keep their underscores', () => {
  assert.equal(
    stripForSpeech('Rename read_state_file to load_state_file.'),
    'Rename read_state_file to load_state_file.'
  );
});

test('emphasis still loses its markers', () => {
  assert.equal(stripForSpeech('That is _important_ work.'), 'That is important work.');
  assert.equal(stripForSpeech('That is *important* work.'), 'That is important work.');
});

// M14: the default has to match config's maxChars, or a caller that omits it
// silently cuts at the old 1800.
test('truncateForSpeech defaults to the configured 12000-char cap', () => {
  const long = 'word '.repeat(1000).trim(); // 4999 chars, well past the old default
  assert.equal(truncateForSpeech(long), long, 'a normal long reply must survive the default cap');
  assert.ok(truncateForSpeech('x '.repeat(7000)).endsWith('the rest is on screen.'));
});
