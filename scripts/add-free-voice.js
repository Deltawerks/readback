#!/usr/bin/env node
// Downloads ReadBack's optional free voice (Kokoro) into free-voice/: its
// packages, pinned by free-voice/package-lock.json, then the voice model. Then
// it times a sentence, so you know whether this PC keeps up. Nothing else in
// ReadBack changes, and the paid providers never load any of it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const { FREE_VOICE_DIR, prepare } = await import('../src/providers/kokoro.js');

if (!existsSync(path.join(FREE_VOICE_DIR, 'package-lock.json'))) {
  console.error(`There is no package-lock.json in ${FREE_VOICE_DIR}, so this is not a complete ReadBack folder.`);
  process.exit(1);
}

console.log('Installing the free voice: about 400 MB of packages...');
// A fixed command, no user input: the shell is only there because Windows will
// not start npm.cmd without one.
const install = spawnSync('npm ci --no-audit --no-fund', { cwd: FREE_VOICE_DIR, shell: true, stdio: 'inherit' });
if (install.status !== 0) {
  console.error('npm could not install the free voice. Nothing else in ReadBack was changed.');
  process.exit(1);
}

console.log('Downloading the voice model (about 310 MB) and timing this PC...');
let result;
try {
  result = await prepare();
} catch (err) {
  console.error(`The voice model could not be downloaded or run: ${err.message}`);
  process.exit(1);
}

const x = result.xRealtime;
if (x >= 1.5) {
  console.log(`Ready. This PC makes the free voice about ${x}x faster than it plays. Pick "Free (Kokoro)" in the panel.`);
} else if (x >= 1) {
  console.log(`Ready, but this PC only just keeps up (${x}x real time): replies will take a few seconds to start and long ones may pause. Pick "Free (Kokoro)" in the panel.`);
} else {
  console.log(`Installed, but this PC makes speech slower than it plays (${x}x real time), so replies will pause. Inworld or ElevenLabs will sound smoother.`);
}
process.exit(0);
