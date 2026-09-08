import {
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { STATE_DIR, LEGACY_STATE_DIRS, STATE_FILE, RUNTIME_FILE, SECRET_FILE, DEFAULTS } from './config.js';
import { PROVIDER_IDS } from './providers/index.js';
import { log } from './log.js';

// Fields that describe what is happening RIGHT NOW rather than what you chose.
// Every speaking worker rewrites these; nobody edits them deliberately. They are
// stored apart from settings so that churn can never clobber `enabled`.
const RUNTIME_KEYS = ['lastPid', 'lastSpokenId', 'lastSpokenBy'];
const isRuntimeKey = (k) => RUNTIME_KEYS.includes(k);

// "Could not read the settings file right now" is a different thing from "the
// file is missing" or "the file is garbage", and callers must not reset the
// user's settings over it. Thrown by readState; the panel answers 503 with it.
export class StateUnreadableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StateUnreadableError';
    this.cause = cause;
  }
}

// Errors Windows hands back when another process has the file open. Every
// Readback process reads these files constantly, so these are routine.
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);

// Synchronous pause for the retry loops below. These run inside sync call
// chains in short-lived workers, so a promise is not an option here.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
          if (f === 'state.json') disarmMigrated(path.join(STATE_DIR, f));
        }
      } catch {
        // best effort; the panel can re-enter the key
      }
    }
    if (migrated) return; // newest legacy dir wins; don't let older ones clobber it
  }
}

// A migrated settings file must never switch voice on by itself. The legacy
// copy can hold enabled:true from months ago, and someone reaching this path is
// starting fresh, not asking to be talked to.
function disarmMigrated(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      s.enabled = false;
      writeFileSync(file, JSON.stringify(s, null, 2));
    }
  } catch {
    // leave the copy alone; normalize() still coerces what it can
  }
}

// Windows refuses to rename over a file another process has open for reading,
// and with the panel, the MCP server and the hook workers all reading these
// files, that refusal (EPERM) landed on almost half of all writes under
// contention in testing. Unretried, it meant "voice off" could error out with
// the audio still playing. So: retry with a short backoff, and always remove
// the temp file on failure so a lost write leaves no litter.
function writeAtomic(obj, file = STATE_FILE) {
  ensureStateDir();
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  let delay = 2;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      if (!TRANSIENT_CODES.has(err.code) || attempt >= 40) {
        try {
          unlinkSync(tmp);
        } catch {
          // nothing left to clean up
        }
        throw err;
      }
      pause(delay);
      delay = Math.min(delay * 2, 50);
    }
  }
}

function readRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Keep a copy of a settings file we could not parse, so a reset never destroys
// the only evidence of what went wrong or what the user had.
function quarantine(raw, why) {
  const aside = `${STATE_FILE}.corrupt-${Date.now()}`;
  try {
    writeFileSync(aside, raw);
  } catch {
    // best effort
  }
  log(`state: settings file could not be parsed (${why}); kept a copy as ${path.basename(aside)} and reset to defaults`);
}

// Reads and parses the settings file, telling apart the three things that can
// go wrong. Missing (returns null): first run, caller writes defaults. Garbage
// (returns undefined): the file is moved aside and defaults take over, and that
// is logged. Unreadable (throws): a lock or permission problem is not
// corruption. All three used to be handled the same way, so an antivirus scan
// holding the file for a moment silently reset every setting to defaults.
function readSettingsFile() {
  let raw;
  let delay = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = readFileSync(STATE_FILE, 'utf8');
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (TRANSIENT_CODES.has(err.code) && attempt < 8) {
        pause(delay);
        delay = Math.min(delay * 2, 80);
        continue;
      }
      throw new StateUnreadableError(`cannot read ${STATE_FILE}: ${err.message}`, err);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    quarantine(raw, err.message);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    quarantine(raw, 'not a JSON object');
    return undefined;
  }
  return parsed;
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

  // Only the boolean true means voice is on. A string "false", a 1, or a null
  // that reached the file through some other client must never be read as on
  // by the workers while a panel shows off.
  s.enabled = s.enabled === true;

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
// Throws StateUnreadableError when the settings file exists but cannot be read
// right now; callers that cannot wait must treat that as "unknown", never as off
// and never as on.
export function readState() {
  ensureStateDir();
  const parsed = readSettingsFile();
  let settings;
  if (parsed === null || parsed === undefined) {
    settings = normalize({});
    try {
      writeAtomic({ ...settings, updatedAt: new Date().toISOString() });
    } catch {
      // best effort; reads still work from the returned object
    }
  } else {
    settings = normalize(parsed);
  }
  const runtime = readRuntime();
  for (const k of RUNTIME_KEYS) settings[k] = runtime[k] ?? null;
  return settings;
}

// Writes only the file a patch actually touches. A worker recording `lastPid`
// rewrites runtime.json and never opens state.json, so it cannot carry a stale
// `enabled` back over a voice-off you pressed a moment earlier. A key set to
// undefined is removed from the file.
export function writeState(patch) {
  const runtimePatch = {};
  const settingsPatch = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (isRuntimeKey(k)) runtimePatch[k] = v;
    else settingsPatch[k] = v;
  }
  if ('enabled' in settingsPatch) settingsPatch.enabled = settingsPatch.enabled === true;

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
    for (const [k, v] of Object.entries(settingsPatch)) if (v === undefined) delete next[k];
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
