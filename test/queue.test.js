import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Isolate every queue/state file into a throwaway dir BEFORE the modules load
// (config.js resolves its paths at import time from READBACK_STATE_DIR, and
// CACHE_DIR follows STATE_DIR when that override is set).
const DIR = mkdtempSync(path.join(tmpdir(), 'readback-queue-'));
process.env.READBACK_STATE_DIR = DIR;

const {
  QUEUE_DIR,
  enqueue,
  releaseTicket,
  isFront,
  cleanStale,
  currentEpoch,
  flushQueue,
  waitTurn,
  pidAlive,
} = await import('../src/queue.js');
const { writeState } = await import('../src/state.js');

function writeTicket(name, pid) {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(path.join(QUEUE_DIR, name), JSON.stringify({ pid, ts: Date.now() }));
}
function tickets() {
  try {
    return readdirSync(QUEUE_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}
function clearTickets() {
  for (const f of tickets()) releaseTicket({ file: path.join(QUEUE_DIR, f) });
}
// A pid that is guaranteed dead: run a node that exits immediately, reuse its pid.
const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;

test('pidAlive: self is alive, a reaped pid is dead', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid), false);
  assert.equal(pidAlive(0), false);
});

test('a lone utterance is immediately front, and release clears it', () => {
  clearTickets();
  const t = enqueue();
  assert.equal(isFront(t), true);
  releaseTicket(t);
  assert.equal(tickets().length, 0);
});

test('FIFO: the older ticket is front, the newer one waits', () => {
  clearTickets();
  writeTicket('000000000000100-0000001.json', process.pid);
  writeTicket('000000000000200-0000002.json', process.pid);
  assert.equal(isFront({ name: '000000000000100-0000001.json' }), true);
  assert.equal(isFront({ name: '000000000000200-0000002.json' }), false);
  clearTickets();
});

test('cleanStale drops tickets whose process has died, keeps live ones', () => {
  clearTickets();
  writeTicket('000000000000300-9999999.json', deadPid);
  writeTicket('000000000000400-0000001.json', process.pid);
  cleanStale();
  const left = tickets();
  assert.ok(!left.includes('000000000000300-9999999.json'), 'dead-pid ticket removed');
  assert.ok(left.includes('000000000000400-0000001.json'), 'live-pid ticket kept');
  clearTickets();
});

test('isFront fails open when our ticket vanished (never wait forever)', () => {
  clearTickets();
  writeTicket('000000000000500-0000009.json', process.pid); // someone ahead of us
  assert.equal(isFront({ name: 'ticket-that-does-not-exist.json' }), true);
  clearTickets();
});

test('waitTurn returns immediately when alone and nothing is playing', async () => {
  clearTickets();
  writeState({ lastPid: null });
  const t = enqueue();
  const ok = await waitTurn(t, currentEpoch(), { stillWanted: () => true });
  assert.equal(ok, true);
  releaseTicket(t);
});

test('waitTurn aborts when voice is no longer wanted', async () => {
  clearTickets();
  const t = enqueue();
  const ok = await waitTurn(t, currentEpoch(), { stillWanted: () => false });
  assert.equal(ok, false);
  releaseTicket(t);
});

test('waitTurn aborts when the epoch changes (a stop/flush happened)', async () => {
  clearTickets();
  const t = enqueue();
  const captured = currentEpoch();
  flushQueue();
  assert.notEqual(currentEpoch(), captured);
  const ok = await waitTurn(t, captured, { stillWanted: () => true });
  assert.equal(ok, false);
  releaseTicket(t);
});

test('waitTurn holds behind an earlier ticket, then proceeds once it clears', async () => {
  clearTickets();
  writeState({ lastPid: null });
  // An explicitly-older ticket sits ahead of ours.
  writeTicket('000000000000010-0000001.json', process.pid);
  const mine = enqueue(); // newer (real Date.now()), so not front yet
  assert.equal(isFront(mine), false);

  // Start waiting; it should NOT resolve until the ticket ahead is released.
  let resolved = false;
  const turn = waitTurn(mine, currentEpoch(), { stillWanted: () => true }).then((v) => {
    resolved = true;
    return v;
  });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(resolved, false, 'must not proceed while someone is ahead');

  releaseTicket({ file: path.join(QUEUE_DIR, '000000000000010-0000001.json') });
  assert.equal(await turn, true, 'proceeds once the line clears');
  releaseTicket(mine);
});
