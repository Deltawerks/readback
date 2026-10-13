import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A sandboxed panel that can never start the real audio helper.
async function startPanel(extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-duck-routes-'));
  const port = await freePort();
  const panel = spawn(process.execPath, [path.join(ROOT, 'src', 'panel-server.js'), '--no-open'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      READBACK_STATE_DIR: dir,
      READBACK_CACHE_DIR: dir,
      READBACK_PORT: String(port),
      READBACK_DUCKING_HELPER: 'off',
      ...extraEnv,
    },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const headers = { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' };
  const post = (route, body, h = headers) => fetch(`${base}${route}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const disk = () => JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
  return { base, post, disk, stop: () => panel.kill() };
}

test('the state carries ducking settings and live status, off by default', async () => {
  const p = await startPanel();
  try {
    const st = await (await fetch(`${p.base}/api/state`)).json();
    assert.equal(st.ducking.enabled, false);
    assert.deepEqual(st.ducking.micApps, ['claude', 'ChatGPT']);
    assert.equal(st.duckingStatus.helper, 'disabled');
  } finally {
    p.stop();
  }
});

test('a ducking save is cleaned, stored, and never touches the voice switch', async () => {
  const p = await startPanel();
  try {
    assert.equal((await p.post('/api/state', { enabled: true })).status, 200);
    const res = await p.post('/api/ducking', { enabled: true, depth: 0.2, micApps: ['claude.exe', 'ChatGPT', 'claude'] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ducking.enabled, true);
    assert.deepEqual(body.ducking.micApps, ['claude', 'ChatGPT']);
    assert.equal(p.disk().ducking.depth, 0.2);
    assert.equal(p.disk().enabled, true, 'voice is untouched');
  } finally {
    p.stop();
  }
});

test('wrong types are refused and nothing is written', async () => {
  const p = await startPanel();
  try {
    await p.post('/api/ducking', { enabled: true });
    for (const bad of [{ enabled: 'yes' }, { depth: '0.2' }, { micApps: 'claude' }, { neverDuck: [1] }, { onMic: null }]) {
      const r = await p.post('/api/ducking', bad);
      assert.equal(r.status, 400, `${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(p.disk().ducking.enabled, true);
    assert.equal(p.disk().ducking.depth, 0.1);
  } finally {
    p.stop();
  }
});

test('the ducking routes are local only, even for an origin allowed to read state', async () => {
  const origin = 'https://dash.example';
  const p = await startPanel({ READBACK_ALLOWED_ORIGINS: origin });
  try {
    const r = await p.post('/api/ducking', { enabled: true }, { 'Content-Type': 'application/json', Origin: origin });
    assert.equal(r.status, 403);
    const restore = await p.post('/api/ducking/restore', {}, { 'Content-Type': 'application/json', Origin: origin });
    assert.equal(restore.status, 403);
  } finally {
    p.stop();
  }
});

test('the restore route answers with how many apps it put back', async () => {
  const p = await startPanel();
  try {
    const r = await p.post('/api/ducking/restore', {});
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { restored: 0 });
  } finally {
    p.stop();
  }
});
