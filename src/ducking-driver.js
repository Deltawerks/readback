import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DUCKING_FILE } from './config.js';
import { readState } from './state.js';
import { livePlayers } from './players.js';
import { createReferee, TIMING, RECOVERY_MAX_AGE_MS } from './ducking.js';
import { createHelperSupervisor } from './ducking-helper.js';
import { log as defaultLog } from './log.js';

// With ducking off, the helper still runs this long after the panel starts, a
// switch-off, or a restore press whenever leftovers remain, so apps a crash or
// an unheard put-back left lowered still go back.
const CLEANUP_MS = 30 * 1000;
// The helper reports at least every 2 s; this much silence means it is hung.
const STALE_MS = 6 * 1000;
// A report older than this may come from a helper that has hung. The referee
// is handed nothing until a fresh one arrives, so it sends nothing into a
// pipe that nobody may be reading.
const FRESH_MS = 3 * 1000;
// Ticks come every 50 ms. A gap this long is this process's own pause (sleep,
// a blocked event loop), not the helper's silence.
const PAUSE_MS = 2 * 1000;

// Apps we lowered and their original levels, kept in the cache dir (never with
// settings), so a power cut mid-dip can be undone on the next panel start.
export function loadRecovery(file = DUCKING_FILE, now = Date.now()) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    return entries.filter(
      (e) =>
        e && typeof e.name === 'string' && e.name !== '' &&
        [e.orig, e.low, e.at].every(Number.isFinite) && now - e.at < RECOVERY_MAX_AGE_MS
    );
  } catch {
    return [];
  }
}

export function saveRecovery(entries, file = DUCKING_FILE, log = defaultLog) {
  try {
    if (!entries.length) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, entries }));
    renameSync(tmp, file);
  } catch (err) {
    log(`ducking: could not save recovery state: ${err.message}`);
  }
}

// Runs the referee inside the panel server: ticks it every 50 ms with the
// current settings, ReadBack's live players and the helper's latest report, and
// carries out what it decides. The audio helper runs only while ducking is on.
export function createDuckingDriver({
  readSettings = () => readState().ducking,
  readPlayers = () => livePlayers().map((p) => p.pid),
  makeSupervisor = (callbacks) => createHelperSupervisor(callbacks),
  recoveryFile = DUCKING_FILE,
  platform = process.platform,
  helperMode = process.env.READBACK_DUCKING_HELPER,
  log = defaultLog,
  clock = () => Date.now(),
} = {}) {
  const leftovers = loadRecovery(recoveryFile, clock());
  const referee = createReferee({ recovery: leftovers, log });
  const status = { helper: 'off', others: 'idle', voice: 'full', sources: [], apps: [], lastError: null };
  let settings = null;
  let settingsAt = -Infinity;
  let pids = [];
  let playersAt = -Infinity;
  let helperState = null;
  let timer = null;
  let recoveryCount = leftovers.length;
  let cleanupUntil = clock() + CLEANUP_MS;
  let lastReportAt = -Infinity;
  let lastTickAt = null;
  let wasOn = false;
  const cleaning = (now) => recoveryCount > 0 && now < cleanupUntil;

  let supervisor = null;
  if (platform !== 'win32') status.helper = 'unsupported';
  else if (helperMode === 'off') status.helper = 'disabled';
  else {
    supervisor = makeSupervisor({
      onMessage: (m) => {
        if (m.t === 'ready') {
          lastReportAt = clock();
          helperState = null;
          referee.helperRestarted();
        } else if (m.t === 'state') {
          lastReportAt = clock();
          helperState = {
            seq: Number(m.seq) || 0,
            mic: Array.isArray(m.mic) ? m.mic : [],
            out: Array.isArray(m.out) ? m.out : [],
          };
        } else if (m.t === 'log') {
          log(`ducking: helper: ${m.msg}`);
        }
      },
      onStatus: (s, detail) => {
        status.helper = s;
        if (detail) status.lastError = detail;
        if (s !== 'ready') helperState = null;
      },
      log,
    });
  }

  function apply(out) {
    for (const c of out.commands) supervisor?.send(c);
    if (out.recovery) {
      saveRecovery(out.recovery, recoveryFile, log);
      recoveryCount = out.recovery.length;
    }
    Object.assign(status, out.status);
  }

  const freshHelper = (now) => (helperState && now - lastReportAt <= FRESH_MS ? helperState : null);

  function tick() {
    const now = clock();
    // After a pause of our own, or a clock set back, start the helper's count
    // again and wait for a report taken since: the last one may be long stale.
    if (lastTickAt !== null && (now - lastTickAt > PAUSE_MS || now < lastTickAt)) {
      lastReportAt = now;
      helperState = null;
    }
    lastTickAt = now;
    if (now - settingsAt >= 500) {
      settingsAt = now;
      try {
        settings = readSettings();
      } catch {
        // Unreadable for a moment (antivirus, a write in progress): keep the
        // last good copy rather than reading it as "off" and restoring mid-dip.
      }
    }
    if (now - playersAt >= 100) {
      playersAt = now;
      try {
        pids = readPlayers();
      } catch {
        pids = [];
      }
    }
    const on = settings?.enabled === true;
    if (wasOn && !on) cleanupUntil = now + CLEANUP_MS; // switched off: let the put-backs land
    wasOn = on;
    if (on || cleaning(now)) supervisor?.start();
    if (supervisor && status.helper === 'ready' && now - lastReportAt > STALE_MS) {
      log('ducking: the audio helper stopped reporting; restarting it');
      lastReportAt = now;
      helperState = null;
      supervisor.restart();
    }
    apply(referee.tick({ now, settings, readbackPids: pids, helper: freshHelper(now) }));
    // Off with nothing left to clean up: the put-backs above are already queued
    // on the helper's stdin, ahead of the EOF that stop() sends.
    // stop() also cancels a restart that is waiting out its backoff.
    if (!on && !cleaning(now)) {
      helperState = null;
      supervisor?.stop();
    }
  }

  return {
    start() {
      if (!timer) {
        timer = setInterval(tick, TIMING.tickMs);
        timer.unref?.();
      }
      tick();
    },
    // Panel shutdown. Closing the helper's stdin makes it put back whatever it
    // lowered before it exits; a hard kill gets the same from the EOF.
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      supervisor?.stop();
    },
    tick,
    settingsChanged() {
      settingsAt = -Infinity;
    },
    restoreNow() {
      const out = referee.restoreAll(freshHelper(clock()));
      apply(out);
      // Whatever could not be put back yet gets a cleanup run, ducking on or off.
      cleanupUntil = clock() + CLEANUP_MS;
      return { restored: out.restored, waiting: out.waiting };
    },
    status: () => ({ ...status }),
  };
}
