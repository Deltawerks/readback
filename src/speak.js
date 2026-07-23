import { once } from 'node:events';
import { synthesize } from './tts.js';
import { chunkForSpeech } from './chunk.js';
import {
  newStreamDir,
  spawnStreamPlayer,
  writeChunk,
  writeEndMarker,
  stopPlayback,
} from './audio.js';
import { readState, writeState } from './state.js';
import { enqueue, releaseTicket, waitTurn, currentEpoch, flushQueue } from './queue.js';
import { log } from './log.js';

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
export async function speak(text, st, { wait = false, queue = false } = {}) {
  const chunks = chunkForSpeech(text);
  if (!chunks.length) return { spoken: 0 };

  // Take our place in line. (enqueue is a couple of file ops; when nothing else
  // is talking, waitTurn returns on the first pass with no sleep, so no latency.)
  const ticket = enqueue();
  if (queue) {
    // Wait politely behind any active or queued utterance. Give up if voice is
    // turned off, or a stop/flush clears the line, while we wait.
    const epoch = currentEpoch();
    const ok = await waitTurn(ticket, epoch, {
      stillWanted: () => readState().enabled,
    });
    if (!ok) {
      releaseTicket(ticket);
      return { spoken: 0, aborted: true };
    }
    // A stop or voice-off can land in the sliver between being handed the line
    // and spawning the player below. Without this re-check, that reply would
    // start talking a beat after you hit "off". Re-read and bail if so.
    if (currentEpoch() !== epoch || !readState().enabled) {
      releaseTicket(ticket);
      return { spoken: 0, aborted: true };
    }
    // Our turn. The prior utterance has finished, so do NOT stop anything.
  } else {
    // Manual/interactive: take over now. Kill current audio and clear the queue,
    // then hold the line (our ticket) so incoming hook speech waits behind us.
    stopPlayback();
    flushQueue();
  }

  const dir = newStreamDir();
  const player = spawnStreamPlayer(dir);
  // Attach the close listener up front so a fast utterance can't emit 'close'
  // before we await it.
  const closed = once(player, 'close');
  writeState({ lastPid: player.pid });
  // Release our ticket the instant playback ends (in every mode, including
  // wait:false where the player outlives this function), so the next in line
  // can start.
  const release = () => releaseTicket(ticket);
  closed.then(release, release);

  // First chunk synchronously: surfaces errors and starts audio ASAP.
  let first;
  try {
    first = await synthesize(chunks[0], st);
  } catch (err) {
    writeEndMarker(dir, 0); // let the waiting player exit cleanly
    stopPlayback();
    releaseTicket(ticket);
    throw err;
  }
  writeChunk(dir, 0, first);

  // Remaining chunks pipeline while the first plays.
  const rest = (async () => {
    let written = 1;
    try {
      for (let i = 1; i < chunks.length; i++) {
        const audio = await synthesize(chunks[i], st);
        writeChunk(dir, i, audio);
        written = i + 1;
      }
    } catch (err) {
      log('speak: chunk synth error', err && err.message);
    } finally {
      writeEndMarker(dir, written);
    }
  })();

  if (!wait) {
    player.unref();
    rest.catch(() => {});
    return { spoken: chunks.length, streaming: true };
  }

  await rest;
  await closed;
  return { spoken: chunks.length };
}
