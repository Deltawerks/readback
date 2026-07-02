import {
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { STATE_DIR, LEGACY_STATE_DIR, STATE_FILE, DEFAULTS } from './config.js';
import { PROVIDER_IDS } from './providers/index.js';

export function ensureStateDir() {
  if (existsSync(STATE_DIR)) return;
  mkdirSync(STATE_DIR, { recursive: true });
  // One-time migration: copy a saved key + settings from the old .voicebox dir
  // (leaving it intact). Skipped when a custom state dir is set (tests).
  if (!process.env.READBACK_STATE_DIR && existsSync(LEGACY_STATE_DIR)) {
    for (const f of ['state.json', 'secret.json']) {
      try {
        const src = path.join(LEGACY_STATE_DIR, f);
        if (existsSync(src)) copyFileSync(src, path.join(STATE_DIR, f));
      } catch {
        // best effort — the panel can re-enter the key
      }
    }
  }
}

function writeAtomic(obj) {
  ensureStateDir();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, STATE_FILE);
}

// Merge stored state over defaults (including per-provider blocks) and migrate a
// legacy flat state (voiceId/speed/expression at top level) into the inworld block.
function normalize(parsed) {
  const s = { ...DEFAULTS, ...parsed };
  s.inworld = { ...DEFAULTS.inworld, ...(parsed.inworld || {}) };
  s.elevenlabs = { ...DEFAULTS.elevenlabs, ...(parsed.elevenlabs || {}) };

  if (!parsed.inworld && (parsed.voiceId || parsed.speed != null || parsed.expression != null)) {
    s.inworld = {
      ...DEFAULTS.inworld,
      voiceId: parsed.voiceId || DEFAULTS.inworld.voiceId,
      modelId: parsed.modelId || DEFAULTS.inworld.modelId,
      speed: parsed.speed ?? DEFAULTS.inworld.speed,
      temperature: parsed.expression ?? DEFAULTS.inworld.temperature,
    };
  }

  if (!PROVIDER_IDS.includes(s.provider)) s.provider = 'inworld';

  // Drop stale flat fields from the pre-provider schema.
  delete s.voiceId;
  delete s.modelId;
  delete s.speed;
  delete s.expression;
  delete s.encoding;
  delete s.sampleRateHertz;
  return s;
}

export function readState() {
  ensureStateDir();
  if (existsSync(STATE_FILE)) {
    try {
      return normalize(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
    } catch {
      // fall through and reset a corrupt file
    }
  }
  const initial = normalize({});
  try {
    writeAtomic({ ...initial, updatedAt: new Date().toISOString() });
  } catch {
    // best effort — reads still work from the returned object
  }
  return initial;
}

export function writeState(patch) {
  const current = readState();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeAtomic(next);
  return next;
}

// The active provider's config block.
export function activeConfig(state) {
  return state[state.provider] || state.inworld;
}

// Merge a patch into one provider's nested config block.
export function updateProviderConfig(provider, patch) {
  const current = readState();
  const block = { ...(current[provider] || {}), ...patch };
  return writeState({ [provider]: block });
}
