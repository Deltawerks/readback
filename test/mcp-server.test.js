import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Runs the real MCP server over stdio against throwaway settings, with no keys
// and the audio helper off. Nothing here synthesizes or plays anything.
async function withServer(fn, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-mcp-'));
  const env = { ...process.env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: path.join(dir, 'cache'), READBACK_DUCKING_HELPER: 'off', ...extraEnv };
  delete env.INWORLD_API_KEY;
  delete env.ELEVENLABS_API_KEY;
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-server.js')], { env, windowsHide: true });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return await fn({ init, call, settings: () => JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) });
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the MCP server reports the version in package.json', async () => {
  await withServer(async ({ init }) => {
    assert.equal(init.result.serverInfo.version, PKG.version);
  });
});

// The panel cleans voice and model ids before saving them; the MCP tools wrote
// whatever string a model sent, control characters and all, straight into the
// settings every ReadBack process reads.
test('set_voice and set_model store ids cleaned the way the panel cleans them', async () => {
  await withServer(async ({ call, settings }) => {
    await call('tools/call', { name: 'set_voice', arguments: { voiceId: `Ash\u0007ley${'x'.repeat(300)}` } });
    await call('tools/call', { name: 'set_model', arguments: { modelId: 'inworld-tts-2\r\n' } });
    const saved = settings().agents.claude.inworld;
    assert.equal(saved.voiceId, `Ashley${'x'.repeat(194)}`);
    assert.equal(saved.modelId, 'inworld-tts-2');
  });
});

// Stand-ins for the free voice's packages and model: enough for ReadBack to
// count it as installed. Nothing here loads or downloads the real thing.
function freeVoice({ installed }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-mcp-voice-'));
  if (installed) {
    for (const f of ['node_modules/kokoro-js/dist/kokoro.js', 'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
      'models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), '');
    }
  }
  return { READBACK_FREE_VOICE_DIR: dir };
}

test('set_provider can switch to the free voice', async () => {
  await withServer(async ({ call, settings }) => {
    const r = await call('tools/call', { name: 'set_provider', arguments: { provider: 'kokoro' } });
    assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
    assert.equal(settings().agents.claude.provider, 'kokoro');
  }, freeVoice({ installed: true }));
});

// Switching to it before the download used to succeed, after which every
// reply failed in a background worker where nobody sees the error.
test('set_provider will not switch to the free voice before it is installed', async () => {
  await withServer(async ({ call }) => {
    const r = await call('tools/call', { name: 'set_provider', arguments: { provider: 'kokoro' } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /npm run add-free-voice/);
    const status = await call('tools/call', { name: 'voice_status', arguments: {} });
    assert.match(status.result.content[0].text, / · inworld · /);
  }, freeVoice({ installed: false }));
});

// A voice from another provider was saved as the free voice's and reported as
// set while Heart spoke; a model it does not have was saved too; and the
// tool's 1.5x ceiling hid its top speeds.
test("set_voice, set_model and set_speed keep to the free voice's own choices", async () => {
  await withServer(async ({ call, settings }) => {
    await call('tools/call', { name: 'set_provider', arguments: { provider: 'kokoro' } });
    const luna = await call('tools/call', { name: 'set_voice', arguments: { voiceId: 'Luna' } });
    assert.equal(luna.result.isError, true);
    assert.match(luna.result.content[0].text, /list_voices/);
    const george = await call('tools/call', { name: 'set_voice', arguments: { voiceId: 'bm_george' } });
    assert.ok(!george.result.isError, JSON.stringify(george));
    const model = await call('tools/call', { name: 'set_model', arguments: { modelId: 'inworld-tts-2' } });
    assert.equal(model.result.isError, true);
    const speed = await call('tools/call', { name: 'set_speed', arguments: { speed: 2 } });
    assert.ok(!speed.error && !speed.result.isError, JSON.stringify(speed));
    const saved = settings().agents.claude.kokoro;
    assert.equal(saved.voiceId, 'bm_george');
    assert.equal(saved.modelId, undefined);
    assert.equal(saved.speed, 2);
  }, freeVoice({ installed: true }));
});

test('voice_status describes the free voice without blanks', async () => {
  await withServer(async ({ call }) => {
    await call('tools/call', { name: 'set_provider', arguments: { provider: 'kokoro' } });
    const r = await call('tools/call', { name: 'voice_status', arguments: {} });
    const line = r.result.content[0].text;
    assert.match(line, / · kokoro · af_heart · speed 1$/);
    assert.doesNotMatch(line, /undefined/);
  }, freeVoice({ installed: true }));
});
