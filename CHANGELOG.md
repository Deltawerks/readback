# Changelog

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
