import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Isolate every queue/state file into a throwaway dir BEFORE the modules load.
// config.js resolves its paths at import time, and settings and cache are two
// separate overrides on purpose: CACHE_DIR deliberately does NOT follow
// READBACK_STATE_DIR, because a launcher that set one and not the other used to
// split the panel and the hook workers across different queue directories.
const DIR = mkdtempSync(path.join(tmpdir(), 'readback-queue-'));
process.env.READBACK_STATE_DIR = DIR;
process.env.READBACK_CACHE_DIR = DIR;

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

// A ticket that sits behind ten minutes of speech is still in line. Aging
// tickets from when they were written threw such a waiter's ticket away, its
// owner then took the front, and two replies started on top of each other.
function ticketFrom(msAgo) {
  const t = Date.now() - msAgo;
  const name = `${String(t).padStart(15, '0')}-${String(process.pid).padStart(7, '0')}-${String(msAgo % 9999).padStart(4, '0')}.json`;
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
  const file = path.join(QUEUE_DIR, name);
  writeFileSync(file, JSON.stringify({ pid: process.pid, ts: t }));
  return { name, file, pid: process.pid };
}

test('a reply that has waited more than ten minutes keeps its place', () => {
  clearTickets();
  const old = ticketFrom(11 * 60 * 1000);
  cleanStale();
  assert.ok(tickets().includes(old.name));
  clearTickets();
});

test('two waiting replies are never let through together', async () => {
  clearTickets();
  writeState({ lastPid: null });
  const first = ticketFrom(11 * 60 * 1000);
  const second = ticketFrom(60 * 1000);
  const granted = [];
  const wait = (t, label) => waitTurn(t, currentEpoch(), { stillWanted: () => true, pollMs: 20 }).then((ok) => ok && granted.push(label));
  const both = Promise.all([wait(first, 'first'), wait(second, 'second')]);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(granted, ['first'], 'only the front of the line goes');
  releaseTicket(first);
  await both;
  assert.deepEqual(granted, ['first', 'second']);
  clearTickets();
});

test('a waiter whose ticket was taken for abandoned puts it back in the same place', async () => {
  clearTickets();
  writeState({ lastPid: null });
  const ahead = ticketFrom(2000);
  const mine = ticketFrom(1000);
  const turn = waitTurn(mine, currentEpoch(), { stillWanted: () => true, pollMs: 20 });
  releaseTicket(mine); // e.g. swept after a long sleep
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(tickets(), [ahead.name, mine.name]);
  releaseTicket(ahead);
  assert.equal(await turn, true);
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
