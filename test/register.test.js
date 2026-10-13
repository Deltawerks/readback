import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Claude Desktop does not always start with the shell's PATH (nvm, fnm, a
// per-user Node), and a hook registered as plain "node" then never runs, with
// no error anywhere. The Codex registration already wrote Node's full path.
test('Claude registration names Node by its full path', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-register-'));
  try {
    mkdirSync(path.join(dir, 'scripts'));
    copyFileSync(path.join(ROOT, 'scripts', 'register.ps1'), path.join(dir, 'scripts', 'register.ps1'));
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'scripts', 'register.ps1')], {
      encoding: 'utf8', windowsHide: true, timeout: 25000,
    });
    assert.equal(r.status, 0, r.stderr);
    const mcp = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.readback;
    const hook = JSON.parse(readFileSync(path.join(dir, 'hooks-snippet.json'), 'utf8')).hooks.Stop[0].hooks[0];
    for (const command of [mcp.command, hook.command]) {
      assert.ok(path.isAbsolute(command), `"${command}" depends on PATH`);
      assert.match(path.basename(command), /^node(\.exe)?$/i);
      assert.ok(existsSync(command));
    }
    assert.deepEqual(mcp.args, [path.join(dir, 'src', 'mcp-server.js')]);
    assert.deepEqual(hook.args, [path.join(dir, 'hook', 'stop-hook.js')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
