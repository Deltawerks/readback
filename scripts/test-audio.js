#!/usr/bin/env node
// Runs the Windows audio integration tests, which `npm test` skips: they start
// the real audio helper and change a silent test app's per-app volume. Only one
// audio helper can run per Windows session, so switch ReadBack's own ducking
// off in the panel first.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, ['--test', path.join(root, 'test', 'audio-helper.test.js')], {
  stdio: 'inherit',
  env: { ...process.env, READBACK_AUDIO_TESTS: '1' },
});
process.exit(r.status ?? 1);
