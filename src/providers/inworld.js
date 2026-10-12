import { fetchBody, bodyText, bodyJson, requestWithRetry } from './_http.js';

const TTS_URL = 'https://api.inworld.ai/tts/v1/voice';
const VOICES_URL = 'https://api.inworld.ai/voices/v1/voices';

export const label = 'Inworld';

export const models = [
  { id: 'inworld-tts-2-flash', label: 'TTS-2 Flash' },
  { id: 'inworld-tts-2', label: 'TTS-2 · Flagship' },
];

// Tuning knobs the panel renders for this provider.
export const knobs = [
  { key: 'speed', label: 'Speed', min: 0.5, max: 1.5, step: 0.1, suffix: 'x' },
  { key: 'deliveryMode', label: 'Delivery', type: 'select', models: ['inworld-tts-2'], options: ['STABLE', 'BALANCED', 'CREATIVE'] },
];

export const defaults = { voiceId: 'Luna', modelId: 'inworld-tts-2-flash', speed: 1.3, deliveryMode: 'BALANCED' };

export function migrateConfig(cfg) {
  const out = { ...cfg };
  if (!out.modelId || /^inworld-tts-1(?:\.5)?(?:-mini|-max)?$/.test(out.modelId)) out.modelId = defaults.modelId;
  if (!['STABLE', 'BALANCED', 'CREATIVE'].includes(out.deliveryMode)) out.deliveryMode = defaults.deliveryMode;
  delete out.temperature;
  return out;
}

// Keep a number inside the range the API accepts, and fall back to the default
// when the panel sends something that is not a number at all.
function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// The key is a pre-base64 string sent as `Authorization: Basic <key>`.
export async function synthesize(text, cfg, apiKey) {
  if (!apiKey) throw new Error('Inworld API key is not set');
  const body = {
    text,
    voiceId: cfg.voiceId || defaults.voiceId,
    // Must agree with the declared default, or a config block that predates the
    // model picker quietly buys the model that costs twice as much.
    modelId: migrateConfig(cfg).modelId,
    audioConfig: {
      audioEncoding: 'LINEAR16', // = WAV with header
      speakingRate: clamp(cfg.speed, 0.5, 1.5, 1.0),
      sampleRateHertz: 48000,
    },
  };
  if (body.modelId === 'inworld-tts-2') body.deliveryMode = migrateConfig(cfg).deliveryMode;

  const res = await requestWithRetry(
    TTS_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${apiKey}` },
      body: JSON.stringify(body),
    },
    { errorFor: (r) => new Error(`Inworld TTS ${r.status}: ${bodyText(r).slice(0, 200)}`) }
  );
  const data = bodyJson(res);
  if (!data || !data.audioContent) throw new Error('Inworld response missing audioContent');
  return Buffer.from(data.audioContent, 'base64'); // LINEAR16 → WAV bytes
}

export async function listVoices(apiKey, { filter = 'lang_code = "en"', pageSize = 200 } = {}) {
  if (!apiKey) throw new Error('Inworld API key is not set');
  const url = new URL(VOICES_URL);
  if (filter) url.searchParams.set('filter', filter);
  url.searchParams.set('orderBy', 'display_name asc');
  url.searchParams.set('pageSize', String(pageSize));

  const res = await fetchBody(url, { headers: { Authorization: `Basic ${apiKey}` } });
  if (!res.ok) throw new Error(`Inworld voices ${res.status}: ${bodyText(res).slice(0, 200)}`);
  const data = bodyJson(res) || {};
  return (data.voices || []).map((v) => ({
    voiceId: v.voiceId,
    displayName: v.displayName || v.voiceId,
    description: v.description || '',
    gender: (v.gender || '').toLowerCase(),
  }));
}
