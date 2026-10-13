#!/usr/bin/env node
// Smoke test: `npm run say "hello there"` synthesizes and plays one line
// through the active provider.
import { readAgentState, activeConfig } from '../src/state.js';
import { stripForSpeech } from '../src/tts.js';
import { speak } from '../src/speak.js';

const input = process.argv.slice(2).join(' ') || 'ReadBack is online and ready.';
const st = readAgentState(process.env.READBACK_SOURCE === 'codex' ? 'codex' : 'claude');
const c = activeConfig(st);
const clean = stripForSpeech(input) || input;

console.log(`Provider: ${st.provider} · voice: ${c.voiceId || '(none)'} · model: ${c.modelId} · speed ${c.speed}`);
console.log(`Synthesizing: "${clean}"`);

try {
  console.log('Playing…');
  // wait:true keeps this process alive until playback finishes.
  const result = await speak(clean, st, { wait: true });
  console.log(result.aborted ? 'Muted or stopped; nothing spoken.' : 'Done.');
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
}
