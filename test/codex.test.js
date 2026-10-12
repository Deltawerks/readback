import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { codexReply, stripCodexMetadata, readHookInput } from '../src/codex.js';
import { codexRegistration } from '../src/codex-registration.js';

const event = (patch = {}) => ({
  hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1',
  last_assistant_message: 'Ready to read.', ...patch,
});

test('Codex accepts only identified main-thread Stop replies', () => {
  assert.equal(codexReply(event()).text, 'Ready to read.');
  for (const patch of [
    { hook_event_name: 'SubagentStop' }, { hook_event_name: 'Interrupt' },
    { hook_event_name: 'PostToolUse' }, { agent_id: 'child' },
    { session_id: '' }, { turn_id: null }, { turn_id: {} },
    { last_assistant_message: null }, { last_assistant_message: ['text'] },
    { last_assistant_message: ' \n ' },
  ]) assert.equal(codexReply(event(patch)), null);
  for (const value of [null, undefined, [], 'text']) assert.equal(codexReply(value), null);
});

test('Codex identities deduplicate delivery without dropping other chats or turns', () => {
  const first = codexReply(event()).id;
  assert.equal(codexReply(event()).id, first);
  assert.notEqual(codexReply(event({ turn_id: 'turn-2' })).id, first);
  assert.notEqual(codexReply(event({ session_id: 'session-2' })).id, first);
  assert.notEqual(codexReply(event({ session_id: 'a/b' })).id, codexReply(event({ session_id: 'a_b' })).id);
  assert.match(first, /^codex-[a-f0-9]{64}$/);
});

test('a continuation can speak its own completed turn', () => {
  assert.ok(codexReply(event({ stop_hook_active: true, turn_id: 'continued-turn' })));
});

test('Codex cleanup removes app markup and keeps human-facing text', () => {
  const input = 'Done.\n::code-comment{title="Internal" body="Details"}\n' +
    'Source. \uE200cite\uE202turn0search0\uE201\n' +
    '- :codex-followup[Review the result]{prompt="private command"}\n' +
    '<oai-mem-citation><citation_entries>private path</citation_entries></oai-mem-citation>';
  const result = stripCodexMetadata(input);
  assert.ok(result.includes('Done.'));
  assert.ok(result.includes('Review the result'));
  assert.ok(!/Internal|private|turn0search0|code-comment/.test(result));
  assert.equal(stripCodexMetadata('Normal text < 4, and `code`.'), 'Normal text < 4, and `code`.');
});

test('hook input preserves split UTF-8 and rejects malformed or oversized data', async () => {
  const raw = Buffer.from(JSON.stringify(event({ last_assistant_message: 'Voix é 🎧' })));
  const stream = Readable.from([...raw].map((n) => Buffer.from([n])));
  assert.equal((await readHookInput(stream)).last_assistant_message, 'Voix é 🎧');
  await assert.rejects(readHookInput(Readable.from(['{broken'])), SyntaxError);
  await assert.rejects(readHookInput(Readable.from([raw]), 10), /size limit/);
});

test('Codex registration quotes paths and keeps the hook separate from MCP controls', () => {
  const root = "C:\\Voice tools\\elf's $studio & café";
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const config = codexRegistration(root, node);
  const hook = config.hooks.hooks.Stop[0].hooks[0];
  assert.equal(hook.type, 'command');
  assert.equal(hook.timeout, 15);
  const encoded = hook.commandWindows.split(' ').at(-1);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(script.startsWith("& 'C:\\Program Files\\nodejs\\node.exe' "));
  assert.ok(script.includes("elf''s $studio & café"));
  assert.ok(script.endsWith("codex-stop-hook.js'"));
  assert.ok(config.mcpToml.includes('[mcp_servers.readback]'));
  assert.ok(!config.mcpToml.includes('enabled = true'));
});
