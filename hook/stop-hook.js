#!/usr/bin/env node
// Claude Code Stop hook. Reads the hook payload from stdin, and if voice is
// enabled, spawns a detached worker to speak the last reply, then exits
// immediately so the turn is never blocked or slowed by TTS.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentState } from '../src/state.js';
import { log } from '../src/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readStdin() {
  let input = '';
  try {
    for await (const chunk of process.stdin) input += chunk;
  } catch {
    // no stdin
  }
  return input;
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    // ignore malformed payloads
  }

  const st = readAgentState('claude');
  if (!st.enabled) return;
  const workerScript = path.join(__dirname, 'worker.js');

  // Claude Code hands over the final reply itself, and its hook docs tell
  // read-aloud hooks to use it: the transcript is written asynchronously and
  // may not hold that reply yet when Stop fires. It goes to the worker through
  // a pipe, never the command line.
  const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
  if (text.trim()) {
    const job = JSON.stringify({ session_id: payload.session_id, prompt_id: payload.prompt_id, text: text.slice(0, 200000) });
    const worker = spawn(process.execPath, [workerScript], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.stdin.once('error', reject);
      worker.stdin.end(job, resolve);
    });
    worker.unref();
    return;
  }

  // Older Claude Code: the worker finds the reply in the transcript.
  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) {
    log('stop-hook: no transcript_path in payload');
    return;
  }

  const worker = spawn(process.execPath, [workerScript, transcriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  worker.unref();
}

main()
  .catch((err) => log('stop-hook error', err && err.message))
  .finally(() => process.exit(0));
