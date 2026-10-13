import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReferee, TIMING } from '../src/ducking.js';

// A fake Windows mixer that behaves like the audio helper: a session keeps the
// level we set, a new session of an armed process starts at the armed level,
// and every report echoes the last command applied.
function fakeAudio() {
  const out = new Map();
  const mic = new Map();
  const arms = new Map();
  let seq = 0;
  let nextPid = 1000;
  return {
    play(key, name, vol = 1, { pid = nextPid++, system = false, playing = true } = {}) {
      out.set(key, { key, pid, name, vol: arms.has(pid) ? arms.get(pid) : vol, playing, system });
    },
    close(key) {
      out.delete(key);
    },
    userSets(key, vol) {
      out.get(key).vol = vol;
    },
    mic(name, active, pid = 5000) {
      mic.set(name, { pid, name, active });
    },
    apply(commands) {
      for (const c of commands) {
        seq = Math.max(seq, c.seq);
        if (c.c === 'set' && out.has(c.key)) out.get(c.key).vol = c.vol;
        if (c.c === 'arm' && c.vol === null) arms.delete(c.pid);
        if (c.c === 'arm' && c.vol !== null) {
          arms.set(c.pid, c.vol);
          for (const s of out.values()) if (s.pid === c.pid) s.vol = c.vol;
        }
      }
    },
    // A restarted helper: Windows keeps the levels, the helper forgets the rest.
    restartHelper() {
      seq = 0;
      arms.clear();
    },
    state() {
      return { seq, mic: [...mic.values()].map((m) => ({ ...m })), out: [...out.values()].map((s) => ({ ...s })) };
    },
    vol(key) {
      return out.get(key)?.vol;
    },
  };
}

const SETTINGS = Object.freeze({
  enabled: true,
  onSpeech: true,
  onMic: true,
  voiceUnderMic: true,
  depth: 0.1,
  voiceDepth: 0.15,
  micApps: ['claude', 'ChatGPT'],
  neverDuck: [],
});

// Drives a referee against the fake in 50 ms ticks, feeding every command back
// into the fake the way the driver feeds the real helper.
function harness({ settings = SETTINGS, recovery = [], start = 1_000_000 } = {}) {
  const h = {
    logs: [],
    audio: fakeAudio(),
    settings: { ...settings },
    pids: [],
    now: start,
    sent: [],
    recovery: null,
    last: null,
    step() {
      const out = h.ref.tick({ now: h.now, settings: h.settings, readbackPids: h.pids, helper: h.audio.state() });
      h.audio.apply(out.commands);
      h.sent.push(...out.commands);
      if (out.recovery) h.recovery = out.recovery;
      h.last = out;
      h.now += TIMING.tickMs;
      return out;
    },
    run(ms) {
      for (let t = 0; t < ms; t += TIMING.tickMs) h.step();
      return h.last;
    },
  };
  h.ref = createReferee({ recovery, log: (m) => h.logs.push(m) });
  return h;
}

// Long enough for any dip to finish: the hold, the fade back, and some slack.
const GONE = TIMING.holdMs + TIMING.releaseMs + 200;

test('ReadBack speaking lowers other audio, and it comes back exactly afterwards', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.step();
  h.pids = [4242];
  h.run(300);
  assert.equal(h.audio.vol('mb'), 0.08);
  assert.equal(h.last.status.others, 'down');
  assert.deepEqual(h.last.status.sources, ['speech']);
  h.pids = [];
  h.run(TIMING.holdMs - 100);
  assert.equal(h.audio.vol('mb'), 0.08, 'the hold keeps it down for a moment');
  h.run(GONE);
  assert.equal(h.audio.vol('mb'), 0.8);
  assert.equal(h.last.status.others, 'idle');
  assert.deepEqual(h.recovery, []);
});

test('dictating into a listed app lowers other audio until the mic closes', () => {
  const h = harness();
  h.audio.play('sp', 'Spotify', 0.6);
  h.audio.mic('claude', true);
  h.run(300);
  assert.equal(h.audio.vol('sp'), 0.06);
  assert.deepEqual(h.last.status.sources, ['mic:claude']);
  h.audio.mic('claude', false);
  h.run(GONE);
  assert.equal(h.audio.vol('sp'), 0.6);
});

test('ReadBack finishing does not bring the music back while you are still dictating', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(300);
  h.audio.mic('ChatGPT', true);
  h.run(300);
  h.pids = [];
  h.run(3000);
  assert.equal(h.audio.vol('mb'), 0.08);
  h.audio.mic('ChatGPT', false);
  h.run(GONE);
  assert.equal(h.audio.vol('mb'), 0.8);
});

test('a short gap between queued replies does not bounce the music', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [1];
  h.run(1000);
  h.pids = [];
  const during = [];
  for (let t = 0; t < 500; t += TIMING.tickMs) {
    h.step();
    during.push(h.audio.vol('mb'));
  }
  h.pids = [2];
  h.run(500);
  assert.ok(during.every((v) => v === 0.08), `stayed down through the gap: ${during}`);
});

test('ReadBack, the dictation apps, system sounds and never-lower apps are left alone', () => {
  const h = harness({ settings: { ...SETTINGS, neverDuck: ['Discord'] } });
  h.audio.play('rb', 'powershell', 1, { pid: 7 });
  h.audio.play('helper', 'powershell', 1, { pid: 8 });
  h.audio.play('cl', 'claude', 0.9);
  h.audio.play('sys', '', 1, { pid: 0, system: true });
  h.audio.play('dc', 'Discord', 0.7);
  h.audio.play('sp', 'Spotify', 0.6);
  h.pids = [7];
  h.run(400);
  assert.equal(h.audio.vol('sp'), 0.06);
  assert.equal(h.audio.vol('rb'), 1);
  assert.equal(h.audio.vol('helper'), 1);
  assert.equal(h.audio.vol('cl'), 0.9);
  assert.equal(h.audio.vol('sys'), 1);
  assert.equal(h.audio.vol('dc'), 0.7);
});

test('a level the user changes mid-dip is theirs: no more sets and no restore over it', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(300);
  h.audio.userSets('mb', 0.5);
  const out = h.step();
  assert.ok(out.commands.some((c) => c.c === 'forget' && c.key === 'mb'));
  h.pids = [];
  h.run(GONE);
  assert.equal(h.audio.vol('mb'), 0.5);
  assert.ok(!h.recovery.some((e) => e.name === 'MusicBee'));
  assert.ok(h.logs.some((l) => /leaving it alone/.test(l)));
});

test('switching ducking off mid-dip puts everything back at once', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(300);
  h.settings = { ...h.settings, enabled: false };
  const out = h.step();
  assert.equal(h.audio.vol('mb'), 0.8);
  assert.ok(out.commands.some((c) => c.c === 'forget' && c.key === 'mb'));
  assert.equal(out.status.others, 'idle');
  assert.deepEqual(h.recovery, []);
  assert.deepEqual(h.step().commands, [], 'nothing more to do while off');
});

test('an app that starts playing mid-dip joins it', () => {
  const h = harness();
  h.pids = [7];
  h.run(300);
  h.audio.play('sp', 'Spotify', 0.6);
  h.step();
  assert.equal(h.audio.vol('sp'), 0.06);
});

test('an app closed mid-dip is put back when it reopens at the level we left', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(300);
  h.audio.close('mb');
  h.step();
  assert.deepEqual(h.recovery.map((e) => [e.name, e.orig, e.low]), [['MusicBee', 0.8, 0.08]]);
  h.pids = [];
  h.run(GONE);
  h.audio.play('mb2', 'MusicBee', 0.08); // Windows hands the new session the lowered level
  h.step();
  assert.equal(h.audio.vol('mb2'), 0.8);
  assert.deepEqual(h.recovery, []);
});

test('leftovers from a previous run are put back, unless the user changed them or they are old', () => {
  const start = 1_000_000_000;
  const h = harness({
    start,
    recovery: [
      { name: 'MusicBee', orig: 0.8, low: 0.08, at: start - 1000 },
      { name: 'Spotify', orig: 0.6, low: 0.06, at: start - 1000 },
      { name: 'foobar2000', orig: 0.9, low: 0.09, at: start - 8 * 24 * 60 * 60 * 1000 },
    ],
  });
  h.audio.play('mb', 'MusicBee', 0.08);
  h.audio.play('sp', 'Spotify', 0.7); // turned up by hand since
  h.audio.play('fb', 'foobar2000', 0.09); // too old to trust
  h.step();
  assert.equal(h.audio.vol('mb'), 0.8);
  assert.equal(h.audio.vol('sp'), 0.7);
  assert.equal(h.audio.vol('fb'), 0.09);
  assert.deepEqual(h.recovery, []);
});

test('only listed dictation apps count, by exact name in any case', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.audio.mic('claude-helper', true, 5001);
  h.run(400);
  assert.equal(h.audio.vol('mb'), 0.8);
  h.audio.mic('CLAUDE', true, 5002);
  h.run(400);
  assert.equal(h.audio.vol('mb'), 0.08);
});

test('a restarted helper gets every level re-sent with its original', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(400);
  h.audio.restartHelper();
  h.ref.helperRestarted();
  const out = h.step();
  const set = out.commands.find((c) => c.c === 'set' && c.key === 'mb');
  assert.ok(set, 'the level is re-sent');
  assert.equal(set.orig, 0.8, 'with its original, so the new helper can restore it if the panel dies');
});

test('nothing is sent while the helper has not reported yet', () => {
  const ref = createReferee();
  assert.deepEqual(ref.tick({ now: 1, settings: SETTINGS, readbackPids: [7], helper: null }).commands, []);
});

test('the restore button puts everything back and reports how many', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(400);
  const out = h.ref.restoreAll(h.audio.state());
  h.audio.apply(out.commands);
  assert.equal(out.restored, 1);
  assert.equal(h.audio.vol('mb'), 0.8);
});

// A put-back that cannot reach a helper must not be forgotten, or the app it
// was for stays quiet with no record left anywhere.
test('with no helper connected, the restore button keeps what it could not put back and says so', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(400);
  h.pids = [];
  const out = h.ref.restoreAll(null);
  assert.equal(out.restored, 0);
  assert.equal(out.waiting, 1);
  assert.deepEqual(out.recovery.map((e) => e.name), ['MusicBee']);
  h.step(); // a helper is reporting again
  assert.equal(h.audio.vol('mb'), 0.8);
});

test('switching off while no helper is connected keeps the leftover and puts it back once one reports', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(400);
  h.settings = { ...h.settings, enabled: false };
  const out = h.ref.tick({ now: h.now, settings: h.settings, readbackPids: [], helper: null });
  h.now += TIMING.tickMs;
  assert.deepEqual(out.commands, [], 'nothing is sent into the void');
  assert.deepEqual(out.recovery.map((e) => e.name), ['MusicBee'], 'still on record');
  h.step(); // ducking is still off, but a helper is reporting again
  assert.equal(h.audio.vol('mb'), 0.8);
});

// A new depth must reach apps already lowered, not only the next dip, and the
// level kept for crash recovery must follow it.
test('dragging the depth slider mid-dip glides other audio to the new level', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.run(400);
  h.settings = { ...h.settings, depth: 0.3 };
  h.run(TIMING.releaseMs);
  assert.equal(h.audio.vol('mb'), 0.24);
  assert.equal(h.recovery.find((e) => e.name === 'MusicBee').low, 0.24);
});

// An app put on the never-lower list mid-dip should not stay quiet until the
// dip ends.
test('adding a lowered app to never-lower puts it back at once', () => {
  const h = harness();
  h.audio.play('dc', 'Discord', 0.7);
  h.pids = [7];
  h.run(400);
  assert.equal(h.audio.vol('dc'), 0.07);
  h.settings = { ...h.settings, neverDuck: ['discord'] };
  h.step();
  assert.equal(h.audio.vol('dc'), 0.7);
});

test('a session whose level could not be read is never touched', () => {
  const h = harness();
  h.audio.play('x', 'Mystery', -1);
  h.pids = [7];
  h.run(400);
  assert.ok(!h.sent.some((c) => c.key === 'x'));
});

// ---- ReadBack under the mic ----

test('while you dictate, ReadBack drops to a whisper and comes back when you stop', () => {
  const h = harness();
  h.audio.play('mb', 'MusicBee', 0.8);
  h.pids = [7];
  h.audio.play('rb', 'powershell', 1, { pid: 7 });
  h.run(300);
  assert.equal(h.audio.vol('rb'), 1);
  h.audio.mic('ChatGPT', true);
  h.run(300);
  assert.equal(h.audio.vol('rb'), 0.15);
  assert.equal(h.audio.vol('mb'), 0.08);
  assert.equal(h.last.status.voice, 'low');
  h.audio.mic('ChatGPT', false);
  h.run(GONE);
  assert.equal(h.audio.vol('rb'), 1, 'ReadBack is back to full');
  assert.equal(h.audio.vol('mb'), 0.08, 'the music stays down while ReadBack is still talking');
  h.pids = [];
  h.audio.close('rb');
  h.run(GONE);
  assert.equal(h.audio.vol('mb'), 0.8);
});

test('a ReadBack reply that starts mid-dictation is quiet from its first sound', () => {
  const h = harness();
  h.audio.mic('claude', true);
  h.run(400);
  h.pids = [9]; // the player's marker appears before it makes a sound
  h.step();
  h.audio.play('rb', 'powershell', 1, { pid: 9 }); // its session appears already armed
  assert.equal(h.audio.vol('rb'), 0.15);
});

test('with nobody dictating, every new player is armed at full', () => {
  const h = harness();
  h.pids = [11];
  const out = h.step();
  assert.ok(out.commands.some((c) => c.c === 'arm' && c.pid === 11 && c.vol === 1));
});

test('a finished player is disarmed', () => {
  const h = harness();
  h.pids = [11];
  h.step();
  h.pids = [];
  const out = h.step();
  assert.ok(out.commands.some((c) => c.c === 'arm' && c.pid === 11 && c.vol === null));
});

test('with lower-ReadBack-while-you-dictate off, ReadBack stays at full under the mic', () => {
  const h = harness({ settings: { ...SETTINGS, voiceUnderMic: false } });
  h.pids = [7];
  h.audio.play('rb', 'powershell', 1, { pid: 7 });
  h.audio.mic('claude', true);
  h.run(600);
  assert.equal(h.audio.vol('rb'), 1);
});

test('dragging a player slider by hand mid-sentence wins for that player', () => {
  const h = harness();
  h.pids = [7];
  h.audio.play('rb', 'powershell', 1, { pid: 7 });
  h.audio.mic('claude', true);
  h.run(400);
  h.audio.userSets('rb', 0.6);
  const out = h.step();
  assert.ok(out.commands.some((c) => c.c === 'arm' && c.pid === 7 && c.vol === null));
  h.audio.mic('claude', false);
  h.run(GONE);
  assert.equal(h.audio.vol('rb'), 0.6);
});

// Players are armed by pid, so one finishing must not release another that is
// still speaking under the mic.
test('two overlapping ReadBack players are each armed, and one ending leaves the other alone', () => {
  const h = harness();
  h.audio.mic('claude', true);
  h.run(400);
  h.pids = [21, 22];
  h.audio.play('p21', 'powershell', 1, { pid: 21 });
  h.audio.play('p22', 'powershell', 1, { pid: 22 });
  h.step();
  assert.equal(h.audio.vol('p21'), 0.15);
  assert.equal(h.audio.vol('p22'), 0.15);
  h.pids = [22];
  h.audio.close('p21');
  const out = h.step();
  assert.ok(out.commands.some((c) => c.c === 'arm' && c.pid === 21 && c.vol === null));
  assert.ok(!out.commands.some((c) => c.c === 'arm' && c.pid === 22 && c.vol === null));
  assert.equal(h.audio.vol('p22'), 0.15);
});
