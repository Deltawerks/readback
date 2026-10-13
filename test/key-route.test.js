import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

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

// The free voice has no key. Saving one "for" it used to answer ok with the
// saved Inworld key's masked hint, since key lookups took any other name for
// Inworld.
test('the panel will not take a key for the free voice', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-key-route-'));
  const port = await freePort();
  const panel = spawn(process.execPath, [path.join(ROOT, 'src', 'panel-server.js'), '--no-open'], {
    stdio: 'ignore',
    env: { ...process.env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: dir, READBACK_PORT: String(port), READBACK_DUCKING_HELPER: 'off' },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const res = await fetch(`${base}/api/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ provider: 'kokoro', apiKey: 'some-key' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /needs no key/);
  } finally {
    panel.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
