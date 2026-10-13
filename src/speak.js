import { once } from 'node:events';
import { synthesize } from './tts.js';
import { chunkForSpeech } from './chunk.js';
import {
  newStreamDir,
  spawnStreamPlayer,
  writeChunk,
  writeEndMarker,
  stopPlayback,
  wavDurationMs,
} from './audio.js';
import { readAgentState, writeState, StateUnreadableError } from './state.js';
import { enqueue, releaseTicket, waitTurn, currentEpoch, flushQueue } from './queue.js';
import { log } from './log.js';

// Spoken when a reply cannot be finished, so a cut-off never passes for the end.
const CUT_SHORT_CUE = 'The rest is on screen.';

// How far synthesis may run ahead of what is playing. Plenty to hide a slow
// provider, and small enough that a stop or a voice-off part way through a long
// reply saves the rest of the bill. Synthesizing as fast as the provider
// answered paid for a ten-minute reply within its first minute.
const LOOKAHEAD_MS = 30 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Speak text with low latency: split into sentence chunks, start playing the
// first as soon as it's synthesized, and prefetch the rest so they play
// back-to-back with no gap. Chunks are always WAV (the streaming player uses
// Windows SoundPlayer).
//
// wait:false: for long-lived parents (panel / MCP server). Awaits ONLY the
//   first chunk (so auth/network errors surface and audio has already started),
//   then streams the remaining chunks in the background and returns.
// wait:true: for short-lived parents (hook worker, say.js). Awaits the entire
//   utterance including playback, so the process stays alive until audio ends.
// queue:true: automatic (hook) speech that waits its turn in the cross-process FIFO
//   queue so multiple sessions read in order instead of stomping each other.
// queue:false (default): manual speech (panel/CLI) takes over immediately.
//
// Returns { spoken, total, aborted?, truncated?, playerFailed? }: spoken is the
// number of chunks actually delivered to the player, which is what the worker
// logs; playerFailed is the exit code of a player that quit before the end.
export async function speak(text, st, { wait = false, queue = false } = {}) {
  // Playback goes through Windows PowerShell. Anywhere else the player cannot
  // start, and that used to surface only after the whole reply was paid for.
  if (process.platform !== 'win32') {
    throw new Error('ReadBack plays audio through Windows PowerShell, so it cannot speak on this system');
  }
  const chunks = chunkForSpeech(text);
  const total = chunks.length;
  if (!total) return { spoken: 0, total: 0 };
  const aborted = () => ({ spoken: 0, total, aborted: true });
  const agent = st.agent || 'claude';
  const agentEpoch = currentEpoch(agent);

  // Take our place in line. (enqueue is a couple of file ops; when nothing else
  // is talking, waitTurn returns on the first pass with no sleep, so no latency.)
  const ticket = enqueue();
  let epoch;

  // While waiting, a settings file we cannot read right now is "unknown", and
  // the right answer to unknown is to keep waiting, not to speak and not to
  // give up. Once it is our turn we need a definite yes.
  const stillEnabled = () => {
    try {
      return currentEpoch(agent) === agentEpoch && readAgentState(agent).enabled;
    } catch (err) {
      if (err instanceof StateUnreadableError) return true;
      throw err;
    }
  };
  const definitelyEnabled = () => {
    try {
      return readAgentState(agent).enabled === true;
    } catch {
      return false;
    }
  };
  // Has the line been pulled out from under us? A stop or a flush bumps the
  // epoch; all speech also respects the master and source switches.
  const lineStillOurs = () => currentEpoch() === epoch && currentEpoch(agent) === agentEpoch && definitelyEnabled();

  if (!definitelyEnabled()) { releaseTicket(ticket); return aborted(); }

  if (queue) {
    // Wait politely behind any active or queued utterance. Give up if voice is
    // turned off, or a stop/flush clears the line, while we wait.
    epoch = currentEpoch();
    const ok = await waitTurn(ticket, epoch, { stillWanted: stillEnabled });
    if (!ok || !lineStillOurs()) {
      releaseTicket(ticket);
      return aborted();
    }
    // Our turn. The prior utterance has finished, so do NOT stop anything.
  } else {
    // Manual/interactive: take over now. Clear the queue before killing the
    // current audio: the kill takes a moment, and a queued reply that saw the
    // line free in between would start talking. Then hold the line (our
    // ticket) so incoming hook speech waits behind us.
    flushQueue();
    stopPlayback();
    epoch = currentEpoch();
  }

  const dir = newStreamDir();
  const player = spawnStreamPlayer(dir, agent);
  // Attach the close listener up front so a fast utterance can't emit 'close'
  // before we await it.
  const closed = once(player, 'close');
  // A player that quits before it is told the reply is over (a script policy
  // that blocks it, a broken audio stack) will never play another chunk, so
  // nothing more is bought for it, and the result says what happened.
  let playerExit = null;
  closed.then(
    ([code, signal]) => { playerExit = code ?? signal ?? 'unknown'; },
    (err) => { playerExit = err.code || 'failed to start'; }
  );
  const playerAlive = () => playerExit === null;
  try {
    writeState({ lastPid: player.pid });
  } catch {
    // informational only; never worth abandoning a reply over
  }
  // Release our ticket the instant playback ends (in every mode, including
  // wait:false where the player outlives this function), so the next in line
  // can start.
  const release = () => releaseTicket(ticket);
  closed.then(release, release);

  const abandon = () => {
    writeEndMarker(dir, 0);
    try {
      player.kill();
    } catch {
      // already gone
    }
    releaseTicket(ticket);
  };

  // A stop or voice-off can land between the gate above and the spawn. That
  // stop found nothing to kill, because this player did not exist yet, and
  // nothing sweeps again; so check once more now that it exists and can die.
  if (!lineStillOurs()) {
    abandon();
    return aborted();
  }

  // First chunk synchronously: surfaces errors and starts audio ASAP.
  let first;
  try {
    first = await synthesize(chunks[0], st);
  } catch (err) {
    abandon();
    throw err;
  }
  if (!lineStillOurs() || !writeChunk(dir, 0, first)) {
    abandon();
    return aborted();
  }
  if (!playerAlive()) {
    abandon();
    return { spoken: 0, total, playerFailed: playerExit };
  }

  // Remaining chunks pipeline while the first plays, staying LOOKAHEAD_MS
  // ahead of the estimated playhead. Every step re-checks the line: a voice-off
  // mid-reply used to stop the audio while this loop kept paying the provider
  // for every remaining sentence.
  let written = 1;
  let truncated = false;
  let playerFailed;
  let queuedMs = wavDurationMs(first);
  const playStarted = Date.now();
  const rest = (async () => {
    try {
      for (let i = 1; i < total; i++) {
        while (queuedMs - (Date.now() - playStarted) > LOOKAHEAD_MS && lineStillOurs() && playerAlive()) {
          await sleep(250);
        }
        if (!lineStillOurs()) return;
        if (!playerAlive()) { playerFailed = playerExit; return; }
        const audio = await synthesize(chunks[i], st);
        if (!lineStillOurs()) return;
        if (!playerAlive()) { playerFailed = playerExit; return; }
        if (!writeChunk(dir, i, audio)) return;
        written = i + 1;
        queuedMs += wavDurationMs(audio);
      }
    } catch (err) {
      truncated = true;
      log(`speak: chunk ${written + 1} of ${total} failed, cutting the reply short: ${err && err.message}`);
      // Say so out loud, so a cut-off never passes for the end of the reply.
      try {
        if (lineStillOurs() && playerAlive() && writeChunk(dir, written, await synthesize(CUT_SHORT_CUE, st))) written += 1;
      } catch {
        // the provider is down; the log line above is all we can do
      }
    } finally {
      writeEndMarker(dir, written);
    }
  })();

  if (!wait) {
    player.unref();
    rest.catch(() => {});
    return { spoken: 1, total, streaming: true };
  }

  await rest;
  await closed.catch(() => {});
  return { spoken: written, total, truncated, ...(playerFailed !== undefined && { playerFailed }) };
}
