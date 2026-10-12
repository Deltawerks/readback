import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Isolate BEFORE importing anything from src/ (paths resolve at import time).
const DIR = mkdtempSync(path.join(tmpdir(), 'readback-ducking-state-'));
process.env.READBACK_STATE_DIR = DIR;
process.env.READBACK_CACHE_DIR = DIR;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readState, writeState, writeAgentState, writeDuckingState, normalizeDucking, cleanAppList } =
  await import('../src/state.js');
const { STATE_FILE, DUCKING_DEFAULTS } = await import('../src/config.js');

test('a fresh install has ducking off with the documented defaults', () => {
  const st = readState();
  assert.deepEqual(st.ducking, DUCKING_DEFAULTS);
  assert.equal(st.ducking.enabled, false);
  assert.deepEqual(st.ducking.micApps, ['claude', 'ChatGPT']);
});

test('only a real true switches ducking on, and levels are clamped', () => {
  const d = normalizeDucking({ enabled: 'true', onMic: 0, depth: 3, voiceDepth: -1 });
  assert.equal(d.enabled, false);
  assert.equal(d.onMic, false);
  assert.equal(d.onSpeech, true, 'a missing switch takes its default');
  assert.equal(d.depth, 0.5);
  assert.equal(d.voiceDepth, 0);
  assert.equal(normalizeDucking({ depth: 'loud' }).depth, DUCKING_DEFAULTS.depth);
});

test('app lists are cleaned: .exe stripped, junk dropped, duplicates folded, capped at 20', () => {
  assert.deepEqual(cleanAppList([' Spotify.exe ', 'spotify', 'MusicBee', 42, '../evil', ''], []), ['Spotify', 'MusicBee']);
  assert.equal(cleanAppList(Array.from({ length: 30 }, (_, i) => `app${i}`), []).length, 20);
  assert.deepEqual(cleanAppList('claude', ['x']), ['x'], 'not a list: fall back');
});

test('a ducking save never resurrects voice or touches agent profiles', () => {
  writeState({ enabled: true });
  writeAgentState('codex', { enabled: false });
  writeState({ enabled: false });
  const st = writeDuckingState({ enabled: true, depth: 0.2, neverDuck: ['Discord.exe'] });
  assert.equal(st.enabled, false, 'master voice stays off');
  assert.equal(st.agents.codex.enabled, false, 'Codex stays muted');
  assert.equal(st.ducking.enabled, true);
  assert.equal(st.ducking.depth, 0.2);
  assert.deepEqual(st.ducking.neverDuck, ['Discord']);
  assert.equal(JSON.parse(readFileSync(STATE_FILE, 'utf8')).ducking.enabled, true);
});

test('other settings writes keep the ducking block', () => {
  writeDuckingState({ enabled: true, voiceDepth: 0.3 });
  writeState({ enabled: true });
  writeAgentState('claude', { enabled: true });
  const st = readState();
  assert.equal(st.ducking.enabled, true);
  assert.equal(st.ducking.voiceDepth, 0.3);
});

// Every settings write merges inside one lock. A burst of ducking saves racing
// a voice-off from another process must never put voice back on.
test('ducking saves racing a voice-off in another process never resurrect voice', async () => {
  writeState({ enabled: true });
  const mod = pathToFileURL(path.join(ROOT, 'src', 'state.js')).href;
  const child = (code) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', `const s = await import(${JSON.stringify(mod)}); ${code}`], {
        env: { ...process.env },
        stdio: 'ignore',
      });
      c.on('close', resolve);
    });
  await Promise.all([
    child('for (let i = 0; i < 25; i++) s.writeDuckingState({ depth: (i % 5) / 10 });'),
    child('s.writeState({ enabled: false });'),
    child('for (let i = 0; i < 25; i++) s.writeDuckingState({ voiceDepth: (i % 5) / 10 });'),
  ]);
  const st = readState();
  assert.equal(st.enabled, false, 'the voice-off survived the ducking saves');
  assert.equal(typeof st.ducking.depth, 'number');
});
