#!/usr/bin/env node
import { createReadStream, unlinkSync } from 'node:fs';
import { readHookInput } from '../src/codex.js';
import { speakCodexReply } from '../src/codex-speech.js';
import { log } from '../src/log.js';

try {
  let payload;
  if (process.argv[2] === '--input-file' && process.argv[3]) {
    const file = process.argv[3];
    try { payload = await readHookInput(createReadStream(file)); }
    finally { try { unlinkSync(file); } catch {} }
  } else {
    payload = await readHookInput(process.stdin);
  }
  await speakCodexReply(payload);
} catch (err) {
  // Do not log payloads, replies or provider keys.
  log('codex-worker error', err.code || err.name || 'Error');
}
