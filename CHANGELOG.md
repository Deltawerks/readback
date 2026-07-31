# Changelog

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
