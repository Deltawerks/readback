import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DIR = mkdtempSync(path.join(tmpdir(), 'readback-ducking-driver-'));
process.env.READBACK_STATE_DIR = DIR;
process.env.READBACK_CACHE_DIR = DIR;

const { createDuckingDriver, loadRecovery, saveRecovery } = await import('../src/ducking-driver.js');
const { TIMING } = await import('../src/ducking.js');

const ON = {
  enabled: true,
  onSpeech: true,
  onMic: true,
  voiceUnderMic: true,
  depth: 0.1,
  voiceDepth: 0.15,
  micApps: ['claude', 'ChatGPT'],
  neverDuck: [],
};
const MB = { key: 'mb', pid: 50, name: 'MusicBee', vol: 0.8, playing: true, system: false };

// A driver wired to a fake supervisor that records what it is asked to do,
// in order, in r.events.
function rig({ platform = 'win32', helperMode, settings = ON, recovery } = {}) {
  const fake = { cb: null, running: false };
  const r = {
    settings,
    players: [],
    now: 1_000_000,
    events: [],
    logs: [],
    file: path.join(mkdtempSync(path.join(DIR, 'rig-')), 'ducking.json'),
  };
  if (recovery) writeFileSync(r.file, JSON.stringify({ v: 1, entries: recovery }));
  r.driver = createDuckingDriver({
    readSettings: () => {
      if (r.settings instanceof Error) throw r.settings;
      return r.settings;
    },
    readPlayers: () => r.players,
    makeSupervisor: (cb) => {
      fake.cb = cb;
      return {
        start() {
          if (!fake.running) {
            fake.running = true;
            r.events.push('start');
          }
        },
        stop() {
          if (fake.running) {
            fake.running = false;
            r.events.push('stop');
          }
        },
        send(c) {
          r.events.push(c);
          return true;
        },
        restart() {
          r.events.push('restart');
        },
        running: () => fake.running,
        status: () => (fake.running ? 'ready' : 'off'),
      };
    },
    recoveryFile: r.file,
    platform,
    helperMode,
    log: (m) => r.logs.push(m),
    clock: () => r.now,
  });
  r.report = (out, mic = []) => {
    fake.cb.onStatus('ready');
    fake.cb.onMessage({ t: 'ready', v: 1 });
    fake.cb.onMessage({ t: 'state', seq: 0, mic, out });
  };
  r.run = (ms) => {
    for (let t = 0; t < ms; t += TIMING.tickMs) {
      r.driver.tick();
      r.now += TIMING.tickMs;
    }
  };
  r.sets = () => r.events.filter((e) => e && e.c === 'set');
  return r;
}

test('switching on starts the helper, and a dip records a leftover for crash recovery', () => {
  const r = rig();
  r.driver.tick();
  assert.deepEqual(r.events, ['start']);
  r.report([MB]);
  r.players = [7];
  r.run(400);
  assert.ok(r.sets().some((c) => c.key === 'mb' && c.orig === 0.8));
  const saved = JSON.parse(readFileSync(r.file, 'utf8'));
  assert.deepEqual(saved.entries.map((e) => e.name), ['MusicBee']);
});

test('switching off sends the put-backs before it closes the helper', () => {
  const r = rig();
  r.driver.tick();
  r.report([MB]);
  r.players = [7];
  r.run(400);
  r.settings = { ...ON, enabled: false };
  r.now += 600; // past the settings re-read interval
  r.driver.tick();
  const stopAt = r.events.lastIndexOf('stop');
  const putBack = r.events.findLastIndex((e) => e && e.c === 'set' && e.key === 'mb' && e.vol === 0.8);
  assert.ok(putBack >= 0 && putBack < stopAt, 'restore first, then close');
  assert.equal(existsSync(r.file), false, 'nothing left to recover');
});

// Review focus 3.
test('a settings file that cannot be read for a moment changes nothing mid-dip', () => {
  const r = rig();
  r.driver.tick();
  r.report([MB]);
  r.players = [7];
  r.run(400);
  const before = r.events.length;
  r.settings = new Error('EBUSY: antivirus has it open');
  r.now += 600;
  r.driver.tick();
  assert.equal(r.driver.status().others, 'down');
  assert.ok(!r.events.slice(before).some((e) => e === 'stop' || (e && e.c === 'set' && e.vol === 0.8)));
});

test('leftovers load from disk, old ones are dropped, and an empty list removes the file', () => {
  const file = path.join(mkdtempSync(path.join(DIR, 'rec-')), 'ducking.json');
  const now = 2_000_000_000;
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      entries: [
        { name: 'MusicBee', orig: 0.8, low: 0.08, at: now - 1000 },
        { name: 'Old', orig: 0.5, low: 0.05, at: now - 8 * 24 * 60 * 60 * 1000 },
        { name: 42 },
      ],
    })
  );
  assert.deepEqual(loadRecovery(file, now).map((e) => e.name), ['MusicBee']);
  saveRecovery([], file);
  assert.equal(existsSync(file), false);
  assert.deepEqual(loadRecovery(file, now), []);
});

test('the helper is never started off Windows, or when tests switch it off', () => {
  const linux = rig({ platform: 'linux' });
  linux.driver.tick();
  assert.equal(linux.driver.status().helper, 'unsupported');
  assert.deepEqual(linux.events, []);
  const off = rig({ helperMode: 'off' });
  off.driver.tick();
  assert.equal(off.driver.status().helper, 'disabled');
  assert.deepEqual(off.events, []);
});

test('the restore button reports how many apps it put back', () => {
  const r = rig();
  r.driver.tick();
  r.report([MB]);
  r.players = [7];
  r.run(400);
  assert.deepEqual(r.driver.restoreNow(), { restored: 1, waiting: 0 });
  assert.ok(r.sets().some((c) => c.key === 'mb' && c.vol === 0.8));
});

// A crash or power cut can leave an app lowered while ducking is now off. The
// leftover has to be put back anyway, so a short cleanup run starts the
// helper, and stops it again once nothing is left to do.
test('with ducking off, a leftover from a crash is still put back by a short cleanup run', () => {
  const r = rig({
    settings: { ...ON, enabled: false },
    recovery: [{ name: 'MusicBee', orig: 0.8, low: 0.08, at: 1_000_000 - 1000 }],
  });
  r.driver.tick();
  assert.deepEqual(r.events, ['start'], 'the cleanup run starts the helper');
  r.report([{ ...MB, vol: 0.08 }]);
  r.driver.tick();
  assert.ok(r.sets().some((c) => c.key === 'mb' && c.vol === 0.8));
  assert.equal(r.events.at(-1), 'stop', 'and stops it once nothing is left');
});

test('a helper that stops reporting is restarted', () => {
  const r = rig();
  r.driver.tick();
  r.report([MB]);
  r.run(7000);
  assert.ok(r.events.includes('restart'));
  assert.ok(r.logs.some((l) => /stopped reporting/.test(l)));
});
