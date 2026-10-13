import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The real free voice, once `npm run add-free-voice` has put it in this
// checkout's free-voice/ folder; skipped everywhere else. Nothing is played.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = path.join(ROOT, 'free-voice');
const MODEL = path.join('onnx-community', 'Kokoro-82M-v1.0-ONNX');
const ONNX = path.join('onnx', 'model.onnx');
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', ONNX];
const INSTALLED = existsSync(path.join(REAL, 'node_modules', 'kokoro-js'))
  && FILES.every((f) => existsSync(path.join(REAL, 'models', MODEL, f)));
const skip = INSTALLED ? false : 'the free voice is not installed here (npm run add-free-voice)';
const KOKORO = pathToFileURL(path.join(ROOT, 'src', 'providers', 'kokoro.js')).href;

const SANDBOX = mkdtempSync(path.join(tmpdir(), 'readback-kokoro-voice-'));
const junctions = [];

// A copy of the installed free voice that costs nothing: its packages through a
// junction and its model files as hard links. Every test works in one, so its
// timings land in the copy's speed.json, never in the real one the panel reads.
// `drop` leaves model files out; `damage` keeps only their first megabyte.
function voiceCopy({ drop = [], damage = [] } = {}) {
  const dir = mkdtempSync(path.join(SANDBOX, 'voice-'));
  if (!INSTALLED) return dir;
  const modules = path.join(dir, 'node_modules');
  symlinkSync(path.join(REAL, 'node_modules'), modules, 'junction');
  junctions.push(modules);
  for (const f of FILES) {
    if (drop.includes(f)) continue;
    const from = path.join(REAL, 'models', MODEL, f);
    const to = path.join(dir, 'models', MODEL, f);
    mkdirSync(path.dirname(to), { recursive: true });
    if (damage.includes(f)) writeFileSync(to, firstBytes(from, 1 << 20));
    else {
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to); // another drive: no hard links across volumes
      }
    }
  }
  return dir;
}

function firstBytes(file, n) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(n);
    return b.subarray(0, readSync(fd, b, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

// The junctions go first, each on its own, so removing the sandbox can never
// walk into the real packages they point at.
test.after(() => {
  for (const j of junctions) {
    try { unlinkSync(j); } catch {}
  }
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

process.env.READBACK_STATE_DIR = SANDBOX;
process.env.READBACK_CACHE_DIR = SANDBOX;
process.env.READBACK_FREE_VOICE_DIR = voiceCopy();
const kokoro = await import('../src/providers/kokoro.js');
const { wavDurationMs } = await import('../src/audio.js');

// Runs a script against kokoro.js (as `k`) in a fresh process and copy.
function fresh(script, dir, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `const k = await import(${JSON.stringify(KOKORO)});\n${script}`], {
    encoding: 'utf8', timeout: 100000, windowsHide: true, env: { ...process.env, READBACK_FREE_VOICE_DIR: dir, ...env },
  });
}

const LINE = 'Done. The login issue was caused by the refresh token expiring too early, and everything passes now.';
const LOCAL_PATH = /[A-Za-z]:\\|\\\\|\//;

test('the free voice speaks a sentence as 24 kHz 16-bit WAV', { skip, timeout: 60000 }, async () => {
  const wav = await kokoro.synthesize(LINE, kokoro.defaults);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16);
  const ms = wavDurationMs(wav);
  assert.ok(ms > 3000 && ms < 15000, `${ms} ms of speech for one sentence`);
});

test('accented text and symbols do not break it', { skip, timeout: 60000 }, async () => {
  const wav = await kokoro.synthesize('Café, naïve, jalapeño… ✓ All done.', kokoro.defaults);
  assert.ok(wavDurationMs(wav) > 500);
});

test('the speed knob changes how long a line takes to say', { skip, timeout: 60000 }, async () => {
  const normal = wavDurationMs(await kokoro.synthesize(LINE, { ...kokoro.defaults, speed: 1 }));
  const fast = wavDurationMs(await kokoro.synthesize(LINE, { ...kokoro.defaults, speed: 2 }));
  assert.ok(fast / normal < 0.75, `2x took ${fast} ms against ${normal} ms`);
});

test('a voice id it does not know still speaks, in Heart', { skip, timeout: 60000 }, async () => {
  const wav = await kokoro.synthesize('Still talking.', { voiceId: 'Luna', speed: 1 });
  assert.ok(wavDurationMs(wav) > 300);
});

// Kokoro reads at most 512 sounds per call and silently drops the rest. Plain
// prose fits in a 300-character chunk, but numbers, versions and paths spell
// out to two or three times as many sounds, and a chunk's ending went missing.
test('a chunk too long for one pass is said in full, not cut off', { skip, timeout: 120000 }, async () => {
  const first = 'Version 0.8.0 ships on 2026-10-13 with commits 4c83e0f, b02f432 and ed645a9;';
  const second = 'build 20261013.4471 passed 247 of 247 tests in 28.3 seconds on node 24.12.0, and the crash at 0x7FFADF3FB12C, exit code 0xC0000005, is gone.';
  const whole = wavDurationMs(await kokoro.synthesize(`${first} ${second}`, kokoro.defaults));
  const parts = wavDurationMs(await kokoro.synthesize(first, kokoro.defaults)) + wavDurationMs(await kokoro.synthesize(second, kokoro.defaults));
  assert.ok(whole > parts * 0.9, `the whole chunk ran ${whole} ms, its two halves ${parts} ms`);
});

test('a model that checks out is not downloaded again', { skip, timeout: 120000 }, async () => {
  const fetchImpl = async () => {
    throw new Error('it downloaded the model again');
  };
  assert.equal(await kokoro.ensureModel({ fetchImpl }), 'ready');
});

test('it writes down how fast this PC made speech', { skip, timeout: 120000 }, () => {
  const dir = voiceCopy();
  assert.equal(existsSync(path.join(dir, 'speed.json')), false);
  const r = fresh(`await k.synthesize(${JSON.stringify(LINE)}, k.defaults); process.stdout.write(JSON.stringify(k.status()));`, dir);
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(readFileSync(path.join(dir, 'speed.json'), 'utf8'));
  assert.equal(typeof saved.xRealtime, 'number');
  assert.ok(saved.xRealtime > 0);
  assert.equal(JSON.parse(r.stdout).xRealtime, saved.xRealtime);
});

// The panel and the MCP server run for hours; the model's half a gigabyte is
// given back when they go quiet, and comes back on the next reply.
test('it lets go of the model after it has been idle, and loads it again when needed', { skip, timeout: 120000 }, () => {
  const r = fresh(`
    await k.synthesize('Hello.', k.defaults);
    const during = k.status().loaded;
    await new Promise((r) => setTimeout(r, 1500));
    const after = k.status().loaded;
    await k.synthesize('Hello again.', k.defaults);
    process.stdout.write(JSON.stringify({ during, after, again: k.status().loaded }));
  `, voiceCopy(), { READBACK_FREE_VOICE_IDLE_MS: '300' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { during: true, after: false, again: true });
});

// Only the install step downloads. A reply that found the model gone used to
// risk a silent 300 MB download in the middle of a sentence.
test('a missing model is reported at once, not downloaded mid-reply', { skip, timeout: 60000 }, () => {
  const started = Date.now();
  const r = fresh(`try { await k.synthesize('Hello.', k.defaults); process.stdout.write('spoke'); } catch (err) { process.stdout.write(err.message); }`, voiceCopy({ drop: FILES }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /npm run add-free-voice/);
  assert.ok(Date.now() - started < 30000, 'it did not wait on a download');
});

// The tokenizer used to load after the model, so a missing tokenizer left the
// model's memory behind with nothing pointing at it, in a panel that runs all day.
test('a half-installed model fails fast without holding its memory', { skip, timeout: 120000 }, () => {
  const r = fresh(`
    const before = process.memoryUsage().rss;
    let message = 'spoke';
    for (let i = 0; i < 3; i++) {
      try { await k.synthesize('Hello.', k.defaults); } catch (err) { message = err.message; }
    }
    process.stdout.write(JSON.stringify({ message, grewMB: Math.round((process.memoryUsage().rss - before) / 1048576), loaded: k.status().loaded }));
  `, voiceCopy({ drop: ['tokenizer.json'] }));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.message, /npm run add-free-voice/);
  assert.doesNotMatch(out.message, LOCAL_PATH, 'no local paths in a message the panel shows');
  assert.ok(out.grewMB < 250, `still holding ${out.grewMB} MB after failing`);
  assert.equal(out.loaded, false);
});

test('a damaged model says so, without local paths, and how to repair it', { skip, timeout: 120000 }, () => {
  const r = fresh(`try { await k.synthesize('Hello.', k.defaults); process.stdout.write('spoke'); } catch (err) { process.stdout.write(err.message); }`, voiceCopy({ damage: [ONNX] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /damaged/);
  assert.match(r.stdout, /npm run add-free-voice/);
  assert.doesNotMatch(r.stdout, LOCAL_PATH);
});

// The whole path a reply takes: speak() chunks it, the free voice makes each
// chunk, and the player is handed WAV files it can play. The PowerShell player
// is swapped for a process that just stays up, so nothing is heard.
test('a reply in the free voice reaches the player as playable WAV chunks', { skip, timeout: 120000 }, () => {
  const dir = mkdtempSync(path.join(SANDBOX, 'speak-'));
  const state = path.join(dir, 'state');
  const cache = path.join(dir, 'cache');
  mkdirSync(state);
  mkdirSync(cache);
  writeFileSync(path.join(state, 'state.json'), JSON.stringify({ enabled: true, provider: 'kokoro', agents: { claude: { provider: 'kokoro' } } }));
  writeFileSync(path.join(dir, 'fixture.cjs'), `
    const cp = require('node:child_process');
    const { syncBuiltinESMExports } = require('node:module');
    const realSpawn = cp.spawn;
    cp.spawn = function (command, args, options) {
      if (command === 'powershell' && args.includes('-Dir')) {
        return realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
      }
      return realSpawn(command, args, options);
    };
    cp.execFileSync = () => Buffer.alloc(0);
    syncBuiltinESMExports();
    globalThis.fetch = async () => { throw new Error('the free voice made a network request'); };
  `);
  const url = (...p) => JSON.stringify(pathToFileURL(path.join(ROOT, ...p)).href);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readdirSync, readFileSync } from 'node:fs';
    import path from 'node:path';
    const { speak } = await import(${url('src', 'speak.js')});
    const { readAgentState } = await import(${url('src', 'state.js')});
    const { wavDurationMs } = await import(${url('src', 'audio.js')});
    const reply = 'First, the short one. ' + 'Then a longer sentence that goes on for a while, so the reply needs more than one chunk to say. '.repeat(4);
    const out = await speak(reply, readAgentState('claude'), { wait: false, queue: true });
    const stream = readdirSync(process.env.READBACK_CACHE_DIR).find((f) => f.startsWith('stream-'));
    const dirPath = path.join(process.env.READBACK_CACHE_DIR, stream);
    const wavs = () => readdirSync(dirPath).filter((f) => f.endsWith('.wav'));
    for (let waited = 0; wavs().length < out.total && waited < 60000; waited += 250) await new Promise((r) => setTimeout(r, 250));
    const chunks = wavs().sort().map((f) => {
      const b = readFileSync(path.join(dirPath, f));
      return { riff: b.toString('ascii', 0, 4), rate: b.readUInt32LE(24), bits: b.readUInt16LE(34), ms: wavDurationMs(b) };
    });
    process.stdout.write(JSON.stringify({ out, chunks }));
    process.exit(0);
  `], {
    encoding: 'utf8', timeout: 100000, windowsHide: true,
    env: { ...process.env, READBACK_STATE_DIR: state, READBACK_CACHE_DIR: cache, READBACK_DUCKING_HELPER: 'off',
      READBACK_FREE_VOICE_DIR: voiceCopy(), NODE_OPTIONS: `--require ${JSON.stringify(path.join(dir, 'fixture.cjs'))}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const { out, chunks } = JSON.parse(r.stdout);
  assert.equal(out.streaming, true);
  assert.ok(out.total >= 2, `${out.total} chunks`);
  assert.equal(chunks.length, out.total, 'every chunk was made');
  for (const c of chunks) {
    assert.deepEqual({ riff: c.riff, rate: c.rate, bits: c.bits }, { riff: 'RIFF', rate: 24000, bits: 16 });
    assert.ok(c.ms > 500, `a ${c.ms} ms chunk`);
  }
});
