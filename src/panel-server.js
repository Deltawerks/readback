#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  ROOT,
  PORT,
  STATE_DIR,
  CACHE_DIR,
  REMOTE_ORIGINS,
  setApiKey,
  hasApiKey,
  keyHint,
  storedApiKey,
  envOverridesKey,
} from './config.js';
import { readState, writeState, updateProviderConfig, StateUnreadableError } from './state.js';
import { listVoices, stripForSpeech, truncateForSpeech } from './tts.js';
import { stopPlayback } from './audio.js';
import { flushQueue } from './queue.js';
import { speak } from './speak.js';
import { providerMeta, PROVIDER_IDS, clampKnobs } from './providers/index.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const INDEX = path.join(ROOT, 'panel', 'index.html');
// Bundled so the panel renders with no outbound requests.
const LOGO = path.join(ROOT, 'panel', 'logo.png');
const FONT_DIR = path.join(ROOT, 'panel', 'fonts');

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || VERSION;
} catch {
  // reported on /health only
}

const noOpen = process.env.READBACK_NO_OPEN || process.argv.includes('--no-open');

// Config fields the panel may write into the active provider's block. This
// only whitelists which fields may be set; the coercion (numbers into each
// knob's range, toggles to booleans, ids to bounded plain strings, junk to the
// provider default) is clampKnobs, shared with the provider layer so there is
// one definition of a valid value. Unchecked values used to reach the file, the
// provider and the page, which then rendered NaN.
const CONFIG_FIELDS = ['voiceId', 'modelId', 'speed', 'temperature', 'stability', 'similarity', 'style', 'speakerBoost'];

function pickConfig(cfg) {
  const out = {};
  for (const k of CONFIG_FIELDS) if (cfg[k] !== undefined) out[k] = cfg[k];
  return out;
}

function maskKey(k) {
  if (!k) return '';
  return k.length <= 4 ? '••••' : `••••${k.slice(-4)}`;
}

function keyStatus() {
  const one = (p) => ({ hasKey: hasApiKey(p), hint: keyHint(p), envOverride: envOverridesKey(p) });
  return { inworld: one('inworld'), elevenlabs: one('elevenlabs') };
}

// State plus panel metadata (provider descriptors + masked key status). Never
// includes raw keys. A remote caller gets no key status at all: even the masked
// last-4 hint is the local panel's business, not a dashboard's.
function stateResponse(st, remote = false) {
  const base = { ...(st || readState()), providers: providerMeta() };
  return remote ? base : { ...base, keys: keyStatus() };
}

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // Nothing here should ever be framed: an overlay could otherwise induce
    // clicks on the panel's own controls, which the origin check would allow.
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  };
  // Set by the handler only for an allowlisted remote origin on an allowed route.
  if (res.corsOrigin) {
    headers['Access-Control-Allow-Origin'] = res.corsOrigin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

// The panel is loopback-only, but a page you visit in the same browser could
// still POST to it (classic CSRF), or point its own hostname at 127.0.0.1
// (DNS rebinding). Requiring a loopback Host and a same-origin-looking request
// closes both without needing a token.
const LOOPBACK_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const SELF_ORIGINS = new Set([...LOOPBACK_HOSTS].map((h) => `http://${h}`));

// The routes that render the page itself. Only these may be reached by a
// cross-site navigation; everything under /api/ has side effects or spends
// provider quota, and an <iframe> pointed at it is a navigation too.
const UI_ROUTES = new Set(['/', '/index.html', '/logo.png']);
const isUiRoute = (pathname) => UI_ROUTES.has(pathname) || pathname.startsWith('/fonts/');

function isSameOriginLocal(req, pathname) {
  if (!LOOPBACK_HOSTS.has(req.headers.host)) return false;

  // Opening the panel from a bookmark or a link on another site is a *cross-site
  // navigation*, and that's legitimate: the user lands on the panel's own origin,
  // and the referring page can't read a navigation's response. Restricted to safe
  // methods and to the page's own routes, so a cross-site form POST is still
  // treated as CSRF and a hidden iframe cannot drive /api/voices.
  const method = (req.method || 'GET').toUpperCase();
  if (
    req.headers['sec-fetch-mode'] === 'navigate' &&
    (method === 'GET' || method === 'HEAD') &&
    isUiRoute(pathname)
  ) {
    return true;
  }

  // Origin alone isn't enough: browsers omit it on no-cors GETs (<img>, <script>,
  // fetch with mode:'no-cors'), which would otherwise let a hostile page hit
  // /api/voices and burn the user's provider quota. Sec-Fetch-Site is sent on
  // those too. Absent entirely means a non-browser client (curl, health probe).
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  return !origin || SELF_ORIGINS.has(origin);
}

// A named remote origin may touch exactly one route, and only to read voice
// state or flip it on/off. /api/key, /api/voices, /api/say and /api/stop stay
// strictly loopback: a remote page must never change the key, burn provider
// quota, or make this machine talk. The loopback Host check still applies, so
// pointing a hostname at 127.0.0.1 gains nothing even for a listed origin.
const REMOTE_ROUTES = new Set(['/api/state']);

function remoteAllowed(req, pathname) {
  const origin = req.headers.origin;
  if (!origin || !REMOTE_ORIGINS.has(origin)) return false;
  if (!REMOTE_ROUTES.has(pathname)) return false;
  return LOOPBACK_HOSTS.has(req.headers.host);
}

// Always resolves to a plain object, so handlers can read fields off it without
// a JSON `null` or array turning into a thrown TypeError.
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const v = data ? JSON.parse(data) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// Serve a bundled asset, or 404 if it's missing. Never let the fs error reach
// the client, whose message carries the absolute install path.
async function sendAsset(res, file, type) {
  let buf;
  try {
    buf = await readFile(file);
  } catch {
    return send(res, 404, { error: 'not found' });
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(buf);
}

// Reads the settings file from a SEPARATE process. Everything this panel checks
// against itself passes when its own reads and writes are wrong together, which
// is exactly the failure that shipped a dead toggle twice: the panel answered
// normally, served values that existed in no file, and discarded every write. A
// child process has its own view of the filesystem, so it is the only witness
// here that cannot be fooled the same way. Asynchronous, so a slow child cannot
// freeze the event loop and with it the Stop button.
async function stateFileOnDisk() {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'read-state-file.js')],
    { encoding: 'utf8', timeout: 10000, windowsHide: true }
  );
  const parsed = JSON.parse(stdout || '{}');
  if (parsed.readbackReadError) throw new Error(parsed.readbackReadError);
  return parsed;
}

// True only if the setting is genuinely on disk, not merely agreed to in memory.
async function persistedOnDisk(field, value) {
  try {
    return (await stateFileOnDisk())[field] === value;
  } catch (err) {
    log(`panel: cannot read the state file back: ${err.message}`);
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${PORT}`);
    } catch {
      // A malformed target ("//[" parses as an invalid IPv6 host) must not be
      // allowed to throw out of this async handler and kill the process.
      return send(res, 400, { error: 'bad request' });
    }
    const { pathname } = url;

    const remoteOk = remoteAllowed(req, pathname);
    if (remoteOk) res.corsOrigin = req.headers.origin;

    // CORS preflight for an allowlisted origin. Answered before the origin gate
    // because a preflight carries no credentials and reveals nothing.
    if (req.method === 'OPTIONS' && remoteOk) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers.origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        // Chrome Private Network Access: public origin reaching loopback.
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      return res.end();
    }

    // Applies to every route, not just /api/: the static routes would otherwise
    // still answer a rebound host, and their errors reveal the install path.
    if (!isSameOriginLocal(req, pathname) && !remoteOk) {
      return send(res, 403, { error: 'forbidden' });
    }

    // Both directories are reported so a split brain is diagnosable in one
    // request: if these don't match what `npm run where` prints from a Claude
    // Code session, the toggle will appear to work while changing nothing the
    // hook workers can see. `readback: true` is what a second panel launch
    // checks for before deciding the port is held by one of ours.
    if (pathname === '/health') {
      return send(res, 200, {
        ok: true,
        readback: true,
        version: VERSION,
        stateDir: STATE_DIR,
        cacheDir: CACHE_DIR,
        pid: process.pid,
      });
    }

    if (pathname === '/' || pathname === '/index.html') {
      const html = await readFile(INDEX, 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    if (pathname === '/logo.png') return sendAsset(res, LOGO, 'image/png');

    if (pathname.startsWith('/fonts/')) {
      // basename + whitelist: the URL can never escape panel/fonts/.
      const name = path.basename(pathname);
      if (!/^[\w-]+\.woff2$/.test(name)) return send(res, 404, { error: 'not found' });
      return sendAsset(res, path.join(FONT_DIR, name), 'font/woff2');
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, stateResponse(null, remoteOk));
    }

    if (pathname === '/api/state' && req.method === 'POST') {
      const body = await readBody(req);
      const top = {};
      // Only a real boolean. A string "false" is truthy to every worker that
      // reads the file, and 0 or null would skip the silencing below, so any
      // other shape is refused outright rather than stored.
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be true or false' });
        top.enabled = body.enabled;
      }
      // A remote origin may ONLY flip voice on/off. Switching provider or
      // editing voice/model/tuning changes what gets spent and how it sounds,
      // and a dashboard button has no business reaching that far.
      if (!remoteOk && body.provider !== undefined) {
        if (!PROVIDER_IDS.includes(body.provider)) return send(res, 400, { error: 'unknown provider' });
        top.provider = body.provider;
      }
      const turningOff = top.enabled === false;
      let st;
      let saveError;
      try {
        st = Object.keys(top).length ? writeState(top) : readState();
      } catch (err) {
        saveError = err;
      } finally {
        // Silence only AFTER the state records voice as off (killing audio
        // first frees the queue while enabled still reads true, so the next
        // queued reply grabs the line), but silence regardless of whether the
        // save succeeded or the check below passes. An unsaved "off" is an
        // error to report; it is never a reason to keep talking.
        if (turningOff) {
          flushQueue();
          stopPlayback();
        }
      }
      if (saveError) {
        if (saveError instanceof StateUnreadableError) {
          log(`panel: ${saveError.message}`);
          return send(res, 503, { error: 'the settings file could not be read right now; try again' });
        }
        // A failed save must read as a failed save on the page, not as an errno
        // the user has to decode, and never as a toggle that looks like it took.
        log(`panel: could not save settings: ${saveError.message}`);
        return send(res, 500, { error: 'could not save the voice setting to disk' });
      }
      // Confirm the change actually reached disk before reporting success.
      // writeState returns what it read back, so a mismatch means this panel
      // cannot persist settings. Saying 200 anyway is how a dead toggle ends up
      // looking like a working one while every reply keeps talking.
      if (top.enabled !== undefined && (st.enabled !== top.enabled || !(await persistedOnDisk('enabled', top.enabled)))) {
        log('panel: voice setting did not reach disk; refusing to report success');
        return send(res, 500, { error: 'could not save the voice setting to disk' });
      }
      if (!remoteOk && body.config && typeof body.config === 'object') {
        st = updateProviderConfig(st.provider, clampKnobs(st.provider, pickConfig(body.config)));
      }
      return send(res, 200, stateResponse(st, remoteOk));
    }

    if (pathname === '/api/key' && req.method === 'POST') {
      const body = await readBody(req);
      const provider = body.provider === undefined ? 'inworld' : body.provider;
      if (!PROVIDER_IDS.includes(provider)) return send(res, 400, { ok: false, error: 'unknown provider' });
      // A missing or non-string key used to wipe the saved one and answer ok.
      // An explicit empty string clears the key; anything else must be a key.
      if (typeof body.apiKey !== 'string') return send(res, 400, { ok: false, error: 'apiKey must be a string' });
      const clean = body.apiKey.trim();
      if (clean && (clean.length > 512 || /[\s\u0000-\u001f\u007f]/.test(clean))) {
        return send(res, 400, { ok: false, error: 'that does not look like an API key' });
      }
      setApiKey(provider, clean);
      // Report what was actually stored, and say when an environment variable
      // is going to be used instead of it, rather than showing the env key's
      // hint as if it were the one just saved.
      const stored = storedApiKey(provider);
      return send(res, 200, {
        ok: true,
        provider,
        hasKey: stored.length > 0,
        keyHint: maskKey(stored),
        envOverride: envOverridesKey(provider),
      });
    }

    if (pathname === '/api/voices' && req.method === 'GET') {
      const filter = url.searchParams.get('filter');
      const voices = await listVoices(readState(), filter ? { filter } : undefined);
      return send(res, 200, { voices });
    }

    if (pathname === '/api/say' && req.method === 'POST') {
      const { text } = await readBody(req);
      const st = readState();
      const clean = truncateForSpeech(stripForSpeech(typeof text === 'string' ? text : ''), st.maxChars);
      if (!clean) return send(res, 200, { ok: false, reason: 'nothing speakable' });
      // wait:false awaits the first chunk (so errors surface here), then
      // streams the rest in the background.
      await speak(clean, st, { wait: false });
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/stop' && req.method === 'POST') {
      // Clear the queue first, then kill audio. The reverse order lets a queued
      // reply claim the freed line before the flush lands.
      flushQueue();
      stopPlayback();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof StateUnreadableError) {
      log(`panel: ${err.message}`);
      return send(res, 503, { error: 'the settings file could not be read right now; try again' });
    }
    // The message stays in the log. An fs error's text carries the user's
    // profile path, which has no business in a response.
    log('panel error', err && err.message);
    return send(res, 500, { error: 'internal error' });
  }
});

// Malformed HTTP that never reaches the handler must not take the panel down.
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function openBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    }).unref();
  } catch {
    // ignore; user can open the URL manually
  }
}

const localUrl = `http://localhost:${PORT}/`;

let bindRetries = 0;
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    // Distinguish "another Readback panel is really serving" from "port still
    // in TIME_WAIT from a stop a moment ago" and from "some other program owns
    // the port". Only an answer that identifies itself as Readback counts; a
    // foreign 200 used to make this exit quietly and open a browser at the
    // wrong app.
    let alive = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const r = await fetch(`${localUrl}health`, { signal: ctrl.signal });
      clearTimeout(t);
      const body = r.ok ? await r.json().catch(() => null) : null;
      alive = Boolean(body && body.readback === true);
    } catch {
      alive = false;
    }
    if (alive) {
      log(`panel: already running at ${localUrl}`);
      if (!noOpen) openBrowser(localUrl);
      process.exit(0);
    }
    if (bindRetries++ < 5) {
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 1000);
      return;
    }
    const msg = `panel: port ${PORT} is held by something that does not answer as Readback; set READBACK_PORT or free it`;
    log(msg);
    console.error(msg);
    process.exit(1);
  }
  log('panel listen error', err.message);
  console.error(`panel: ${err.message}`);
  process.exit(1);
});

// Prove we can actually round-trip the state file before serving. A panel that
// answers requests but cannot reach its state file is the worst possible
// failure: the toggle appears to work, the status line says "voice on", and
// nothing ever speaks, with no error anywhere. Refusing to start turns that into
// an honest "panel not running", which the page already reports as NOT
// CONNECTED. Seen in the wild on a panel launched at login. Runs after the port
// is ours, so a launch that is about to exit on EADDRINUSE does not first write
// to the live settings file three times.
async function verifyStatePersistence() {
  const probe = `readback-probe-${process.pid}-${Date.now()}`;
  try {
    // Must probe a SETTINGS field. This previously probed lastSpokenBy, which is
    // a RUNTIME field kept in a different file, so it verified the wrong file
    // and happily started a panel that could not persist the voice toggle.
    writeState({ probe });
    if (readState().probe !== probe) throw new Error('settings write did not read back');
    // ...and confirm it from outside. Every check above passes in a panel whose
    // own view of the file is stale or fabricated, which is how a panel that
    // could not save anything started cleanly and served a dead toggle.
    if ((await stateFileOnDisk()).probe !== probe) {
      throw new Error('the write never reached disk; this process is reading a stale copy');
    }
    writeState({ probe: undefined });
    return true;
  } catch (err) {
    log(`panel: FATAL, cannot persist settings in ${STATE_DIR}: ${err.message}`);
    console.error(`panel: cannot persist settings in ${STATE_DIR}: ${err.message}`);
    return false;
  }
}

server.listen(PORT, '127.0.0.1', async () => {
  if (!(await verifyStatePersistence())) {
    server.close();
    process.exit(1);
  }
  log(`panel listening on ${localUrl}`);
  if (!noOpen) openBrowser(localUrl);
});
