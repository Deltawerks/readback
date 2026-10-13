import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DIR = mkdtempSync(path.join(tmpdir(), 'readback-helper-sup-'));
process.env.READBACK_STATE_DIR = DIR;
process.env.READBACK_CACHE_DIR = DIR;
const LOG = path.join(DIR, 'fake.log');
process.env.FAKE_LOG = LOG;

const { createHelperSupervisor, asciiJson } = await import('../src/ducking-helper.js');

// A stand-in helper that speaks the protocol: noise and a broken line first,
// then ready; it logs every command it receives, dies on "crash", and records
// EOF before exiting cleanly.
const FAKE = path.join(DIR, 'fake-helper.mjs');
writeFileSync(
  FAKE,
  String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
process.stdout.write('WARNING: PowerShell noise that is not JSON\n');
process.stdout.write('{"t":"state","seq":\n');
process.stdout.write(JSON.stringify({ t: 'ready', v: 1 }) + '\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  appendFileSync(process.env.FAKE_LOG, line + '\n');
  if (JSON.parse(line).c === 'crash') process.exit(3);
});
lines.on('close', () => {
  appendFileSync(process.env.FAKE_LOG, 'EOF\n');
  process.exit(0);
});
`
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error('condition not met in time');
}
const fakeLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');

test('wire JSON is pure ASCII', () => {
  assert.equal(asciiJson({ k: 'é✓' }), '{"k":"\\u00e9\\u2713"}');
});

// Review focus 4: noise and half lines on the helper's stdout are ignored.
test('the supervisor starts the helper, ignores noise, and closes stdin on stop', async () => {
  const statuses = [];
  const messages = [];
  const sup = createHelperSupervisor({
    command: process.execPath,
    args: [FAKE],
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
  });
  sup.start();
  await until(() => statuses.includes('ready'));
  assert.ok(sup.send({ c: 'set', seq: 1, key: 'Spotify é', vol: 0.1 }));
  await until(() => fakeLog().includes('Spotify'));
  assert.match(fakeLog(), /\\u00e9/, 'non-ASCII travels escaped');
  assert.deepEqual(messages.map((m) => m.t), ['ready'], 'noise never reached onMessage');
  sup.stop();
  await until(() => statuses.at(-1) === 'off');
  assert.match(fakeLog(), /EOF/);
});

test('a helper that dies is restarted', async () => {
  const statuses = [];
  let ready = 0;
  const sup = createHelperSupervisor({
    command: process.execPath,
    args: [FAKE],
    onMessage: (m) => {
      if (m.t === 'ready') ready++;
    },
    onStatus: (s) => statuses.push(s),
    setTimer: (fn) => setTimeout(fn, 20),
  });
  sup.start();
  await until(() => ready === 1);
  sup.send({ c: 'crash', seq: 2 });
  await until(() => ready === 2);
  assert.ok(statuses.includes('restarting'));
  sup.stop();
  await until(() => statuses.at(-1) === 'off');
});

test('stop cancels a pending restart', async () => {
  let spawned = 0;
  const sup = createHelperSupervisor({
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    spawnFn: (...a) => {
      spawned++;
      return spawn(...a);
    },
    setTimer: (fn) => setTimeout(fn, 50),
  });
  sup.start();
  await until(() => spawned === 1 && !sup.running());
  sup.stop();
  await sleep(200);
  assert.equal(spawned, 1);
  assert.equal(sup.status(), 'off');
});
