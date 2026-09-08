import * as inworld from './inworld.js';
import * as elevenlabs from './elevenlabs.js';

export const PROVIDERS = { inworld, elevenlabs };
export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function getProvider(name) {
  return PROVIDERS[name] || inworld;
}

// Serializable metadata for the panel (labels, models, tuning knobs). No functions.
export function providerMeta() {
  return Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, p]) => [
      id,
      { label: p.label, models: p.models, knobs: p.knobs, defaults: p.defaults },
    ])
  );
}

// Voice and model ids are identifiers, not prose: anything long or unprintable
// in them came from something other than the panel's dropdowns.
const MAX_ID_CHARS = 200;

function cleanId(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, MAX_ID_CHARS);
}

// Coerce a saved config patch to what the provider will actually accept.
//
// The panel's sliders produce numbers in range, but the route behind them takes
// whatever JSON it is handed: an unclamped stability reaches the API as a 400
// the user never sees, and a NaN speed comes back out of state.json and renders
// as "NaN" on the slider forever. Only keys the patch actually carries are
// touched, so a one-field save stays a one-field save.
export function clampKnobs(providerId, cfg) {
  const provider = getProvider(providerId);
  const out = { ...(cfg || {}) };

  for (const knob of provider.knobs || []) {
    const raw = out[knob.key];
    if (raw === undefined) continue;

    if (knob.type === 'toggle') {
      // A checkbox posts a JSON boolean, but the string "false" would otherwise
      // coerce to true and turn a knob on by writing it off.
      out[knob.key] = raw === 'false' ? false : Boolean(raw);
      continue;
    }

    // Only a number or a numeric string is a number. Number([]) is 0 and
    // Number(null) is 0, which would silently pin a knob to its minimum.
    const numeric =
      typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    out[knob.key] = Number.isFinite(numeric)
      ? Math.min(knob.max, Math.max(knob.min, numeric))
      : provider.defaults[knob.key];
  }

  if (out.voiceId !== undefined) out.voiceId = cleanId(out.voiceId);
  if (out.modelId !== undefined) out.modelId = cleanId(out.modelId);
  return out;
}
