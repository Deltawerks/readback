#!/usr/bin/env node
// Detached worker: take the current turn's assistant reply (piped from the hook,
// or from the transcript on older Claude Code), clean it up for speech,
// synthesize with the active provider, and stream it.
// All failures are logged and swallowed. This must never crash or surface an error.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readAgentState, writeState, activeConfig } from '../src/state.js';
import { currentReply } from '../src/transcript.js';
import { stripForSpeech, truncateForSpeech } from '../src/tts.js';
import { speak } from '../src/speak.js';
import { isClaimed, claim, cleanOldClaims } from '../src/claims.js';
import { readHookInput } from '../src/codex.js';
import { log, errorText } from '../src/log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A reply the hook piped from Claude Code's last_assistant_message. Its id is
// built from the session, the prompt and the text, so duplicate fires of one
// Stop agree on it.
function pipedReply(job) {
  const text = typeof job?.text === 'string' ? job.text : '';
  if (!text.trim()) return null;
  const id = 'claude-' + createHash('sha256').update(JSON.stringify([job.session_id ?? '', job.prompt_id ?? '', text])).digest('hex');
  return { id, text };
}

// Duplicate fires of one Stop arrive within seconds. A text-built id can recur
// (two identical "Done." replies), so its claim must not outlive that window.
const PIPED_CLAIM_TTL_MS = 60 * 1000;

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

  let st = readAgentState('claude');
  if (!st.enabled) return;

  let reply = null;
  let claimOptions = {};
  if (!transcriptPath) {
    reply = pipedReply(await readHookInput(process.stdin));
    if (!reply) return;
    claimOptions = { ttlMs: PIPED_CLAIM_TTL_MS };
  } else {
    // Older Claude Code. The final reply may not be flushed to the transcript at
    // the instant the Stop hook fires, so we'd otherwise read the PREVIOUS turn's
    // reply. Poll until the current turn's reply appears (assistant text after
    // the last user entry) and it's one nobody has claimed yet.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      reply = readReply(transcriptPath);
      if (reply && !isClaimed(reply.id)) break;
      reply = null;
      await sleep(120);
      st = readAgentState('claude');
      if (!st.enabled) return; // toggled off while we waited
    }

    if (!reply) {
      log('worker: current reply not ready in time');
      return;
    }
  }

  // Exactly one worker gets to speak a reply. Duplicate hook fires and other
  // projects' workers all race on the same atomic create; losers exit here.
  if (!claim(reply.id, claimOptions)) {
    log('worker: reply already claimed by another worker');
    return;
  }
  cleanOldClaims();
  writeState({ lastSpokenId: reply.id, lastSpokenBy: process.pid });

  const clean = truncateForSpeech(stripForSpeech(reply.text), st.maxChars);
  if (!clean || clean.length < 2) {
    log('worker: nothing speakable in reply');
    return;
  }

  // wait:true  keeps this alive until playback finishes, or the player (a non-detached
  //   child) would be torn down when the worker exits.
  // queue:true lines up behind other sessions instead of cutting them off.
  const result = await speak(clean, st, { wait: true, queue: true });
  const via = `${st.provider}/${activeConfig(st).voiceId}`;
  if (result.aborted) {
    log(`worker: reply not spoken (voice off or stopped while waiting) via ${via}`);
  } else if (result.playerFailed !== undefined) {
    log(`worker: the audio player quit early (exit ${result.playerFailed}), so the reply stopped after ${result.spoken} of ${result.total} chunks via ${via}`);
  } else {
    const note = result.truncated ? ', cut short by a synthesis error' : '';
    log(`worker: spoke ${result.spoken} of ${result.total} chunks (${clean.length} chars) via ${via}${note}`);
  }
}

main()
  .catch((err) => log('worker error', errorText(err)))
  .finally(() => process.exit(0));
