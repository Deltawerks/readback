import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Isolate BEFORE importing anything from src/ (paths resolve at import time).
const DIR = mkdtempSync(path.join(tmpdir(), 'readback-state-'));
process.env.READBACK_STATE_DIR = DIR;
process.env.READBACK_CACHE_DIR = DIR;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(DIR, 'state.json');
const { readState, writeState, StateUnreadableError } = await import('../src/state.js');

const runChild = (script, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });

// Two processes saving settings at the same time. Windows refuses to rename over
// a file the other process has open, and before the retry this failed on ~45%
// of writes under contention (947 of ~2100 in one measured run), which is how
// "voice off" could error out with the audio still playing.
test('two processes saving settings at once never lose a write', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-contend-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ provider: 'inworld', enabled: true }));
  const mod = pathToFileURL(path.join(ROOT, 'src', 'state.js')).href;
  const script = `
    const { writeState } = await import(${JSON.stringify(mod)});
    let ok = 0, failed = 0;
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      try { writeState({ enabled: Math.random() < 0.5 }); ok++; }
      catch (e) { failed++; }
    }
    console.log(JSON.stringify({ ok, failed }));
  `;
  const env = { READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: dir };
  const [a, b] = await Promise.all([runChild(script, env), runChild(script, env)]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const ra = JSON.parse(a.out);
  const rb = JSON.parse(b.out);
  assert.ok(ra.ok > 50 && rb.ok > 50, `too few writes to prove contention: ${a.out} ${b.out}`);
  assert.equal(ra.failed + rb.failed, 0, `saves were lost: ${a.out} ${b.out}`);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
    'a failed rename must not leave temp files behind'
  );
});

test('only the boolean true means voice is on', () => {
  for (const bad of ['false', 'true', 'off', 1, 0, null, [], {}]) {
    writeFileSync(STATE_FILE, JSON.stringify({ provider: 'inworld', enabled: bad }));
    assert.equal(readState().enabled, false, `stored ${JSON.stringify(bad)} must read as off`);
  }
  writeFileSync(STATE_FILE, JSON.stringify({ provider: 'inworld', enabled: true }));
  assert.equal(readState().enabled, true);
  // A caller passing a non-boolean gets it coerced to false, never stored as-is.
  writeState({ enabled: 'true' });
  assert.equal(JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled, false);
  writeState({ enabled: true });
  assert.equal(JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled, true);
});

// An antivirus scan or a backup holding the file for a moment used to look
// exactly like a corrupt file: every setting was reset to defaults and written
// back over it, silently.
test('an unreadable settings file is an error, not a reset to defaults', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-unreadable-'));
  const file = path.join(dir, 'state.json');
  mkdirSync(file); // a directory where the file must be: reads fail, and not with ENOENT
  const mod = pathToFileURL(path.join(ROOT, 'src', 'state.js')).href;
  return runChild(
    `
    const { readState, StateUnreadableError } = await import(${JSON.stringify(mod)});
    try { readState(); console.log('returned'); }
    catch (e) { console.log(e instanceof StateUnreadableError ? 'unreadable' : 'other:' + e.message); }
  `,
    { READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: dir }
  ).then((r) => {
    assert.equal(r.out, 'unreadable', r.err);
    assert.ok(statSync(file).isDirectory(), 'the unreadable file must not be replaced');
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('corrupt')), [], 'nothing was corrupt');
  });
});

test('a corrupt settings file is kept aside, then replaced with defaults', () => {
  writeFileSync(STATE_FILE, '{"provider":"inworld","enabled":true,'); // truncated mid-write
  const st = readState();
  assert.equal(st.enabled, false);
  assert.equal(st.provider, 'inworld');
  const kept = readdirSync(DIR).filter((f) => f.startsWith('state.json.corrupt-'));
  assert.equal(kept.length, 1, 'the bad file must be kept as evidence');
  assert.equal(readFileSync(path.join(DIR, kept[0]), 'utf8'), '{"provider":"inworld","enabled":true,');
  assert.doesNotThrow(() => JSON.parse(readFileSync(STATE_FILE, 'utf8')), 'the live file must parse again');
});

test('a key set to undefined is removed from the file', () => {
  writeFileSync(STATE_FILE, JSON.stringify({ provider: 'inworld', enabled: false }));
  writeState({ probe: 'x' });
  assert.equal(JSON.parse(readFileSync(STATE_FILE, 'utf8')).probe, 'x');
  writeState({ probe: undefined });
  assert.equal('probe' in JSON.parse(readFileSync(STATE_FILE, 'utf8')), false);
});

test('runtime bookkeeping never touches the settings file', () => {
  writeFileSync(STATE_FILE, JSON.stringify({ provider: 'inworld', enabled: true }));
  const before = statSync(STATE_FILE).mtimeMs;
  writeState({ lastPid: 4242, lastSpokenId: 'abc' });
  assert.equal(statSync(STATE_FILE).mtimeMs, before);
  assert.equal(readState().lastPid, 4242);
  assert.equal(readState().enabled, true);
  assert.ok(existsSync(path.join(DIR, 'runtime.json')));
});

test('StateUnreadableError is exported for callers that must tell unknown from off', () => {
  assert.equal(typeof StateUnreadableError, 'function');
  assert.ok(new StateUnreadableError('x') instanceof Error);
});

// The lock is the whole fix, so test the lock itself rather than racing for the
// symptom it prevents. Detecting the clobber by sampling was luck: the window is
// about 1.5ms wide and Windows timers only fire every 15.6ms, so a sampler
// missed it on a third of the runs even with the lock removed. Mutual exclusion
// is deterministic. If two writers are ever inside at once, the lock is broken,
// and a broken lock is what let a config write put `enabled` back to true a
// moment after the toggle turned it off.
//
// Each worker records its own critical sections in memory and writes them once,
// to its own file. Appending to one shared log from several processes is its own
// source of failure on Windows and would have been measuring the harness again.
test('the settings lock actually serializes writers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-lock-'));
  const mod = JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'state.js')).href);
  const env = { READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: dir };
  const outFile = (id) => path.join(dir, 'sections-' + id + '.json');

  const spawnWorker = (id) =>
    runChild(`
      const { withSettingsLock } = await import(${mod});
      const { writeFileSync } = await import('node:fs');
      const sections = [];
      for (let i = 0; i < 4; i++) {
        withSettingsLock(() => {
          const start = Date.now();
          const until = start + 40;
          while (Date.now() < until) {}
          sections.push([start, Date.now()]);
        });
        await new Promise((r) => setTimeout(r, 1));
      }
      writeFileSync(${JSON.stringify(outFile(id))}, JSON.stringify(sections));
    `, env);

  const ids = ['a', 'b', 'c'];
  const results = await Promise.all(ids.map(spawnWorker));
  results.forEach((r, i) => assert.equal(r.code, 0, `lock worker ${ids[i]} crashed: ${r.err}`));

  const held = [];
  for (const id of ids) {
    const spans = JSON.parse(readFileSync(outFile(id), 'utf8'));
    assert.equal(spans.length, 4, `worker ${id} completed ${spans.length} of 4 sections`);
    for (const [start, end] of spans) held.push({ id, start, end });
  }
  held.sort((x, y) => x.start - y.start);

  const overlaps = [];
  for (let i = 1; i < held.length; i++) {
    if (held[i].start < held[i - 1].end) overlaps.push(`${held[i - 1].id} and ${held[i].id}`);
  }
  assert.equal(overlaps.length, 0, `writers were inside the lock at the same time: ${overlaps.join(', ')}`);
});

test('a settings write preserves the keys it does not carry', () => {
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      provider: 'inworld',
      enabled: false,
      maxChars: 9000,
      inworld: { voiceId: 'Vinny', modelId: 'inworld-tts-1.5-mini', speed: 1.3, temperature: 1.3 },
    })
  );
  // Changing a voice must not touch voice on/off, and must not drop everything
  // else either: merging a patch onto an empty object once wiped the whole file.
  writeState({ inworld: { voiceId: 'Ashley', modelId: 'inworld-tts-1.5-mini', speed: 1.1, temperature: 1 } });
  const onDisk = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  assert.equal(onDisk.enabled, false, 'a config write must never change voice on/off');
  assert.equal(onDisk.provider, 'inworld');
  assert.equal(onDisk.maxChars, 9000);
  assert.equal(onDisk.inworld.voiceId, 'Ashley');
});
