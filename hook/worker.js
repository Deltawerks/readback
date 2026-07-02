#!/usr/bin/env node
// Detached worker: read the current turn's assistant reply from the transcript,
// clean it up for speech, synthesize with Inworld, and stream it. All failures
// are logged and swallowed — this must never crash or surface an error.
import { readFileSync } from 'node:fs';
import { readState, writeState } from '../src/state.js';
import { currentReply } from '../src/transcript.js';
import { stripForSpeech, truncateForSpeech } from '../src/tts.js';
import { speak } from '../src/speak.js';
import { log } from '../src/log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readReply(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  return currentReply(raw);
}

async function main() {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) return;

  let st = readState();
  if (!st.enabled) return;
  const prevId = st.lastSpokenId;

  // The final reply may not be flushed to the transcript at the instant the Stop
  // hook fires, so we'd otherwise read the PREVIOUS turn's reply. Poll until the
  // current turn's reply appears (assistant text after the last user entry) and
  // it's one we haven't already spoken.
  let reply = null;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    reply = readReply(transcriptPath);
    if (reply && reply.id !== prevId) break;
    reply = null;
    await sleep(120);
    st = readState();
    if (!st.enabled) return; // toggled off while we waited
  }

  if (!reply) {
    log('worker: current reply not ready in time');
    return;
  }

  // Mark spoken up front so a duplicate hook fire won't repeat this reply.
  writeState({ lastSpokenId: reply.id });

  const clean = truncateForSpeech(stripForSpeech(reply.text), st.maxChars);
  if (!clean || clean.length < 2) {
    log('worker: nothing speakable in reply');
    return;
  }

  // wait:true — stay alive until playback finishes, or the player (a non-detached
  // child) would be torn down when the worker exits. speak() streams chunks.
  await speak(clean, st, { wait: true });
  log(`worker: spoke ${clean.length} chars via ${st.voiceId}`);
}

main()
  .catch((err) => log('worker error', err && err.message))
  .finally(() => process.exit(0));
