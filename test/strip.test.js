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
