#!/usr/bin/env node
import { createReadStream, unlinkSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../src/config.js';
import { readHookInput } from '../src/codex.js';
import { speakCodexReply } from '../src/codex-speech.js';
import { log, errorText } from '../src/log.js';

// The worker deletes its input once read, so it only accepts the hook's own
// single-use files: codex-input-<uuid>.json, directly in the cache dir.
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const isOwnInput = (file) =>
  same(path.dirname(path.resolve(file)), path.resolve(CACHE_DIR)) &&
  /^codex-input-[0-9a-f-]{36}\.json$/i.test(path.basename(file));

try {
  let payload;
  if (process.argv[2] === '--input-file' && process.argv[3]) {
    const file = process.argv[3];
    if (!isOwnInput(file)) throw new Error('refused --input-file: not a ReadBack input file in the cache');
    try { payload = await readHookInput(createReadStream(file)); }
    finally { try { unlinkSync(file); } catch {} }
  } else {
    payload = await readHookInput(process.stdin);
  }
  await speakCodexReply(payload);
} catch (err) {
  // Never the payload, the reply or a key: errorText names parse errors only.
  log('codex-worker error', errorText(err));
}
