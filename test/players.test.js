import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Isolate BEFORE importing anything from src/ (paths resolve at import time).
const DIR = mkdtempSync(path.join(tmpdir(), 'readback-players-'));
process.env.READBACK_STATE_DIR = DIR;
process.env.READBACK_CACHE_DIR = DIR;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PLAYERS_DIR, LIVE_MS, pidAlive, recordPlayer, livePlayers, killPlayers, sweepPlayers, markerPath } =
  await import('../src/players.js');
const { claim, isClaimed } = await import('../src/claims.js');
const { enqueue, releaseTicket } = await import('../src/queue.js');
const { newStreamDir } = await import('../src/audio.js');
const { STREAM_SCRIPT } = await import('../src/config.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A PowerShell process that sits there so we can aim kills at it. Returns the
// child; the caller kills it in finally.
function sleeper(command) {
  return spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function waitDead(pid, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

// The claim used to be a shared slot plus a 60 ms settle, so two projects
// finishing within 60 ms dropped a reply and duplicate fires further apart
// spoke it twice. An atomic create has exactly one winner.
test('exactly one of several racing workers wins a reply claim', async () => {
  const mod = pathToFileURL(path.join(ROOT, 'src', 'claims.js')).href;
  const script = `
    const { claim } = await import(${JSON.stringify(mod)});
    console.log(claim('reply-race-1') ? 1 : 0);
  `;
  const run = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(Number(out.trim())));
    });
  const wins = await Promise.all([run(), run(), run(), run()]);
  assert.equal(wins.reduce((a, b) => a + b, 0), 1, `winners: ${wins}`);
  assert.equal(isClaimed('reply-race-1'), true);
  assert.equal(claim('reply-race-1'), false, 'a later fire for the same reply must lose');
});

test('a live marker counts; a stale or dead one is dropped', () => {
  mkdirSync(PLAYERS_DIR, { recursive: true });
  recordPlayer(process.pid); // this process is alive and the marker is fresh
  assert.equal(livePlayers().length, 1);

  // Untouched for longer than LIVE_MS: the player is gone, whatever the pid says.
  const old = (Date.now() - LIVE_MS - 60_000) / 1000;
  utimesSync(markerPath(process.pid), old, old);
  assert.equal(livePlayers().length, 0);
  assert.equal(existsSync(markerPath(process.pid)), false, 'stale marker must be removed');

  // Fresh marker but the pid is dead.
  recordPlayer(999999);
  assert.equal(livePlayers().length, 0);
  assert.equal(existsSync(markerPath(999999)), false);
});

// Windows recycles pids within seconds. A kill by pid alone would hit whatever
// now owns the number; a kill checked against the recorded start time cannot.
test('a kill only lands on the process the marker recorded', async () => {
  const child = sleeper('Start-Sleep -Seconds 40');
  try {
    await sleep(700); // let PowerShell come up so Get-Process can see it
    assert.ok(pidAlive(child.pid));

    // Marker says this pid started an hour ago: not our process, must survive.
    killPlayers([{ pid: child.pid, started: Date.now() - 3600_000 }]);
    await sleep(500);
    assert.ok(pidAlive(child.pid), 'a start-time mismatch must never kill');

    // Marker matches the real start time: killed.
    killPlayers([{ pid: child.pid, started: Date.now() - 1200 }]);
    assert.ok(await waitDead(child.pid), 'a matching player must be killed');
  } finally {
    try {
      child.kill();
    } catch {
      // already dead
    }
  }
});

// The sweep used to match any command line containing the script's file name,
// killing shells and editors and its own PowerShell, which aborted it half way.
test('the sweep kills a real player and nothing that merely mentions the script', async () => {
  const bystander = sleeper(`$x = '${STREAM_SCRIPT}'; Start-Sleep -Seconds 40`);
  // A real player that belongs to a DIFFERENT cache dir must survive our sweep.
  const otherPlayersDir = mkdtempSync(path.join(tmpdir(), 'readback-other-players-'));
  const foreign = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STREAM_SCRIPT, '-Dir', otherPlayersDir, '-PlayersDir', otherPlayersDir],
    { stdio: 'ignore', windowsHide: true }
  );
  const streamDir = mkdtempSync(path.join(tmpdir(), 'readback-sweep-'));
  // Spawned the way audio.js spawns a real player, including this cache dir's
  // players folder, which is what scopes the sweep to our own players.
  const player = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STREAM_SCRIPT, '-Dir', streamDir, '-PlayersDir', PLAYERS_DIR],
    { stdio: 'ignore', windowsHide: true }
  );
  try {
    await sleep(1200);
    assert.ok(pidAlive(bystander.pid), `bystander shell (pid ${bystander.pid}) died before the sweep`);
    assert.ok(pidAlive(player.pid), `player (pid ${player.pid}) died before the sweep`);
    sweepPlayers();
    assert.ok(await waitDead(player.pid), 'the real player must be killed');
    assert.ok(pidAlive(bystander.pid), 'a shell that only mentions the script must survive');
    assert.ok(pidAlive(foreign.pid), "another cache dir's player must survive");
  } finally {
    for (const c of [bystander, player, foreign]) {
      try {
        c.kill();
      } catch {
        // already dead
      }
    }
  }
});

test('two tickets or stream dirs from one process in the same millisecond do not collide', () => {
  const a = enqueue();
  const b = enqueue();
  assert.notEqual(a.name, b.name);
  releaseTicket(a);
  releaseTicket(b);
  const d1 = newStreamDir();
  const d2 = newStreamDir();
  assert.notEqual(d1, d2);
  // and the cleanup that runs inside newStreamDir removed the older one only
  assert.equal(existsSync(d2), true);
  assert.equal(readdirSync(DIR).filter((f) => f.startsWith('stream-')).length, 1);
});
