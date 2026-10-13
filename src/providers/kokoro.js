import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pcmToWav } from './_http.js';

// The free voice: Kokoro, an open-weight model that runs on this PC instead of
// a paid service. Nothing of it is downloaded until someone runs
// `npm run add-free-voice`, which puts its packages and model in free-voice/;
// until then every reply says how to get it, and the paid providers never load
// any of this.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FREE_VOICE_DIR = process.env.READBACK_FREE_VOICE_DIR || path.join(ROOT, 'free-voice');
const MODULES = path.join(FREE_VOICE_DIR, 'node_modules');
const KOKORO_ENTRY = path.join(MODULES, 'kokoro-js', 'dist', 'kokoro.js');
const TRANSFORMERS_ENTRY = path.join(MODULES, '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
const MODEL_DIR = path.join(FREE_VOICE_DIR, 'models');
const SPEED_FILE = path.join(FREE_VOICE_DIR, 'speed.json');
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const NOT_INSTALLED = 'The free voice is not installed yet. Run npm run add-free-voice in the ReadBack folder.';

// Measured on a 24-core desktop: the full-precision model on 4 threads makes
// speech about 4.5 times faster than it plays. The 8-bit model was three times
// slower on the CPU, and left to itself the runtime spread every reply across
// 20 cores for a quarter more speed.
const THREADS = Math.max(1, Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length));
// Long-running processes (the panel, the MCP server) give the model's memory
// back after this long without speaking; a reply's worker exits anyway.
const IDLE_MS = Number(process.env.READBACK_FREE_VOICE_IDLE_MS) > 0 ? Number(process.env.READBACK_FREE_VOICE_IDLE_MS) : 10 * 60 * 1000;

export const label = 'Free (Kokoro)';
export const needsKey = false;
export const models = [];
export const knobs = [{ key: 'speed', label: 'Speed', min: 0.5, max: 2, step: 0.05, suffix: 'x' }];
export const defaults = { voiceId: 'af_heart', speed: 1 };

// Kokoro's English voices and the grade its authors give each one. Static, so
// the panel can list them before anything is downloaded.
const GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];
const VOICES = [
  ['af_heart', 'Heart', 'A'], ['af_bella', 'Bella', 'A-'], ['af_nicole', 'Nicole', 'B-'],
  ['af_aoede', 'Aoede', 'C+'], ['af_kore', 'Kore', 'C+'], ['af_sarah', 'Sarah', 'C+'],
  ['af_alloy', 'Alloy', 'C'], ['af_nova', 'Nova', 'C'], ['af_sky', 'Sky', 'C-'],
  ['af_jessica', 'Jessica', 'D'], ['af_river', 'River', 'D'],
  ['am_fenrir', 'Fenrir', 'C+'], ['am_michael', 'Michael', 'C+'], ['am_puck', 'Puck', 'C+'],
  ['am_echo', 'Echo', 'D'], ['am_eric', 'Eric', 'D'], ['am_liam', 'Liam', 'D'], ['am_onyx', 'Onyx', 'D'],
  ['am_santa', 'Santa', 'D-'], ['am_adam', 'Adam', 'F+'],
  ['bf_emma', 'Emma', 'B-'], ['bf_isabella', 'Isabella', 'C'], ['bf_alice', 'Alice', 'D'], ['bf_lily', 'Lily', 'D'],
  ['bm_fable', 'Fable', 'C'], ['bm_george', 'George', 'C'], ['bm_lewis', 'Lewis', 'D+'], ['bm_daniel', 'Daniel', 'D'],
]
  .map(([voiceId, displayName, grade]) => ({
    voiceId,
    displayName,
    description: `${voiceId[0] === 'b' ? 'British' : 'American'}, grade ${grade}`,
    gender: voiceId[1] === 'f' ? 'female' : 'male',
    rank: GRADES.indexOf(grade),
  }))
  .sort((a, b) => a.rank - b.rank || a.displayName.localeCompare(b.displayName))
  .map(({ rank, ...voice }) => voice);
const VOICE_IDS = new Set(VOICES.map((v) => v.voiceId));

// A voice id from somewhere else (a hand-edited file, an MCP call, another
// provider's id) gets the default voice rather than a failed reply.
export function voiceFor(voiceId) {
  return VOICE_IDS.has(voiceId) ? voiceId : defaults.voiceId;
}

export async function listVoices() {
  return VOICES.map((v) => ({ ...v }));
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Kokoro returns 32-bit float samples; Windows' SoundPlayer only plays PCM.
export function toWav(samples, sampleRate) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    pcm.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return pcmToWav(pcm, { sampleRate, channels: 1, bitsPerSample: 16 });
}

// Loads the model from free-voice/models. Only the install step may download
// it: a reply that found it missing would otherwise stall on 300 MB.
async function load({ download = false } = {}) {
  if (!existsSync(KOKORO_ENTRY) || !existsSync(TRANSFORMERS_ENTRY)) throw new Error(NOT_INSTALLED);
  // kokoro-js imports this same file, so the settings below apply to it too.
  const hf = await import(pathToFileURL(TRANSFORMERS_ENTRY).href);
  const { KokoroTTS } = await import(pathToFileURL(KOKORO_ENTRY).href);
  hf.env.cacheDir = MODEL_DIR;
  hf.env.allowRemoteModels = download;
  try {
    // What KokoroTTS.from_pretrained does, plus a thread cap it does not offer.
    const model = await hf.StyleTextToSpeech2Model.from_pretrained(MODEL_ID, {
      dtype: 'fp32',
      device: 'cpu',
      session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 },
    });
    const tokenizer = await hf.AutoTokenizer.from_pretrained(MODEL_ID);
    return new KokoroTTS(model, tokenizer);
  } catch (err) {
    if (download) throw err;
    throw new Error(`The free voice's model could not be loaded (${err.message}). Run npm run add-free-voice again.`);
  }
}

// One model per process, shared by every reply in it, and let go of once the
// process has been quiet for IDLE_MS.
let loading = null;
let busy = 0;
let idleTimer = null;

async function acquire() {
  busy++;
  clearTimeout(idleTimer);
  try {
    if (!loading) {
      loading = load().catch((err) => {
        loading = null;
        throw err;
      });
    }
    return await loading;
  } catch (err) {
    release();
    throw err;
  }
}

function release() {
  busy--;
  if (busy > 0 || !loading) return;
  idleTimer = setTimeout(unload, IDLE_MS);
  idleTimer.unref?.();
}

async function unload() {
  if (busy > 0 || !loading) return;
  const current = loading;
  loading = null;
  try {
    const tts = await current;
    await tts.model?.dispose?.();
  } catch {
    // it never loaded, or is already gone
  }
}

// How fast this PC makes speech, as a multiple of how fast it plays. The first
// clip long enough to time fairly is written down once per process, so the
// panel can warn a PC that cannot keep up.
let speedNoted = false;

function noteSpeed(audioMs, ms) {
  if (speedNoted || audioMs < 2000 || ms <= 0) return null;
  speedNoted = true;
  const xRealtime = Math.round((audioMs / ms) * 10) / 10;
  try {
    writeFileSync(SPEED_FILE, JSON.stringify({ xRealtime, at: new Date().toISOString() }));
  } catch {
    // informational only
  }
  return xRealtime;
}

async function generate(tts, text, cfg) {
  const started = performance.now();
  const audio = await tts.generate(text, { voice: voiceFor(cfg.voiceId), speed: clamp(cfg.speed, 0.5, 2, defaults.speed) });
  const ms = performance.now() - started;
  return { audio, audioMs: (audio.audio.length / audio.sampling_rate) * 1000, ms };
}

export async function synthesize(text, cfg) {
  const tts = await acquire();
  try {
    const { audio, audioMs, ms } = await generate(tts, text, cfg || {});
    noteSpeed(audioMs, ms);
    return toWav(audio.audio, audio.sampling_rate);
  } finally {
    release();
  }
}

export function status() {
  let xRealtime = null;
  try {
    const saved = JSON.parse(readFileSync(SPEED_FILE, 'utf8'));
    if (typeof saved.xRealtime === 'number' && Number.isFinite(saved.xRealtime)) xRealtime = saved.xRealtime;
  } catch {
    // not measured yet, or half written
  }
  return { installed: existsSync(KOKORO_ENTRY), loaded: loading !== null, xRealtime };
}

// The install step: download the model, then time a real sentence (the second
// one, after the first has warmed the runtime up) and write the speed down.
export async function prepare() {
  const tts = await load({ download: true });
  try {
    const line = 'Done. I fixed the refresh logic, added a regression test, and everything passes. Your music stays down until I finish.';
    await generate(tts, line, defaults);
    const { audioMs, ms } = await generate(tts, line, defaults);
    speedNoted = false;
    return { xRealtime: noteSpeed(audioMs, ms), threads: THREADS };
  } finally {
    await tts.model?.dispose?.();
  }
}
