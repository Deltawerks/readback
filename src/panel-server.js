#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, PORT, setApiKey, hasApiKey, keyHint } from './config.js';
import { readState, writeState, updateProviderConfig } from './state.js';
import { listVoices, stripForSpeech, truncateForSpeech } from './tts.js';
import { stopPlayback } from './audio.js';
import { speak } from './speak.js';
import { providerMeta, PROVIDER_IDS } from './providers/index.js';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(ROOT, 'panel', 'index.html');

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
// includes raw keys.
function stateResponse(st) {
  return { ...(st || readState()), providers: providerMeta(), keys: keyStatus() };
}

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    if (pathname === '/health') return send(res, 200, { ok: true });

    if (pathname === '/' || pathname === '/index.html') {
      const html = await readFile(INDEX, 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, stateResponse());
    }

    if (pathname === '/api/state' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.enabled === false) stopPlayback();
      const top = {};
      if (body.enabled !== undefined) top.enabled = body.enabled;
      if (body.provider !== undefined && PROVIDER_IDS.includes(body.provider)) top.provider = body.provider;
      let st = Object.keys(top).length ? writeState(top) : readState();
      if (body.config && typeof body.config === 'object') {
        st = updateProviderConfig(st.provider, sanitizeConfig(body.config));
      }
      return send(res, 200, stateResponse(st));
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
      // wait:false — awaits the first chunk (so errors surface here), then
      // streams the rest in the background.
      await speak(clean, st, { wait: false });
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/stop' && req.method === 'POST') {
      stopPlayback();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    log('panel error', err && err.message);
    return send(res, 500, { error: err && err.message });
  }
});

function openBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    }).unref();
  } catch {
    // ignore — user can open the URL manually
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
    log(`panel: port ${PORT} busy and unresponsive — set READBACK_PORT or free it`);
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
