import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Reads settings in a fresh process, the way every hook worker does, with the
// given environment and (optionally) a settings file already on disk.
function readWith(env, saved) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-env-'));
  try {
    if (saved) writeFileSync(path.join(dir, 'state.json'), JSON.stringify(saved));
    const code = `
      const { readState } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'state.js')).href)});
      const { PORT } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'config.js')).href)});
      process.stdout.write(JSON.stringify({ maxChars: readState().maxChars, port: PORT }));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...process.env, READBACK_MAX_CHARS: '', READBACK_PORT: '', ...env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: path.join(dir, 'cache') },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The README offers READBACK_MAX_CHARS as the way to cap how long (and how
// expensive) a read can get, and nothing in the panel sets it. It used to seed
// state.json on first run and then be ignored forever after.
test('READBACK_MAX_CHARS caps replies even after settings exist', () => {
  assert.equal(readWith({ READBACK_MAX_CHARS: '3000' }, { enabled: false, maxChars: 12000 }).maxChars, 3000);
  assert.equal(readWith({}, { enabled: false, maxChars: 12000 }).maxChars, 12000);
});

// Number('') is 0. A blank READBACK_MAX_CHARS turned every reply into "the
// rest is on screen", and a blank READBACK_PORT bound a random port that every
// request was then refused on.
test('blank or nonsense values are ignored, not read as zero', () => {
  for (const value of ['', '  ', '0', '-5', 'lots']) {
    const got = readWith({ READBACK_MAX_CHARS: value, READBACK_PORT: value });
    assert.deepEqual(got, { maxChars: 12000, port: 7717 }, `value ${JSON.stringify(value)}`);
  }
});

test('the override is never written back, so removing it brings back the saved cap', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-env-'));
  try {
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ enabled: false, maxChars: 12000 }));
    const code = `
      const { writeState } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'state.js')).href)});
      process.stdout.write(String(writeState({ enabled: true }).maxChars));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...process.env, READBACK_MAX_CHARS: '3000', READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: path.join(dir, 'cache') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '3000', 'the running process sees the override');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).maxChars, 12000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a zero cap saved by that bug is repaired on read', () => {
  assert.equal(readWith({}, { enabled: false, maxChars: 0 }).maxChars, 12000);
});
