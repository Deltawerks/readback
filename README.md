# Readback

**Voice output for Claude Code.** Flip it on and Claude reads its replies aloud,
so you can rest your eyes or keep half an ear on a long run instead of watching
the terminal scroll. Flip it off and it stops immediately, mid-sentence if the
phone rings.

<p align="center">
  <img src="img/readback.png" alt="Readback control panel" width="420" />
</p>

- 🪟 **Windows-first.** Plays through built-in PowerShell audio, with zero
  external dependencies. (Most Claude voice tools are macOS-only.)
- 🎚️ **Two providers.** [Inworld](https://inworld.ai) (hundreds of voices, cheap)
  and [ElevenLabs](https://elevenlabs.io), switchable in a click.
- 🖥️ **GUI-tunable.** A little control panel for voice, model, speed and
  expression, with a live voice picker and in-app key entry. No `.env` fiddling.
- ⚡ **Streaming.** Splits replies into sentences and starts talking on the first
  one, so audio kicks in fast even on long messages.
- 🔀 **Multi-session.** Running several Claude projects at once? Their replies
  **queue and read in order** instead of cutting each other off. Voice off still
  silences everything instantly.

> Unofficial community tool. Not affiliated with, or endorsed by, Anthropic,
> Inworld, or ElevenLabs.

---

## How it works

Three cooperating pieces sharing one state file:

| Piece | Role |
|------|------|
| **MCP server** | in-chat toggle: `voice_on` / `voice_off` / `set_provider` / `set_voice` / `say` / `list_voices` |
| **Stop hook** | the actual voice: auto-speaks each reply while enabled |
| **Control panel** | `localhost:7717` web cockpit for provider / voice / model / tuning + live preview |

The hook and MCP toggle work whether or not the panel is open.

## Setup (Windows, Node 18+)

```powershell
git clone https://github.com/Deltawerks/readback
cd readback
npm install
npm run panel        # opens the control panel in your browser
```

In the panel: pick a **provider**, paste that provider's **API key**, choose a
**voice**, and hit ▶ to hear it. Then wire it into Claude Code:

```powershell
npm run register     # writes .mcp.json + hooks-snippet.json for this folder
```

**1. MCP server** (the in-chat toggle). Auto-loads whenever you work in this
folder. To get it in *every* project, run the `claude mcp add` line that
`register` prints.

**2. Auto-speak hook** (the part that actually talks). Open your Claude Code
settings at `C:\Users\<you>\.claude\settings.json` and add the `hooks` block from
the `hooks-snippet.json` that `register` just wrote. If that settings file
doesn't exist yet, paste the snippet in as the whole file. If it does exist, add
`"hooks"` alongside whatever is already in there:

```json
{
  "yourExistingSettings": "stay exactly as they are",
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node", "args": ["C:\\path\\to\\readback\\hook\\stop-hook.js"], "timeout": 15 } ] }
    ]
  }
}
```

Use the path from *your* generated snippet, not the one above. Then **restart
Claude Code**, say "voice on", and the next reply should speak.

**Optional:** `npm run shortcut` drops a "Readback" icon on your Desktop that
opens the panel in one click.

Quick smoke test, no Claude Code required:

```powershell
npm run say "readback is online"
npm run voices        # list the active provider's voices
```

### Day to day (and after a reboot)

**Nothing to restart.** Claude Code launches the MCP server itself, and the hook
is just a line in its settings file, so both come back on their own after a
reboot.

The control panel is **optional and on-demand**: a settings GUI, not a background
service. Voice keeps working whether or not it's open, because the hook reads
your saved settings from disk. Launch it (Desktop icon or `npm run panel`) when
you want to switch voice, provider or speed, then close it again.

## Using it

- In chat: say "voice on" and replies start speaking. "voice off" silences
  instantly, including whatever's playing right then.
- Multiple projects at once: their replies line up and read one after another
  instead of stomping each other. "voice off" (or the panel's Stop button) clears
  the whole queue at once, for when the phone rings.
- In the panel: switch provider, pick a voice, drag speed / expression, hit ▶ to
  preview. The panel's Speak/preview takes over immediately (it's you, at the
  keyboard); only the automatic per-reply speech queues.

Keys are stored per-user **outside the repo**: `%APPDATA%\Readback\secret.json`
on Windows (`~/.config/readback/` elsewhere), so cloning into a shared or
cloud-synced folder can't sync your key with it. Override the location with
`READBACK_STATE_DIR`. Replies are cleaned before speaking (code blocks dropped,
links flattened, markdown/emoji stripped). Extremely long replies are capped
with a spoken "the rest is on screen", but the cap is deliberately high so it
acts as a backstop rather than clipping normal replies. Set
`READBACK_MAX_CHARS` if you want a shorter ceiling on how long a read can run.

> **Upgrading from an earlier version?** Your key and settings are copied to the
> new location automatically on first run. The originals are left in the repo's
> `.readback/` folder (gitignored), so nothing is lost if you roll back. Delete
> that folder once you've confirmed things still work.

## Notes & limits

- Windows only (PowerShell `SoundPlayer` playback). No STT / voice input.
- Speech is provider-agnostic WAV under the hood (Inworld LINEAR16; ElevenLabs
  PCM wrapped in a WAV header), so the streaming player never cares which
  provider you're on.
- The panel is loopback-only (`127.0.0.1`), rejects cross-origin requests, and
  bundles its own logo + fonts, so the page itself loads nothing from the
  internet.
- Synthesis *does* call out, by design: your cleaned, truncated reply text and
  your API key go to whichever provider you picked (Inworld or ElevenLabs) over
  HTTPS, and nowhere else. Readback has no servers, no telemetry, no analytics,
  and no update check.
- **It costs money per character spoken.** Readback defaults to the cheapest
  sensible model (Inworld `tts-1.5-mini`, $5 per million characters; `max` is
  double that for a bit more richness). Worth knowing: if you add the hook to
  your global `settings.json`, it speaks in *every* project where voice is on,
  which adds up faster than you'd guess. Keep it per-project, or toggle voice
  off when you're not listening.
- Trouble? Check `readback.log` in `%LOCALAPPDATA%\Readback` on Windows
  (throwaway data is kept out of the roaming profile), or alongside the state dir
  otherwise.

## License

MIT. See [LICENSE](LICENSE).
