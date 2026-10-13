import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Reproduce Windows killing a hook's job. An ordinary detached child dies;
// the WMI worker must survive. No audio, live settings, or network involved.
test('independent worker survives termination of its originating Windows job', {
  skip: process.platform !== 'win32', timeout: 25000,
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "readback-job's $fixture & "));
  const worker = path.join(dir, 'worker.cjs');
  writeFileSync(worker, `
    const fs = require('node:fs'), path = require('node:path');
    const [dir, name] = process.argv.slice(2);
    setInterval(() => {
      if (fs.existsSync(path.join(dir, 'release'))) {
        fs.writeFileSync(path.join(dir, name + '.done'), process.env.RB_LIFETIME_FIXTURE || 'missing');
        process.exit(0);
      }
    }, 25);
    setTimeout(() => process.exit(2), 18000);
  `);
  const runner = path.join(dir, 'runner.mjs');
  const launcher = new URL('../src/independent-process.js', import.meta.url).href;
  writeFileSync(runner, `
    import { launchIndependentNode } from ${JSON.stringify(launcher)};
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    const dir = ${JSON.stringify(dir)}, worker = ${JSON.stringify(worker)};
    while (!fs.existsSync(path.join(dir, 'go'))) await new Promise(r=>setTimeout(r,25));
    process.env.RB_LIFETIME_FIXTURE = 'environment preserved';
    spawn(process.execPath, [worker, dir, 'control'], {detached:true,stdio:'ignore',windowsHide:true});
    await launchIndependentNode(worker, [dir, 'independent']);
    fs.writeFileSync(path.join(dir, 'ready'), 'ready');
    setInterval(()=>{},1000);
  `);
  const script = path.join(dir, 'job.ps1');
  writeFileSync(script, `
    $ErrorActionPreference = 'Stop'
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ReadBackTestJob {
  [StructLayout(LayoutKind.Sequential)] public struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Extended {
    public Basic Basic; public ulong Rops,Wops,Oops,Rbytes,Wbytes,Obytes;
    public UIntPtr ProcessMem,JobMem,PeakProcess,PeakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
    $dir = $env:RB_JOB_DIR
    $job = [ReadBackTestJob]::CreateJobObject([IntPtr]::Zero, $null)
    $info = New-Object ReadBackTestJob+Extended
    $info.Basic.Flags = 0x2000
    if (-not [ReadBackTestJob]::SetInformationJobObject($job, 9, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info))) { throw 'job setup failed' }
    try {
      $start = New-Object Diagnostics.ProcessStartInfo
      $start.FileName = $env:RB_JOB_NODE
      $start.Arguments = '"' + (Join-Path $dir 'runner.mjs') + '"'
      $start.UseShellExecute = $false
      $start.CreateNoWindow = $true
      $child = [Diagnostics.Process]::Start($start)
      if (-not [ReadBackTestJob]::AssignProcessToJobObject($job, $child.Handle)) { $child.Kill(); throw 'job assignment failed' }
      [IO.File]::WriteAllText((Join-Path $dir 'go'), 'go')
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
      while (-not (Test-Path -LiteralPath (Join-Path $dir 'ready'))) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'worker did not launch' }
        Start-Sleep -Milliseconds 30
      }
      if (-not [ReadBackTestJob]::TerminateJobObject($job, 73)) { throw 'job termination failed' }
      $child.WaitForExit()
      [IO.File]::WriteAllText((Join-Path $dir 'release'), 'release')
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      while (-not (Test-Path -LiteralPath (Join-Path $dir 'independent.done'))) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'independent worker was killed' }
        Start-Sleep -Milliseconds 30
      }
    } finally { [void][ReadBackTestJob]::CloseHandle($job) }
  `);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true, encoding: 'utf8', timeout: 23000,
    env: { ...process.env, RB_JOB_DIR: dir, RB_JOB_NODE: process.execPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(dir, 'independent.done'), 'utf8'), 'environment preserved');
  assert.equal(existsSync(path.join(dir, 'control.done')), false, 'ordinary detached child must die with its job');
});

// Windows PowerShell decodes piped stdin with the console code page, not UTF-8.
// A launch request carrying "é" arrived garbled, so a profile folder such as
// C:\Users\José sent the worker to a path that does not exist and Codex replies
// were never spoken.
test('independent worker gets non-ASCII paths, arguments and environment intact', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-José-ünï-'));
  try {
    const worker = path.join(dir, 'wörker.cjs');
    writeFileSync(worker, `
      require('node:fs').writeFileSync(require('node:path').join(__dirname, 'received.json'),
        JSON.stringify({ arg: process.argv[2], env: process.env.RB_UNICODE_FIXTURE }));
    `);
    const { launchIndependentNode } = await import('../src/independent-process.js');
    await launchIndependentNode(worker, ['Señor ✓'], { ...process.env, RB_UNICODE_FIXTURE: 'Zoë ✓ 日本' });
    const received = path.join(dir, 'received.json');
    const deadline = Date.now() + 10000;
    while (!existsSync(received) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(received), 'the worker never ran: its path was garbled on the way');
    assert.deepEqual(JSON.parse(readFileSync(received, 'utf8')), { arg: 'Señor ✓', env: 'Zoë ✓ 日本' });
  } finally {
    // Not rmSync, which quietly leaves a non-ASCII path in place.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
