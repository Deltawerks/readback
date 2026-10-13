import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
const MODEL_ONNX = path.join(MODEL_DIR, MODEL_ID, 'onnx', 'model.onnx');

// The model's files, pinned to one revision on Hugging Face and checked byte
// for byte, the way the npm packages are pinned by their lockfile.
export const MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const MODEL_FILES = [
  { path: 'config.json', size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
  { path: 'tokenizer.json', size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
  { path: 'tokenizer_config.json', size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
  { path: 'onnx/model.onnx', size: 325532232, sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb' },
];

// What a user is told. Never a local path: these reach the panel and, through
// the MCP say tool, the assistant.
const NOT_INSTALLED = 'The free voice is not installed yet. Run npm run add-free-voice in the ReadBack folder.';
const MODEL_MISSING = "The free voice's model is not downloaded, or part of it is missing. Run npm run add-free-voice in the ReadBack folder.";
const MODEL_DAMAGED = "The free voice's model is damaged. Run npm run add-free-voice in the ReadBack folder to repair it.";
const MODEL_UNREADABLE = "The free voice's model could not be read, so it may be damaged. Run npm run add-free-voice in the ReadBack folder to repair it.";
const PACKAGES_BROKEN = "The free voice's packages are incomplete. Close the ReadBack panel and any Claude Code or Codex sessions, then run npm run add-free-voice.";

// Measured on a 24-core desktop: the full-precision model on 4 threads makes
// speech about 4.5 times faster than it plays. The 8-bit model was three times
// slower on the CPU, and left to itself the runtime spread every reply across
// 20 cores for a quarter more speed.
const THREADS = Math.max(1, Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length));
// Long-running processes (the panel, the MCP server) give the model's memory
// back after this long without speaking; a reply's worker exits anyway.
const IDLE_MS = Number(process.env.READBACK_FREE_VOICE_IDLE_MS) > 0 ? Number(process.env.READBACK_FREE_VOICE_IDLE_MS) : 10 * 60 * 1000;
// Kokoro reads at most 512 tokens, one per sound plus two markers, and silently
// drops the rest. Plain prose fits in a 300-character chunk; numbers, versions
// and paths spell out to two or three times as many sounds and did not.
const MAX_TOKENS = 510;

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

// A voice id from somewhere else (a hand-edited file, another provider's id)
// gets the default voice rather than a failed reply.
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

// Where a chunk too long for one pass is cut in two: the clause break nearest
// its middle (if that is anywhere near the middle), else the space nearest the
// middle, else the middle itself.
export function splitInHalf(text) {
  const mid = text.length / 2;
  const nearest = (re) => {
    let best = -1;
    for (const m of text.matchAll(re)) {
      const at = m.index + m[0].length;
      if (at < text.length && (best < 0 || Math.abs(at - mid) < Math.abs(best - mid))) best = at;
    }
    return best;
  };
  let at = nearest(/[,;:.!?]\s+/g);
  if (at < 0 || Math.abs(at - mid) > text.length / 4) at = nearest(/\s+/g);
  if (at <= 0) at = Math.floor(mid);
  return [text.slice(0, at).trim(), text.slice(at).trim()];
}

// Whether every model file is there and, unless hash is false, exactly the
// pinned bytes: null when all is well, else 'missing' or 'damaged'.
export async function checkModel({ dir = MODEL_DIR, files = MODEL_FILES, hash = true } = {}) {
  let damaged = false;
  for (const f of files) {
    const file = path.join(dir, MODEL_ID, f.path);
    let size;
    try {
      size = statSync(file).size;
    } catch {
      return 'missing';
    }
    if (size !== f.size || (hash && (await sha256(file)) !== f.sha256)) damaged = true;
  }
  return damaged ? 'damaged' : null;
}

async function sha256(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

// Downloads the pinned model into a folder beside the real one, checks every
// byte, and only then swaps it in, so an interrupted or bad download never
// leaves a model that looks finished. A damaged model is replaced the same way.
export async function downloadModel({ dir = MODEL_DIR, files = MODEL_FILES, fetchImpl = fetch, onProgress = () => {} } = {}) {
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  try {
    for (const f of files) {
      const res = await fetchImpl(`https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${f.path}`);
      if (!res.ok || !res.body) throw new Error(`the download of ${f.path} failed (HTTP ${res.status})`);
      const target = path.join(partial, MODEL_ID, f.path);
      mkdirSync(path.dirname(target), { recursive: true });
      const hash = createHash('sha256');
      let bytes = 0;
      const count = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          done += chunk.length;
          onProgress(done, total);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), count, createWriteStream(target));
      if (bytes !== f.size || hash.digest('hex') !== f.sha256) throw new Error(`the downloaded ${f.path} did not match the pinned file`);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(partial, dir);
  } catch (err) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// The model as the install step wants it: kept if every byte checks out,
// downloaded (again) otherwise.
export async function ensureModel(options = {}) {
  if ((await checkModel()) === null) return 'ready';
  await downloadModel(options);
  return 'downloaded';
}

// Whether free-voice/node_modules already holds exactly what its lockfile
// pins, so a reinstall can leave it alone: Windows will not let npm replace
// files that a running panel or MCP server has loaded.
export function packagesReady() {
  try {
    const lock = JSON.parse(readFileSync(path.join(FREE_VOICE_DIR, 'package-lock.json'), 'utf8'));
    for (const [key, entry] of Object.entries(lock.packages || {})) {
      if (!key.startsWith('node_modules/')) continue;
      const manifest = path.join(FREE_VOICE_DIR, ...key.split('/'), 'package.json');
      // npm leaves out optional packages that only another platform's build
      // pulls in; one that is here still has to be the pinned version.
      if (entry.optional && !existsSync(manifest)) continue;
      if (JSON.parse(readFileSync(manifest, 'utf8')).version !== entry.version) return false;
    }
    return true;
  } catch {
    return false;
  }
}

class TooLong extends Error {
  constructor() {
    super('a passage too long for the free voice to say in one pass');
  }
}

// kokoro-js tokenizes inside generate() with truncation on. Count first: a
// passage over the limit is refused here, and split by the caller.
function guardLength(tts) {
  tts.tokenizer = new Proxy(tts.tokenizer, {
    apply(target, thisArg, [text, options]) {
      const full = Reflect.apply(target, thisArg, [text, { ...options, truncation: false }]);
      if (full.input_ids.dims.at(-1) > MAX_TOKENS) throw new TooLong();
      return full;
    },
  });
  return tts;
}

// Loads the model from free-voice/models. Never downloads: only the install
// step does, so a reply that finds it missing says so instead of stalling on
// 300 MB.
async function load() {
  if (!existsSync(KOKORO_ENTRY) || !existsSync(TRANSFORMERS_ENTRY)) throw new Error(NOT_INSTALLED);
  // A cheap look before half a gigabyte is read: every file there, at its size.
  const problem = await checkModel({ hash: false });
  if (problem) throw new Error(problem === 'missing' ? MODEL_MISSING : MODEL_DAMAGED);
  let hf;
  let KokoroTTS;
  try {
    // kokoro-js imports this same file, so the settings below apply to it too.
    hf = await import(pathToFileURL(TRANSFORMERS_ENTRY).href);
    ({ KokoroTTS } = await import(pathToFileURL(KOKORO_ENTRY).href));
  } catch {
    throw new Error(PACKAGES_BROKEN);
  }
  hf.env.cacheDir = MODEL_DIR;
  hf.env.allowRemoteModels = false;
  let model = null;
  try {
    // The 3 KB tokenizer first: if anything is wrong with it, the model's
    // memory is never taken, and nothing is left holding it.
    const tokenizer = await hf.AutoTokenizer.from_pretrained(MODEL_ID);
    // What KokoroTTS.from_pretrained does, plus a thread cap it does not offer.
    model = await hf.StyleTextToSpeech2Model.from_pretrained(MODEL_ID, {
      dtype: 'fp32',
      device: 'cpu',
      session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 },
    });
    return guardLength(new KokoroTTS(model, tokenizer));
  } catch {
    try {
      await model?.dispose?.();
    } catch {
      // nothing more to give back
    }
    throw new Error(MODEL_UNREADABLE);
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

// Says text in one pass if it fits, else in halves, split again as needed.
async function sayAll(tts, text, options, depth = 0) {
  try {
    return [await tts.generate(text, options)];
  } catch (err) {
    if (!(err instanceof TooLong) || depth >= 8) throw err;
    const [first, second] = splitInHalf(text);
    if (!first || !second) throw err;
    return [...(await sayAll(tts, first, options, depth + 1)), ...(await sayAll(tts, second, options, depth + 1))];
  }
}

async function generate(tts, text, cfg) {
  const options = { voice: voiceFor(cfg.voiceId), speed: clamp(cfg.speed, 0.5, 2, defaults.speed) };
  const started = performance.now();
  const parts = await sayAll(tts, text, options);
  const ms = performance.now() - started;
  const rate = parts[0].sampling_rate;
  const samples = new Float32Array(parts.reduce((n, p) => n + p.audio.length, 0));
  let at = 0;
  for (const p of parts) {
    samples.set(p.audio, at);
    at += p.audio.length;
  }
  return { samples, rate, audioMs: (samples.length / rate) * 1000, ms };
}

export async function synthesize(text, cfg) {
  const tts = await acquire();
  try {
    const { samples, rate, audioMs, ms } = await generate(tts, text, cfg || {});
    noteSpeed(audioMs, ms);
    return toWav(samples, rate);
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
  const installed = existsSync(KOKORO_ENTRY) && existsSync(TRANSFORMERS_ENTRY) && existsSync(MODEL_ONNX);
  return { installed, loaded: loading !== null, xRealtime };
}

// The install step, after npm: make sure the model is there and whole, then
// time a real sentence (the second one, once the first has warmed the runtime
// up) and write the speed down.
export async function prepare({ onProgress } = {}) {
  const model = await ensureModel({ onProgress });
  const tts = await load();
  try {
    const line = 'Done. I fixed the refresh logic, added a regression test, and everything passes. Your music stays down until I finish.';
    await generate(tts, line, defaults);
    const { audioMs, ms } = await generate(tts, line, defaults);
    speedNoted = false;
    return { xRealtime: noteSpeed(audioMs, ms), threads: THREADS, model };
  } finally {
    await tts.model?.dispose?.();
  }
}
