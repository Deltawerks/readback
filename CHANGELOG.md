# Changelog

## 0.5.1

### Fixed

- **Voice could turn itself back on a moment after you turned it off.** Every
  settings write was a read, a merge and a write, with nothing serializing them.
  A write that began before your toggle, changing a voice or dragging a slider or
  anything else the panel saves, merged the `enabled` it had read a moment
  earlier and put that back on top. The panel's own request sequencing then
  discarded the stale reply, so the switch went on showing off while the file
  said on and every finished task spoke. Cycling the toggle cleared it until the
  next time, which is what made it look intermittent rather than broken.

  Settings writes now take a cross-process lock and merge onto the file as it is
  inside that lock, so a write can only change the keys it actually carries. A
  voice-off can no longer be undone by an unrelated save.

- **Turning voice on or off is now recorded in the log**, with which process did
  it and what it changed from. "It turned itself back on" is answerable from the
  log now instead of by guesswork.

## 0.5.0

The stop button is fixed at the root this time, and the fixes ship with tests
that fail without them. If you are on any 0.4.x, update. A full adversarial
review (five passes over the whole tool) turned up the causes below; the ones
that made voice keep talking are first.

### Fixed

- **The recurring "it works, then one day it just stops" bug.** After a normal
  reply finished, a leftover process id was never cleared, and the check for
  "is something still playing" trusted that id with no expiry. As soon as
  Windows handed that number to any long-running program, every later reply
  waited forever for a player that had ended hours ago, and only cycling the
  toggle cleared it. Players now announce themselves in their own files and keep
  them fresh while they run, so "still playing" means a process that is actually
  playing right now, not a remembered number.

- **Voice off could error out with the audio still going.** Two Readback
  processes saving at the same moment (the panel and a hook, say) collided on
  the file rename Windows would not allow, and under load that failed on nearly
  half of all writes. The save is now retried through that transient refusal,
  and, just as important, turning voice off stops the audio and clears the queue
  whether or not the save succeeds. An unsaved setting is something to report,
  never a reason to keep talking.

- **"Stop" could kill the wrong thing and miss the right one.** The sweep that
  backed up the stop matched any program whose command line merely mentioned the
  player script, so an open editor or shell could be terminated, and it matched
  its own command, which cut the sweep off half finished so players enumerated
  after it survived. It now targets only real player processes started by this
  install, confirmed by their recorded start time, and never itself.

- **A reply longer than ten minutes used to be unstoppable.** The old stop gave
  up on any player more than ten minutes old, measured from when it started, and
  then deleted the record so nothing could reach it again. Liveness is now based
  on the player still running, not its age, so a long read stops like any other.

- **Turning voice off now stops paying for the rest of the reply.** A reply is
  synthesized sentence by sentence. Voice off stopped the audio but the
  background synthesis kept calling the provider for every remaining sentence.
  It now checks after each sentence and stops synthesizing the moment the line
  is pulled.

- **Two projects finishing at the same instant no longer drop a reply, and a
  doubled hook fire no longer speaks one twice.** The "who speaks this reply"
  claim was a single shared slot with a brief settle; two replies landing close
  together fought over it. Each reply is now claimed by an atomic file create,
  which exactly one worker can win.

- **A save that cannot be written is reported, not swallowed.** `enabled` is only
  ever the real value true or false now, so a stray string or number from
  another client can no longer read as "on" to the workers while the panel shows
  off. A non-boolean is refused. A settings file that is briefly unreadable
  (an antivirus or backup holding it) is treated as "unknown, try again", not as
  corruption to reset over, which is what silently wiped saved settings before.
  A genuinely corrupt file is kept aside before defaults take over.

- **A truncated reply no longer passes for the whole thing.** If a sentence fails
  mid-reply, Readback says "the rest is on screen" out loud and the log records
  how many sentences of how many were actually spoken, instead of logging a full
  success over a reply that was cut short.

- **A stalled provider response can no longer hang a worker forever.** The
  request timeout now covers the whole download, not just the initial
  connection, and the retry only repeats failures worth repeating (network
  errors, rate limits, server errors), never a bad key and never a request that
  was already aborted, which on ElevenLabs could otherwise be billed more than
  once.

- **The panel no longer freezes on a long read.** A wall of dashes or spaces in a
  reply hit a pathological regex that could pin the CPU for minutes on the very
  path that runs on every reply. Fixed, and input is capped before it reaches it.

- **The control panel keeps its own state honest.** A hung server now trips the
  NOT CONNECTED banner instead of showing a confident wrong toggle; the poll no
  longer rebuilds the dropdowns and sliders under your cursor mid-drag; a stale
  read can no longer overwrite a newer toggle; and a value the provider will
  reject shows the default rather than NaN.

- **Speech reads better.** Wrapped prose is no longer read with a full stop at
  every line break, and `snake_case` identifiers keep their underscores instead
  of being run together.

### Changed

- **Voice off means off, even to the tools.** The MCP `say` tool now refuses
  while voice is off unless it is called with `force: true`, so an assistant
  cannot decide to talk over a mute you just pressed. The panel's Speak and
  preview buttons are unaffected: that is you at the keyboard.

- **ElevenLabs defaults that actually work on the first try.** It ships with a
  real default voice (so a first run is not silent), defaults to a current Flash
  model rather than a deprecated Turbo one, and stops sending the tuning fields
  the newest model does not accept. The panel and README now show the
  per-character cost next to the provider, since ElevenLabs runs ten to twenty
  times the price of Inworld's default.

- **Overriding `READBACK_STATE_DIR` no longer splits the app.** The cache
  directory has its own override, `READBACK_CACHE_DIR`, and every Readback
  process resolves both the same way; `npm run where` prints them and `/health`
  reports them, so a mismatch is one command to see. (Carried from 0.4.4.)

### Docs and packaging

- The install steps no longer tell you to paste a second `hooks` key, which is
  valid JSON that silently drops every hook you already had; the MCP line now
  registers at user scope so the tools exist in every project, matching the hook.
- `.gitignore` now covers `.env*`, `secret.json`, `.claude/settings.local.json`
  and retired files; the sample env file shows the real default cap.

## 0.4.4

Voice off has been unreliable for several releases now, and each fix landed on a
real bug without reaching the one underneath. Sorry. This is the one that was
actually holding the toggle open, and it now has tests that fail without the fix.

### Fixed

- **Voice off stops what is playing, and stays off.** Settings and working files
  are kept in two different places on purpose, but the cache location used to
  fall back to the settings location whenever `READBACK_STATE_DIR` was set. That
  read like a convenience for tests and was a trap in practice: any launcher that
  set the override for the panel but not for the hook workers put the two halves
  in different folders.

  They still shared `state.json`, so voice on and off looked like it worked, and
  the next reply really did stay quiet. But the queue, the playback epoch and the
  list of running players were per-half, so the panel's "stop talking" swept a
  directory that was always empty and cleared a queue nobody was waiting in.
  Whatever was already speaking talked straight through it, and a reply already
  queued behind it started up after.

  The cache location no longer follows the settings location on any platform. It
  has its own override, `READBACK_CACHE_DIR`, and both halves resolve it the same
  way regardless of how they were launched.

- **The panel checks its own work from outside itself.** Twice now a panel has
  been found answering requests while its reads and writes were wrong together:
  it served values that existed in no file and discarded every write, so every
  check it ran against itself agreed with itself and passed. The startup
  self-test and the save confirmation now both verify through a separate process,
  which has its own view of the filesystem and cannot be fooled the same way.

- **A save that fails now says so in plain language** instead of returning an
  errno, and still never reports success. A toggle that did not reach disk shows
  as an error on the page rather than as a switch that looks like it moved.

### Added

- `npm run where` prints every path Readback resolved. Run it from the panel's
  environment and from a Claude Code session; if the two disagree, that is the
  bug. `/health` now reports the cache directory alongside the state directory.

- Tests covering the above: that pinning the settings directory cannot move the
  cache directory, that the two overrides are independent, that a panel which
  cannot save settings refuses to start, and that a toggle which cannot be saved
  comes back as an error rather than a success.

### Note

The 0.4.2 notes described a "bundled" Windows startup script. There is no such
script in this repo, only the manual launcher in `scripts/`. That entry has been
corrected.

## 0.4.3

### Fixed

- **Off now actually means off.** With the toggle showing off, every finished
  task would still speak, and only cycling the toggle on and off again would
  silence the current one.

  Two faults stacked. A panel could end up unable to persist settings while
  still serving normally: it answered requests, showed the toggle in whatever
  position you left it, and threw every write away, so the file the speaking
  workers actually read still said voice was on. And the startup self-test added
  in 0.4.2 to catch exactly this probed `lastSpokenBy`, which is a *runtime*
  field kept in a different file, so it verified the wrong file entirely and
  cheerfully started a panel that could not save the voice setting.

  The self-test now probes a settings field, so a panel that cannot save the
  toggle refuses to start rather than pretending. On top of that, saving the
  setting is now confirmed against disk before the panel reports success; if it
  did not persist, the request fails and the page shows the error instead of a
  toggle that looks like it worked.

## 0.4.2

### Fixed

- **The panel refuses to start if it cannot reach its state file.** A panel
  launched at login was seen answering requests normally while never touching
  the filesystem: it reported a plausible state directory, served values that
  existed in no file, and silently discarded every write. The toggle looked like
  it worked, the status line read "voice on", and nothing ever spoke. There was
  no error anywhere to find.

  The panel now proves it can round-trip its state file before it serves, and
  exits if it cannot. A panel that cannot work is now visibly not running, which
  the page already reports as `NOT CONNECTED`, instead of quietly lying.

- Guidance for auto-starting the panel at login on Windows: wait for the session
  to settle before launching. Starting too early is the likeliest way to get the
  wedged panel described above. (This release note originally described a
  "bundled" startup script. No such script ships in this repo; only the manual
  launcher in `scripts/` does. Corrected in 0.4.4.)

## 0.4.1

### Fixed

- **Voice off now stays off.** Turning voice off while a reply was speaking
  stopped that reply, but the next one spoke anyway, and only a second on-then-off
  cycle made it stick.

  Settings and transient bookkeeping shared one file. Every speaking worker
  rewrites that file to record which player is running and which reply it last
  spoke, and it did so by reading the whole file, merging its change, and writing
  it all back. When a toggle landed between a worker's read and its write, the
  worker wrote back the `enabled: true` it had read a moment earlier and silently
  undid the toggle. Because a worker writes exactly when speech starts, hitting
  the toggle during speech is precisely when it was most likely to be lost.

  Runtime bookkeeping now lives in its own file, so a worker recording its player
  never opens the settings file and cannot overwrite your choice.

## 0.4.0

**If you are on an earlier version, update.** Several of these are fixes for
"voice won't turn off" and "the toggle does nothing", which were real bugs
rather than misconfiguration.

### Fixed

- **Voice off now reliably stops playback.** Playback was stopped by killing a
  single tracked process id, which goes stale the moment one reply hands off to
  the next. With several projects running you could hit that window often, and
  the reply would talk straight through "voice off". Every player is now tracked
  by its real pid and all of them are stopped.
- **The panel and the hook workers could end up on different state files**, so
  the panel toggle updated a file no worker ever read: the panel showed the new
  value and its Speak button worked, while replies stayed silent. This happened
  when the panel was launched from a login or startup task with an environment
  that has no `APPDATA`. The state directory now resolves consistently, and
  `/health` reports it so a mismatch is one request to spot.
- **The panel no longer shows a voice state it hasn't verified.** A toggle whose
  request never reached the server used to leave a confident "voice on" on
  screen; the panel now re-syncs on a failed write and shows `NOT CONNECTED`
  when it can't reach the server.
- **The panel keeps itself in sync.** It read state once at load, so anything
  that changed voice elsewhere (the MCP tools, another tab) left a stale toggle.
- **A leftover queue ticket can no longer block every reply forever.** Tickets
  were only cleaned when their owning process was gone, but pids get reused,
  especially across a reboot, so an unrelated program could hold the line open
  indefinitely. Tickets now expire by age as well.
- **A stale player marker can no longer cause an unrelated process to be
  stopped** after a reboot reassigned its pid.
- Long replies are no longer clipped. The spoken-reply cap was low enough to
  truncate roughly one in seven replies, always the longer summaries, with a
  spoken "the rest is on screen". It is now a backstop rather than a limit.

### Changed

- **Inworld defaults to `tts-1.5-mini` instead of `tts-1.5-max`.** Mini costs
  half as much per character and is more than good enough for reading replies
  aloud. The previous default quietly billed double. Existing installs keep
  whatever model they already selected; change it in the panel.
- A named remote origin can be allowed to read and toggle voice, for mirroring
  the control onto a dashboard. Off by default, opt in with
  `READBACK_ALLOWED_ORIGINS`; that origin can only flip voice on and off.
- Following a bookmark or a link to the panel works again. The origin check was
  rejecting cross-site navigation, which is not CSRF.

## 0.3.0

- **Multi-session queueing.** Replies from several Claude Code projects line up
  and read in order instead of cutting each other off. Voice off still silences
  everything instantly.

## 0.2.0

- Dual provider support: Inworld and ElevenLabs, switchable in the panel.
- Control panel for voice, model, speed and tuning, with in-app key entry.
- Sentence-chunked streaming so audio starts on the first sentence.
- Keys moved out of the repo into a per-user directory, so cloning into a shared
  or cloud-synced folder cannot sync your key with it.
- Panel hardened: loopback only, cross-origin API requests rejected, logo and
  fonts bundled so the page makes no outbound requests.

## 0.1.0

- Initial release.
