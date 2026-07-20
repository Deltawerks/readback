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
