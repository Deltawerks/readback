import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A throwaway install: a copy of src/ with its own .env and saved keys, so these
// tests never read or touch the developer's real .env or secret.json.
function withInstall({ dotenv, saved }, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-keys-'));
  try {
    cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, '.env'), dotenv);
    const state = path.join(dir, 'state');
    mkdirSync(state);
    writeFileSync(path.join(state, 'secret.json'), JSON.stringify(saved));
    // The parent loads the config and then starts a child the way both Stop
    // hooks start their workers, handing down its environment. Each reports
    // the Inworld key it would use.
    writeFileSync(path.join(dir, 'probe.mjs'), `
      import { spawnSync } from 'node:child_process';
      import { getApiKey } from './src/config.js';
      if (process.argv[2] === 'child') process.stdout.write(getApiKey('inworld'));
      else process.stdout.write(JSON.stringify({
        parent: getApiKey('inworld'),
        child: spawnSync(process.execPath, [process.argv[1], 'child'], { encoding: 'utf8' }).stdout,
      }));
    `);
    return fn((realEnvKey) => {
      const env = { ...process.env, READBACK_STATE_DIR: state, READBACK_CACHE_DIR: path.join(dir, 'cache') };
      delete env.INWORLD_API_KEY;
      if (realEnvKey) env.INWORLD_API_KEY = realEnvKey;
      const r = spawnSync(process.execPath, [path.join(dir, 'probe.mjs')], { encoding: 'utf8', env });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The documented order is environment variable, then the key saved in the
// panel, then .env. Loading .env used to copy its keys into process.env, so
// every worker a hook started inherited them and took them for real
// environment variables: a key replaced in the panel kept being sent from the
// old .env entry by automatic speech, while the panel's own preview used the
// new one.
test('a key saved in the panel beats an old .env key in the workers the hooks start', () => {
  withInstall({ dotenv: 'INWORLD_API_KEY=old-dotenv-key\n', saved: { inworldApiKey: 'panel-key' } }, (run) => {
    assert.deepEqual(run(), { parent: 'panel-key', child: 'panel-key' });
  });
});

test('a .env key is still used, in parent and child, when nothing else is set', () => {
  withInstall({ dotenv: 'INWORLD_API_KEY="dotenv-key"\n', saved: {} }, (run) => {
    assert.deepEqual(run(), { parent: 'dotenv-key', child: 'dotenv-key' });
  });
});

test('a real environment variable still wins everywhere', () => {
  withInstall({ dotenv: 'INWORLD_API_KEY=dotenv-key\n', saved: { inworldApiKey: 'panel-key' } }, (run) => {
    assert.deepEqual(run('env-key'), { parent: 'env-key', child: 'env-key' });
  });
});
