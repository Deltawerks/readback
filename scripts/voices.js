#!/usr/bin/env node
// `npm run voices` prints the available voices for the active provider.
// Optional Inworld filter: `npm run voices -- 'source = "SYSTEM" AND lang_code = "en"'`
import { readState } from '../src/state.js';
import { listVoices } from '../src/tts.js';

const filter = process.argv.slice(2).join(' ').trim();

try {
  const st = readState();
  const voices = await listVoices(st, filter ? { filter } : undefined);
  for (const v of voices) {
    const id = String(v.voiceId).padEnd(24);
    const gender = (v.gender || '').padEnd(7);
    console.log(`${id} ${gender} ${v.description || v.displayName}`);
  }
  console.log(`\n${voices.length} ${st.provider} voices`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
}
