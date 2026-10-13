import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

function mkdirFreeVoice() {
  mkdirSync(FREE_VOICE, { recursive: true });
}
