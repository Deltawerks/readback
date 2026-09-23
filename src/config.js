import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
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

// State + secrets live in a per-user dir, deliberately NOT inside the
// repo: cloning into a cloud-synced or shared folder would otherwise sync your
// API key along with it. Override with READBACK_STATE_DIR (tests use this).
function defaultStateDir() {
  // Not %APPDATA% on Windows. Claude Desktop gives everything it launches (the
  // hook that speaks, the MCP server) its own private copy of AppData, while the
  // panel, started at login, reads the real one. Same path, two different files,
  // so the panel's off switch never reached the voice. The profile folder itself
  // is shared by both, which was checked by writing on each side and reading on
  // the other.
  if (process.platform === 'win32') return path.join(os.homedir(), '.readback');
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.env.HOME ? path.join(process.env.HOME, '.config') : '');
  return base ? path.join(base, 'readback') : path.join(ROOT, '.readback');
}

export const STATE_DIR = process.env.READBACK_STATE_DIR
  ? path.resolve(process.env.READBACK_STATE_DIR)
  : defaultStateDir();
// Older locations, copied over on first run (originals left intact). The old
// Windows AppData spot comes first, so an upgrade keeps the saved key.
export const LEGACY_STATE_DIRS = [
  ...(process.platform === 'win32' && process.env.APPDATA ? [path.join(process.env.APPDATA, 'Readback')] : []),
  path.join(ROOT, '.readback'),
  path.join(ROOT, '.voicebox'),
];

// Throwaway data (the log, the queue, the player list and multi-MB WAV chunks)
// goes in a local (never roamed) dir, so it can't bloat a synced Windows profile.
//
// This MUST resolve identically in every Readback process, because the queue and
// the playback bookkeeping live here and the panel and the hook workers have to
// find each other's files. It used to fall back to STATE_DIR whenever
// READBACK_STATE_DIR was set, which looked like a convenience for tests and was a
// trap in production: the Windows startup script pinned READBACK_STATE_DIR for
// the panel, Claude Code launches the hook workers without it, and the two halves
// silently kept their queue, playback epoch and player list in different folders.
// Settings still agreed, so voice on/off looked fine, while "stop talking" swept
// a directory that was always empty. Override this location on its own with
// READBACK_CACHE_DIR, and set it for every process if you set it at all.
function defaultCacheDir() {
  if (process.env.READBACK_CACHE_DIR) return path.resolve(process.env.READBACK_CACHE_DIR);
  // Same reason as the state dir: the queue and the stop signal only work if the
  // panel and the voice see the same files, and AppData gives each side its own.
  if (process.platform === 'win32') return path.join(os.homedir(), '.readback', 'cache');
  const base =
    process.env.XDG_CACHE_HOME || (process.env.HOME ? path.join(process.env.HOME, '.cache') : '');
  return base ? path.join(base, 'readback') : STATE_DIR;
}

export const CACHE_DIR = defaultCacheDir();
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
// Transient bookkeeping (which player is running, which reply was last spoken)
// lives in its OWN file. It is written constantly by every speaking worker,
// while state.json holds settings you change by hand. Keeping them together
// meant a worker recording its pid could write back a stale copy of `enabled`
// and silently undo a voice-off you had just pressed.
export const RUNTIME_FILE = path.join(CACHE_DIR, 'runtime.json');
export const LOG_FILE = path.join(CACHE_DIR, 'readback.log');
export const SECRET_FILE = path.join(STATE_DIR, 'secret.json');
export const STREAM_SCRIPT = path.join(ROOT, 'scripts', 'play-stream.ps1');

export const PORT = num(process.env.READBACK_PORT, 7717);

// Origins outside this machine that may read voice state and flip voice on/off,
// comma-separated. EMPTY BY DEFAULT: the panel stays strictly loopback unless
// you deliberately name an origin, so a stock install grants nothing. Anything
// listed here can toggle your voice, so only list a site you control.
export const REMOTE_ORIGINS = new Set(
  (process.env.READBACK_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

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
// No-ops for an unknown provider rather than writing a garbage field. The file
// is created owner-only: on Windows it inherits the profile's ACL anyway, but
// on a shared POSIX box the default mode would leave the key world-readable.
export function setApiKey(provider, key) {
  if (!SECRET_FIELD[provider]) return '';
  const clean = String(key || '').trim();
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const secret = readSecret();
  secret[SECRET_FIELD[provider]] = clean;
  writeFileSync(SECRET_FILE, JSON.stringify(secret, null, 2), { mode: 0o600 });
  return clean;
}

// The key saved from the panel, ignoring any environment variable. Lets the
// panel report what a save actually stored rather than what will be used.
export function storedApiKey(provider = 'inworld') {
  return (readSecret()[SECRET_FIELD[normProvider(provider)]] || '').trim();
}

// True when a real environment variable is overriding whatever the panel saved,
// so the panel can say that instead of pretending the saved key is in use.
export function envOverridesKey(provider = 'inworld') {
  const real = REAL_ENV_KEYS[normProvider(provider)];
  return Boolean(real && real.trim());
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
  // Generous on purpose: this is a backstop against a pathological wall of text,
  // not a normal-reply limit. 1800 silently cut the tail off ~15% of replies,
  // and it was always the long summaries (the part worth hearing). Lower it via
  // READBACK_MAX_CHARS if you'd rather cap how long a read can run.
  maxChars: num(process.env.READBACK_MAX_CHARS, 12000),
  lastPid: null,
  lastSpokenId: null,
  lastSpokenBy: null,
  inworld: { ...PROVIDERS.inworld.defaults },
  elevenlabs: { ...PROVIDERS.elevenlabs.defaults },
};
