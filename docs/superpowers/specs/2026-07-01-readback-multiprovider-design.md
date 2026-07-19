# Readback — multi-provider + public release design

Date: 2026-07-01
Status: **shipped** — kept as a historical design record, not current documentation.
Supersedes naming/scope of the original `voicebox` spec (2026-06-30).

> Some details here were overtaken by the implementation. Most notably, state and
> secrets now live in a per-user app-data directory rather than the in-repo
> `.readback/` this document describes. **The [README](../../../README.md) is the
> authoritative description of how Readback actually behaves.**

## Goal

Rename `voicebox` → **Readback**, add **ElevenLabs** as a second TTS provider
alongside Inworld, polish it for public release, and publish to
`github.com/Deltawerks/readback`. Free/open-source. Positioning: "Windows-first,
dual-provider, GUI-tunable voice output for Claude Code."

Decided in brainstorm: **dedicated Provider selector** (not merged into the model
dropdown); **native controls per provider** (Inworld: speed + temperature;
ElevenLabs: speed + stability + similarity + style); build everything before the
first push.

## 1. Rename voicebox → readback

Mechanical but wide. The name appears in: `package.json`, MCP server name, the
panel title, README, `.env.example`, `.mcp.json`, `hooks-snippet.json`, log lines,
the spec. State dir stays `.readback/` (was `.voicebox/`). Desktop shortcut
"Readback". The code already resolves its own root from `import.meta.url`, so only
strings/paths in registration + docs change. MCP server id becomes `readback`.

## 2. Provider abstraction

New `src/providers/`:
- `inworld.js` — `synthesize(text, cfg, apiKey) → WAV Buffer`, `listVoices(apiKey, filter) → [{voiceId, name, description, gender}]`, `MODELS`, `DEFAULTS`.
- `elevenlabs.js` — same interface.
- `index.js` (dispatcher) — `getProvider(name)` returns the module; `PROVIDERS` metadata (label, models, tuning-knob descriptors for the panel).

Both **return WAV bytes**, so the chunker, streaming player, hook, sync fix, and
kill-on-new are untouched:
- Inworld: `audioEncoding: LINEAR16` → already WAV.
- ElevenLabs: `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=pcm_24000`,
  header `xi-api-key`, body `{ text, model_id, voice_settings:{ stability,
  similarity_boost, style, use_speaker_boost, speed } }`. Response is raw PCM;
  prepend a 44-byte WAV header (24 kHz, 16-bit, mono) → WAV. Voices:
  `GET https://api.elevenlabs.io/v2/voices` (xi-api-key), map `voice_id`/`name`/
  `labels`/`description`. Default model `eleven_turbo_v2_5` (low latency for
  chunked streaming); also `eleven_multilingual_v2`, `eleven_flash_v2_5`.

`src/tts.js` keeps `stripForSpeech`/`truncateForSpeech` and becomes a thin
`synthesize(text, state)` / `listVoices(state)` that resolve the active provider +
its config + key and delegate. `src/speak.js` calls this; unchanged otherwise.

## 3. State model + keys

```
{
  provider: "inworld" | "elevenlabs",   // default inworld
  enabled, maxChars, lastPid, lastSpokenId,
  inworld:    { voiceId:"Luna",  modelId:"inworld-tts-1.5-max", speed:1.3, temperature:0.1 },
  elevenlabs: { voiceId, modelId:"eleven_turbo_v2_5", speed:1.0,
                stability:0.5, similarity:0.75, style:0.0, speakerBoost:true }
}
```
`readState()` resolves `active = state[state.provider]`. Migration: an old flat
state (voiceId/modelId/speed/expression at top level) folds into `inworld{}` with
`temperature = expression`, `provider = "inworld"`. Keys in `.readback/secret.json`:
`{ inworldApiKey, elevenlabsApiKey }`. `getApiKey(provider)` picks the right one
(env override still wins, per provider: `INWORLD_API_KEY` / `ELEVENLABS_API_KEY`).

## 4. Panel

- **Provider toggle** (segmented: Inworld / ElevenLabs) at the top of settings.
- Switching provider swaps: the API-key field (active provider's key + masked
  saved-state), the voice dropdown (fetched from that provider), the model
  dropdown, and the tuning controls.
- Tuning controls are **provider-descriptor driven** — the panel renders sliders
  from a per-provider knob list (`{key, label, min, max, step, default}`), so
  Inworld shows Speed + Expression(temperature) and ElevenLabs shows Speed +
  Stability + Similarity + Style + a Speaker-boost switch, with no bespoke markup.
- Speed clamps per provider (Inworld 0.5–1.5, ElevenLabs ~0.7–1.2).
- Preview / Speak / Stop unchanged.

## 5. MCP tools

Add `set_provider(provider)`. `set_voice` / `set_model` / `set_speed` /
`list_voices` / `voice_status` act on the **active** provider (write into its
nested block). Fine ElevenLabs knobs (stability/similarity/style) stay panel-only
to keep chat lean. `voice_status` reports provider + voice + model + key knobs.

## 6. Shippable / release

- **Portable registration:** a `scripts/register.ps1` (or `npm run register`)
  that writes `.mcp.json` and the Claude Code Stop-hook entry using the *actual*
  install directory (resolved at runtime), instead of the hardcoded `E:\CLAUDE\…`.
  Same for the desktop shortcut (already resolves its own dir).
- **README:** the Windows-first / dual-provider / GUI-tunable pitch, quick-start
  (install → run panel → pick provider → paste key → register → restart), a note
  that it's unofficial and not affiliated with Anthropic, and screenshots.
- **LICENSE:** MIT (confirm at publish).
- **Cleanup:** delete the now-dead single-clip `play.ps1` + `PLAY_SCRIPT`; drop
  stale references; ensure `.gitignore` covers `node_modules/`, `.readback/`,
  `.env`, `*.log`, generated icon.
- **Publish:** local `git init` + first commit now; remote `Deltawerks/readback`;
  **push only after Elf confirms** (public, one-way door).

## 7. Testing

Keep the existing unit tests (chunker, transcript/currentReply, stripForSpeech).
Add: provider-dispatch tests (right module/config/key per `state.provider`),
PCM→WAV header correctness (RIFF/WAVE, 24 kHz/16-bit/mono, data size), and state
migration (flat → nested). Smoke: `npm run say` on each provider, panel Speak on
each, an end-to-end auto-speak. Adversarial review of the provider layer before
push.

## 8. Out of scope (v1 release)

STT / voice input; providers beyond Inworld + ElevenLabs; non-Windows playback;
Inworld's / ElevenLabs' native streaming synthesis endpoints (sentence-chunking
already gives the fast start).
