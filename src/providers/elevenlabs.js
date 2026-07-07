import { fetchWithTimeout, sleep, pcmToWav } from './_http.js';

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
const VOICES_URL = 'https://api.elevenlabs.io/v1/voices'; // account voices (matches AgentLink)
const OUTPUT_FORMAT = 'pcm_24000'; // raw PCM → wrapped to WAV for the headless player

export const label = 'ElevenLabs';

export const models = [
  { id: 'eleven_turbo_v2_5', label: 'eleven_turbo_v2.5 (fast)' },
  { id: 'eleven_v3', label: 'eleven_v3 (expressive)' },
  { id: 'eleven_multilingual_v2', label: 'eleven_multilingual_v2 (quality)' },
  { id: 'eleven_flash_v2_5', label: 'eleven_flash_v2.5 (fastest)' },
];

export const knobs = [
  { key: 'speed', label: 'Speed', min: 0.7, max: 1.2, step: 0.05, suffix: 'x' },
  { key: 'stability', label: 'Stability', min: 0, max: 1, step: 0.05 },
  { key: 'similarity', label: 'Similarity', min: 0, max: 1, step: 0.05 },
  { key: 'style', label: 'Style', min: 0, max: 1, step: 0.05, hint: 'Higher = more expressive / exaggerated' },
  { key: 'speakerBoost', label: 'Speaker boost', type: 'toggle' },
];

export const defaults = {
  voiceId: '',
  modelId: 'eleven_turbo_v2_5',
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
  const spd = Number(cfg.speed);
  const body = {
    text,
    model_id: cfg.modelId || 'eleven_turbo_v2_5',
    voice_settings: {
      stability: cfg.stability ?? 0.5,
      similarity_boost: cfg.similarity ?? 0.75,
      style: cfg.style ?? 0.0,
      use_speaker_boost: cfg.speakerBoost ?? true,
      // ElevenLabs accepts ~0.7–1.2; clamp so an out-of-range value can't 400.
      speed: Number.isFinite(spd) ? Math.min(1.2, Math.max(0.7, spd)) : 1.0,
    },
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        20000
      );
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(elError('TTS', resp.status, detail));
      }
      const pcm = Buffer.from(await resp.arrayBuffer());
      return pcmToWav(pcm, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(500);
    }
  }
  throw lastErr;
}

export async function listVoices(apiKey) {
  if (!apiKey) throw new Error('ElevenLabs API key is not set');
  const resp = await fetchWithTimeout(VOICES_URL, { headers: { 'xi-api-key': apiKey } });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(elError('voices', resp.status, detail));
  }
  const data = await resp.json();
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
