import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real Claude hook and its detached worker, with only the paid HTTP call
// and the audio device replaced, as in codex-queue.test.js.
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-claude-hook-'));
  const state = path.join(dir, 'state');
  const cache = path.join(dir, 'cache');
  mkdirSync(state);
  mkdirSync(cache);
  writeFileSync(path.join(state, 'state.json'), JSON.stringify({ enabled: true, provider: 'inworld' }));
  const events = path.join(dir, 'events.jsonl');
  const preload = path.join(dir, 'fixture.cjs');
  writeFileSync(preload, `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const { syncBuiltinESMExports } = require('node:module');
    const record = (e) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(e) + '\\n');
    const realSpawn = cp.spawn;
    cp.spawn = function (command, args, options) {
      if (command === 'powershell' && args.includes('-Dir')) {
        return realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { stdio: 'ignore', windowsHide: true });
      }
      return realSpawn(command, args, options);
    };
    cp.execFileSync = () => Buffer.alloc(0);
    syncBuiltinESMExports();
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.inworld.ai/tts/v1/voice') throw new Error('unexpected network request');
      record({ event: 'synthesize', text: JSON.parse(init.body).text });
      return new Response(JSON.stringify({ audioContent: Buffer.from('fixture audio').toString('base64') }));
    };
  `);
  const env = {
    ...process.env, READBACK_STATE_DIR: state, READBACK_CACHE_DIR: cache, READBACK_DUCKING_HELPER: 'off',
    INWORLD_API_KEY: 'isolated-fixture-key', NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
  };
  const spoken = () => (existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
    .filter((e) => e.event === 'synthesize').map((e) => e.text);
  const hook = (payload) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hook', 'stop-hook.js')], {
      input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
  };
  return { dir, spoken, hook, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// Claude Code's hook docs: read-aloud hooks should use last_assistant_message,
// because the transcript is written asynchronously and may not hold the final
// reply yet at Stop. The worker used to poll the transcript for up to six
// seconds and give up silently when it lagged.
test('the Claude hook speaks the reply Claude Code hands it, without the transcript', { timeout: 30000 }, async () => {
  const s = sandbox();
  try {
    const transcript = path.join(s.dir, 'transcript.jsonl');
    writeFileSync(transcript, ''); // not flushed yet
    s.hook({ hook_event_name: 'Stop', session_id: 'session-1', prompt_id: 'prompt-1', transcript_path: transcript,
      last_assistant_message: 'Fresh reply from the hook payload.' });
    const deadline = Date.now() + 5000;
    while (!s.spoken().length && Date.now() < deadline) await sleep(50);
    assert.deepEqual(s.spoken(), ['Fresh reply from the hook payload.']);
  } finally {
    s.done();
  }
});

test('a duplicate fire of the same Claude reply is spoken once', { timeout: 30000 }, async () => {
  const s = sandbox();
  try {
    const payload = { hook_event_name: 'Stop', session_id: 'session-1', prompt_id: 'prompt-2',
      transcript_path: path.join(s.dir, 'none.jsonl'), last_assistant_message: 'Only once, please.' };
    s.hook(payload);
    s.hook(payload);
    await sleep(3000);
    assert.deepEqual(s.spoken(), ['Only once, please.']);
  } finally {
    s.done();
  }
});

// A reply keyed by its text alone would stay claimed for the claims' full day,
// silencing the next identical "Done." in that session. Such claims expire as
// soon as no duplicate fire could still be on its way.
test('a claim given a lifetime can be taken again once it has passed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-claims-'));
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { claim } = await import(${JSON.stringify(new URL('../src/claims.js', import.meta.url).href)});
      const out = [claim('same-text', { ttlMs: 200 }), claim('same-text', { ttlMs: 200 })];
      await new Promise((r) => setTimeout(r, 400));
      out.push(claim('same-text', { ttlMs: 200 }), claim('same-text', { ttlMs: 200 }));
      process.stdout.write(JSON.stringify(out));
    `], { env: { ...process.env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: dir }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [true, false, true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
