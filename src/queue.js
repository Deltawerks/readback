// Cross-process FIFO queue so multiple Claude sessions speak in turn instead of
// stomping each other. Every utterance drops a ticket file; a speaker may start
// only when its ticket is the oldest live one AND no player is still draining.
// All coordination is via files in CACHE_DIR — no daemon, no shared memory — so
// it works across the independent, short-lived worker processes the Stop hook
// spawns (one per reply, per project), which only ever see each other on disk.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './config.js';
import { readState } from './state.js';

export const QUEUE_DIR = path.join(CACHE_DIR, 'speak-queue');
const EPOCH_FILE = path.join(CACHE_DIR, 'speak-epoch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureQueueDir() {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
}

// True if a process with this pid is currently running (same user). Signal 0
// tests existence without actually signalling; EPERM means it exists but isn't
// ours to touch (still "alive" for our purposes).
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The current "epoch". A hard stop (voice off / stop button / a manual utterance
// taking over) stamps a new value; waiters that captured an older value give up.
export function currentEpoch() {
  try {
    return readFileSync(EPOCH_FILE, 'utf8').trim();
  } catch {
    return '0';
  }
}

// Tell every waiter to abandon its wait — the user asked for silence, or a
// manual utterance is jumping the line. Strictly monotonic, so even two flushes
// in the same millisecond still register as a change to a waiter.
export function flushQueue() {
  ensureQueueDir();
  try {
    const prev = Number(currentEpoch()) || 0;
    writeFileSync(EPOCH_FILE, String(Math.max(Date.now(), prev + 1)));
  } catch {
    // best effort — a stale epoch just means a waiter starts instead of aborting
  }
}

// Join the line. Returns a ticket for waitTurn / releaseTicket.
export function enqueue() {
  ensureQueueDir();
  // Zero-padded so a plain lexicographic filename sort is chronological (FIFO).
  const seq = `${String(Date.now()).padStart(15, '0')}-${String(process.pid).padStart(7, '0')}`;
  const name = `${seq}.json`;
  const file = path.join(QUEUE_DIR, name);
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {
    // If we can't even enqueue, isFront() fails open so we never go silent.
  }
  return { name, file, pid: process.pid };
}

export function releaseTicket(ticket) {
  if (!ticket) return;
  try {
    unlinkSync(ticket.file);
  } catch {
    // already gone
  }
}

// Drop tickets whose owning process has died, so a crashed or killed session
// can never wedge the queue behind it.
export function cleanStale() {
  let files;
  try {
    files = readdirSync(QUEUE_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(QUEUE_DIR, f);
    let pid = null;
    try {
      pid = JSON.parse(readFileSync(p, 'utf8')).pid;
    } catch {
      // unreadable / torn write — treat as dead and remove
    }
    if (!pidAlive(pid)) {
      try {
        unlinkSync(p);
      } catch {
        // someone else already cleaned it
      }
    }
  }
}

// Is this ticket the oldest live one in the queue? Fails OPEN: if our ticket
// vanished (write failed, or a stale-sweep removed it) we return true rather
// than wait forever — a reply must never go unspoken over queue bookkeeping.
export function isFront(ticket) {
  let files;
  try {
    files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return true;
  }
  if (!files.length) return true;
  files.sort();
  if (!files.includes(ticket.name)) return true;
  return files[0] === ticket.name;
}

// A player from the previous utterance may still be draining its final chunk.
function activePlayerAlive() {
  return pidAlive(readState().lastPid);
}

// Block until it's our turn (oldest ticket, nothing still playing) or until we
// should give up. Returns true = go now, false = aborted (caller releases the
// ticket). The common single-session case returns true on the first pass with
// no sleep, so there is zero added latency when nothing else is talking.
export async function waitTurn(ticket, myEpoch, { stillWanted, pollMs = 120 } = {}) {
  for (;;) {
    if (currentEpoch() !== myEpoch) return false; // a stop / flush happened
    if (stillWanted && !stillWanted()) return false; // e.g. voice toggled off
    cleanStale();
    if (isFront(ticket) && !activePlayerAlive()) return true;
    await sleep(pollMs);
  }
}
