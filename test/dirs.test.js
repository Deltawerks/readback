import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Resolve Readback's paths in a child process with a controlled environment.
// Each Readback process (panel, MCP server, every hook worker) does this
// independently, so the only thing that matters is that they all agree.
function dirsWith(env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'where.js')], {
    encoding: 'utf8',
    env: { ...process.env, READBACK_STATE_DIR: '', READBACK_CACHE_DIR: '', ...env },
  });
  assert.equal(r.status, 0, `where.js failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// The regression this file exists for. The Windows autostart script pinned
// READBACK_STATE_DIR for the panel; Claude Code launches the hook workers
// without it. CACHE_DIR used to fall back to STATE_DIR whenever that override
// was present, so the two halves kept their queue, playback epoch and player
// list in different folders. Settings still agreed, so voice on/off looked
// fine, while "stop talking" swept a directory that was always empty.
test('pinning the state dir does not move the cache dir', () => {
  const pinned = path.join(tmpdir(), 'readback-pinned-state');
  const worker = dirsWith({});
  const panel = dirsWith({ READBACK_STATE_DIR: pinned });

  // Sanity: the pin must actually have taken effect, or this proves nothing.
  assert.notEqual(panel.STATE_DIR, worker.STATE_DIR, 'READBACK_STATE_DIR had no effect');

  assert.equal(
    panel.CACHE_DIR,
    worker.CACHE_DIR,
    'a launcher that pins only the state dir must still share the queue and player list'
  );
  assert.equal(panel.RUNTIME_FILE, worker.RUNTIME_FILE);
  assert.equal(panel.LOG_FILE, worker.LOG_FILE);
});

test('the cache dir has its own override', () => {
  const cache = path.join(tmpdir(), 'readback-pinned-cache');
  const d = dirsWith({ READBACK_CACHE_DIR: cache });
  assert.equal(d.CACHE_DIR, path.resolve(cache));
  assert.equal(d.RUNTIME_FILE, path.join(path.resolve(cache), 'runtime.json'));
  // Settings must not follow the cache override either; the two are independent.
  assert.notEqual(d.STATE_DIR, d.CACHE_DIR);
});

test('settings and cache stay separate by default', () => {
  const d = dirsWith({});
  assert.equal(d.STATE_FILE, path.join(d.STATE_DIR, 'state.json'));
  assert.equal(d.SECRET_FILE, path.join(d.STATE_DIR, 'secret.json'));
  assert.equal(d.RUNTIME_FILE, path.join(d.CACHE_DIR, 'runtime.json'));
});

// Must wait for listen to complete: address() is null until then, and closing a
// server that has not finished binding leaves the socket open and hangs the run.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A panel that cannot save the voice toggle must refuse to serve. Making
// state.json a directory makes every settings write fail while leaving the
// cache dir perfectly writable, which is the shape of the failure that shipped
// twice: runtime bookkeeping worked, so self-checks passed, and the toggle was
// dead.
test('the panel refuses to start when it cannot save settings', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-unwritable-'));
  const cache = mkdtempSync(path.join(tmpdir(), 'readback-unwritable-cache-'));
  mkdirSync(path.join(dir, 'state.json')); // a directory where the file must go
  assert.ok(existsSync(path.join(dir, 'state.json')));

  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'panel-server.js'), '--no-open'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      READBACK_STATE_DIR: dir,
      READBACK_CACHE_DIR: cache,
      READBACK_PORT: String(await freePort()),
    },
  });

  assert.notEqual(r.status, 0, 'a panel that cannot persist settings must exit, not serve');
});

// The witness itself. The panel trusts this script's answer over its own, so it
// has to report what is genuinely on disk rather than anything cached.
test('the disk reader reports the file as it actually is', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-witness-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ enabled: true, marker: 'on-disk' }));

  const read = () =>
    JSON.parse(
      spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'read-state-file.js')], {
        encoding: 'utf8',
        env: { ...process.env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: dir },
      }).stdout
    );

  assert.equal(read().marker, 'on-disk');
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ enabled: false, marker: 'changed' }));
  assert.equal(read().marker, 'changed', 'the reader must not serve a cached answer');
  assert.equal(read().enabled, false);
});

// The promise the panel makes to the page: a toggle that was not saved must come
// back as an error. A 200 here is how a dead toggle looks like a working one
// while every finished task keeps talking.
test('a toggle that cannot be saved returns an error, not success', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-toggle-'));
  const cache = mkdtempSync(path.join(tmpdir(), 'readback-toggle-cache-'));
  const port = await freePort();

  const panel = spawn(process.execPath, [path.join(ROOT, 'src', 'panel-server.js'), '--no-open'], {
    stdio: 'ignore',
    env: { ...process.env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: cache, READBACK_PORT: String(port) },
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' };
    const toggle = (enabled) =>
      fetch(`${base}/api/state`, { method: 'POST', headers, body: JSON.stringify({ enabled }) });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Healthy panel: saving works and is reported as working.
    assert.equal((await toggle(true)).status, 200);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).enabled, true);

    // Now make settings unsaveable underneath the running panel, the way a
    // profile going away mid-session would.
    rmSync(path.join(dir, 'state.json'));
    mkdirSync(path.join(dir, 'state.json'));

    const res = await toggle(false);
    assert.equal(res.status, 500, 'an unsaved toggle must not report success');
    assert.match((await res.json()).error, /could not save/i);
  } finally {
    panel.kill();
  }
});
