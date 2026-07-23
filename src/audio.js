import { spawn, execFileSync } from 'node:child_process';
import {
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, STREAM_SCRIPT } from './config.js';
import { readState, writeState, ensureStateDir } from './state.js';

// One empty file per live player, named by its real pid, written when the player
// spawns and removed when it exits. stopPlayback kills exactly these pids. This
// is what makes "voice off" reliable: it doesn't depend on a single tracked pid
// (which goes stale during a queue handoff) or on a WMI command-line lookup
// (which can miss a process whose command line isn't readable).
const PLAYERS_DIR = path.join(CACHE_DIR, 'players');

// Kill every streaming player by its command-line signature. The tracked
// lastPid is not enough on its own: during a queue handoff (one project's reply
// finishing, the next taking the line) lastPid briefly points at the just-ended
// player while a new one is starting, so killing lastPid alone let a reply keep
// talking straight through "voice off". Matching on play-stream.ps1 kills
// whatever is actually making sound, whichever worker owns it.
function killAllPlayers() {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*play-stream.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 5000 }
    );
  } catch {
    // best effort; the fast lastPid kill above has usually handled it already
  }
}

// Stop playback now. Synchronous, so a following speak() can't spawn a player
// that overlaps this one.
export function stopPlayback() {
  // Kill every recorded player by pid. Robust: covers all live players, not just
  // the last, and doesn't rely on WMI being able to read a command line.
  let pids = [];
  try {
    pids = readdirSync(PLAYERS_DIR).filter((f) => /^\d+$/.test(f));
  } catch {
    // no players dir yet
  }
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // already gone
    }
    try {
      unlinkSync(path.join(PLAYERS_DIR, pid));
    } catch {
      // its own close handler beat us to it
    }
  }
  // Backstop for anything that slipped through (a player whose pid we failed to
  // record): sweep by command-line signature too.
  killAllPlayers();
  writeState({ lastPid: null });
}

function cleanOldStreams(keepDir) {
  try {
    const keep = keepDir ? path.basename(keepDir) : null;
    for (const f of readdirSync(CACHE_DIR)) {
      if (/^stream-\d+$/.test(f) && f !== keep) {
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

// Fresh per-utterance directory for streamed chunks; stale ones are removed.
export function newStreamDir() {
  ensureStateDir();
  const dir = path.join(CACHE_DIR, `stream-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cleanOldStreams(dir);
  return dir;
}

export function chunkFile(dir, index) {
  return path.join(dir, `chunk-${String(index).padStart(3, '0')}.wav`);
}

// Write a chunk atomically (temp + rename) so the player never reads a
// half-written file while polling.
export function writeChunk(dir, index, buffer) {
  const dest = chunkFile(dir, index);
  const tmp = `${dest}.part`;
  try {
    writeFileSync(tmp, buffer);
    renameSync(tmp, dest);
  } catch {
    // The stream dir may have been removed by a newer utterance (kill-on-new);
    // that stream is superseded, so a failed write here is harmless.
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
// detached, because on Windows detached gives powershell.exe no console and it silently
// fails to run). Returns the child; the caller stores its PID and either
// unref()s it (long-lived parent) or awaits its 'close' (short-lived parent).
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
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  // Record this player's pid so any process's stopPlayback can find and kill it,
  // and clear the record when it exits on its own.
  const marker = path.join(PLAYERS_DIR, String(player.pid));
  try {
    mkdirSync(PLAYERS_DIR, { recursive: true });
    writeFileSync(marker, '');
  } catch {
    // best effort; killAllPlayers() is the backstop if we couldn't record it
  }
  player.on('close', () => {
    try {
      unlinkSync(marker);
    } catch {
      // already removed by a stopPlayback sweep
    }
  });
  return player;
}
