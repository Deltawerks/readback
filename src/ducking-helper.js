import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { ROOT } from './config.js';

export const HELPER_SCRIPT = path.join(ROOT, 'scripts', 'audio-helper.ps1');
// Started detached, so it lives outside the panel server's job object and the
// helper behind it survives the panel long enough to put levels back. The
// relay's header explains why the helper cannot simply be spawned directly.
export const RELAY_SCRIPT = path.join(ROOT, 'scripts', 'audio-helper-relay.js');
const HELPER_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', HELPER_SCRIPT];
const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];

// Windows PowerShell reads stdin in the console code page, so anything outside
// ASCII (a session id whose path holds an accented user name) would arrive
// mangled and never match. Escape it: JSON parsers turn \uXXXX back into the
// same string.
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Keeps the platform audio helper running while ducking is on: parses its JSON
// lines (anything else on its stdout is ignored), restarts it with backoff
// when it dies, and on stop closes its stdin, which is its signal to put back
// what it lowered and exit.
export function createHelperSupervisor({
  command = process.execPath,
  args = [RELAY_SCRIPT, 'powershell.exe', ...HELPER_ARGS],
  detached = true,
  onMessage = () => {},
  onStatus = () => {},
  log = () => {},
  spawnFn = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let child = null;
  let wanted = false;
  let failures = 0;
  let timer = null;
  let status = 'off';

  function setStatus(next, detail) {
    if (next === status && !detail) return;
    status = next;
    onStatus(next, detail);
  }

  function scheduleRestart(detail) {
    if (!wanted) return;
    const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
    failures++;
    setStatus(failures > 5 ? 'failed' : 'restarting', detail);
    timer = setTimer(launch, delay);
  }

  function launch() {
    timer = null;
    if (!wanted) return;
    setStatus(failures ? 'restarting' : 'starting');
    let proc;
    try {
      proc = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached });
    } catch (err) {
      log(`ducking: could not start the audio helper: ${err.message}`);
      scheduleRestart(err.message);
      return;
    }
    child = proc;
    let stderr = '';
    let finished = false;
    proc.stderr?.on('data', (d) => {
      stderr = (stderr + d).slice(-500);
    });
    proc.stdin?.on('error', () => {});
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // PowerShell noise, a warning, half a line: not ours
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'ready') {
        failures = 0;
        setStatus('ready');
      }
      onMessage(msg);
    });
    const done = (code) => {
      if (finished) return;
      finished = true;
      lines.close();
      if (child === proc) child = null;
      if (!wanted) {
        setStatus('off');
        return;
      }
      const why = stderr.trim().split(/\r?\n/).pop() || `exit code ${code}`;
      log(`ducking: audio helper stopped (${why}); restarting`);
      scheduleRestart(why);
    };
    proc.on('error', (err) => {
      log(`ducking: audio helper error: ${err.message}`);
      if (proc.pid === undefined) done(err.message); // it never started at all
    });
    proc.on('exit', done);
  }

  return {
    start() {
      wanted = true;
      if (!child && !timer) launch();
    },
    stop() {
      wanted = false;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      if (child) {
        try {
          child.stdin.end();
        } catch {
          // already closed
        }
      } else {
        setStatus('off');
      }
    },
    // A helper that stopped reporting: end it hard. Its relay takes it down
    // too, and the exit handler restarts it like any other death.
    restart() {
      if (!child) return;
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
    send(msg) {
      if (!child || !child.stdin || child.stdin.destroyed) return false;
      try {
        child.stdin.write(`${asciiJson(msg)}\n`);
        return true;
      } catch {
        return false;
      }
    },
    running: () => Boolean(child),
    status: () => status,
  };
}
