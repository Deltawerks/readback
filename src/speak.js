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
import { writeState } from './state.js';
import { log } from './log.js';

// Speak text with low latency: split into sentence chunks, start playing the
// first as soon as it's synthesized, and prefetch the rest so they play
// back-to-back with no gap. Chunks are always WAV (the streaming player uses
// Windows SoundPlayer).
//
// wait:false — for long-lived parents (panel / MCP server). Awaits ONLY the
//   first chunk (so auth/network errors surface and audio has already started),
//   then streams the remaining chunks in the background and returns.
// wait:true  — for short-lived parents (hook worker, say.js). Awaits the entire
//   utterance including playback, so the process stays alive until audio ends.
export async function speak(text, st, { wait = false } = {}) {
  const chunks = chunkForSpeech(text);
  if (!chunks.length) return { spoken: 0 };

  stopPlayback(); // kill-on-new: stop any prior stream first
  const dir = newStreamDir();
  const player = spawnStreamPlayer(dir);
  // Attach the close listener up front so a fast utterance can't emit 'close'
  // before we await it.
  const closed = once(player, 'close');
  writeState({ lastPid: player.pid });

  // First chunk synchronously — surfaces errors and starts audio ASAP.
  let first;
  try {
    first = await synthesize(chunks[0], st);
  } catch (err) {
    writeEndMarker(dir, 0); // let the waiting player exit cleanly
    stopPlayback();
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
