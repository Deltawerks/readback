import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { ROOT } from './config.js';
import { asciiJson } from './ascii-json.js';

export const HELPER_SCRIPT = path.join(ROOT, 'scripts', 'audio-helper.ps1');
// Started detached, so it lives outside the panel server's job object and the
// helper behind it survives the panel long enough to put levels back. The
// relay's header explains why the helper cannot simply be spawned directly.
export const RELAY_SCRIPT = path.join(ROOT, 'scripts', 'audio-helper-relay.js');
// By full path, so a PATH without System32 cannot make the helper fail with
// nothing but an exit code.
const POWERSHELL = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HELPER_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', HELPER_SCRIPT];
const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
// A helper only counts as healthy again once it has stayed up this long, so
// one that dies right after starting backs off instead of restarting forever.
const HEALTHY_MS = 60 * 1000;

// Keeps the platform audio helper running while ducking is on: parses its JSON
// lines (anything else on its stdout is ignored), restarts it with backoff
// when it dies, and on stop closes its stdin, which is its signal to put back
// what it lowered and exit.
export function createHelperSupervisor({
  command = process.execPath,
  args = [RELAY_SCRIPT, POWERSHELL, ...HELPER_ARGS],
  detached = true,
  onMessage = () => {},
  onStatus = () => {},
  log = () => {},
  spawnFn = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  let child = null;
  let wanted = false;
  let failures = 0;
  let readyAt = null;
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
      if (stderr.length < 2000) stderr += d; // the reason comes first
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
        readyAt = now();
        setStatus('ready');
      }
      onMessage(msg);
    });
    const done = (code) => {
      if (finished) return;
      finished = true;
      lines.close();
      if (child === proc) child = null;
      if (readyAt !== null && now() - readyAt >= HEALTHY_MS) failures = 0;
      readyAt = null;
      if (!wanted) {
        setStatus('off');
        return;
      }
      // PowerShell puts the reason on the first line and its error-record
      // boilerplate after it.
      const why = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || `exit code ${code}`;
      log(`ducking: audio helper stopped (${why}); restarting`);
      scheduleRestart(why);
    };
    proc.on('error', (err) => {
      log(`ducking: audio helper error: ${err.message}`);
      if (proc.pid === undefined) done(err.message); // it never started at all
    });
    // 'close', not 'exit': by then everything it wrote to stderr has arrived.
    proc.on('close', done);
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
