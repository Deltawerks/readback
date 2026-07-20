import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root = parent of src/
export const ROOT = path.resolve(__dirname, '..');

// Capture genuine environment API keys BEFORE loading .env, so a real env var
// wins, but a panel-saved key beats a stale .env entry.
const REAL_ENV_KEYS = {
  inworld: process.env.INWORLD_API_KEY,
  elevenlabs: process.env.ELEVENLABS_API_KEY,
};

// Minimal .env loader (no dependency). Does not override real environment vars.
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

function num(value, def) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

// State + secrets live in a per-user app-data dir, deliberately NOT inside the
// repo: cloning into a cloud-synced or shared folder would otherwise sync your
// API key along with it. Override with READBACK_STATE_DIR (tests use this).
function defaultStateDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Readback');
  }
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.env.HOME ? path.join(process.env.HOME, '.config') : '');
  return base ? path.join(base, 'readback') : path.join(ROOT, '.readback');
}

export const STATE_DIR = process.env.READBACK_STATE_DIR
  ? path.resolve(process.env.READBACK_STATE_DIR)
  : defaultStateDir();
// Older in-repo locations, copied over on first run (originals left intact).
export const LEGACY_STATE_DIRS = [
  path.join(ROOT, '.readback'),
  path.join(ROOT, '.voicebox'),
];

// Throwaway data (the log and multi-MB WAV chunks) goes in a local (never
// roamed) dir, so it can't bloat a synced Windows profile. Follows STATE_DIR
// when that's been overridden, to keep everything together for tests.
function defaultCacheDir() {
  if (process.env.READBACK_STATE_DIR) return STATE_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Readback');
  }
  return STATE_DIR;
}

export const CACHE_DIR = defaultCacheDir();
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const LOG_FILE = path.join(CACHE_DIR, 'readback.log');
export const SECRET_FILE = path.join(STATE_DIR, 'secret.json');
export const STREAM_SCRIPT = path.join(ROOT, 'scripts', 'play-stream.ps1');

export const PORT = num(process.env.READBACK_PORT, 7717);

// --- API keys (per provider) ---
const ENV_KEY_NAME = { inworld: 'INWORLD_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' };
const SECRET_FIELD = { inworld: 'inworldApiKey', elevenlabs: 'elevenlabsApiKey' };

// Unknown provider strings fall back to inworld (mirrors getProvider) so key
// reads stay consistent with which provider actually synthesizes.
function normProvider(provider) {
  return SECRET_FIELD[provider] ? provider : 'inworld';
}

function readSecret() {
  try {
    return JSON.parse(readFileSync(SECRET_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Resolution order for a provider's key: real env var > panel-saved key > .env.
export function getApiKey(provider = 'inworld') {
  provider = normProvider(provider);
  const real = REAL_ENV_KEYS[provider];
  if (real && real.trim()) return real.trim();
  const fromFile = (readSecret()[SECRET_FIELD[provider]] || '').trim();
  if (fromFile) return fromFile;
  return (process.env[ENV_KEY_NAME[provider]] || '').trim();
}

// Persist a provider's key from the panel (merges, doesn't clobber the other).
// No-ops for an unknown provider rather than writing a garbage field.
export function setApiKey(provider, key) {
  if (!SECRET_FIELD[provider]) return '';
  const clean = String(key || '').trim();
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const secret = readSecret();
  secret[SECRET_FIELD[provider]] = clean;
  writeFileSync(SECRET_FILE, JSON.stringify(secret, null, 2));
  return clean;
}

export function hasApiKey(provider = 'inworld') {
  return getApiKey(provider).length > 0;
}

// Masked display hint (last 4 chars). Never sends the full secret to the browser.
export function keyHint(provider = 'inworld') {
  const k = getApiKey(provider);
  if (!k) return '';
  return k.length <= 4 ? '••••' : `••••${k.slice(-4)}`;
}

// --- State defaults (per-provider nested) ---
export const DEFAULTS = {
  provider: process.env.READBACK_PROVIDER || 'inworld',
  enabled: false,
  maxChars: num(process.env.READBACK_MAX_CHARS, 1800),
  lastPid: null,
  lastSpokenId: null,
  lastSpokenBy: null,
  inworld: { ...PROVIDERS.inworld.defaults },
  elevenlabs: { ...PROVIDERS.elevenlabs.defaults },
};
