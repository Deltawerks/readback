#!/usr/bin/env node
// Claude Code Stop hook. Reads the hook payload from stdin, and if voice is
// enabled, spawns a detached worker to speak the last reply, then exits
// immediately so the turn is never blocked or slowed by TTS.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState } from '../src/state.js';
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

  const st = readState();
  if (!st.enabled) return;

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) {
    log('stop-hook: no transcript_path in payload');
    return;
  }

  const worker = spawn(process.execPath, [path.join(__dirname, 'worker.js'), transcriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  worker.unref();
}

main()
  .catch((err) => log('stop-hook error', err && err.message))
  .finally(() => process.exit(0));
