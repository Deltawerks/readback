#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, PORT, REMOTE_ORIGINS, setApiKey, hasApiKey, keyHint } from './config.js';
import { readState, writeState, updateProviderConfig } from './state.js';
import { listVoices, stripForSpeech, truncateForSpeech } from './tts.js';
import { stopPlayback } from './audio.js';
import { flushQueue } from './queue.js';
import { speak } from './speak.js';
import { providerMeta, PROVIDER_IDS } from './providers/index.js';
import { log } from './log.js';

const INDEX = path.join(ROOT, 'panel', 'index.html');
// Bundled so the panel renders with no outbound requests.
const LOGO = path.join(ROOT, 'panel', 'logo.png');
const FONT_DIR = path.join(ROOT, 'panel', 'fonts');

// Config fields the panel may write into the active provider's block.
const CONFIG_FIELDS = ['voiceId', 'modelId', 'speed', 'temperature', 'stability', 'similarity', 'style', 'speakerBoost'];

function sanitizeConfig(cfg) {
  const out = {};
  for (const k of CONFIG_FIELDS) if (cfg[k] !== undefined) out[k] = cfg[k];
  return out;
}

function keyStatus() {
  return {
    inworld: { hasKey: hasApiKey('inworld'), hint: keyHint('inworld') },
    elevenlabs: { hasKey: hasApiKey('elevenlabs'), hint: keyHint('elevenlabs') },
  };
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

function isSameOriginLocal(req) {
  if (!LOOPBACK_HOSTS.has(req.headers.host)) return false;

  // Opening the panel from a bookmark or a link on another site is a *cross-site
  // navigation*, and that's legitimate: the user lands on the panel's own origin,
  // and the referring page can't read a navigation's response. Restricted to safe
  // methods, so a cross-site form POST is still treated as CSRF.
  const method = (req.method || 'GET').toUpperCase();
  if (req.headers['sec-fetch-mode'] === 'navigate' && (method === 'GET' || method === 'HEAD')) {
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

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
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
    if (!isSameOriginLocal(req) && !remoteOk) {
      return send(res, 403, { error: 'forbidden' });
    }

    if (pathname === '/health') return send(res, 200, { ok: true });

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
      if (body.enabled !== undefined) top.enabled = body.enabled;
      // A remote origin may ONLY flip voice on/off. Switching provider or
      // editing voice/model/tuning changes what gets spent and how it sounds,
      // and a dashboard button has no business reaching that far.
      if (!remoteOk && body.provider !== undefined && PROVIDER_IDS.includes(body.provider)) {
        top.provider = body.provider;
      }
      let st = Object.keys(top).length ? writeState(top) : readState();
      // Silence only AFTER the state records voice as off. Killing audio first
      // frees the queue while enabled still reads true, so the next queued reply
      // grabs the line and keeps talking, making the toggle look broken.
      if (body.enabled === false) { flushQueue(); stopPlayback(); }
      if (!remoteOk && body.config && typeof body.config === 'object') {
        st = updateProviderConfig(st.provider, sanitizeConfig(body.config));
      }
      return send(res, 200, stateResponse(st, remoteOk));
    }

    if (pathname === '/api/key' && req.method === 'POST') {
      const { provider = 'inworld', apiKey } = await readBody(req);
      if (!PROVIDER_IDS.includes(provider)) return send(res, 400, { ok: false, error: 'unknown provider' });
      setApiKey(provider, apiKey || '');
      return send(res, 200, {
        ok: true,
        provider,
        hasKey: hasApiKey(provider),
        keyHint: keyHint(provider),
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
      const clean = truncateForSpeech(stripForSpeech(text || ''), st.maxChars);
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
    log('panel error', err && err.message);
    return send(res, 500, { error: err && err.message });
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
    // Distinguish "another panel is really serving" from "port still in TIME_WAIT
    // from a stop a moment ago". If nothing answers /health, retry a few times so
    // a quick stop→start doesn't silently leave the panel down.
    let alive = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      alive = (await fetch(`${localUrl}health`, { signal: ctrl.signal })).ok;
      clearTimeout(t);
    } catch {
      alive = false;
    }
    if (alive) {
      openBrowser(localUrl);
      process.exit(0);
    }
    if (bindRetries++ < 5) {
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 1000);
      return;
    }
    log(`panel: port ${PORT} busy and unresponsive; set READBACK_PORT or free it`);
    process.exit(1);
  }
  log('panel listen error', err.message);
  process.exit(1);
});

const noOpen = process.env.READBACK_NO_OPEN || process.argv.includes('--no-open');

server.listen(PORT, '127.0.0.1', () => {
  log(`panel listening on ${localUrl}`);
  if (!noOpen) openBrowser(localUrl);
});
