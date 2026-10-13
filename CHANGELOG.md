# Changelog

Dates are the git tag date for tagged versions. Versions that were never
tagged (0.1.0 to 0.3.0, and the 0.6 line, which shipped inside 0.7.0) are
dated from the commit history; 0.1.0 predates it.

## 0.7.0 (2026-10-12)

The first release after 0.5.2. It adds music ducking and includes the
unreleased 0.6 line: Codex support, separate Claude and Codex profiles, and
Inworld TTS-2 (see below).

### Added

- **Ducking.** While ReadBack speaks, or while you dictate into Claude Desktop or Codex Desktop, other audio dips to 10% and comes back afterwards. While you dictate, ReadBack's own voice drops to 15% so it can't blast into your voice-to-text. It works with apps that play through the normal Windows mixer (not WASAPI exclusive mode), with nothing to configure per player. Off by default; switch it on in the panel.
- A single referee in the panel server owns every volume change, so overlapping speech, previews and dictation don't bring the music back early. A small Windows PowerShell audio helper (inline C#, no new dependencies) does the Windows audio work and, when it exits, puts back the levels it lowered, including when the panel server dies.
- Crash safety:
  - apps left lowered by a crash or power cut are put back on the next panel start
  - an app closed mid-dip is put back when it reopens while the audio helper is running
  - a **Restore volume** button restores on demand
  - moving an app's volume yourself during a dip is respected
- Tests:
  - the referee's overlap, hold, restore, manual-change and recovery rules
  - settings normalization under the settings lock
  - the panel routes
  - a Windows integration test that ducks a throwaway silent app and checks it comes back

### Also in this release: the unreleased 0.6 line

These versions were numbered during development but never tagged or
published. All of this work shipped in 0.7.0.

#### 0.6.3 (2026-10-12)

- Fix silent Codex replies in long-running chats whose transcripts exceed 128 MB. Verify session identity at the beginning and search backward for the matching turn, with bounded memory and no total-file-size cutoff.
- Preserve background-suggestion and subagent filtering. Add regression coverage for large histories, oversized records, and UTF-8/read-boundary handling.

#### 0.6.2 (2026-10-12)

- Launch Codex speech workers outside the Windows hook job so turn cleanup cannot cut off playback. Pass the worker's environment through the launcher's standard input, never the command line, and consume reply input from a single-use private cache file.
- Add a real Windows job-termination regression test alongside shared-queue and mute coverage.

#### 0.6.1 (2026-10-12)

- Skip Codex composer predictions, subagent turns and turns with an unrecognized trigger, using the session and turn metadata in the saved Codex transcript. Only that metadata is used; the spoken text still comes from the Stop event. A turn whose metadata carries no attribution is still spoken. The README lists the exact checks.
- Launch the Windows panel shortcut outside the calling app job so closing Codex does not terminate the panel.

#### 0.6.0 (2026-10-12)

**Added**

- **Codex auto-speak:** a dedicated `Stop` hook accepts the finished reply from
  Codex and sends it to ReadBack's existing automatic speech queue. Claude and
  Codex share the master switch and queue; duplicate Codex hook
  delivery is claimed once per session/turn. The spoken text comes from the
  Stop event's `last_assistant_message`; this version did not read the Codex
  transcript at all (0.6.1 added a metadata check).
- `npm run register:codex` generates hook and optional MCP snippets without
  changing either assistant's configuration or ReadBack settings. The setup
  guide includes hook trust, independent profiles and rollback instructions.
- Codex-only cleanup skips app directives and citation metadata when speaking.
- The panel now says **Voice for Claude & Codex**, with an independent speech
  toggle, provider, voice, model and tuning for each agent. Keys remain shared.
- Inworld's default and any saved TTS-1 or TTS-1.5 model move to TTS-2 Flash,
  keeping voice and speed. Flagship TTS-2 uses the supported deliveryMode enum:
  Stable, Balanced or Creative. Flash shows speed only.
- Per-agent mute cancels only that source's players and queued workers. Master
  mute also blocks manual previews and MCP say; the old force bypass is removed.
- Profile updates merge under the existing cross-process settings lock. Saved
  master mute is preserved, and runtime bookkeeping remains in a separate file.

**Compatibility**

- Local Windows Codex chats with lifecycle-hook support. Remote/cloud execution
  is not supported. Codex hooks must be reviewed and trusted by the user.
- Existing settings seed both profiles on upgrade. The legacy top-level provider
  fields mirror Claude for compatibility. No new provider key is required.
- Codex's MCP registration sets READBACK_SOURCE=codex; existing Claude MCP
  registrations default to Claude. Restart long-lived panels/MCP clients after upgrading.

## 0.5.2 (2026-09-23)

### Fixed

- **Voice off now stays off when Claude Code runs inside Claude Desktop on
  Windows.** Claude Desktop gives everything it starts, including the hook that
  speaks, its own private copy of `AppData`. The panel, started at login or from
  a shortcut, runs outside Claude Desktop and reads the real one. ReadBack kept
  its settings in `AppData`, so the panel and the voice read two different files
  at the same path, and switching voice off in the panel changed a file the
  voice never read. Cycling the toggle seemed to help only because stopping
  playback acts on the running process, not on the file.

  Settings, the key and the working files now live in `%USERPROFILE%\.readback`,
  which Claude Desktop does not redirect. Your existing key and settings are
  copied there on first run (the originals are left where they were), and voice
  starts off.

## 0.5.1 (2026-09-14)

### Fixed

- **Voice could turn itself back on a moment after you turned it off.** Every
  settings write was a read, a merge and a write, with nothing serializing them.
  A write that began before your toggle (changing a voice, dragging a slider, or
  anything else the panel saves) merged the `enabled` it had read a moment
  earlier and put that back. The panel's own request sequencing then discarded
  the stale reply, so the switch kept showing off while the file said on and
  every finished task spoke. Cycling the toggle cleared it until the next time,
  which made it look intermittent.

  Settings writes now take a cross-process lock and merge onto the file as it is
  inside that lock, so a write changes only the keys it carries. An unrelated
  save can no longer undo a voice-off.

- **Turning voice on or off is now logged**, with the process that did it and
  the value it changed from.

## 0.5.0 (2026-09-08)

Each fix below ships with a test that fails without it. Recommended for anyone
on 0.4.x. The fixes for voice that kept talking come first.

### Fixed

- **Replies could stop speaking until the toggle was cycled.** After a normal
  reply finished, a leftover process id was never cleared, and the check for
  "is something still playing" trusted that id with no expiry. Once Windows
  reused that number for any long-running program, every later reply waited
  indefinitely for a player that had ended hours before, and only cycling the
  toggle cleared it.
  Players now announce themselves in their own files and keep them fresh while
  they run, so "still playing" means a process that is playing now, not a
  remembered number.

- **Voice off could fail with the audio still playing.** Two ReadBack processes
  saving at the same moment (the panel and a hook, say) collided on a file
  rename Windows would not allow, and under load that failed on nearly half of
  all writes. The save is now retried through that transient refusal, and
  turning voice off stops the audio and clears the queue whether or not the
  save succeeds.

- **Stop could end the wrong process and miss the right one.** The sweep behind
  the stop matched any program whose command line mentioned the player script,
  so an open editor or shell could be terminated, and it matched its own
  command, which cut the sweep off partway so players listed after it survived.
  It now targets only player processes started by this install, confirmed by
  their recorded start time, and never itself.

- **A reply longer than ten minutes could not be stopped.** The old stop gave up
  on any player more than ten minutes old, measured from its start, and then
  deleted its record, so nothing could reach it again. Liveness is now based on
  the player still running, not its age, so a long read stops like any other.

- **Voice off now stops paying for the rest of the reply.** A reply is
  synthesized sentence by sentence. Voice off stopped the audio, but background
  synthesis kept calling the provider for every remaining sentence. It now
  checks after each sentence and stops synthesizing once voice is off.

- **Two projects finishing at the same instant no longer drop a reply, and a
  doubled hook fire no longer speaks one twice.** The claim on which worker
  speaks a reply was a single shared slot with a brief settle, and two replies
  landing close together fought over it. Each reply is now claimed by an atomic
  file create, which exactly one worker can win.

- **A save that cannot be written is reported, not swallowed.** `enabled` is now
  only ever true or false, so a stray string or number from another client can
  no longer read as "on" to the workers while the panel shows off; a
  non-boolean is refused. A settings file that is briefly unreadable (an
  antivirus or backup holding it) is treated as "unknown, try again", not as
  corruption to reset, which had silently wiped saved settings. A corrupt file
  is kept aside before defaults take over.

- **A cut-short reply now says so.** If a sentence fails mid-reply, ReadBack
  says "the rest is on screen" out loud and the log records how many sentences
  of how many were spoken, instead of logging a full success.

- **A stalled provider response can no longer hang a worker.** The request
  timeout now covers the whole download, not just the initial connection, and
  the retry repeats only failures worth repeating (network errors, rate limits,
  server errors), never a bad key and never an aborted request, which on
  ElevenLabs could otherwise be billed more than once.

- **The panel no longer freezes on a long run of dashes or spaces.** That input
  hit a pathological regex on the path that runs on every reply and could pin
  the CPU for minutes. The regex is fixed, and input is capped before it.

- **The control panel keeps its state accurate.** A hung server now shows the
  NOT CONNECTED banner instead of a toggle that may be wrong; the poll no longer
  rebuilds the dropdowns and sliders under your cursor mid-drag; a stale read
  can no longer overwrite a newer toggle; and a value the provider will reject
  shows the default rather than NaN.

- **Speech reads better.** Wrapped prose is no longer read with a full stop at
  every line break, and `snake_case` identifiers keep their underscores instead
  of being run together.

### Changed

- **Voice off applies to the tools too.** The MCP `say` tool now refuses while
  voice is off unless it is called with `force: true`, so an assistant cannot
  talk over a mute you just pressed. The panel's Speak and preview buttons are
  unaffected. (0.6.0 removed the `force` bypass.)

- **ElevenLabs defaults that work on the first try.** It ships with a real
  default voice (so a first run is not silent), defaults to a current Flash
  model rather than a deprecated Turbo one, and stops sending the tuning fields
  the newest model does not accept. The panel and README now show the
  per-character price next to the provider; at the time, ElevenLabs cost ten to
  twenty times Inworld's default.

- **Overriding `READBACK_STATE_DIR` no longer splits the app.** The cache
  directory has its own override, `READBACK_CACHE_DIR`, and every ReadBack
  process resolves both the same way; `npm run where` prints them and `/health`
  reports them. (Carried from 0.4.4.)

### Docs and packaging

- The install steps no longer tell you to paste a second `hooks` key, which is
  valid JSON that silently drops every hook you already had; the MCP line now
  registers at user scope so the tools exist in every project, matching the hook.
- `.gitignore` now covers `.env*`, `secret.json`, `.claude/settings.local.json`
  and retired files; the sample env file shows the real default cap.

## 0.4.4 (2026-09-08)

### Fixed

- **Voice off stops what is playing, and stays off.** Settings and working files
  are kept in two different places on purpose, but the cache location used to
  fall back to the settings location whenever `READBACK_STATE_DIR` was set. Any
  launcher that set the override for the panel but not for the hook workers put
  the two halves in different folders.

  They still shared `state.json`, so voice on and off appeared to work, and the
  next reply did stay quiet. But the queue, the playback epoch and the list of
  running players were per-half, so the panel's "stop talking" swept a
  directory that was always empty and cleared a queue nobody was waiting in.
  Whatever was already speaking kept going, and a reply already queued behind
  it started afterwards.

  The cache location no longer follows the settings location on any platform. It
  has its own override, `READBACK_CACHE_DIR`, and both halves resolve it the same
  way regardless of how they were launched.

- **The panel checks its own work from a separate process.** A panel had twice
  been found answering requests while its reads and writes were wrong together:
  it served values that existed in no file and discarded every write, so every
  check it ran against itself passed. The startup self-test and the save
  confirmation now both verify through a separate process, which has its own
  view of the filesystem.

- **A failed save is reported in plain language** instead of as an errno, and
  never as a success. A toggle that did not reach disk shows as an error on the
  page rather than as a switch that looks like it moved.

### Added

- `npm run where` prints every path ReadBack resolved. Run it from the panel's
  environment and from a Claude Code session; if the two disagree, that is the
  problem. `/health` now reports the cache directory alongside the state
  directory.

- Tests covering the above: that pinning the settings directory cannot move the
  cache directory, that the two overrides are independent, that a panel which
  cannot save settings refuses to start, and that a toggle which cannot be saved
  comes back as an error rather than a success.

### Note

The 0.4.2 notes described a "bundled" Windows startup script. There is no such
script in this repo, only the manual launcher in `scripts/`. That entry has been
corrected.

## 0.4.3 (2026-09-07)

### Fixed

- **Finished tasks no longer speak while the toggle shows off.** Before, every
  finished task still spoke, and only cycling the toggle on and off again
  silenced the current one.

  Two faults combined. A panel could end up unable to persist settings while
  still serving normally: it answered requests, showed the toggle in whatever
  position you left it, and discarded every write, so the file the speaking
  workers read still said voice was on. And the startup self-test added in 0.4.2
  to catch this probed `lastSpokenBy`, a *runtime* field kept in a different
  file, so it verified the wrong file and started a panel that could not save
  the voice setting.

  The self-test now probes a settings field, so a panel that cannot save the
  toggle refuses to start. Saving the setting is also confirmed against disk
  before the panel reports success; if it did not persist, the request fails and
  the page shows the error.

## 0.4.2 (2026-08-15)

### Fixed

- **The panel refuses to start if it cannot reach its state file.** A panel
  launched at login was seen answering requests normally while never touching
  the filesystem: it reported a plausible state directory, served values that
  existed in no file, and discarded every write. The toggle appeared to work,
  the status line read "voice on", and nothing spoke, with no error anywhere.

  The panel now proves it can round-trip its state file before it serves, and
  exits if it cannot, so the page reports it as `NOT CONNECTED`.

- Guidance for auto-starting the panel at login on Windows: wait for the session
  to settle before launching. Starting too early is the likeliest way to get the
  panel described above. (This release note originally described a "bundled"
  startup script. No such script ships in this repo; only the manual launcher in
  `scripts/` does. Corrected in 0.4.4.)

## 0.4.1 (2026-08-02)

### Fixed

- **Voice off now stays off when you turn it off mid-reply.** Turning voice off
  while a reply was speaking stopped that reply, but the next one spoke anyway,
  and only a second on-then-off cycle made it stick.

  Settings and transient bookkeeping shared one file. Every speaking worker
  rewrites that file to record which player is running and which reply it last
  spoke, and it did so by reading the whole file, merging its change, and writing
  it all back. When a toggle landed between a worker's read and its write, the
  worker wrote back the `enabled: true` it had read and undid the toggle. Because
  a worker writes exactly when speech starts, a toggle during speech was the most
  likely to be lost.

  Runtime bookkeeping now lives in its own file, so a worker recording its player
  never opens the settings file and cannot overwrite your choice.

## 0.4.0 (2026-07-31)

Recommended for anyone on an earlier version. Several of these fix voice not
turning off and a panel toggle that had no effect; they were bugs, not
misconfiguration.

### Fixed

- **Voice off now stops every player.** Playback was stopped by killing a single
  tracked process id, which goes stale the moment one reply hands off to the
  next. With several projects running that window was easy to hit, and the
  reply kept talking through "voice off". Every player is now tracked by its real
  pid and all of them are stopped.
- **The panel and the hook workers could end up on different state files**, so
  the panel toggle updated a file no worker read: the panel showed the new value
  and its Speak button worked, while replies stayed silent. This happened when
  the panel was launched from a login or startup task with an environment that
  has no `APPDATA`. The state directory now resolves consistently, and `/health`
  reports it so a mismatch is easy to spot.
- **The panel no longer shows a voice state it hasn't verified.** A toggle whose
  request never reached the server used to leave "voice on" on screen; the panel
  now re-syncs on a failed write and shows `NOT CONNECTED` when it can't reach
  the server.
- **The panel keeps itself in sync.** It read state once at load, so anything
  that changed voice elsewhere (the MCP tools, another tab) left a stale toggle.
- **A leftover queue ticket can no longer block every reply.** Tickets were only
  cleaned when their owning process was gone, but pids get reused, especially
  across a reboot, so an unrelated program could hold the line open
  indefinitely. Tickets now expire by age as well.
- **A stale player marker can no longer cause an unrelated process to be
  stopped** after a reboot reassigned its pid.
- Long replies are no longer clipped. The spoken-reply cap was low enough to
  truncate roughly one in seven replies, always the longer summaries, with a
  spoken "the rest is on screen". It is now a backstop rather than a limit.

### Changed

- **Inworld defaults to `tts-1.5-mini` instead of `tts-1.5-max`.** Mini cost half
  as much per character at the time and is good enough for reading replies
  aloud; the previous default cost twice as much. Existing installs keep
  whatever model they already selected; change it in the panel.
- A named remote origin can be allowed to read and toggle voice, for mirroring
  the control onto a dashboard. Off by default; opt in with
  `READBACK_ALLOWED_ORIGINS`. That origin can only flip voice on and off.
- Following a bookmark or a link to the panel works again. The origin check was
  rejecting cross-site navigation, which is not CSRF.

## 0.3.0 (2026-07-20)

- **Multi-session queueing.** Replies from several Claude Code projects line up
  and read in order instead of cutting each other off. Voice off still silences
  everything instantly.

## 0.2.0 (2026-07-01 to 2026-07-18)

- Dual provider support: Inworld and ElevenLabs, switchable in the panel.
- Control panel for voice, model, speed and tuning, with in-app key entry.
- Sentence-chunked streaming so audio starts on the first sentence.
- Keys moved out of the repo into a per-user directory, so cloning into a shared
  or cloud-synced folder cannot sync your key with it.
- Panel hardened: loopback only, cross-origin API requests rejected, logo and
  fonts bundled so the page makes no outbound requests.

## 0.1.0 (before 2026-07-01)

- Initial version. It predates this repository: the first commit, on
  2026-07-01, is already 0.2.0.
