param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$PlayersDir = ''
)

# Streaming player: plays chunk-000.wav, chunk-001.wav, ... from $Dir in order,
# waiting for the next chunk to appear (it is being synthesized in the
# background). Stops after playing the count written to end.marker. Runs in ONE
# process so chunks play back-to-back with no per-clip spawn gap, and so killing
# this process (stop / kill-on-new) stops the whole stream.
#
# While it runs it keeps its own marker file fresh (PlayersDir\<pid>, written by
# the process that spawned it). Readback treats a marker touched within the last
# two minutes as a live player and anything older as garbage, so this touch is
# what makes "stop" find this process and what keeps a reused pid from being
# mistaken for it. It cannot touch during PlaySync, which is fine: one chunk is
# a single sentence.
try {
  $i = 0
  $total = -1
  $endFile = Join-Path $Dir 'end.marker'
  $waited = 0
  $marker = ''
  if ($PlayersDir -ne '') { $marker = Join-Path $PlayersDir "$PID" }
  $lastTouch = [DateTime]::MinValue

  function Touch-Marker {
    if ($marker -eq '') { return }
    $now = [DateTime]::UtcNow
    if (($now - $script:lastTouch).TotalMilliseconds -lt 1000) { return }
    $script:lastTouch = $now
    try {
      if (Test-Path -LiteralPath $marker) { [IO.File]::SetLastWriteTimeUtc($marker, $now) }
    } catch { }
  }

  while ($true) {
    Touch-Marker

    if ($total -lt 0 -and (Test-Path -LiteralPath $endFile)) {
      $c = (Get-Content -LiteralPath $endFile -Raw).Trim()
      if ($c -ne '') { $total = [int]$c }
    }

    if ($total -ge 0 -and $i -ge $total) { break }

    $chunk = Join-Path $Dir ('chunk-{0:D3}.wav' -f $i)
    if (Test-Path -LiteralPath $chunk) {
      $waited = 0
      try {
        $sp = New-Object System.Media.SoundPlayer $chunk
        $sp.PlaySync()
        $sp.Dispose()
      } catch { }
      $i++
    }
    else {
      Start-Sleep -Milliseconds 40
      $waited += 40
      # Give up only if nothing new arrives for a long time (covers a slow chunk
      # incl. synth retries ~60s). $waited resets whenever a chunk appears, and a
      # superseded stream is killed by the next speak()'s stopPlayback anyway.
      if ($waited -ge 90000) { break }
    }
  }
}
catch { }
