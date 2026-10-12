#!/usr/bin/env node
import { readHookInput } from '../src/codex.js';
import { speakCodexReply } from '../src/codex-speech.js';
import { log } from '../src/log.js';

try {
  await speakCodexReply(await readHookInput(process.stdin));
} catch (err) {
  // Do not log payloads, replies or provider keys.
  log('codex-worker error', err.code || err.name || 'Error');
}
