param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$projDir = Split-Path -Parent $PSScriptRoot
$baseUrl = 'http://localhost:7717/'
function Get-ReadbackHealth {
  try {
    $health = Invoke-RestMethod ($baseUrl + 'health') -TimeoutSec 2
    if ($health.ok -eq $true -and $health.readback -eq $true) { return $health }
  } catch { }
  return $null
}
try {
  $health = Get-ReadbackHealth
  if (-not $health) {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $serverPath = Join-Path $projDir 'src\panel-server.js'
    # WMI launches outside the caller's job object. Start-Process alone can
    # still leave the server owned by Codex and killed when Codex exits.
    $startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{ShowWindow=[uint16]0} -ClientOnly
    $process = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine=('"' + $nodePath + '" "' + $serverPath + '" --no-open')
      CurrentDirectory=$projDir
      ProcessStartupInformation=$startup
    }
    if ($process.ReturnValue -ne 0) { throw "Panel launch failed: $($process.ReturnValue)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 200
      $health = Get-ReadbackHealth
    } while (-not $health -and [DateTime]::UtcNow -lt $deadline)
    if (-not $health) { throw 'Panel did not become healthy within 15 seconds' }
  }
  if (-not $NoOpen) { Start-Process $baseUrl }
  Write-Output ("ReadBack panel ready (PID " + $health.pid + ").")
} catch {
  Write-Error $_
  exit 1
}
