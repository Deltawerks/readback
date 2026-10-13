import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Isolate BEFORE importing anything from src/ (paths resolve at import time).
const DIR = mkdtempSync(path.join(tmpdir(), 'readback-players-'));
process.env.READBACK_STATE_DIR = DIR;
process.env.READBACK_CACHE_DIR = DIR;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PLAYERS_DIR, LIVE_MS, pidAlive, recordPlayer, forgetPlayer, livePlayers, killPlayers, sweepPlayers, markerPath } =
  await import('../src/players.js');
// These drive real PowerShell processes, which only exist on Windows.
const WINDOWS_ONLY = { skip: process.platform !== 'win32' };
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
test('a kill only lands on the process the marker recorded', WINDOWS_ONLY, async () => {
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
test('the sweep kills a real player and nothing that merely mentions the script', WINDOWS_ONLY, async () => {
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

// fs.rmSync quietly removes nothing when the path has non-ASCII characters
// (seen on Node 24 on Windows), so under a profile folder such as
// C:\Users\José every reply's audio stayed in the cache for good.
test('old stream dirs are cleaned up under a cache path with non-ASCII characters', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'readback-José-cache-'));
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
      import path from 'node:path';
      const old = path.join(process.env.READBACK_CACHE_DIR, 'stream-1-1-1');
      mkdirSync(old, { recursive: true });
      writeFileSync(path.join(old, 'chunk-000.wav'), 'old audio');
      const { newStreamDir } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'audio.js')).href)});
      newStreamDir();
      process.stdout.write(JSON.stringify(readdirSync(process.env.READBACK_CACHE_DIR).filter((f) => f.startsWith('stream-'))));
    `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, READBACK_STATE_DIR: cache, READBACK_CACHE_DIR: cache } });
    assert.equal(r.status, 0, r.stderr);
    const left = JSON.parse(r.stdout);
    assert.equal(left.length, 1, `still there: ${left.join(', ')}`);
    assert.notEqual(left[0], 'stream-1-1-1');
  } finally {
    // rmSync has the same trouble with this path; fs.rm does not.
    await rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('muting one agent stops its marked and unmarked players without stopping the other agent', WINDOWS_ONLY, async () => {
  const { stopPlayback } = await import('../src/audio.js');
  const children = [];
  try {
    for (const agent of ['claude', 'codex']) {
      for (const marked of [true, false]) {
        const stream = mkdtempSync(path.join(tmpdir(), 'readback-source-player-'));
        const c = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STREAM_SCRIPT, '-Dir', stream, '-PlayersDir', PLAYERS_DIR, '-Agent', agent], {stdio:'ignore',windowsHide:true});
        children.push({c,agent});
        if (marked) recordPlayer(c.pid, agent);
      }
    }
    await sleep(1000);
    assert.ok(children.every(({c})=>pidAlive(c.pid)), 'fixture players must start');
    stopPlayback('codex');
    for (const {c,agent} of children) {
      if (agent === 'codex') assert.ok(await waitDead(c.pid), 'both Codex players must stop');
      else assert.ok(pidAlive(c.pid), 'Claude must keep playing');
    }
  } finally { for (const {c} of children) { try { c.kill(); } catch {} } }
});

// PowerShell's -like reads [ and ] as a wildcard set, so a profile or cache
// folder with brackets in its name made the backstop sweep match nothing.
test('the sweep still finds players when the folder has brackets in its name', { ...WINDOWS_ONLY, timeout: 30000 }, () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'readback-[sweep] '));
  const child = path.join(cache, 'child.mjs');
  writeFileSync(child, `
    import { spawn } from 'node:child_process';
    import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const { PLAYERS_DIR, sweepPlayers, pidAlive } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'players.js')).href)});
    const { STREAM_SCRIPT } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'config.js')).href)});
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    mkdirSync(PLAYERS_DIR, { recursive: true });
    const stream = mkdtempSync(path.join(PLAYERS_DIR, 'stream-'));
    const player = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STREAM_SCRIPT,
      '-Dir', stream, '-PlayersDir', PLAYERS_DIR], { stdio: 'ignore', windowsHide: true });
    await sleep(1500);
    const before = pidAlive(player.pid);
    sweepPlayers();
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) { await sleep(100); dead = !pidAlive(player.pid); }
    writeFileSync(path.join(stream, 'end.marker'), '0');
    try { player.kill(); } catch {}
    process.stdout.write(JSON.stringify({ before, dead }));
  `);
  const r = spawnSync(process.execPath, [child], {
    encoding: 'utf8', windowsHide: true, timeout: 25000,
    env: { ...process.env, READBACK_STATE_DIR: cache, READBACK_CACHE_DIR: cache },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { before: true, dead: true });
});

// A marker untouched for two minutes is swept as garbage, but a sleep or a
// hung audio device can do that to a player that is still alive. It used to
// stay gone, so the queue let the next reply start on top of it and Stop could
// reach it only through the slower command-line sweep.
test('a live player puts its marker back after it was swept', { ...WINDOWS_ONLY, timeout: 20000 }, async () => {
  mkdirSync(PLAYERS_DIR, { recursive: true });
  const streamDir = mkdtempSync(path.join(tmpdir(), 'readback-marker-'));
  // Started without a marker, exactly as if it had been swept already.
  const player = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STREAM_SCRIPT, '-Dir', streamDir, '-PlayersDir', PLAYERS_DIR, '-Agent', 'codex'],
    { stdio: 'ignore', windowsHide: true }
  );
  try {
    const marker = markerPath(player.pid);
    const deadline = Date.now() + 10000;
    while (!existsSync(marker) && Date.now() < deadline) await sleep(100);
    assert.ok(existsSync(marker), 'the player wrote its marker back');
    const data = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(data.pid, player.pid);
    assert.equal(data.agent, 'codex');
    assert.ok(Math.abs(data.started - Date.now()) < 15000, 'it records its own start time, so a kill can verify it');
    assert.ok(livePlayers().some((p) => p.pid === player.pid && p.agent === 'codex'));
  } finally {
    writeFileSync(path.join(streamDir, 'end.marker'), '0');
    try { player.kill(); } catch {}
    forgetPlayer(player.pid);
  }
});
