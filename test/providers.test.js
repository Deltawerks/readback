import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Sandbox the paths before anything from src/ resolves them, and never let a
// test reach a real provider: every call below goes through a stubbed fetch.
const SANDBOX = mkdtempSync(path.join(tmpdir(), 'readback-providers-test-'));
process.env.READBACK_STATE_DIR = SANDBOX;
process.env.READBACK_CACHE_DIR = SANDBOX;

const elevenlabs = await import('../src/providers/elevenlabs.js');
const inworld = await import('../src/providers/inworld.js');
const { clampKnobs } = await import('../src/providers/index.js');

const realFetch = globalThis.fetch;

// Answer each call with the next queued entry, repeating the last one for any
// further calls, so "exactly one request" assertions mean something.
function queueFetch(t, entries) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const entry = entries[Math.min(calls.length, entries.length - 1)];
    calls.push({
      url: String(url),
      headers: (init && init.headers) || {},
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    if (entry.throw) throw entry.throw;
    // A real Response, so these tests pin what the provider sends and reads
    // rather than which method it happens to use to read it.
    return new Response(Buffer.from(entry.body ?? ''), {
      status: entry.status ?? 200,
      headers: entry.headers || {},
    });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return calls;
}

const PCM = { body: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) };
const INWORLD_OK = { body: JSON.stringify({ audioContent: Buffer.from('wavbytes').toString('base64') }) };
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

// I11: an empty default voice looks like a chosen voice in the dropdown and
// throws inside a detached worker, so a first run is silent with no error shown.
test('ElevenLabs ships with a real default voice', () => {
  assert.equal(typeof elevenlabs.defaults.voiceId, 'string');
  assert.ok(elevenlabs.defaults.voiceId.length > 0, 'a first-time user must have a voice selected');
});

// M13: ElevenLabs recommends Flash over Turbo in all use cases.
test('ElevenLabs defaults to Flash and still offers Turbo', () => {
  assert.equal(elevenlabs.defaults.modelId, 'eleven_flash_v2_5');
  const ids = elevenlabs.models.map((m) => m.id);
  assert.ok(ids.includes('eleven_flash_v2_5'));
  assert.ok(ids.includes('eleven_turbo_v2_5'), 'Turbo stays available');
});

test('the ElevenLabs model fallback matches the declared default', async (t) => {
  const calls = queueFetch(t, [PCM]);
  await elevenlabs.synthesize('hi', { voiceId: 'v1' }, 'key');
  assert.equal(calls[0].body.model_id, 'eleven_flash_v2_5');
});

// M13: the in-provider fallback used to be -max while the declared default was
// -mini, so a config block missing modelId silently bought the expensive model.
test('the Inworld model fallback matches the declared default', async (t) => {
  const calls = queueFetch(t, [INWORLD_OK]);
  await inworld.synthesize('hi', { voiceId: 'Luna' }, 'key');
  assert.equal(calls[0].body.modelId, inworld.defaults.modelId);
  assert.equal(calls[0].body.modelId, 'inworld-tts-1.5-mini');
});

// I12: ElevenLabs documents speed, similarity and speaker boost as unavailable
// on v3. Sending them anyway is noise the model cannot honor.
test('v3 omits the settings it does not support', async (t) => {
  const calls = queueFetch(t, [PCM]);
  await elevenlabs.synthesize(
    'hi',
    { voiceId: 'v1', modelId: 'eleven_v3', speed: 1.1, similarity: 0.9, speakerBoost: true, stability: 0.4, style: 0.2 },
    'key'
  );
  const vs = calls[0].body.voice_settings;
  assert.equal(vs.speed, undefined);
  assert.equal(vs.similarity_boost, undefined);
  assert.equal(vs.use_speaker_boost, undefined);
  assert.equal(vs.stability, 0.4);
  assert.equal(vs.style, 0.2);
});

test('non-v3 models still get speed, similarity and speaker boost', async (t) => {
  const calls = queueFetch(t, [PCM]);
  await elevenlabs.synthesize(
    'hi',
    { voiceId: 'v1', modelId: 'eleven_flash_v2_5', speed: 1.1, similarity: 0.9, speakerBoost: false, stability: 0.4, style: 0.2 },
    'key'
  );
  const vs = calls[0].body.voice_settings;
  assert.equal(vs.speed, 1.1);
  assert.equal(vs.similarity_boost, 0.9);
  assert.equal(vs.use_speaker_boost, false);
  assert.equal(vs.stability, 0.4);
  assert.equal(vs.style, 0.2);
});

// I13: a bad key fails identically every time. Three round trips just delay the
// error the user needs to read.
test('a 401 is not retried and reads like an error', async (t) => {
  const calls = queueFetch(t, [
    { status: 401, body: JSON.stringify({ detail: { message: 'Invalid API key' } }) },
  ]);
  await assert.rejects(
    () => elevenlabs.synthesize('hi', { voiceId: 'v1' }, 'bad'),
    /401.*Invalid API key/
  );
  assert.equal(calls.length, 1, 'a 4xx other than 429 must not be repeated');
});

test('Inworld does not retry a 403 either', async (t) => {
  const calls = queueFetch(t, [{ status: 403, body: 'permission denied' }]);
  await assert.rejects(() => inworld.synthesize('hi', { voiceId: 'Luna' }, 'bad'), /403/);
  assert.equal(calls.length, 1);
});

test('a 429 is retried once the server says it may be', async (t) => {
  const calls = queueFetch(t, [{ status: 429, headers: { 'retry-after': '0' }, body: 'slow down' }, PCM]);
  const wav = await elevenlabs.synthesize('hi', { voiceId: 'v1' }, 'key');
  assert.equal(calls.length, 2);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
});

test('a 500 is retried', async (t) => {
  const calls = queueFetch(t, [{ status: 500, body: 'boom' }, INWORLD_OK]);
  await inworld.synthesize('hi', { voiceId: 'Luna' }, 'key');
  assert.equal(calls.length, 2);
});

// I13: ElevenLabs bills on generation, so re-sending after a client-side abort
// risks paying twice for audio nobody hears.
test('a timeout is never repeated', async (t) => {
  const calls = queueFetch(t, [{ throw: abortError() }]);
  await assert.rejects(() => elevenlabs.synthesize('hi', { voiceId: 'v1' }, 'key'));
  assert.equal(calls.length, 1, 'an aborted request must not be sent again');

  const inworldCalls = queueFetch(t, [{ throw: abortError() }]);
  await assert.rejects(() => inworld.synthesize('hi', { voiceId: 'Luna' }, 'key'));
  assert.equal(inworldCalls.length, 1);
});

test('a network failure is retried', async (t) => {
  const calls = queueFetch(t, [{ throw: new Error('socket hang up') }, PCM]);
  await elevenlabs.synthesize('hi', { voiceId: 'v1' }, 'key');
  assert.equal(calls.length, 2);
});

// M8: an out-of-range knob reaches the provider as a 400 the user never sees.
test('ElevenLabs clamps stability, similarity and style', async (t) => {
  const calls = queueFetch(t, [PCM]);
  await elevenlabs.synthesize(
    'hi',
    { voiceId: 'v1', modelId: 'eleven_flash_v2_5', stability: 5, similarity: -2, style: 'nonsense', speed: 99 },
    'key'
  );
  const vs = calls[0].body.voice_settings;
  assert.equal(vs.stability, 1);
  assert.equal(vs.similarity_boost, 0);
  assert.equal(vs.style, elevenlabs.defaults.style);
  assert.equal(vs.speed, 1.2);
});

test('Inworld clamps temperature and speed', async (t) => {
  const calls = queueFetch(t, [INWORLD_OK]);
  await inworld.synthesize('hi', { voiceId: 'Luna', temperature: 9, speed: 12 }, 'key');
  assert.equal(calls[0].body.temperature, 2);
  assert.equal(calls[0].body.audioConfig.speakingRate, 1.5);

  const more = queueFetch(t, [INWORLD_OK]);
  await inworld.synthesize('hi', { voiceId: 'Luna', temperature: 'hot' }, 'key');
  assert.equal(more[0].body.temperature, inworld.defaults.temperature);
});

// M8: the panel takes numbers from sliders, but a POST can carry anything.
test('clampKnobs coerces every knob the provider declares', () => {
  const el = clampKnobs('elevenlabs', {
    stability: 5,
    similarity: -3,
    style: 'nope',
    speed: NaN,
    speakerBoost: 'yes',
  });
  assert.equal(el.stability, 1);
  assert.equal(el.similarity, 0);
  assert.equal(el.style, elevenlabs.defaults.style);
  assert.equal(el.speed, elevenlabs.defaults.speed);
  assert.equal(el.speakerBoost, true);
  assert.equal(clampKnobs('elevenlabs', { speakerBoost: 'false' }).speakerBoost, false);
  assert.equal(clampKnobs('elevenlabs', { speakerBoost: 0 }).speakerBoost, false);

  const iw = clampKnobs('inworld', { temperature: 99, speed: '1.2' });
  assert.equal(iw.temperature, 2);
  assert.equal(iw.speed, 1.2);
});

test('clampKnobs tames voiceId and modelId', () => {
  const out = clampKnobs('inworld', {
    voiceId: `Lu\u0001na\u0007Drop${'x'.repeat(400)}`,
    modelId: { evil: true },
  });
  assert.equal(typeof out.voiceId, 'string');
  assert.ok(!/[\u0000-\u001F\u007F]/.test(out.voiceId), 'control characters must be gone');
  assert.equal(out.voiceId.length, 200);
  assert.ok(out.voiceId.startsWith('LunaDrop'));
  assert.equal(typeof out.modelId, 'string');
});

test('clampKnobs only touches what the patch carries', () => {
  assert.deepEqual(clampKnobs('inworld', {}), {});
  assert.deepEqual(clampKnobs('inworld', { speed: 1.1 }), { speed: 1.1 });
  // An unknown provider resolves the same way getProvider does.
  assert.deepEqual(clampKnobs('nope', { temperature: 99 }), { temperature: 2 });
});
