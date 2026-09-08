// Live-player bookkeeping. One marker file per running player in
// CACHE_DIR/players, named by pid and holding the process start time. The
// player itself touches its marker about once a second while it runs, so:
//   - a marker touched within LIVE_MS belongs to a player that is really
//     running, whichever worker started it and whether or not that worker is
//     still around;
//   - a marker older than that is garbage from a crash, a kill or a reboot, and
//     is never acted on (pids get reused, so acting on it could hit a stranger);
//   - the recorded start time lets a kill confirm it is aiming at the process
//     it recorded, which a bare pid cannot do.
// This replaces two things that were both wrong. Trusting lastPid, which was
// never cleared after a normal reply, so one recycled pid made every later
// reply wait forever until the user cycled the toggle. And a ten-minute cutoff
// measured from spawn, which made any reply longer than that impossible to
// stop.
import {
  writeFileSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  statSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { CACHE_DIR, STREAM_SCRIPT } from './config.js';

export const PLAYERS_DIR = path.join(CACHE_DIR, 'players');

// The player touches its marker between chunks and while idle. The longest
// stretch it cannot touch is one chunk playing back to back, well under a
// minute, so two minutes untouched means it is gone.
export const LIVE_MS = 120 * 1000;

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

export function markerPath(pid) {
  return path.join(PLAYERS_DIR, String(pid));
}

export function recordPlayer(pid) {
  if (!existsSync(PLAYERS_DIR)) mkdirSync(PLAYERS_DIR, { recursive: true });
  writeFileSync(markerPath(pid), JSON.stringify({ pid, started: Date.now() }));
}

export function forgetPlayer(pid) {
  try {
    unlinkSync(markerPath(pid));
  } catch {
    // already gone
  }
}

// Every player that is really running right now. Markers that are stale or
// whose pid is dead are removed on the way through.
export function livePlayers(now = Date.now()) {
  let names = [];
  try {
    names = readdirSync(PLAYERS_DIR).filter((f) => /^\d+$/.test(f));
  } catch {
    return [];
  }
  const live = [];
  for (const name of names) {
    const pid = Number(name);
    const file = markerPath(pid);
    let mtime = 0;
    let started = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    try {
      started = Number(JSON.parse(readFileSync(file, 'utf8')).started) || 0;
    } catch {
      // a marker from before start times were recorded; the kill below then
      // relies on the process name alone
    }
    if (now - mtime > LIVE_MS || !pidAlive(pid)) {
      forgetPlayer(pid);
      continue;
    }
    live.push({ pid, started, mtime });
  }
  return live;
}

export function anyPlayerAlive() {
  return livePlayers().length > 0;
}

const PS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'];

// Kill the given players, but only where the pid still belongs to the process
// we recorded: a PowerShell process whose start time is within a few seconds of
// what the marker says. One PowerShell call for the whole batch.
export function killPlayers(players) {
  if (!players.length) return;
  const spec = players.map((p) => `${p.pid}:${p.started}`).join(',');
  const script = `
    foreach ($item in $env:RB_PLAYERS.Split(',')) {
      $parts = $item.Split(':')
      $id = [int]$parts[0]
      $started = [double]$parts[1]
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($null -eq $p) { continue }
      if ($p.ProcessName -ne 'powershell') { continue }
      if ($started -gt 0) {
        $ms = ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
        if ([math]::Abs($ms - $started) -gt 5000) { continue }
      }
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }`;
  try {
    execFileSync('powershell', [...PS, script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000,
      env: { ...process.env, RB_PLAYERS: spec },
    });
  } catch {
    // best effort; sweepPlayers is the backstop
  }
}

// Backstop for a player whose marker was never written. Matches the exact
// script path AND this cache dir's players folder AND the -File switch AND the
// process name, collects the ids first, and never includes this sweep's own
// process. The previous version matched any command line containing the
// script's file name, which killed unrelated shells and editors, and matched
// itself, which aborted the sweep half way through. Scoping to the players
// folder also keeps an isolated test run from silencing the user's real reply.
export function sweepPlayers() {
  const script = `
    $script = '*' + $env:RB_SCRIPT + '*'
    $players = '*-PlayersDir*' + $env:RB_PLAYERS_DIR + '*'
    $ids = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -like '*-File*' -and
        $_.CommandLine -like $script -and $_.CommandLine -like $players
      } | Select-Object -ExpandProperty ProcessId)
    foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync('powershell', [...PS, script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000,
      env: { ...process.env, RB_SCRIPT: STREAM_SCRIPT, RB_PLAYERS_DIR: PLAYERS_DIR },
    });
  } catch {
    // best effort
  }
}
