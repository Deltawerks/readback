#!/usr/bin/env node
// Fast, non-blocking bridge. A detached worker owns the complete playback;
// neither closing a chat nor the hook timeout should cut off its sentence.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../src/config.js';
import { launchIndependentNode } from '../src/independent-process.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexReply, readHookInput } from '../src/codex.js';
import { readAgentState } from '../src/state.js';
import { log } from '../src/log.js';

try {
  const payload = await readHookInput(process.stdin);
  const reply = codexReply(payload);
  if (reply && readAgentState('codex').enabled) {
    const data = JSON.stringify({
      hook_event_name: 'Stop', session_id: payload.session_id, turn_id: payload.turn_id,
      transcript_path: payload.transcript_path, last_assistant_message: reply.text,
    });
    const script = fileURLToPath(new URL('./codex-worker.js', import.meta.url));
    if (process.platform === 'win32') {
      // Private per-user cache; no text or keys in command-line arguments.
      // The independent worker consumes and removes this single-use file.
      mkdirSync(CACHE_DIR, { recursive: true });
      const input = path.join(CACHE_DIR, `codex-input-${randomUUID()}.json`);
      writeFileSync(input, data, { flag: 'wx', mode: 0o600 });
      try {
        await launchIndependentNode(script, ['--input-file', input]);
      } catch (err) {
        try { unlinkSync(input); } catch {}
        throw err;
      }
    } else {
      const worker = spawn(process.execPath, [script], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
      });
      await new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.stdin.once('error', reject);
        worker.stdin.end(data, resolve);
      });
      worker.unref();
    }
  }
} catch (err) {
  log('codex-stop-hook error', err.code || err.name || 'Error');
}
// No continuation/block decisions and no model-visible text.
process.stdout.write('{}\n');
