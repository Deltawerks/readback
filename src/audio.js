import { spawn } from 'node:child_process';
import { writeFileSync, renameSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, STREAM_SCRIPT } from './config.js';
import { readState, writeState, ensureStateDir } from './state.js';
import {
  PLAYERS_DIR,
  recordPlayer,
  forgetPlayer,
  livePlayers,
  killPlayers,
  sweepPlayers,
} from './players.js';

// Stop playback now. Synchronous, so a following speak() can't spawn a player
// that overlaps this one. Kills every player whose marker is live and whose
// identity checks out (see players.js), then sweeps by exact command line for
// any player that never got a marker.
export function stopPlayback() {
  const players = livePlayers();
  killPlayers(players);
  for (const p of players) forgetPlayer(p.pid);
  sweepPlayers();
  try {
    writeState({ lastPid: null });
  } catch {
    // informational only
  }
}

// Stream dirs are named stream-<ms>-<pid>-<n>; only those, never anything else
// in the cache dir, and never the one being started.
const STREAM_DIR_RE = /^stream-\d+(?:-\d+){0,2}$/;

function cleanOldStreams(keepDir) {
  try {
    const keep = keepDir ? path.basename(keepDir) : null;
    for (const f of readdirSync(CACHE_DIR)) {
      if (STREAM_DIR_RE.test(f) && f !== keep) {
        try {
          rmSync(path.join(CACHE_DIR, f), { recursive: true, force: true });
        } catch {
          // a dying player may still hold a clip, cleaned next time
        }
      }
    }
  } catch {
    // ignore
  }
}

let streamSeq = 0;

// Fresh per-utterance directory for streamed chunks; stale ones are removed.
// The pid and a counter keep two utterances started in the same millisecond
// (by two processes, or by one long-lived panel) from sharing a directory.
export function newStreamDir() {
  ensureStateDir();
  const dir = path.join(CACHE_DIR, `stream-${Date.now()}-${process.pid}-${++streamSeq}`);
  mkdirSync(dir, { recursive: true });
  cleanOldStreams(dir);
  return dir;
}

export function chunkFile(dir, index) {
  return path.join(dir, `chunk-${String(index).padStart(3, '0')}.wav`);
}

// Write a chunk atomically (temp + rename) so the player never reads a
// half-written file while polling. Returns false if the chunk could not be
// written, so the caller does not count it as delivered.
export function writeChunk(dir, index, buffer) {
  const dest = chunkFile(dir, index);
  const tmp = `${dest}.part`;
  try {
    writeFileSync(tmp, buffer);
    renameSync(tmp, dest);
    return true;
  } catch {
    // The stream dir may have been removed by a newer utterance (kill-on-new);
    // that stream is superseded, so a failed write here is harmless.
    return false;
  }
}

export function writeEndMarker(dir, count) {
  const dest = path.join(dir, 'end.marker');
  const tmp = `${dest}.part`;
  try {
    writeFileSync(tmp, String(count));
    renameSync(tmp, dest);
  } catch {
    // superseded stream: the dir is gone; nothing to signal
  }
}

// Spawn the single streaming player for a directory. Hidden console (NOT
// detached, because on Windows detached gives powershell.exe no console and it
// silently fails to run). Returns the child; the caller either unref()s it
// (long-lived parent) or awaits its 'close' (short-lived parent). The player
// is told where the markers live so it can keep its own marker fresh.
export function spawnStreamPlayer(dir) {
  const player = spawn(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      STREAM_SCRIPT,
      '-Dir',
      dir,
      '-PlayersDir',
      PLAYERS_DIR,
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  try {
    recordPlayer(player.pid);
  } catch {
    // best effort; sweepPlayers() is the backstop if we couldn't record it
  }
  player.on('close', () => {
    forgetPlayer(player.pid);
    // lastPid is informational now, but never leave it pointing at a dead pid.
    try {
      if (readState().lastPid === player.pid) writeState({ lastPid: null });
    } catch {
      // nothing depends on it
    }
  });
  return player;
}
