import {
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { STATE_DIR, LEGACY_STATE_DIRS, STATE_FILE, RUNTIME_FILE, SECRET_FILE, DEFAULTS } from './config.js';
import { PROVIDER_IDS } from './providers/index.js';

// Fields that describe what is happening RIGHT NOW rather than what you chose.
// Every speaking worker rewrites these; nobody edits them deliberately. They are
// stored apart from settings so that churn can never clobber `enabled`.
const RUNTIME_KEYS = ['lastPid', 'lastSpokenId', 'lastSpokenBy'];
const isRuntimeKey = (k) => RUNTIME_KEYS.includes(k);

export function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  // Gate the migration on the payload files, NOT on the directory: log() and
  // setApiKey() also mkdir STATE_DIR, and both entry points log before they
  // ever read state. Keying off the directory meant a stray readback.log
  // created on first launch permanently suppressed the copy, silently losing
  // an upgrading user's saved key.
  if (existsSync(STATE_FILE) || existsSync(SECRET_FILE)) return;
  // One-time migration: copy a saved key + settings from an older in-repo dir
  // (originals left intact). Skipped when a custom state dir is set (tests).
  if (process.env.READBACK_STATE_DIR) return;
  for (const dir of LEGACY_STATE_DIRS) {
    if (!existsSync(dir)) continue;
    let migrated = false;
    for (const f of ['state.json', 'secret.json']) {
      try {
        const src = path.join(dir, f);
        if (existsSync(src)) {
          copyFileSync(src, path.join(STATE_DIR, f));
          migrated = true;
        }
      } catch {
        // best effort; the panel can re-enter the key
      }
    }
    if (migrated) return; // newest legacy dir wins; don't let older ones clobber it
  }
}

function writeAtomic(obj, file = STATE_FILE) {
  ensureStateDir();
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

function readRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'));
  } catch {
    return {};
  }
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

// Settings plus the current runtime view, merged, so callers see one object.
export function readState() {
  ensureStateDir();
  let settings = null;
  if (existsSync(STATE_FILE)) {
    try {
      settings = normalize(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
    } catch {
      // fall through and reset a corrupt file
    }
  }
  if (!settings) {
    settings = normalize({});
    try {
      writeAtomic({ ...settings, updatedAt: new Date().toISOString() });
    } catch {
      // best effort; reads still work from the returned object
    }
  }
  const runtime = readRuntime();
  for (const k of RUNTIME_KEYS) settings[k] = runtime[k] ?? null;
  return settings;
}

// Writes only the file a patch actually touches. A worker recording `lastPid`
// rewrites runtime.json and never opens state.json, so it cannot carry a stale
// `enabled` back over a voice-off you pressed a moment earlier.
export function writeState(patch) {
  const runtimePatch = {};
  const settingsPatch = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (isRuntimeKey(k)) runtimePatch[k] = v;
    else settingsPatch[k] = v;
  }

  if (Object.keys(runtimePatch).length) {
    try {
      writeAtomic({ ...readRuntime(), ...runtimePatch }, RUNTIME_FILE);
    } catch {
      // transient bookkeeping; losing a write here is not worth throwing over
    }
  }

  if (Object.keys(settingsPatch).length) {
    const current = readState();
    const next = { ...current, ...settingsPatch, updatedAt: new Date().toISOString() };
    for (const k of RUNTIME_KEYS) delete next[k];
    writeAtomic(next);
  }

  return readState();
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
