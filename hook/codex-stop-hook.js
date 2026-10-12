#!/usr/bin/env node
// Fast, non-blocking bridge. A detached worker owns the complete playback;
// neither closing a chat nor the hook timeout should cut off its sentence.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexReply, readHookInput } from '../src/codex.js';
import { readState } from '../src/state.js';
import { log } from '../src/log.js';

try {
  const payload = await readHookInput(process.stdin);
  const reply = codexReply(payload);
  if (reply && readState().enabled) {
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./codex-worker.js', import.meta.url))], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.stdin.once('error', reject);
      // Text is data on stdin, never shell code or a command-line argument.
      worker.stdin.end(JSON.stringify({
        hook_event_name: 'Stop',
        session_id: payload.session_id,
        turn_id: payload.turn_id,
        last_assistant_message: reply.text,
      }), resolve);
    });
    worker.unref();
  }
} catch (err) {
  log('codex-stop-hook error', err.code || err.name || 'Error');
}
// No continuation/block decisions and no model-visible text.
process.stdout.write('{}\n');
