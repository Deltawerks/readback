import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The real free voice, once `npm run add-free-voice` has put it in this
// checkout's free-voice/ folder; skipped everywhere else. Nothing is played.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FREE_VOICE = path.join(ROOT, 'free-voice');
const INSTALLED = existsSync(path.join(FREE_VOICE, 'node_modules', 'kokoro-js')) && existsSync(path.join(FREE_VOICE, 'models'));
const skip = INSTALLED ? false : 'the free voice is not installed here (npm run add-free-voice)';
const KOKORO = pathToFileURL(path.join(ROOT, 'src', 'providers', 'kokoro.js')).href;

const SANDBOX = mkdtempSync(path.join(tmpdir(), 'readback-kokoro-voice-'));
process.env.READBACK_STATE_DIR = SANDBOX;
process.env.READBACK_CACHE_DIR = SANDBOX;
const kokoro = await import('../src/providers/kokoro.js');
const { wavDurationMs } = await import('../src/audio.js');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const LINE = 'Done. The login issue was caused by the refresh token expiring too early, and everything passes now.';

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

test('it writes down how fast this PC made speech', { skip, timeout: 60000 }, async () => {
  await kokoro.synthesize(LINE, kokoro.defaults);
  const { xRealtime } = kokoro.status();
  assert.equal(typeof xRealtime, 'number');
  assert.ok(xRealtime > 0);
});

// The panel and the MCP server run for hours; the model's half a gigabyte is
// given back when they go quiet, and comes back on the next reply.
test('it lets go of the model after it has been idle, and loads it again when needed', { skip, timeout: 120000 }, () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const k = await import(${JSON.stringify(KOKORO)});
    await k.synthesize('Hello.', k.defaults);
    const during = k.status().loaded;
    await new Promise((r) => setTimeout(r, 1500));
    const after = k.status().loaded;
    await k.synthesize('Hello again.', k.defaults);
    process.stdout.write(JSON.stringify({ during, after, again: k.status().loaded }));
  `], { encoding: 'utf8', timeout: 100000, windowsHide: true, env: { ...process.env, READBACK_FREE_VOICE_IDLE_MS: '300' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { during: true, after: false, again: true });
});

// Only the install step downloads. A reply that found the model gone used to
// risk a silent 300 MB download in the middle of a sentence.
test('a missing model is reported at once, not downloaded mid-reply', { skip, timeout: 60000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-no-model-'));
  try {
    symlinkSync(path.join(FREE_VOICE, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
    mkdirSync(path.join(dir, 'models'));
    const started = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const k = await import(${JSON.stringify(KOKORO)});
      try { await k.synthesize('Hello.', k.defaults); process.stdout.write('spoke'); }
      catch (err) { process.stdout.write(err.message); }
    `], { encoding: 'utf8', timeout: 50000, windowsHide: true, env: { ...process.env, READBACK_FREE_VOICE_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Run npm run add-free-voice again/);
    assert.ok(Date.now() - started < 30000, 'it did not wait on a download');
  } finally {
    // The link first, on its own, so removing the folder can never walk into
    // the real packages it points at.
    try { unlinkSync(path.join(dir, 'node_modules')); } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The whole path a reply takes: speak() chunks it, the free voice makes each
// chunk, and the player is handed WAV files it can play. The PowerShell player
// is swapped for a process that just stays up, so nothing is heard.
test('a reply in the free voice reaches the player as playable WAV chunks', { skip, timeout: 120000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-kokoro-speak-'));
  try {
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
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(dir, 'fixture.cjs'))}` },
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
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
