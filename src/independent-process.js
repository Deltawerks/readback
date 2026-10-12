import { spawn } from 'node:child_process';

// CREATE_NEW_PROCESS_GROUP (Node's detached:true) does not escape a Windows
// job object. WMI creates the worker outside the hook's job, so Codex can reap
// the hook tree without cutting off audio. Environment is piped, never argv.
export async function launchIndependentNode(script, args = [], env = process.env) {
  const quote = (value) => {
    if (/["\r\n]/.test(value)) throw new Error('invalid worker path');
    return '"' + value + '"';
  };
  const commandLine = [process.execPath, script, ...args].map(quote).join(' ');
  const ps = `
    $ErrorActionPreference = 'Stop'
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{
      ShowWindow=[uint16]0
      EnvironmentVariables=[string[]]$request.environment
    } -ClientOnly
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine=[string]$request.commandLine
      ProcessStartupInformation=$startup
    }
    if ($result.ReturnValue -ne 0) { exit 1 }
    Write-Output $result.ProcessId
  `;
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-Command', ps], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker launch timed out')); }, 8000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-100); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      const pid = Number(output.trim());
      if (code !== 0 || !Number.isSafeInteger(pid) || pid <= 0) reject(new Error('worker launch failed'));
      else resolve(pid);
    });
    child.stdin.end(JSON.stringify({ commandLine,
      environment: Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`),
    }));
  });
}
