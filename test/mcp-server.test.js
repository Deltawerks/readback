import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Runs the real MCP server over stdio against throwaway settings, with no keys
// and the audio helper off. Nothing here synthesizes or plays anything.
async function withServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-mcp-'));
  const env = { ...process.env, READBACK_STATE_DIR: dir, READBACK_CACHE_DIR: path.join(dir, 'cache'), READBACK_DUCKING_HELPER: 'off' };
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

test('set_provider can switch to the free voice', async () => {
  await withServer(async ({ call, settings }) => {
    const r = await call('tools/call', { name: 'set_provider', arguments: { provider: 'kokoro' } });
    assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
    assert.equal(settings().agents.claude.provider, 'kokoro');
  });
});

test('voice_status describes the free voice without blanks', async () => {
  await withServer(async ({ call }) => {
    await call('tools/call', { name: 'set_provider', arguments: { provider: 'kokoro' } });
    const r = await call('tools/call', { name: 'voice_status', arguments: {} });
    const line = r.result.content[0].text;
    assert.match(line, / · kokoro · af_heart · speed 1$/);
    assert.doesNotMatch(line, /undefined/);
  });
});
