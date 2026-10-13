import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    return r.ok && (await r.json()).readback === true;
  } catch {
    return false;
  }
}

// A missing key, a bad key or no credit left all came back as "internal error",
// hiding the provider's own message, which the provider code builds to be read.
test("the panel shows the provider's own error, not \"internal error\"", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-errors-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ enabled: true, provider: 'inworld' }));
  const port = await freePort();
  const env = { ...process.env };
  delete env.INWORLD_API_KEY;
  delete env.ELEVENLABS_API_KEY;
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'panel-server.js'), '--no-open'], {
    env: { ...env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: path.join(dir, 'cache'), READBACK_PORT: String(port), READBACK_DUCKING_HELPER: 'off' },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const deadline = Date.now() + 15000;
    while (!(await healthy(port)) && Date.now() < deadline) await sleep(150);
    const base = `http://127.0.0.1:${port}`;
    const voices = await fetch(`${base}/api/voices?agent=claude`);
    assert.equal(voices.status, 502);
    assert.match((await voices.json()).error, /key is not set/);
    const say = await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ text: 'Hello there.', agent: 'claude' }),
    });
    assert.equal(say.status, 502);
    assert.match((await say.json()).error, /key is not set/);
  } finally {
    child.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Opening the browser is a convenience. When the opener cannot be started (no
// cmd on PATH, or any system other than Windows) the failure arrives as an
// error event, and with nothing listening for it the panel crashed a moment
// after it had started serving.
test('the panel keeps running when it cannot open a browser', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-open-'));
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'panel-server.js')], {
    env: {
      ...env, PATH: '', READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: path.join(dir, 'cache'),
      READBACK_PORT: String(port), READBACK_DUCKING_HELPER: 'off',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const deadline = Date.now() + 15000;
    while (!(await healthy(port)) && Date.now() < deadline && child.exitCode === null) await sleep(150);
    await sleep(1500);
    assert.equal(child.exitCode, null, 'the panel exited after failing to open a browser');
    assert.ok(await healthy(port), 'the panel is still serving');
  } finally {
    child.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A player that cannot start (a script policy blocking PowerShell) still got
// "Speaking..." from the panel, while nothing was heard.
test("the panel's Speak says so when the audio player could not start", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-player-dead-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ enabled: true, provider: 'inworld' }));
  const fixture = path.join(dir, 'fixture.cjs');
  writeFileSync(fixture, `
    const cp = require('node:child_process');
    const { syncBuiltinESMExports } = require('node:module');
    const realSpawn = cp.spawn;
    cp.spawn = function (command, args, options) {
      if (command === 'powershell' && args.includes('-Dir')) return realSpawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore', windowsHide: true });
      return realSpawn(command, args, options);
    };
    cp.execFileSync = () => Buffer.alloc(0);
    syncBuiltinESMExports();
    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 600));
      const b = Buffer.alloc(44 + 3200); b.write('RIFF', 0); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
      b.writeUInt32LE(32000, 28); b.write('data', 36); b.writeUInt32LE(3200, 40);
      return new Response(JSON.stringify({ audioContent: b.toString('base64') }));
    };
  `);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'panel-server.js'), '--no-open'], {
    env: {
      ...process.env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: path.join(dir, 'cache'), READBACK_PORT: String(port),
      READBACK_DUCKING_HELPER: 'off', INWORLD_API_KEY: 'isolated-fixture-key', NODE_OPTIONS: `--require ${JSON.stringify(fixture)}`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const deadline = Date.now() + 15000;
    while (!(await healthy(port)) && Date.now() < deadline) await sleep(150);
    const base = `http://127.0.0.1:${port}`;
    const r = await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ text: 'Hello there.', agent: 'claude' }),
    });
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.reason, /player/i);
  } finally {
    child.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
});
