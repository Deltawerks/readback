import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'readback-codex-'));
process.env.READBACK_STATE_DIR = path.join(dir, 'state');
process.env.READBACK_CACHE_DIR = path.join(dir, 'cache');
const { speakCodexReply } = await import('../src/codex-speech.js');
const { readState, writeState } = await import('../src/state.js');
const { STATE_FILE, RUNTIME_FILE } = await import('../src/config.js');
const event = (turn = 'turn-1', text = 'Read this reply.') => {
  const transcript = path.join(dir, turn + '.jsonl');
  writeFileSync(transcript, [
    { type: 'session_meta', payload: { id: 'test-session', source: 'vscode', thread_source: 'user' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn, turn_attribution: { turn_trigger: 'composer' } } },
  ].map(JSON.stringify).join('\n'));
  return { hook_event_name: 'Stop', session_id: 'test-session', turn_id: turn,
    transcript_path: transcript, last_assistant_message: text };
};

test('Codex uses automatic queued playback and never rewrites saved settings', async () => {
  writeState({ enabled: true, provider: 'inworld' });
  const before = readFileSync(STATE_FILE, 'utf8');
  let calls = 0;
  const playback = async (text, state, options) => {
    calls++;
    assert.equal(text, 'Read this reply.');
    assert.equal(state.enabled, true);
    assert.deepEqual(options, { wait: true, queue: true });
    return { spoken: 1, total: 1 };
  };
  await speakCodexReply(event(), playback);
  assert.equal((await speakCodexReply(event(), playback)).skipped, 'already claimed');
  assert.equal(calls, 1);
  assert.equal(readFileSync(STATE_FILE, 'utf8'), before);
  assert.ok(existsSync(RUNTIME_FILE));
});

test('saved mute survives a new worker process and neither speaks nor claims a reply', async () => {
  writeState({ enabled: false });
  const before = readFileSync(STATE_FILE, 'utf8');
  const payload = event('muted-turn');
  assert.equal((await speakCodexReply(payload, () => assert.fail('must not speak'))).skipped, 'voice off');
  const worker = fileURLToPath(new URL('../hook/codex-worker.js', import.meta.url));
  const child = spawnSync(process.execPath, [worker], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env }, timeout: 5000, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(readFileSync(STATE_FILE, 'utf8'), before);
  assert.equal(readState().enabled, false);
  writeState({ enabled: true });
  let called = false;
  await speakCodexReply(payload, async () => { called = true; return { spoken: 1, total: 1 }; });
  assert.ok(called, 'muted delivery must not claim an unspoken reply');
});

test('Codex cleanup and length limit run before claiming or synthesizing', async () => {
  writeState({ enabled: true, maxChars: 120 });
  const blank = await speakCodexReply(event('code-only', '```js\nconst privateCode = 1;\n```'), () => assert.fail());
  assert.equal(blank.skipped, 'nothing speakable');
  await speakCodexReply(event('long-turn', 'Narration. '.repeat(100) + '<oai-mem-citation>private metadata</oai-mem-citation>'), async (text) => {
    assert.ok(!text.includes('private'));
    assert.ok(text.endsWith('the rest is on screen.'));
    assert.ok(text.length < 170);
    return { spoken: 1, total: 1 };
  });
});

test('Codex hook acknowledges malformed and muted events without changing turn flow', () => {
  writeState({ enabled: false });
  const hook = fileURLToPath(new URL('../hook/codex-stop-hook.js', import.meta.url));
  for (const input of ['{bad json', JSON.stringify(event('hook-muted'))]) {
    const child = spawnSync(process.execPath, [hook], {
      input, encoding: 'utf8', env: { ...process.env }, timeout: 5000, windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {});
    assert.equal(child.stderr, '');
  }
  assert.equal(readState().enabled, false);
});

test('background suggestions cannot synthesize or claim speech', async () => {
  writeState({ enabled: true });
  const payload = event('suggestion-turn');
  const before = readFileSync(STATE_FILE, 'utf8');
  for (const transcript_path of [null, '', path.join(dir, 'absent.jsonl')]) {
    const result = await speakCodexReply({ ...payload, transcript_path }, () => assert.fail('background speech'));
    assert.ok(result.skipped);
  }
  // Rejected provenance must not consume the real turn's claim.
  let called = false;
  await speakCodexReply(payload, async () => { called = true; return { spoken: 1, total: 1 }; });
  assert.ok(called);
  assert.equal(readFileSync(STATE_FILE, 'utf8'), before);
});
