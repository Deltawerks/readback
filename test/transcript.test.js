import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLastAssistantText, currentReply } from '../src/transcript.js';

const line = (obj) => JSON.stringify(obj);

const asst = (uuid, text) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const asstTool = (uuid) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
const userMsg = (uuid, text) => line({ type: 'user', uuid, message: { role: 'user', content: text } });
const toolResult = (uuid) =>
  line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });

test('currentReply: reply flushed after the prompt -> returns it', () => {
  const jsonl = [userMsg('u1', 'hi'), asst('a1', 'the reply')].join('\n');
  assert.deepEqual(currentReply(jsonl), { text: 'the reply', id: 'a1' });
});

test('currentReply: reply NOT yet flushed (last entry is the prompt) -> null', () => {
  const jsonl = [asst('a0', 'previous reply'), userMsg('u1', 'new prompt')].join('\n');
  assert.equal(currentReply(jsonl), null);
});

test('currentReply: final text after a tool round -> returns final text', () => {
  const jsonl = [
    userMsg('u1', 'do it'),
    asstTool('a1'),
    toolResult('t1'),
    asst('a2', 'all done'),
  ].join('\n');
  assert.deepEqual(currentReply(jsonl), { text: 'all done', id: 'a2' });
});

test('currentReply: mid tool round (last entry is tool_result) -> null', () => {
  const jsonl = [userMsg('u1', 'do it'), asstTool('a1'), toolResult('t1')].join('\n');
  assert.equal(currentReply(jsonl), null);
});

test('currentReply: ignores sidechain assistant turns', () => {
  const jsonl = [
    userMsg('u1', 'hi'),
    asst('a1', 'main reply'),
    line({ isSidechain: true, type: 'assistant', uuid: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
  ].join('\n');
  assert.deepEqual(currentReply(jsonl), { text: 'main reply', id: 'a1' });
});

test('currentReply: empty / nullish -> null', () => {
  assert.equal(currentReply(''), null);
  assert.equal(currentReply(null), null);
});

test('returns the last assistant text message', () => {
  const jsonl = [
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
    line({ type: 'user', message: { role: 'user', content: 'more' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the latest reply' }] } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'the latest reply');
});

test('joins multiple text blocks and ignores tool_use blocks', () => {
  const jsonl = line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'part one' },
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'text', text: 'part two' },
      ],
    },
  });
  assert.equal(extractLastAssistantText(jsonl), 'part one\npart two');
});

test('skips a trailing tool-result user turn to find the assistant reply', () => {
  const jsonl = [
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'real answer' }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'real answer');
});

test('handles string content and malformed lines', () => {
  const jsonl = [
    'not json at all',
    line({ type: 'assistant', message: { role: 'assistant', content: 'plain string reply' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'plain string reply');
});

test('ignores subagent (isSidechain) turns and speaks the main reply', () => {
  const jsonl = [
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the main agent reply' }] } }),
    line({ isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent internal output' }] } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'the main agent reply');
});

test('returns empty string when there is no assistant text', () => {
  const jsonl = line({ type: 'user', message: { role: 'user', content: 'hi' } });
  assert.equal(extractLastAssistantText(jsonl), '');
  assert.equal(extractLastAssistantText(''), '');
});
