import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('real Claude and Codex hook workers share one queue with no overlapping players', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-mixed-'));
  const state = path.join(dir, 'state');
  const cache = path.join(dir, 'cache');
  mkdirSync(state);
  mkdirSync(cache);
  const settings = path.join(state, 'state.json');
  writeFileSync(settings, JSON.stringify({ enabled: true, provider: 'inworld', agents: { claude: { inworld: {voiceId:'ClaudeVoice'} }, codex: { inworld: {voiceId:'CodexVoice'} } } }));
  const before = readFileSync(settings, 'utf8');
  const events = path.join(dir, 'events.jsonl');
  const preload = path.join(dir, 'fixture.cjs');
  // Only external boundaries are replaced: paid HTTP and the audio device.
  // Both real hooks, detached workers, claims, FIFO, state and cancellation run.
  writeFileSync(preload, `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const { syncBuiltinESMExports } = require('node:module');
    const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(event)+'\\n');
    const originalSpawn = cp.spawn;
    cp.spawn = function(command, args, options) {
      if (command === 'powershell' && args.includes(${JSON.stringify(path.join(root, 'scripts', 'play-stream.ps1'))})) {
        const player = originalSpawn(process.execPath, ['-e', 'setTimeout(()=>{}, 700)'], {stdio:'ignore',windowsHide:true});
        record({event:'start', pid:player.pid});
        player.on('close', () => record({event:'end', pid:player.pid}));
        return player;
      }
      return originalSpawn(command, args, options);
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.inworld.ai/tts/v1/voice') throw new Error('unexpected network request');
      record({event:'synthesize', text:JSON.parse(init.body).text, voice:JSON.parse(init.body).voiceId});
      return new Response(JSON.stringify({audioContent:Buffer.from('fixture audio').toString('base64')}));
    };
  `);
  const env = { ...process.env, READBACK_STATE_DIR: state, READBACK_CACHE_DIR: cache,
    INWORLD_API_KEY: 'isolated-fixture-key', NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  const run = (hook, payload) => {
    const child = spawnSync(process.execPath, [path.join(root, 'hook', hook)], {
      input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr);
  };
  const readEvents = () => existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const waitFor = async (condition) => {
    const deadline = Date.now() + 12000;
    while (!condition()) {
      if (Date.now() >= deadline) assert.fail(`workers did not finish: ${JSON.stringify(readEvents())}`);
      await sleep(40);
    }
  };
  const transcript = path.join(dir, 'claude.jsonl');
  writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'Fixture prompt' } },
    { type: 'assistant', uuid: 'claude-fixture', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude reply.' }] } },
  ].map(JSON.stringify).join('\n'));
  run('stop-hook.js', { transcript_path: transcript });
  await waitFor(() => readEvents().some((e) => e.event === 'start'));
  const codexTranscript = (session) => {
    const file = path.join(dir, session + '.jsonl');
    writeFileSync(file, [
      {type:'session_meta',payload:{id:session,source:'vscode',thread_source:'user'}},
      {type:'event_msg',payload:{type:'task_started',turn_id:'one',turn_attribution:{turn_trigger:'composer'}}},
    ].map(JSON.stringify).join('\n'));
    return file;
  };
  const codex = { transcript_path: codexTranscript('codex-session'), hook_event_name: 'Stop', session_id: 'codex-session', turn_id: 'one', last_assistant_message: 'Codex reply.' };
  run('codex-stop-hook.js', codex);
  run('codex-stop-hook.js', codex); // duplicate while the first is waiting
  run('codex-stop-hook.js', { ...codex, transcript_path: codexTranscript('another-session'), session_id: 'another-session', last_assistant_message: 'Other chat reply.' });
  await waitFor(() => readEvents().filter((e) => e.event === 'end').length === 3);
  const all = readEvents();
  let active = 0;
  for (const e of all) {
    if (e.event === 'start') active++;
    if (e.event === 'end') active--;
    assert.ok(active >= 0 && active <= 1, `overlapping players: ${JSON.stringify(all)}`);
  }
  assert.equal(active, 0);
  const texts = all.filter((e) => e.event === 'synthesize').map((e) => e.text);
  assert.equal(texts[0], 'Claude reply.');
  assert.deepEqual(all.filter(e => e.event === 'synthesize').map(e => e.voice), ['ClaudeVoice', 'CodexVoice', 'CodexVoice']);
  assert.deepEqual(texts.slice(1).sort(), ['Codex reply.', 'Other chat reply.']);
  assert.equal(readFileSync(settings, 'utf8'), before, 'workers must not change saved voice settings');
});
