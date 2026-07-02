param(
  [Parameter(Mandatory = $true)][string]$Dir
)

# Streaming player: plays chunk-000.wav, chunk-001.wav, ... from $Dir in order,
# waiting for the next chunk to appear (it is being synthesized in the
# background). Stops after playing the count written to end.marker. Runs in ONE
# process so chunks play back-to-back with no per-clip spawn gap, and so killing
# this process (stop / kill-on-new) stops the whole stream.
try {
  $i = 0
  $total = -1
  $endFile = Join-Path $Dir 'end.marker'
  $waited = 0

  while ($true) {
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
