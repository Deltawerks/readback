import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'scripts', 'audio-helper.ps1');
// These run the real audio helper against a silent test app through the real
// Windows mixer, so they are opt-in: `npm run test:audio` sets this. A plain
// `npm test` must never touch anyone's volume levels. Only one audio helper can
// run per Windows session, so switch ReadBack's own ducking off first.
const WIN = process.platform === 'win32' && process.env.READBACK_AUDIO_TESTS === '1';
// A fixed location, so Windows keeps one remembered level for the test app
// rather than one per run.
const TOOLS = path.join(tmpdir(), 'readback-test-tone');
if (WIN) mkdirSync(TOOLS, { recursive: true });

// One second of 16-bit silence. It plays through Windows audio like any app's
// sound, so it gets a real per-app session, but nothing is heard.
function silentWav() {
  const file = path.join(TOOLS, 'silence.wav');
  if (existsSync(file)) return file;
  const rate = 8000;
  const bytes = rate * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(bytes, 40);
  writeFileSync(file, b);
  return file;
}

// A throwaway "music app" with its own exe name. It is not powershell.exe, so
// the level Windows remembers for it can never leak onto ReadBack's players.
function toneApp() {
  const exe = path.join(TOOLS, 'rb-test-tone.exe');
  if (existsSync(exe)) return exe;
  const source = [
    'using System; using System.Media; using System.Threading;',
    'public static class Tone {',
    '  public static void Main(string[] a) {',
    '    Thread.Sleep(int.Parse(a[1]));',
    '    SoundPlayer p = new SoundPlayer(a[0]);',
    '    p.PlayLooping();',
    '    Thread.Sleep(120000);',
    '  }',
    '}',
  ].join('\n');
  const script = `Add-Type -TypeDefinition $env:RB_TONE_SRC -OutputAssembly '${exe}' -OutputType ConsoleApplication`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, RB_TONE_SRC: source },
  });
  assert.equal(r.status, 0, `could not build the test tone app: ${r.stderr}`);
  return exe;
}

function startTone(delayMs = 0) {
  return spawn(toneApp(), [silentWav(), String(delayMs)], { stdio: 'ignore', windowsHide: true });
}

function startHelper() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const waiters = [];
  const logs = [];
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.t === 'log') logs.push(m.msg);
    for (const w of [...waiters]) {
      if (!w.match(m)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(m);
    }
  });
  const exited = new Promise((r) => child.on('exit', r));
  return {
    child,
    exited,
    logs,
    stderr: () => stderr,
    send: (o) => child.stdin.write(`${JSON.stringify(o)}\n`),
    waitFor: (match, ms = 20000) =>
      new Promise((resolve, reject) => {
        const w = { match, resolve };
        w.timer = setTimeout(() => reject(new Error(`the helper never reported that (stderr: ${stderr.slice(-300)})`)), ms);
        waiters.push(w);
      }),
  };
}

const sessionOf = (m, pid) => (m.t === 'state' ? m.out.find((s) => s.pid === pid) : undefined);
const near = (a, b) => Math.abs(a - b) < 0.01;

// Only one helper runs per Windows session. One that is still finishing its
// put-back after being told to stop holds that place for a moment, and a new
// one is turned away (exit 4) meanwhile; try again until it is free.
async function readyHelper() {
  for (let attempt = 0; ; attempt++) {
    const h = startHelper();
    const ready = h.waitFor((m) => m.t === 'ready', 60000);
    const code = await Promise.race([ready.then(() => null), h.exited]);
    if (code === null) return h;
    ready.catch(() => {});
    if (code !== 4 || attempt >= 20) throw new Error(`the helper exited with ${code}: ${h.stderr()}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Reads a process's current level through a fresh helper, the way ReadBack would.
async function levelOf(pid) {
  const h = await readyHelper();
  try {
    return sessionOf(await h.waitFor((m) => Boolean(sessionOf(m, pid))), pid).vol;
  } finally {
    h.child.stdin.end();
    await h.exited;
  }
}

test('the helper lowers a session and puts it back when its stdin closes', { skip: !WIN, timeout: 120000 }, async () => {
  const tone = startTone();
  try {
    const h = await readyHelper();
    const s = sessionOf(await h.waitFor((m) => Boolean(sessionOf(m, tone.pid))), tone.pid);
    assert.equal(s.name, 'rb-test-tone');
    const orig = s.vol;
    h.send({ c: 'set', seq: 1, key: s.key, vol: 0.25, orig });
    await h.waitFor((m) => m.seq >= 1 && near(sessionOf(m, tone.pid)?.vol ?? -1, 0.25));
    h.child.stdin.end(); // the panel server "died"
    await h.exited;
    assert.ok(near(await levelOf(tone.pid), orig), 'put back on EOF');
  } finally {
    tone.kill();
  }
});

// The panel server dying is the case the EOF restore exists for, and closing
// stdin from a live parent does not exercise it: on Windows, Node kills every
// non-detached child the moment the parent exits.
test('the helper still puts levels back when the process that started it is killed', { skip: !WIN, timeout: 120000 }, async () => {
  const tone = startTone();
  const mod = pathToFileURL(path.join(ROOT, 'src', 'ducking-helper.js')).href;
  // A stand-in panel server: starts the helper the way ReadBack does, lowers
  // the tone app, says so, then waits to be killed.
  const code = `
    const { createHelperSupervisor } = await import(${JSON.stringify(mod)});
    let key = null, orig = null, said = false;
    const sup = createHelperSupervisor({ onMessage: (m) => {
      if (m.t !== 'state') return;
      const s = m.out.find((x) => x.pid === ${tone.pid});
      if (!s) return;
      if (key === null) {
        key = s.key;
        orig = s.vol;
        sup.send({ c: 'set', seq: 1, key, vol: 0.25, orig });
        return;
      }
      if (!said && m.seq >= 1 && Math.abs(s.vol - 0.25) < 0.01) {
        said = true;
        console.log('LOWERED ' + orig);
      }
    } });
    sup.start();
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const orig = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the stand-in panel never lowered the tone')), 60000);
      createInterface({ input: parent.stdout }).on('line', (line) => {
        const m = /^LOWERED ([\d.]+)/.exec(line);
        if (!m) return;
        clearTimeout(timer);
        resolve(Number(m[1]));
      });
    });
    parent.kill(); // the panel server dies hard
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(near(await levelOf(tone.pid), orig), 'put back after the process that started it was killed');
  } finally {
    parent.kill();
    tone.kill();
  }
});

test('an arm applies to a session the process only creates afterwards', { skip: !WIN, timeout: 120000 }, async () => {
  const h = await readyHelper();
  const tone = startTone(1500); // its sound starts 1.5 s after launch
  try {
    h.send({ c: 'arm', seq: 1, pid: tone.pid, vol: 0.2 });
    const first = await h.waitFor((m) => Boolean(sessionOf(m, tone.pid)));
    assert.ok(near(sessionOf(first, tone.pid).vol, 0.2), 'quiet from its first report');
    h.send({ c: 'quit' });
    await h.exited;
    assert.ok(near(await levelOf(tone.pid), 1), 'quit returns armed processes to full');
    // Lowering any other app must never touch the level Windows keeps for
    // powershell.exe: that level is ReadBack's real voice on this machine.
    assert.ok(!h.logs.some((l) => /powershell/i.test(l)), `no powershell.exe reset: ${h.logs}`);
  } finally {
    tone.kill();
  }
});

test('a level the user moved is left alone when the helper exits, and junk input is ignored', { skip: !WIN, timeout: 180000 }, async () => {
  const tone = startTone();
  try {
    const a = await readyHelper();
    const s = sessionOf(await a.waitFor((m) => Boolean(sessionOf(m, tone.pid))), tone.pid);
    a.child.stdin.write('this is not json\n');
    a.send({ c: 'set', seq: 1, key: s.key, vol: 0.25, orig: s.vol });
    await a.waitFor((m) => m.seq >= 1 && near(sessionOf(m, tone.pid)?.vol ?? -1, 0.25));
    // "The user" moves it. A set with no original changes the level without
    // touching what the helper remembers setting, which is exactly how a drag
    // in the Volume Mixer looks to it. (Only one helper can run per session,
    // so this cannot come from a second one.)
    a.send({ c: 'set', seq: 2, key: s.key, vol: 0.6 });
    await a.waitFor((m) => m.seq >= 2 && near(sessionOf(m, tone.pid)?.vol ?? -1, 0.6));
    a.child.stdin.end();
    await a.exited;
    assert.ok(near(await levelOf(tone.pid), 0.6), 'the user level survived the helper exiting');
    const b = await readyHelper(); // tidy up
    b.send({ c: 'set', seq: 1, key: s.key, vol: s.vol });
    await b.waitFor((m) => m.seq >= 1);
    b.child.stdin.end();
    await b.exited;
  } finally {
    tone.kill();
  }
});

// Two helpers would each take the other's lowered levels for originals and
// fight over every app (a second panel on another port, say).
test('a second helper in the same session refuses to start and says why', { skip: !WIN, timeout: 120000 }, async () => {
  const first = await readyHelper();
  try {
    const second = startHelper();
    assert.equal(await second.exited, 4);
    assert.match(second.stderr(), /already running/);
    first.send({ c: 'quit' });
    assert.equal(await first.exited, 0, 'the first one was not disturbed');
  } finally {
    first.child.kill();
  }
});

// Opt-in, because it touches the level Windows remembers for powershell.exe,
// which ReadBack's own players use. Run once by hand while nothing is speaking:
//   $env:READBACK_AUDIO_CARRYOVER = '1'; node --test test/audio-helper.test.js
test('a lowered powershell.exe level carried over by Windows is undone when the helper quits', {
  skip: !WIN || process.env.READBACK_AUDIO_CARRYOVER !== '1',
  timeout: 180000,
}, async (t) => {
  const wav = silentWav();
  const ps = () =>
    spawn('powershell', ['-NoProfile', '-Command', `$p = New-Object System.Media.SoundPlayer '${wav}'; $p.PlayLooping(); Start-Sleep -Seconds 60`], {
      stdio: 'ignore',
      windowsHide: true,
    });
  const h = await readyHelper();
  const first = ps();
  h.send({ c: 'arm', seq: 1, pid: first.pid, vol: 0.3 });
  await h.waitFor((m) => near(sessionOf(m, first.pid)?.vol ?? -1, 0.3));
  first.kill();
  await new Promise((r) => setTimeout(r, 1000));
  const second = ps();
  const carried = sessionOf(await h.waitFor((m) => Boolean(sessionOf(m, second.pid))), second.pid).vol;
  t.diagnostic(`a new powershell.exe started at ${carried} after the last one was lowered to 0.3`);
  second.kill();
  h.send({ c: 'quit' });
  await h.exited;
  const third = ps();
  try {
    assert.ok(near(await levelOf(third.pid), 1), 'the next powershell.exe starts at full');
  } finally {
    third.kill();
  }
});
