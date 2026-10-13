// Cross-process FIFO queue so multiple Claude sessions speak in turn instead of
// stomping each other. Every utterance drops a ticket file; a speaker may start
// only when its ticket is the oldest live one AND no player is still draining.
// All coordination is via files in CACHE_DIR (no daemon, no shared memory), so
// it works across the independent, short-lived worker processes the Stop hook
// spawns (one per reply, per project), which only ever see each other on disk.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  unlinkSync,
  statSync,
  utimesSync,
} from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './config.js';
import { pidAlive, anyPlayerAlive } from './players.js';
import { log } from './log.js';

export { pidAlive };

export const QUEUE_DIR = path.join(CACHE_DIR, 'speak-queue');
const EPOCH_FILE = path.join(CACHE_DIR, 'speak-epoch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureQueueDir() {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
}

// The current "epoch". A hard stop (voice off / stop button / a manual utterance
// taking over) stamps a new value; waiters that captured an older value give up.
export function currentEpoch(agent) {
  const file = agent === 'claude' || agent === 'codex' ? `${EPOCH_FILE}-${agent}` : EPOCH_FILE;
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '0';
  }
}

// Tell every waiter to abandon its wait: the user asked for silence, or a
// manual utterance is jumping the line. Strictly monotonic, so even two flushes
// in the same millisecond still register as a change to a waiter.
export function flushQueue(agent) {
  ensureQueueDir();
  const file = agent === 'claude' || agent === 'codex' ? `${EPOCH_FILE}-${agent}` : EPOCH_FILE;
  try {
    const prev = Number(currentEpoch(agent)) || 0;
    writeFileSync(file, String(Math.max(Date.now(), prev + 1)));
  } catch {
    // best effort. A stale epoch just means a waiter starts instead of aborting
  }
}

let ticketSeq = 0;

// Join the line. Returns a ticket for waitTurn / releaseTicket.
export function enqueue() {
  ensureQueueDir();
  // Zero-padded so a plain lexicographic filename sort is chronological (FIFO).
  // The counter keeps two tickets from one long-lived process in the same
  // millisecond (a double-click on the panel's Speak) from sharing a file.
  const seq = [
    String(Date.now()).padStart(15, '0'),
    String(process.pid).padStart(7, '0'),
    String(++ticketSeq).padStart(4, '0'),
  ].join('-');
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

// Drop tickets whose owner is gone, so a crashed or killed session can never
// wedge the queue behind it. A waiter touches its ticket every time it polls,
// so a ticket nobody has touched for this long belongs to a process that died
// or hung, whatever its pid points at now (pids are reused, especially across
// a reboot). Age is measured from that last touch, never from when the ticket
// was written: a reply waiting behind ten minutes of speech is still in line,
// and aging it out let its owner and the next in line start together.
const TICKET_STALE_MS = 30 * 1000;

export function cleanStale(now = Date.now()) {
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
    let touched = 0;
    try {
      pid = JSON.parse(readFileSync(p, 'utf8')).pid;
      touched = statSync(p).mtimeMs;
    } catch {
      // unreadable / torn write; treat as dead and remove (a live waiter puts
      // its ticket back on its next poll)
    }
    if (now - touched > TICKET_STALE_MS || !pidAlive(pid)) {
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
// than wait forever. A reply must never go unspoken over queue bookkeeping.
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

// The heartbeat that keeps our place in line. If our ticket was taken for
// abandoned (after a long sleep, say), put it back: its name carries the time
// it was first written, so it returns to the same place.
function touchTicket(ticket) {
  const now = new Date();
  try {
    utimesSync(ticket.file, now, now);
  } catch {
    try {
      ensureQueueDir();
      writeFileSync(ticket.file, JSON.stringify({ pid: ticket.pid, ts: Date.now() }));
    } catch {
      // isFront fails open below, so a reply is never left waiting forever
    }
  }
}

// Nothing legitimately waits this long. Past it, something is wrong with the
// bookkeeping and giving up (logged) beats a worker polling forever.
const MAX_WAIT_MS = 20 * 60 * 1000;

// Block until it's our turn (oldest ticket, nothing still playing) or until we
// should give up. Returns true = go now, false = aborted (caller releases the
// ticket). The common single-session case returns true on the first pass with
// no sleep, so there is zero added latency when nothing else is talking.
// "Nothing still playing" is decided by the player markers, which the players
// keep fresh themselves, not by a remembered pid that can go stale or be reused.
export async function waitTurn(ticket, myEpoch, { stillWanted, pollMs = 120, maxWaitMs = MAX_WAIT_MS } = {}) {
  const giveUpAt = Date.now() + maxWaitMs;
  for (;;) {
    if (currentEpoch() !== myEpoch) return false; // a stop / flush happened
    if (stillWanted && !stillWanted()) return false; // e.g. voice toggled off
    touchTicket(ticket);
    cleanStale();
    if (isFront(ticket) && !anyPlayerAlive()) return true;
    if (Date.now() > giveUpAt) {
      log('queue: gave up waiting for the line after 20 minutes');
      return false;
    }
    await sleep(pollMs);
  }
}
