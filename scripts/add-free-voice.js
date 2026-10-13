#!/usr/bin/env node
// Downloads ReadBack's optional free voice (Kokoro) into free-voice/: its
// packages, pinned by free-voice/package-lock.json, then the voice model,
// pinned to one revision and checked byte for byte. Then it times a sentence,
// so you know whether this PC keeps up. Run it again to repair an install.
// Nothing else in ReadBack changes, and the paid providers never load any of it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const { FREE_VOICE_DIR, packagesReady, prepare } = await import('../src/providers/kokoro.js');
const { PORT } = await import('../src/config.js');

if (!existsSync(path.join(FREE_VOICE_DIR, 'package-lock.json'))) {
  console.error(`There is no package-lock.json in ${FREE_VOICE_DIR}, so this is not a complete ReadBack folder.`);
  process.exit(1);
}

async function panelRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).readback === true;
  } catch {
    return false;
  }
}

if (packagesReady()) {
  console.log('The free voice packages are already installed.');
} else {
  // npm empties node_modules before it installs. Windows will not let it
  // remove the speech engine's files while a process that has used the free
  // voice is still running, and the free voice would be left half deleted.
  if (existsSync(path.join(FREE_VOICE_DIR, 'node_modules')) && (await panelRunning())) {
    console.error('Close the ReadBack panel, and any Claude Code or Codex sessions that have used the free voice, then run this again. Windows keeps its files in use while they run.');
    process.exit(1);
  }
  console.log('Installing the free voice: about 400 MB of packages...');
  // A fixed command with no user input: the shell is only there because
  // Windows will not start npm.cmd without one. No package's install script
  // runs; the free voice does not need them.
  const install = spawnSync('npm ci --ignore-scripts --no-audit --no-fund', { cwd: FREE_VOICE_DIR, shell: true, stdio: 'inherit' });
  if (install.status !== 0) {
    console.error('npm could not install the free voice. If the ReadBack panel or a Claude Code or Codex session has used it, close them and run this again.');
    process.exit(1);
  }
}

console.log('Checking the voice model (about 310 MB), and downloading it if it is missing or damaged...');
let shown = -10;
let result;
try {
  result = await prepare({
    onProgress: (done, total) => {
      const percent = Math.floor((done / total) * 100);
      if (percent < shown + 10 && done < total) return;
      shown = percent;
      console.log(`  ${percent}% (${Math.round(done / 1048576)} of ${Math.round(total / 1048576)} MB)`);
    },
  });
} catch (err) {
  console.error(`The voice model could not be downloaded or run: ${err.message}`);
  process.exit(1);
}
console.log(result.model === 'downloaded' ? 'Model downloaded and checked.' : 'Model already in place and checked.');

const x = result.xRealtime;
if (x >= 1.5) {
  console.log(`Ready. This PC makes the free voice about ${x}x faster than it plays. Pick "Free (Kokoro)" in the panel.`);
} else if (x >= 1) {
  console.log(`Ready, but this PC only just keeps up (${x}x real time): replies will take a few seconds to start and long ones may pause. Pick "Free (Kokoro)" in the panel.`);
} else {
  console.log(`Installed, but this PC makes speech slower than it plays (${x}x real time), so replies will pause. Inworld or ElevenLabs will sound smoother.`);
}
process.exit(0);
