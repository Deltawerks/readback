import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (...p) => JSON.stringify(pathToFileURL(path.join(ROOT, ...p)).href);

// Only the external boundaries are replaced: the paid HTTP call (a fake Inworld
// answering with WAVs of a set length), the PowerShell player (a node process
// that either quits at once or stays up), and the PowerShell kill/sweep (which
// records the stop epoch at the moment it runs). Queue, epochs, settings,
// chunking and speak() itself are the real thing.
const FIXTURE = `
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const path = require('node:path');
  const { syncBuiltinESMExports } = require('node:module');
  const env = process.env;
  const record = (e) => fs.appendFileSync(env.RB_EVENTS, JSON.stringify(e) + '\\n');
  if (env.RB_FAKE_PLATFORM) Object.defineProperty(process, 'platform', { value: env.RB_FAKE_PLATFORM });
  const realSpawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    if (command === 'powershell' && args.includes('-Dir')) {
      const body = env.RB_FAKE_PLAYER === 'exit' ? 'process.exit(3)' : 'setTimeout(() => {}, 20000)';
      const player = realSpawn(process.execPath, ['-e', body], { stdio: 'ignore', windowsHide: true });
      record({ event: 'player', pid: player.pid });
      return player;
    }
    return realSpawn(command, args, options);
  };
  cp.execFileSync = function () {
    let epoch = '0';
    try { epoch = fs.readFileSync(path.join(env.READBACK_CACHE_DIR, 'speak-epoch'), 'utf8').trim(); } catch {}
    record({ event: 'kill', epoch });
    return Buffer.alloc(0);
  };
  // A scenario can make the settings file unreadable for a while, the way an
  // antivirus scan holding it does: globalThis.busyUntil = performance.now() + ms.
  const realRead = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (performance.now() < (globalThis.busyUntil || 0) && String(file).endsWith('state.json')) {
      const err = new Error('EBUSY: resource busy or locked'); err.code = 'EBUSY'; throw err;
    }
    return realRead.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  const wav = (ms) => {
    const data = Math.round(ms * 32);
    const b = Buffer.alloc(44 + data);
    b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(data, 40);
    return b;
  };
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://api.inworld.ai/tts/v1/voice') throw new Error('unexpected network request');
    record({ event: 'synthesize' });
    await new Promise((r) => setTimeout(r, Number(env.RB_FAKE_SYNTH_MS || 0)));
    return new Response(JSON.stringify({ audioContent: wav(Number(env.RB_FAKE_WAV_MS || 1000)).toString('base64') }));
  };
`;

// Sentences long enough that each one is its own chunk.
const reply = (n) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} ${'lorem '.repeat(40).trim()}.`).join(' ');

function run(env, script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-speak-'));
  try {
    const state = path.join(dir, 'state');
    const cache = path.join(dir, 'cache');
    mkdirSync(state);
    mkdirSync(cache);
    writeFileSync(path.join(state, 'state.json'), JSON.stringify({ enabled: true, provider: 'inworld' }));
    writeFileSync(path.join(dir, 'fixture.cjs'), FIXTURE);
    const events = path.join(dir, 'events.jsonl');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { speak } = await import(${url('src', 'speak.js')});
      const { readAgentState } = await import(${url('src', 'state.js')});
      const { flushQueue } = await import(${url('src', 'queue.js')});
      const { stopPlayback } = await import(${url('src', 'audio.js')});
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let out;
      try { out = await (async () => { ${script} })(); } catch (err) { out = { error: err.message }; }
      process.stdout.write(JSON.stringify(out ?? null));
      process.exit(0);
    `], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: {
        ...process.env, ...env, RB_EVENTS: events, READBACK_STATE_DIR: state, READBACK_CACHE_DIR: cache,
        INWORLD_API_KEY: 'isolated-fixture-key', READBACK_DUCKING_HELPER: 'off',
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(dir, 'fixture.cjs'))}`,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const log = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return { out: JSON.parse(r.stdout), events: log, count: (e) => log.filter((x) => x.event === e).length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A script policy that blocks play-stream.ps1, or a broken audio stack, makes
// the player quit at once. Nothing more can ever be heard, yet every chunk was
// still synthesized and paid for, and the worker logged "spoke 11 of 11".
test('a player that quits early stops the spending and is reported, not logged as spoken', { timeout: 40000 }, () => {
  const { out, count } = run({ RB_FAKE_PLAYER: 'exit', RB_FAKE_SYNTH_MS: '150' }, `
    return await speak(${JSON.stringify(reply(11))}, readAgentState('claude'), { wait: true, queue: true });
  `);
  assert.ok(count('synthesize') <= 3, `synthesized ${count('synthesize')} of 11 chunks for a player that was gone`);
  assert.equal(out.playerFailed, 3);
  assert.ok(out.spoken < 11);
});

// The player is PowerShell; anywhere else it cannot start. That used to come
// out as an error only after the whole reply had been paid for.
test('off Windows nothing is synthesized and the reason is given', { timeout: 40000 }, () => {
  const { out, count } = run({ RB_FAKE_PLATFORM: 'linux' }, `
    return await speak('Hello there. This would cost money.', readAgentState('claude'), { wait: true, queue: true });
  `);
  assert.match(out.error, /Windows/);
  assert.equal(count('synthesize'), 0);
  assert.equal(count('player'), 0);
});

// Clearing the queue has to come first: the kill takes a moment, and a queued
// reply that saw the line free in between would start talking and get billed.
test('a manual utterance clears the queue before it stops the current audio', { timeout: 40000 }, () => {
  const { events } = run({ RB_FAKE_PLAYER: 'stay' }, `
    return await speak('Preview this voice.', readAgentState('claude'), { wait: false, queue: false });
  `);
  const kill = events.find((e) => e.event === 'kill');
  assert.ok(kill, 'stopping the current audio ran');
  assert.notEqual(kill.epoch, '0', 'the queue was already cleared when the kill ran');
});

test("chunk lengths are read from both providers' WAV headers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-wav-'));
  process.env.READBACK_STATE_DIR = dir;
  process.env.READBACK_CACHE_DIR = dir;
  try {
    const { wavDurationMs } = await import('../src/audio.js');
    const { pcmToWav } = await import('../src/providers/_http.js');
    // ElevenLabs: 24 kHz mono 16-bit PCM wrapped as WAV, one second of it.
    assert.equal(wavDurationMs(pcmToWav(Buffer.alloc(48000), { sampleRate: 24000, channels: 1, bitsPerSample: 16 })), 1000);
    assert.equal(wavDurationMs(Buffer.from('not audio at all')), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Synthesis ran as fast as the provider answered, so a long reply was fully
// billed within a minute while it took ten to play, and a stop saved nothing.
test('synthesis stays about half a minute ahead of playback, so a stop saves the rest', { timeout: 40000 }, () => {
  const { count } = run({ RB_FAKE_PLAYER: 'stay', RB_FAKE_WAV_MS: '10000' }, `
    await speak(${JSON.stringify(reply(12))}, readAgentState('claude'), { wait: false, queue: true });
    await sleep(1500);
    flushQueue();
    stopPlayback();
    await sleep(600);
  `);
  // Ten-second chunks: the first plus three more covers the 30 s lookahead.
  assert.equal(count('synthesize'), 4);
});

// Pacing measured the playhead with the wall clock: a clock set back mid-reply
// made synthesis wait until real time caught up, and the player gave up.
test('a clock set back mid-reply does not stall the rest of it', { timeout: 60000 }, () => {
  const { count } = run({ RB_FAKE_PLAYER: 'stay', RB_FAKE_WAV_MS: '10000' }, `
    await speak(${JSON.stringify(reply(12))}, readAgentState('claude'), { wait: false, queue: true });
    const real = Date.now;
    Date.now = () => real() - 10 * 60 * 1000;
    await sleep(11500);
    Date.now = real;
    flushQueue();
    stopPlayback();
    await sleep(600);
  `);
  // Four chunks cover the first 30 s; the fifth is due once 10 s have played.
  assert.ok(count('synthesize') >= 5, `only ${count('synthesize')} chunks after 11.5 s`);
});

// The wait between chunks reads the settings four times a second. A file that
// cannot be read for a moment (an antivirus scan) counted as "voice off" and
// ended the reply with no cue.
test('a settings file that cannot be read for a moment does not end a reply', { timeout: 60000 }, () => {
  const { count } = run({ RB_FAKE_PLAYER: 'stay', RB_FAKE_WAV_MS: '10000' }, `
    await speak(${JSON.stringify(reply(12))}, readAgentState('claude'), { wait: false, queue: true });
    globalThis.busyUntil = performance.now() + 1500;
    await sleep(11500);
    flushQueue();
    stopPlayback();
    await sleep(600);
  `);
  assert.ok(count('synthesize') >= 5, `only ${count('synthesize')} chunks after 11.5 s`);
});
