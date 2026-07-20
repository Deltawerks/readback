import { spawn, execFileSync } from 'node:child_process';
import {
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, STREAM_SCRIPT } from './config.js';
import { readState, writeState, ensureStateDir } from './state.js';

// Kill whatever is currently playing (the streaming player, tracked by PID).
export function stopPlayback() {
  const { lastPid } = readState();
  if (lastPid) {
    try {
      // Synchronous kill: block until the old player is actually terminated
      // before returning, so a following speak() can't spawn a second player
      // that overlaps audio with this one (kill-on-new must really kill first).
      execFileSync('taskkill', ['/PID', String(lastPid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // already gone / taskkill failed, that's fine
    }
  }
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
  return spawn(
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
}
