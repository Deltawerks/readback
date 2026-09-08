#!/usr/bin/env node
// Prints the settings file exactly as it exists on disk, as JSON.
//
// The panel runs this in a SEPARATE process to check its own work. A panel was
// twice found answering requests while its own reads and writes were wrong
// together, so every check it ran against itself agreed with itself and passed.
// A child process has its own view of the filesystem and cannot be fooled the
// same way.
import { readFileSync } from 'node:fs';
import { STATE_FILE } from '../src/config.js';

try {
  process.stdout.write(readFileSync(STATE_FILE, 'utf8'));
} catch (err) {
  process.stdout.write(JSON.stringify({ readbackReadError: err.message }));
}
