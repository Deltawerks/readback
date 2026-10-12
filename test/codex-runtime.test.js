// Opt-in compatibility probe against a real installed Codex executable. All
// model output comes from a loopback fixture; no account, API key or TTS calls.
// Run with READBACK_CODEX_BIN set to the desktop's bundled codex.exe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexRegistration } from '../src/codex-registration.js';
import { codexReply } from '../src/codex.js';

test('installed Codex delivers its Stop payload through the generated Windows command', {
  skip: !process.env.READBACK_CODEX_BIN || process.platform !== 'win32', timeout: 45000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-runtime-'));
  const home = path.join(dir, 'codex-home');
  const fixture = path.join(dir, "voice's $fixture & space");
  const state = path.join(dir, 'state');
  const cache = path.join(dir, 'cache');
  for (const p of [home, state, cache, path.join(fixture, 'hook')]) mkdirSync(p, { recursive: true });
  writeFileSync(path.join(state, 'state.json'), JSON.stringify({ enabled: false }));
  const capture = path.join(dir, 'hook-input.json');
  const result = path.join(dir, 'hook-result.json');
  const realHook = fileURLToPath(new URL('../hook/codex-stop-hook.js', import.meta.url));
  writeFileSync(path.join(fixture, 'hook', 'codex-stop-hook.js'), `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const input = fs.readFileSync(0, 'utf8');
    fs.writeFileSync(${JSON.stringify(capture)}, input);
    const child = spawnSync(process.execPath, [${JSON.stringify(realHook)}], {
      input, encoding: 'utf8', env: process.env, windowsHide: true, timeout: 5000,
    });
    fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({status:child.status, stdout:child.stdout, stderr:child.stderr}));
    process.stdout.write(child.stdout || '{}');
  `);
  writeFileSync(path.join(home, 'hooks.json'), JSON.stringify(codexRegistration(fixture).hooks));
  const reply = 'ReadBack runtime compatibility test.';
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
    phase: 'final_answer', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: 'fixture',
    output: [item], usage: { input_tokens: 1, output_tokens: 8, total_tokens: 9 } };
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume without retaining prompts */ }
    if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: reply },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  writeFileSync(path.join(home, 'config.toml'), `
model = "fixture"
model_provider = "readback_fixture"
[model_providers.readback_fixture]
name = "ReadBack loopback fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`);
  let child;
  let timer;
  try {
    child = spawn(process.env.READBACK_CODEX_BIN, [
      'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
      // This one invocation contains only the vetted fixture hook above. Never
      // use this flag in the user's actual installation or generated config.
      '--dangerously-bypass-hook-trust', '--json', 'Return the fixture response.',
    ], {
      cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '',
        READBACK_STATE_DIR: state, READBACK_CACHE_DIR: cache },
    });
    let output = '';
    child.stdout.on('data', (s) => { output = (output + s).slice(-20000); });
    child.stderr.on('data', (s) => { output = (output + s).slice(-20000); });
    timer = setTimeout(() => child.kill(), 35000);
    const [code] = await once(child, 'close');
    assert.equal(code, 0, output);
    assert.ok(existsSync(capture), `Stop did not run: ${output}`);
    const payload = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(codexReply(payload)?.text, reply);
    const ran = JSON.parse(readFileSync(result, 'utf8'));
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), {});
    assert.equal(JSON.parse(readFileSync(path.join(state, 'state.json'), 'utf8')).enabled, false);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
