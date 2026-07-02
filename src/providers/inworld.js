import { fetchWithTimeout, sleep } from './_http.js';

const TTS_URL = 'https://api.inworld.ai/tts/v1/voice';
const VOICES_URL = 'https://api.inworld.ai/voices/v1/voices';

export const label = 'Inworld';

export const models = [
  { id: 'inworld-tts-1.5-max', label: 'inworld-tts-1.5-max (rich)' },
  { id: 'inworld-tts-1.5-mini', label: 'inworld-tts-1.5-mini (fast)' },
  { id: 'inworld-tts-2', label: 'inworld-tts-2 (flagship)' },
];

// Tuning knobs the panel renders for this provider.
export const knobs = [
  { key: 'speed', label: 'Speed', min: 0.5, max: 1.5, step: 0.1, suffix: 'x' },
  { key: 'temperature', label: 'Expression', min: 0, max: 2, step: 0.1, hint: 'Voice temperature — higher is more expressive' },
];

export const defaults = { voiceId: 'Luna', modelId: 'inworld-tts-1.5-max', speed: 1.3, temperature: 0.1 };

// The key is a pre-base64 string sent as `Authorization: Basic <key>`.
export async function synthesize(text, cfg, apiKey) {
  if (!apiKey) throw new Error('Inworld API key is not set');
  const rate = Number(cfg.speed);
  const body = {
    text,
    voiceId: cfg.voiceId || 'Luna',
    modelId: cfg.modelId || 'inworld-tts-1.5-max',
    audioConfig: {
      audioEncoding: 'LINEAR16', // = WAV with header
      speakingRate: Number.isFinite(rate) ? Math.min(1.5, Math.max(0.5, rate)) : 1.0,
      sampleRateHertz: 48000,
    },
    temperature: cfg.temperature ?? 0.1,
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetchWithTimeout(
        TTS_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${apiKey}` },
          body: JSON.stringify(body),
        },
        20000
      );
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`Inworld TTS ${resp.status}: ${detail.slice(0, 200)}`);
      }
      const data = await resp.json();
      if (!data.audioContent) throw new Error('Inworld response missing audioContent');
      return Buffer.from(data.audioContent, 'base64'); // LINEAR16 → WAV bytes
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(500);
    }
  }
  throw lastErr;
}

export async function listVoices(apiKey, { filter = 'lang_code = "en"', pageSize = 200 } = {}) {
  if (!apiKey) throw new Error('Inworld API key is not set');
  const url = new URL(VOICES_URL);
  if (filter) url.searchParams.set('filter', filter);
  url.searchParams.set('orderBy', 'display_name asc');
  url.searchParams.set('pageSize', String(pageSize));

  const resp = await fetchWithTimeout(url, { headers: { Authorization: `Basic ${apiKey}` } });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Inworld voices ${resp.status}: ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.voices || []).map((v) => ({
    voiceId: v.voiceId,
    displayName: v.displayName || v.voiceId,
    description: v.description || '',
    gender: (v.gender || '').toLowerCase(),
  }));
}
