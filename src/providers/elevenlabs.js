import { fetchBody, bodyText, bodyJson, requestWithRetry, pcmToWav } from './_http.js';

// Pull ElevenLabs' human-readable message out of its JSON error body, so the
// panel shows "missing permission voices_read" instead of a bare "HTTP 500".
function elError(kind, status, detail) {
  try {
    const j = JSON.parse(detail);
    const m = (j && j.detail && j.detail.message) || (j && j.message);
    if (m) return `ElevenLabs ${kind} ${status}: ${m}`;
  } catch {
    // not JSON
  }
  return detail ? `ElevenLabs ${kind} ${status}: ${detail.slice(0, 140)}` : `ElevenLabs ${kind} ${status}`;
}

const TTS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const VOICES_URL = 'https://api.elevenlabs.io/v1/voices'; // the voices on the account
const OUTPUT_FORMAT = 'pcm_24000'; // raw PCM → wrapped to WAV for the headless player

// Keep a number inside the range the API accepts, and fall back to the default
// when the panel sends something that is not a number at all.
function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const label = 'ElevenLabs';

export const models = [
  { id: 'eleven_v4', label: 'eleven_v4 (highest quality)' },
  { id: 'eleven_v4_turbo', label: 'eleven_v4_turbo (expressive, fast)' },
  { id: 'eleven_v3', label: 'eleven_v3 (expressive)' },
  { id: 'eleven_multilingual_v2', label: 'eleven_multilingual_v2 (quality)' },
  { id: 'eleven_flash_v2_5', label: 'eleven_flash_v2.5 (fastest)' },
];

// eleven_turbo_v2_5 is deprecated and no longer offered, but a saved config can
// still name it, so its knobs stay.
const FULL_CONTROL = ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'];

export const knobs = [
  { key: 'speed', label: 'Speed', min: 0.7, max: 1.2, step: 0.05, suffix: 'x', models: FULL_CONTROL },
  { key: 'stability', label: 'Stability', min: 0, max: 1, step: 0.05 },
  { key: 'similarity', label: 'Similarity', min: 0, max: 1, step: 0.05, models: [...FULL_CONTROL, 'eleven_v4', 'eleven_v4_turbo'] },
  { key: 'style', label: 'Style', min: 0, max: 1, step: 0.05, hint: 'Higher = more expressive / exaggerated', models: [...FULL_CONTROL, 'eleven_v3'] },
  { key: 'speakerBoost', label: 'Speaker boost', type: 'toggle', models: FULL_CONTROL },
];

export const defaults = {
  // A real premade voice, not an empty string. The dropdown shows its first
  // entry either way, so an empty default looked like a chosen voice while every
  // reply threw "No ElevenLabs voice selected" inside a detached worker: a first
  // run that is simply silent, with the error nowhere the user can see it.
  // Xb7hH8MSUJpSbSDYk0k2 is Alice, available on every account.
  voiceId: 'Xb7hH8MSUJpSbSDYk0k2',
  // ElevenLabs recommends Flash over Turbo in all use cases, at the same price.
  modelId: 'eleven_flash_v2_5',
  speed: 1.0,
  stability: 0.5,
  similarity: 0.75,
  style: 0.0,
  speakerBoost: true,
};

export async function synthesize(text, cfg, apiKey) {
  if (!apiKey) throw new Error('ElevenLabs API key is not set');
  if (!cfg.voiceId) throw new Error('No ElevenLabs voice selected');
  const url = `${TTS_BASE}/${encodeURIComponent(cfg.voiceId)}?output_format=${OUTPUT_FORMAT}`;
  const modelId = cfg.modelId || defaults.modelId;

  const isV3 = String(modelId).startsWith('eleven_v3');
  const isV4 = String(modelId).startsWith('eleven_v4');
  const voiceSettings = { stability: clamp(cfg.stability, 0, 1, defaults.stability) };
  // ElevenLabs documents v4 as taking stability and similarity only, and v3 as
  // lacking speed, similarity and speaker boost. Sending the rest is noise the
  // model cannot act on.
  if (!isV4) voiceSettings.style = clamp(cfg.style, 0, 1, defaults.style);
  if (!isV3) voiceSettings.similarity_boost = clamp(cfg.similarity, 0, 1, defaults.similarity);
  if (!isV3 && !isV4) {
    voiceSettings.use_speaker_boost = Boolean(cfg.speakerBoost ?? defaults.speakerBoost);
    // ElevenLabs accepts roughly 0.7 to 1.2; clamp so an out-of-range value can't 400.
    voiceSettings.speed = clamp(cfg.speed, 0.7, 1.2, defaults.speed);
  }

  const res = await requestWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings }),
    },
    { errorFor: (r) => new Error(elError('TTS', r.status, bodyText(r))) }
  );
  return pcmToWav(res.body, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
}

export async function listVoices(apiKey) {
  if (!apiKey) throw new Error('ElevenLabs API key is not set');
  const res = await fetchBody(VOICES_URL, { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new Error(elError('voices', res.status, bodyText(res)));
  const data = bodyJson(res) || {};
  return (data.voices || []).map((v) => {
    const labelBits = v.labels ? Object.values(v.labels).filter(Boolean) : [];
    return {
      voiceId: v.voice_id,
      displayName: v.name || v.voice_id,
      description: labelBits.length ? labelBits.join(', ') : v.category || '',
      gender: (v.labels && v.labels.gender) || '',
    };
  });
}
