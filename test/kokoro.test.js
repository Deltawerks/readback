import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The free voice as it is before anyone runs `npm run add-free-voice`: an empty
// folder where its packages and model would go. Nothing here loads a model.
const SANDBOX = mkdtempSync(path.join(tmpdir(), 'readback-kokoro-'));
process.env.READBACK_STATE_DIR = SANDBOX;
process.env.READBACK_CACHE_DIR = SANDBOX;
const FREE_VOICE = path.join(SANDBOX, 'free-voice');
process.env.READBACK_FREE_VOICE_DIR = FREE_VOICE;

const kokoro = await import('../src/providers/kokoro.js');
const { wavDurationMs } = await import('../src/audio.js');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test('the free voice needs no key, has no model picker, and starts on Heart', () => {
  assert.equal(kokoro.needsKey, false);
  assert.deepEqual(kokoro.models, []);
  assert.deepEqual(kokoro.knobs, [{ key: 'speed', label: 'Speed', min: 0.5, max: 2, step: 0.05, suffix: 'x' }]);
  assert.deepEqual(kokoro.defaults, { voiceId: 'af_heart', speed: 1 });
});

// The panel lists them before anything is downloaded, best first by the grade
// Kokoro's authors give each voice.
test('all 28 Kokoro voices are listed best first, before anything is installed', async () => {
  const voices = await kokoro.listVoices();
  assert.equal(voices.length, 28);
  assert.equal(new Set(voices.map((v) => v.voiceId)).size, 28);
  assert.deepEqual(voices[0], { voiceId: 'af_heart', displayName: 'Heart', description: 'American, grade A', gender: 'female' });
  assert.deepEqual(voices.slice(1, 4).map((v) => v.voiceId), ['af_bella', 'bf_emma', 'af_nicole']);
  assert.deepEqual(voices.at(-1), { voiceId: 'am_adam', displayName: 'Adam', description: 'American, grade F+', gender: 'male' });
  const george = voices.find((v) => v.voiceId === 'bm_george');
  assert.deepEqual(george, { voiceId: 'bm_george', displayName: 'George', description: 'British, grade C', gender: 'male' });
});

test('without the download, a reply says how to get the free voice', async () => {
  await assert.rejects(kokoro.synthesize('Hello there.', kokoro.defaults), /npm run add-free-voice/);
  assert.equal(kokoro.status().loaded, false);
});

// The panel warns when this PC makes speech slower than it plays. Whoever
// measured last (the install check, or any reply) leaves the number here.
test('status says whether the free voice is installed and how fast this PC made it', () => {
  assert.deepEqual(kokoro.status(), { installed: false, loaded: false, xRealtime: null });
  mkdirFreeVoice();
  writeFileSync(path.join(FREE_VOICE, 'speed.json'), JSON.stringify({ xRealtime: 0.8, at: '2026-10-13T00:00:00Z' }));
  assert.equal(kokoro.status().xRealtime, 0.8);
  writeFileSync(path.join(FREE_VOICE, 'speed.json'), '{"xRealtime": "fast"}');
  assert.equal(kokoro.status().xRealtime, null);
  writeFileSync(path.join(FREE_VOICE, 'speed.json'), 'half a file');
  assert.equal(kokoro.status().xRealtime, null);
});

// Kokoro hands back 32-bit float samples; Windows' SoundPlayer only plays PCM.
test("Kokoro's float samples become 16-bit WAV the player can read", () => {
  const samples = new Float32Array(24000); // one second at 24 kHz
  samples[0] = 1;
  samples[1] = -1;
  samples[2] = 3; // out of range: clipped, never wrapped
  samples[3] = Number.NaN;
  samples[4] = 0.5;
  const wav = kokoro.toWav(samples, 24000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 48000);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => wav.readInt16LE(44 + i * 2)), [32767, -32768, 32767, 0, 16384]);
  assert.equal(wavDurationMs(wav), 1000);
});

test('an unknown voice falls back to Heart rather than failing the reply', () => {
  assert.equal(kokoro.voiceFor('bm_george'), 'bm_george');
  assert.equal(kokoro.voiceFor('Luna'), 'af_heart'); // an Inworld voice id
  assert.equal(kokoro.voiceFor(undefined), 'af_heart');
});

// Where a chunk too long for Kokoro's single pass is cut in two.
test('a chunk too long for one pass is cut at the clause break nearest its middle', () => {
  assert.deepEqual(kokoro.splitInHalf('aaaa bbbb cccc, dddd eeee ffff'), ['aaaa bbbb cccc,', 'dddd eeee ffff']);
  assert.deepEqual(kokoro.splitInHalf('aaaa bbbb cccc dddd'), ['aaaa bbbb', 'cccc dddd']);
  assert.deepEqual(kokoro.splitInHalf('xxxxxxxxxx'), ['xxxxx', 'xxxxx']);
  // A clause break near one end is a worse place to cut than a space near the middle.
  assert.deepEqual(kokoro.splitInHalf('a, bbbbbbbb cccccccc dddddddd eeeeeeee'), ['a, bbbbbbbb cccccccc', 'dddddddd eeeeeeee']);
});

// A two-file stand-in for the model, so the checker and the downloader are
// tested without Hugging Face or the real 310 MB file.
const FAKE = [
  { path: 'config.json', bytes: Buffer.from('{"a":1}') },
  { path: 'onnx/model.onnx', bytes: Buffer.alloc(2048, 7) },
].map((f) => ({ ...f, size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') }));
const MANIFEST = FAKE.map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 }));
const modelFile = (dir, file) => path.join(dir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', file);
function writeModel(dir, files) {
  for (const f of files) {
    mkdirSync(path.dirname(modelFile(dir, f.path)), { recursive: true });
    writeFileSync(modelFile(dir, f.path), f.bytes);
  }
}
function fakeFetch(replace = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const f = FAKE.find((x) => String(url).endsWith(`/${x.path}`));
    return new Response(replace[f.path] ?? f.bytes, { status: 200 });
  };
  return { fetchImpl, calls };
}

test('the model check tells a missing model from a damaged one', async () => {
  const dir = path.join(SANDBOX, 'models-check');
  assert.equal(await kokoro.checkModel({ dir, files: MANIFEST }), 'missing');
  writeModel(dir, FAKE);
  assert.equal(await kokoro.checkModel({ dir, files: MANIFEST }), null);
  writeFileSync(modelFile(dir, 'onnx/model.onnx'), Buffer.alloc(2048, 8)); // right size, wrong bytes
  assert.equal(await kokoro.checkModel({ dir, files: MANIFEST }), 'damaged');
  writeFileSync(modelFile(dir, 'onnx/model.onnx'), Buffer.alloc(100, 7)); // cut short
  assert.equal(await kokoro.checkModel({ dir, files: MANIFEST }), 'damaged');
});

// transformers.js wrote the 310 MB file straight into place and took any file
// already there for a finished download, so an interrupted one was never
// repaired. The model was also whatever Hugging Face's main branch held.
test('the pinned model is moved into place only once every byte checks out', async () => {
  const dir = path.join(SANDBOX, 'models-download');
  const { fetchImpl, calls } = fakeFetch();
  const progress = [];
  await kokoro.downloadModel({ dir, files: MANIFEST, fetchImpl, onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(await kokoro.checkModel({ dir, files: MANIFEST }), null);
  assert.equal(existsSync(`${dir}.partial`), false);
  assert.ok(calls.every((u) => u.includes(`/resolve/${kokoro.MODEL_REVISION}/`)), calls.join(' '));
  assert.deepEqual(progress.at(-1), [2055, 2055]);
});

test('a bad download is thrown away, and a damaged model is then replaced', async () => {
  const dir = path.join(SANDBOX, 'models-bad');
  writeModel(dir, FAKE);
  writeFileSync(modelFile(dir, 'onnx/model.onnx'), Buffer.alloc(10)); // a damaged copy in place
  const bad = fakeFetch({ 'onnx/model.onnx': Buffer.alloc(2048, 9) });
  await assert.rejects(kokoro.downloadModel({ dir, files: MANIFEST, fetchImpl: bad.fetchImpl }), /did not match/);
  assert.equal(existsSync(`${dir}.partial`), false);
  await kokoro.downloadModel({ dir, files: MANIFEST, fetchImpl: fakeFetch().fetchImpl });
  assert.equal(await kokoro.checkModel({ dir, files: MANIFEST }), null);
});

// A reinstall skips npm when the packages already match the lockfile: Windows
// will not let npm replace files that a running panel or MCP server has loaded.
test('packages count as ready only when they match the lockfile', () => {
  mkdirFreeVoice();
  writeFileSync(path.join(FREE_VOICE, 'package-lock.json'), JSON.stringify({ packages: {
    '': { dependencies: { a: '1.0.0' } },
    'node_modules/a': { version: '1.0.0' },
    'node_modules/b': { version: '2.0.0', optional: true, os: ['aix'] }, // another platform's build
    // Optional with no platform named, but only ever pulled in by another
    // platform's build, so npm leaves it out here too.
    'node_modules/c': { version: '3.0.0', optional: true },
  } }));
  const pkg = (version) => {
    mkdirSync(path.join(FREE_VOICE, 'node_modules', 'a'), { recursive: true });
    writeFileSync(path.join(FREE_VOICE, 'node_modules', 'a', 'package.json'), JSON.stringify({ name: 'a', version }));
  };
  assert.equal(kokoro.packagesReady(), false);
  pkg('1.0.0');
  assert.equal(kokoro.packagesReady(), true);
  pkg('0.9.0');
  assert.equal(kokoro.packagesReady(), false);
  rmSync(path.join(FREE_VOICE, 'node_modules'), { recursive: true, force: true });
});

// Runs last: it leaves stand-in package files that the earlier tests must not see.
test('the free voice counts as installed only with its packages and its model', () => {
  const touch = (p) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '');
  };
  touch(path.join(FREE_VOICE, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js'));
  assert.equal(kokoro.status().installed, false);
  touch(path.join(FREE_VOICE, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'));
  assert.equal(kokoro.status().installed, false);
  touch(modelFile(path.join(FREE_VOICE, 'models'), 'onnx/model.onnx'));
  assert.equal(kokoro.status().installed, true);
});

function mkdirFreeVoice() {
  mkdirSync(FREE_VOICE, { recursive: true });
}
