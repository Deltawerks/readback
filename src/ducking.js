// The ducking referee. Each tick it decides how loud other apps and ReadBack's
// own voice should be, from facts the driver hands it: the ducking settings,
// the pids of ReadBack's live players, and the audio helper's latest report.
// It returns commands for the helper and touches nothing itself, so every rule
// here runs under a fake clock in test/ducking.test.js.
//
// Two dimmers:
//   others  every app that is playing, except ReadBack, the dictation apps,
//           system sounds and the never-lower list. Down while ReadBack speaks
//           or while you dictate.
//   voice   ReadBack's own players. Down while you dictate, so a reply that
//           lands mid-sentence can't blast into your voice-to-text.

export const TIMING = Object.freeze({ tickMs: 50, holdMs: 800, attackMs: 200, releaseMs: 1200 });
export const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Smallest level change worth a command.
const SEND_STEP = 0.005;
// A reported level this far from the one we set means the user moved it.
const MANUAL_DELTA = 0.02;
// Slack below the lowered level when matching a leftover to a reopened app.
const RECOVERY_SLACK = 0.02;
// ReadBack's players and its audio helper run as powershell.exe. They are
// handled by pid as ReadBack's own voice; this name check is a second guard so
// they are never lowered as "other audio", even before their marker is read.
const NEVER_OTHERS = new Set(['powershell', 'pwsh']);

const r3 = (x) => Math.round(x * 1000) / 1000;
const lower = (s) => String(s || '').toLowerCase();
const pct = (x) => `${Math.round(x * 100)}%`;
const validEntry = (e) =>
  Boolean(e) && typeof e.name === 'string' && e.name !== '' && [e.orig, e.low, e.at].every(Number.isFinite);

function ramp(value, target, depth, dt) {
  const span = Math.max(1 - depth, 0.01);
  if (value > target) return Math.max(target, value - (span * dt) / TIMING.attackMs);
  if (value < target) return Math.min(target, value + (span * dt) / TIMING.releaseMs);
  return value;
}

export function createReferee({ recovery = [], log = () => {} } = {}) {
  let seq = 0;
  let lastNow = null;
  let factor = 1; // others: 1 = untouched, depth = fully lowered
  let voiceFactor = 1; // ReadBack: 1 = full, voiceDepth = whisper
  let lastOthers = -Infinity;
  let lastVoice = -Infinity;
  let othersWasDown = false;
  let voiceWasLow = false;
  // Apps lowered in the current dip, by the helper's session key.
  const ducked = new Map(); // key -> { name, orig, low, sent, sentSeq, user, at }
  // ReadBack players we have armed, by pid.
  const players = new Map(); // pid -> { sent, sentSeq, user }
  // Apps left lowered by a previous run, or closed mid-dip. Windows hands a
  // reopened app the level it last had, so these come back quiet unless we put
  // them back.
  let pending = recovery.filter(validEntry).map(({ name, orig, low, at }) => ({ name, orig, low, at }));
  let version = 1; // starts "changed", so the first tick reports the list
  let reported = 0;
  const touch = () => {
    version++;
  };

  function send(commands, command) {
    const c = { ...command, seq: ++seq };
    commands.push(c);
    return c;
  }

  function eligible(o, f) {
    const name = lower(o.name);
    return (
      !o.system &&
      o.pid > 0 &&
      name !== '' &&
      o.vol >= 0 &&
      !f.pids.has(o.pid) &&
      !NEVER_OTHERS.has(name) &&
      !f.mic.has(name) &&
      !f.never.has(name)
    );
  }

  // A leftover for this app, if its level still says we lowered it: anywhere
  // between what we left it at and its original (a crash mid-fade lands in
  // between). Any other level means the user has set it since, so the entry is
  // dropped either way.
  function takePending(o) {
    const i = pending.findIndex((p) => lower(p.name) === lower(o.name));
    if (i < 0) return null;
    const [p] = pending.splice(i, 1);
    touch();
    return o.vol >= p.low - RECOVERY_SLACK && o.vol <= p.orig - SEND_STEP ? p : null;
  }

  function resolvePending(helper, commands, now) {
    const before = pending.length;
    pending = pending.filter((p) => now - p.at < RECOVERY_MAX_AGE_MS);
    if (pending.length !== before) touch();
    if (!pending.length || factor < 1) return; // mid-dip, a reopened app rejoins through takePending
    for (const o of helper.out) {
      if (!o.name || o.vol < 0) continue;
      const p = takePending(o);
      if (!p) continue;
      send(commands, { c: 'set', key: o.key, vol: p.orig });
      log(`ducking: put ${o.name} back to ${pct(p.orig)}; it had been left lowered`);
    }
  }

  function setLevel(commands, key, vol, e) {
    const c = send(commands, { c: 'set', key, vol, orig: e.orig });
    e.sent = vol;
    e.sentSeq = c.seq;
  }

  function driveOthers(helper, commands, now, f, s) {
    // At a target, converge exactly; in between, only send changes worth it.
    const settled = factor === 1 || factor === s.depth;
    const seen = new Set();
    for (const o of helper.out) {
      seen.add(o.key);
      const e = ducked.get(o.key);
      if (e) {
        if (e.user) continue;
        if (!eligible(o, f)) {
          // Moved to never-lower (or made a dictation app) mid-dip: back now.
          send(commands, { c: 'set', key: o.key, vol: e.orig });
          send(commands, { c: 'forget', key: o.key });
          ducked.delete(o.key);
          touch();
          continue;
        }
        if (helper.seq >= e.sentSeq && Math.abs(o.vol - e.sent) > MANUAL_DELTA) {
          e.user = true;
          send(commands, { c: 'forget', key: o.key });
          touch();
          log(`ducking: you changed ${o.name}'s volume during a dip; leaving it alone`);
          continue;
        }
        const low = r3(e.orig * s.depth);
        if (low !== e.low) {
          e.low = low;
          touch();
        }
        const level = r3(e.orig * factor);
        if (Math.abs(level - e.sent) >= SEND_STEP || (settled && level !== e.sent)) setLevel(commands, o.key, level, e);
        continue;
      }
      if (factor < 1 && o.playing && eligible(o, f)) {
        const leftover = takePending(o);
        const orig = leftover ? leftover.orig : o.vol;
        const entry = { name: o.name, orig, low: r3(orig * s.depth), sent: o.vol, sentSeq: Infinity, user: false, at: now };
        ducked.set(o.key, entry);
        touch();
        setLevel(commands, o.key, r3(orig * factor), entry);
      }
    }
    for (const [key, e] of ducked) {
      if (seen.has(key)) continue;
      // Closed mid-dip. Windows will give its next session the level we left,
      // so keep a leftover and put it back when the app returns.
      ducked.delete(key);
      if (!e.user && e.sent < e.orig - SEND_STEP) pending.push({ name: e.name, orig: e.orig, low: e.low, at: now });
      touch();
    }
  }

  function drivePlayers(helper, commands, f, s) {
    // Every live ReadBack player is armed at the current voice level, full
    // included. Windows can hand a lowered level on to the next powershell.exe,
    // and arming each new player at the level we mean is what keeps ReadBack
    // from staying quiet after a dip.
    const level = r3(voiceFactor);
    const settled = voiceFactor === 1 || voiceFactor === s.voiceDepth;
    for (const pid of f.pids) {
      let p = players.get(pid);
      if (!p) {
        p = { sent: null, sentSeq: Infinity, user: false };
        players.set(pid, p);
      }
      if (p.user) continue;
      const o = helper.out.find((x) => x.pid === pid && x.vol >= 0);
      if (o && p.sent !== null && helper.seq >= p.sentSeq && Math.abs(o.vol - p.sent) > MANUAL_DELTA) {
        p.user = true; // dragged by hand mid-sentence: that player is theirs
        send(commands, { c: 'arm', pid, vol: null });
        continue;
      }
      if (p.sent === null || Math.abs(level - p.sent) >= SEND_STEP || (settled && level !== p.sent)) {
        const c = send(commands, { c: 'arm', pid, vol: level });
        p.sent = level;
        p.sentSeq = c.seq;
      }
    }
    for (const pid of [...players.keys()]) {
      if (f.pids.has(pid)) continue;
      players.delete(pid);
      send(commands, { c: 'arm', pid, vol: null }); // finished: the helper can forget it
    }
  }

  function endEpisode(commands) {
    for (const [key, e] of ducked) if (!e.user) send(commands, { c: 'forget', key });
    ducked.clear();
    touch();
  }

  // Everything back now, no fade: switching off, and the restore button.
  function restore(commands, helper) {
    let count = 0;
    for (const [key, e] of ducked) {
      if (e.user) continue;
      send(commands, { c: 'set', key, vol: e.orig });
      send(commands, { c: 'forget', key });
      count++;
    }
    ducked.clear();
    for (const [pid, p] of players) {
      if (!p.user && p.sent !== 1) send(commands, { c: 'arm', pid, vol: 1 });
      send(commands, { c: 'arm', pid, vol: null });
    }
    players.clear();
    if (helper) {
      for (const o of helper.out) {
        if (!o.name || o.vol < 0) continue;
        const i = pending.findIndex((p) => lower(p.name) === lower(o.name));
        if (i < 0) continue;
        const [p] = pending.splice(i, 1);
        if (o.vol < p.orig - SEND_STEP) {
          send(commands, { c: 'set', key: o.key, vol: p.orig });
          count++;
        }
      }
    }
    factor = 1;
    voiceFactor = 1;
    lastOthers = -Infinity;
    lastVoice = -Infinity;
    touch();
    return count;
  }

  function finish(commands, micUsers, speech) {
    const othersDown = factor < 1;
    const voiceLow = voiceFactor < 1;
    if (othersDown !== othersWasDown) {
      othersWasDown = othersDown;
      const why = [speech ? 'ReadBack speaking' : '', ...micUsers.map((n) => `${n} mic open`)].filter(Boolean).join(', ');
      log(othersDown ? `ducking: lowering other audio (${why || 'holding'})` : 'ducking: other audio back up');
    }
    if (voiceLow !== voiceWasLow) {
      voiceWasLow = voiceLow;
      log(voiceLow ? 'ducking: ReadBack lowered under the mic' : 'ducking: ReadBack back to full');
    }
    let recoveryList = null;
    if (version !== reported) {
      reported = version;
      recoveryList = [
        ...pending.map((p) => ({ ...p })),
        ...[...ducked.values()].filter((e) => !e.user).map(({ name, orig, low, at }) => ({ name, orig, low, at })),
      ];
    }
    return {
      commands,
      recovery: recoveryList,
      status: {
        others: othersDown ? 'down' : 'idle',
        voice: voiceLow ? 'low' : 'full',
        sources: [...(speech ? ['speech'] : []), ...micUsers.map((n) => `mic:${n}`)],
        apps: [...ducked.values()].filter((e) => !e.user).map((e) => ({ name: e.name, orig: e.orig, vol: e.sent })),
      },
    };
  }

  function tick({ now, settings, readbackPids = [], helper = null }) {
    const commands = [];
    const dt = lastNow === null ? 0 : Math.min(Math.max(now - lastNow, 0), 1000);
    lastNow = now;
    const s = settings || {};
    const f = {
      pids: new Set(readbackPids),
      mic: new Set((s.micApps || []).map(lower)),
      never: new Set((s.neverDuck || []).map(lower)),
    };
    const micUsers = helper ? helper.mic.filter((m) => m.active && f.mic.has(lower(m.name))).map((m) => m.name) : [];
    const speech = f.pids.size > 0;

    if (s.enabled !== true) {
      if (ducked.size || players.size || factor < 1 || voiceFactor < 1) {
        restore(commands, helper);
        log('ducking: switched off; everything put back');
      }
      return finish(commands, micUsers, speech);
    }

    const othersOn = (s.onSpeech && speech) || (s.onMic && micUsers.length > 0);
    const voiceOn = s.voiceUnderMic && micUsers.length > 0;
    if (othersOn) lastOthers = now;
    if (voiceOn) lastVoice = now;
    const othersTarget = othersOn || now - lastOthers < TIMING.holdMs ? s.depth : 1;
    const voiceTarget = voiceOn || now - lastVoice < TIMING.holdMs ? s.voiceDepth : 1;
    factor = ramp(factor, othersTarget, s.depth, dt);
    voiceFactor = ramp(voiceFactor, voiceTarget, s.voiceDepth, dt);

    if (helper) {
      resolvePending(helper, commands, now);
      driveOthers(helper, commands, now, f, s);
      drivePlayers(helper, commands, f, s);
      if (factor === 1 && ducked.size) endEpisode(commands);
    }
    return finish(commands, micUsers, speech);
  }

  function restoreAll(helper = null) {
    const commands = [];
    const restored = restore(commands, helper);
    if (restored) log(`ducking: restore button put back ${restored} app${restored === 1 ? '' : 's'}`);
    return { ...finish(commands, [], false), restored };
  }

  // A restarted helper remembers nothing: re-send every level, with its
  // original, and every arm on the next tick.
  function helperRestarted() {
    for (const e of ducked.values()) {
      e.sent = -1;
      e.sentSeq = Infinity;
    }
    for (const p of players.values()) {
      p.sent = null;
      p.sentSeq = Infinity;
    }
  }

  return { tick, restoreAll, helperRestarted };
}
