#!/usr/bin/env node
// Smoke test: `npm run say "hello there"` — synthesize and play one line
// through the active provider.
import { readState, activeConfig } from '../src/state.js';
import { stripForSpeech } from '../src/tts.js';
import { speak } from '../src/speak.js';

const input = process.argv.slice(2).join(' ') || 'Readback is online and ready.';
const st = readState();
const c = activeConfig(st);
const clean = stripForSpeech(input) || input;

console.log(`Provider: ${st.provider} · voice: ${c.voiceId || '(none)'} · model: ${c.modelId} · speed ${c.speed}`);
console.log(`Synthesizing: "${clean}"`);

try {
  console.log('Playing…');
  // wait:true — keep this process alive until playback finishes.
  await speak(clean, st, { wait: true });
  console.log('Done.');
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
}
