import { readAgentState, writeState, activeConfig } from './state.js';
import { stripForSpeech, truncateForSpeech } from './tts.js';
import { speak } from './speak.js';
import { claim, cleanOldClaims } from './claims.js';
import { codexReply, stripCodexMetadata, codexTurnEligibility } from './codex.js';
import { log } from './log.js';

// Uses the SAME queue, cancellation epoch, settings and player as Claude. The
// optional playback function lets tests exercise real settings/claims without
// calling a paid TTS provider or playing audio on the user's computer.
export async function speakCodexReply(payload, playback = speak) {
  const reply = codexReply(payload);
  if (!reply) return { skipped: 'not a main-thread reply' };
  const st = readAgentState('codex');
  if (!st.enabled) return { skipped: 'voice off' };
  const eligibility = await codexTurnEligibility(payload);
  if (!eligibility.allowed) {
    log(`codex-worker: skipped ${eligibility.reason}`);
    return { skipped: eligibility.reason };
  }
  const clean = truncateForSpeech(stripForSpeech(stripCodexMetadata(reply.text)), st.maxChars);
  if (clean.length < 2) return { skipped: 'nothing speakable' };
  if (!claim(reply.id)) return { skipped: 'already claimed' };
  cleanOldClaims();
  // Runtime fields only: never save an old copy of the user's settings.
  writeState({ lastSpokenId: reply.id, lastSpokenBy: process.pid });
  const result = await playback(clean, st, { wait: true, queue: true });
  const via = `${st.provider}/${activeConfig(st).voiceId}`;
  if (result.aborted) {
    log(`codex-worker: reply stopped or muted via ${via}`);
  } else if (result.playerFailed !== undefined) {
    log(`codex-worker: the audio player quit early (exit ${result.playerFailed}), so the reply stopped after ${result.spoken} of ${result.total} chunks via ${via}`);
  } else {
    log(`codex-worker: spoke ${result.spoken} of ${result.total} chunks (${clean.length} chars) via ${via}${result.truncated ? ', cut short by a synthesis error' : ''}`);
  }
  return result;
}
