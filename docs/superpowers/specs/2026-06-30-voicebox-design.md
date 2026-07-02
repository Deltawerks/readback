# voicebox — design spec

Date: 2026-06-30
Status: implemented (v0.1)

## Goal

Give Claude Code toggleable **voice output** using Inworld TTS, so the operator can
switch between reading replies and hearing them. Reuse the known-working Inworld
integration from the AgentLink app (same endpoint, auth, voice — Luna by default).

## Key decision: MCP alone can't do this

An MCP server exposes *tools Claude chooses to call*. Getting *every* reply spoken
reliably is not something Claude can be trusted to do by calling a tool each turn. So
the system is **MCP toggle + a Stop hook**:

- **MCP server** = the toggle (`voice_on` / `voice_off` / …). Writes a state file.
- **Stop hook** = fires automatically when Claude finishes a reply; if voice is on, it
  speaks the reply. No reliance on Claude remembering.

## Architecture

Four cooperating pieces over one state file (`.voicebox/state.json`):

1. **MCP server** (`src/mcp-server.js`, stdio, `@modelcontextprotocol/sdk`) — tools:
   `voice_on`, `voice_off`, `voice_status`, `stop`, `say`, `set_voice`, `set_model`,
   `set_speed`, `set_expression`, `list_voices`.
2. **Stop hook** (`hook/stop-hook.js`) — reads the hook payload, checks state; if
   enabled, spawns a **detached worker** and exits immediately (never blocks the turn).
   The worker (`hook/worker.js`) reads the last assistant message from the transcript,
   cleans it, synthesizes, and plays it.
3. **Control panel** (`src/panel-server.js` + `panel/index.html`) — launch-on-demand
   local web cockpit for voice / model / speed / expression + live preview. Reads and
   writes the same state file. Optional; the hook works without it.
4. **Desktop shortcut** (`scripts/launch-panel.vbs`, `scripts/install-shortcut.ps1`) —
   one-click, no-console launch. Starts the server hidden if needed, opens the browser,
   won't double-start.

Shared modules: `src/tts.js` (synthesize, listVoices, stripForSpeech, truncateForSpeech),
`src/audio.js` (play, stopPlayback, kill-on-new), `src/state.js`, `src/config.js`,
`src/transcript.js`, `src/log.js`.

## Inworld integration (from AgentLink)

- Synthesize: `POST https://api.inworld.ai/tts/v1/voice`, `Authorization: Basic <key>`
  (key is already base64). Body: `{ text, voiceId, modelId, audioConfig:{ audioEncoding,
  speakingRate, sampleRateHertz }, temperature }`. Response: `{ audioContent: <base64> }`.
- Voices: `GET https://api.inworld.ai/voices/v1/voices` (different base path), filterable.
- Retry like AgentLink: 3 attempts, 8s timeout, 500ms backoff.
- Defaults: `Luna`, `inworld-tts-1.5-max`, speed 1.3, expression 0.1.

## Playback (headless Windows)

AgentLink plays in a browser; voicebox is headless, so it plays via PowerShell
(`scripts/play.ps1`). Default encoding is `LINEAR16` (WAV-with-header) → `SoundPlayer.PlaySync`,
zero dependencies. `MP3` → winmm MCI (`play … wait`). Both block, so killing the
player process stops the sound. The player PID is stored in state. Supported encodings
are limited to `LINEAR16`/`WAV`/`MP3` (config clamps anything else, e.g. OGG, to
`LINEAR16`, since MCI can't play Opus).

## Control flow

- "voice on" → `voice_on` → `state.enabled = true`. Each subsequent reply: Stop hook →
  worker → strip → synthesize → **kill any current clip** → play. "voice off" /
  `stop` / panel toggle-off → kill current playback by PID.
- **Kill-on-new**: a new reply stops the previous clip so audio never overlaps.
- **Kill-on-demand**: toggle-off and `stop` kill mid-sentence (e.g. a phone call).
  `voice_off` disables + kills; `stop` kills but leaves voice armed.

## Guardrails

- Reply cleaned for speech: code blocks dropped, links flattened, markdown/emoji
  stripped; pure-code replies skipped; long replies truncated with a spoken tail note.
- The transcript parser ignores subagent turns (`isSidechain: true`) so only the main
  agent's reply is spoken, never a Task-tool subagent's internal output.
- Hook never blocks or crashes the turn: detached worker, all failures logged to
  `.voicebox/voicebox.log` and swallowed.
- MCP server writes nothing to stdout (reserved for the protocol); logs go to file.
- API key via `.env` (`INWORLD_API_KEY`), loaded by a tiny dependency-free parser so
  the MCP server, hook, panel, and CLI all pick it up.

## Testing

- Unit (`node --test`): `stripForSpeech` / `truncateForSpeech` and the transcript
  parser `extractLastAssistantText` (the risky pure logic).
- Smoke: `npm run say "…"` (end-to-end audio) and `npm run voices` (catalog).

## Streaming playback (v0.2)

To cut time-to-first-audio, replies are split into sentence chunks (`src/chunk.js`)
and streamed (`src/speak.js`): the first sentence is synthesized on its own and
starts playing immediately, while the remaining chunks are synthesized in the
background and played back-to-back by a single PowerShell player
(`scripts/play-stream.ps1`) reading `chunk-000.wav`, `chunk-001.wav`… from a
per-utterance `.voicebox/stream-<ts>/` dir until `end.marker` (the chunk count).
Chunks are written atomically (temp + rename) so the player never reads a partial
file. Long-lived callers (panel/MCP) await only the first chunk then stream the
rest; short-lived callers (hook worker, `say.js`) await the whole utterance.
Measured ~80% faster to first sound on long replies. Kill-on-new/stop kills the
one player process. Encoding is forced to `LINEAR16`/WAV for streamed chunks.

## Out of scope

Inworld's native streaming *synthesis endpoint* (sentence-chunking gives most of
the benefit with the simple sync endpoint), system-tray presence, non-Windows
playback.
