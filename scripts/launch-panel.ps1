param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$projDir = Split-Path -Parent $PSScriptRoot
function Get-ReadbackHealth {
  try {
    $health = Invoke-RestMethod ($baseUrl + 'health') -TimeoutSec 2
    if ($health.ok -eq $true -and $health.readback -eq $true) { return $health }
  } catch { }
  return $null
}
try {
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  # The port the server itself will resolve, from the same environment and .env.
  $where = & $nodePath (Join-Path $projDir 'scripts\where.js') | Out-String | ConvertFrom-Json
  $baseUrl = 'http://127.0.0.1:' + $where.PORT + '/'
  $health = Get-ReadbackHealth
  if (-not $health) {
    $serverPath = Join-Path $projDir 'src\panel-server.js'
    # WMI launches outside the caller's job object. Start-Process alone can
    # still leave the server owned by Codex and killed when Codex exits. WMI
    # does not hand this shell's environment on by itself, so pass it: every
    # ReadBack process has to resolve the same settings, cache and port.
    $environment = [string[]](Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value })
    $startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{
      ShowWindow=[uint16]0
      EnvironmentVariables=$environment
    } -ClientOnly
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
