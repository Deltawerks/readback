import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-codex-hook-'));
  const state = path.join(dir, 'state');
  const cache = path.join(dir, 'cache');
  mkdirSync(state);
  mkdirSync(cache);
  const env = { ...process.env, READBACK_STATE_DIR: state, READBACK_CACHE_DIR: cache, READBACK_DUCKING_HELPER: 'off' };
  delete env.INWORLD_API_KEY;
  delete env.ELEVENLABS_API_KEY;
  const log = () => (existsSync(path.join(cache, 'readback.log')) ? readFileSync(path.join(cache, 'readback.log'), 'utf8') : '');
  return { dir, state, cache, env, log, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// The worker deletes the file it is handed once it has read it. It must only
// ever accept its own single-use input files, never an arbitrary path.
test('the Codex worker refuses an input file that is not one of its own', () => {
  const s = sandbox();
  try {
    const victim = path.join(s.dir, 'notes.json');
    writeFileSync(victim, '{"keep":"me"}');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hook', 'codex-worker.js'), '--input-file', victim], {
      env: s.env, encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(victim), true, 'a file outside the cache was deleted');
    assert.match(s.log(), /not a ReadBack input file/);
  } finally {
    s.done();
  }
});

// A worker that died before reading its input (or a hook killed between
// writing and launching) left the reply text on disk for good.
test('the Codex hook sweeps reply files that were never picked up', () => {
  const s = sandbox();
  try {
    const stale = path.join(s.cache, 'codex-input-00000000-0000-4000-8000-000000000000.json');
    const fresh = path.join(s.cache, 'codex-input-11111111-1111-4111-8111-111111111111.json');
    writeFileSync(stale, '{"last_assistant_message":"old reply"}');
    writeFileSync(fresh, '{"last_assistant_message":"in flight"}');
    const old = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(stale, old, old);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hook', 'codex-stop-hook.js')], {
      env: s.env, input: '{}', encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(stale), false, 'a reply file left from a failed launch was kept');
    assert.equal(existsSync(fresh), true, 'a reply file a worker may still be reading was removed');
  } finally {
    s.done();
  }
});

// "codex-worker error Error" was all a missing key, a rejected key or an empty
// balance left in the log the README points people to.
test('a Codex reply that fails at the provider logs why', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const s = sandbox();
  try {
    writeFileSync(path.join(s.state, 'state.json'), JSON.stringify({ enabled: true, provider: 'inworld' }));
    const transcript = path.join(s.dir, 'session.jsonl');
    writeFileSync(transcript, [
      { type: 'session_meta', payload: { id: 'session-1', source: 'vscode', thread_source: 'user' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1', turn_attribution: { turn_trigger: 'composer' } } },
    ].map(JSON.stringify).join('\n'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hook', 'codex-worker.js')], {
      env: s.env, encoding: 'utf8', timeout: 25000, windowsHide: true,
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1',
        transcript_path: transcript, last_assistant_message: 'A reply that cannot be synthesized.' }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /codex-worker error .*key is not set/);
  } finally {
    s.done();
  }
});
