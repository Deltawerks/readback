import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
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

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await r.json();
    return body && body.readback === true ? body : null;
  } catch {
    return null;
  }
}

// The launcher behind the Desktop shortcut probed port 7717 whatever
// READBACK_PORT said, and its WMI launch handed the panel none of the caller's
// environment, so state and cache overrides set in a shell never reached it.
test('the panel launcher uses the configured port and hands on its environment', {
  skip: process.platform !== 'win32', timeout: 90000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-launch-'));
  const port = await freePort();
  const env = {
    ...process.env, READBACK_PORT: String(port), READBACK_STATE_DIR: dir,
    READBACK_CACHE_DIR: path.join(dir, 'cache'), READBACK_DUCKING_HELPER: 'off',
  };
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'scripts', 'launch-panel.ps1'), '-NoOpen'], { env, encoding: 'utf8', timeout: 45000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const panel = await health(port);
    assert.ok(panel, 'nothing answers on the configured port');
    assert.match(r.stdout, new RegExp(`PID ${panel.pid}\\b`), 'the launcher reported the panel it started');
    assert.ok(existsSync(path.join(dir, 'state.json')), 'the panel did not use the state dir it was given');
  } finally {
    // Only ever stop what answers on this test's own port. The panel runs
    // outside any job, so one still starting when the launcher gave up gets
    // time to answer rather than being left running.
    let panel = await health(port);
    for (let waited = 0; !panel && waited < 20000; waited += 500) {
      await sleep(500);
      panel = await health(port);
    }
    if (panel) {
      try { process.kill(panel.pid); } catch {}
      await sleep(500);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
