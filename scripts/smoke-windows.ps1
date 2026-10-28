#Requires -Version 7.0
param([string]$ElectronExe, [switch]$LauncherMaintenanceOnly)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$desktop = Join-Path $repo 'apps/desktop'
if (-not $ElectronExe) { $ElectronExe = Join-Path $desktop 'node_modules/electron/dist/electron.exe' }
if (-not (Test-Path -LiteralPath $ElectronExe)) { throw 'Install Windows Electron first: pnpm electron:install' }
$run = Join-Path $repo ('local-build/electron-smoke/' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $run -Force | Out-Null
$names = @('SPARK233_CONFIG_DIR', 'SPARK233_DATA_DIR', 'SPARK233_SMOKE')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  $env:SPARK233_CONFIG_DIR = Join-Path $run 'config'
  $env:SPARK233_DATA_DIR = Join-Path $run 'data'
  $env:SPARK233_SMOKE = '1'
  # Keep all seven plugins installed, but never record the user's desktop clipboard.
  # The native helper starts paused until it receives this isolated persisted policy.
  Push-Location -LiteralPath $repo
  try {
    @'
import fs from "node:fs"; import path from "node:path"; import { defaultConfig } from "./apps/desktop/dist-electron/electron/host-config.js"; const hostDir = path.join(process.env.SPARK233_CONFIG_DIR, "host"); fs.mkdirSync(hostDir, {recursive:true}); fs.writeFileSync(path.join(hostDir,"config.json"), JSON.stringify({...defaultConfig(process.env.SPARK233_DATA_DIR),globalShortcut:"",toggleVisibilityShortcut:""})); import { ClipboardHistory } from "./apps/desktop/dist-electron/electron/plugins/official/clipboard-history.js"; const history = new ClipboardHistory(path.join(process.env.SPARK233_CONFIG_DIR, "plugins/data/spark233.clipboard")); history.saveSettings({paused:true}); history.close(); fs.writeFileSync(path.join(process.env.SPARK233_CONFIG_DIR, "plugins/state.json"), JSON.stringify({schemaVersion:1,plugins:{},dataVersions:{"spark233.clipboard":{dataVersion:1,pluginVersion:"0.1.0",packageName:"@spark233/plugin-clipboard"}}}));
'@ | & node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw 'Could not pause the isolated clipboard recorder before smoke startup' }
  } finally { Pop-Location }
  $report = Join-Path $run 'report.json'
  $applicationArgs = @(('"' + $desktop + '"'), ('"--smoke-output=' + $report + '"'))
  if ($LauncherMaintenanceOnly) { $applicationArgs += "--smoke-launcher-maintenance" }
  $startedAt = [DateTimeOffset]::UtcNow
  $process = Start-Process -FilePath $ElectronExe -ArgumentList $applicationArgs -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'stdout.log') -RedirectStandardError (Join-Path $run 'stderr.log')
  $processEvidenceFile = Join-Path $run 'process.json'
  $processEvidence = [ordered]@{
    pid = $process.Id
    startedAt = $startedAt.ToString('o')
    exitedAt = $null
    durationSeconds = $null
    exitCode = $null
    timeoutSeconds = 300
    timedOut = $false
    executable = $ElectronExe
    report = $report
  }
  $processEvidence | ConvertTo-Json | Set-Content -LiteralPath $processEvidenceFile -Encoding utf8
  Write-Output "Smoke started: PID=$($process.Id), UTC=$($processEvidence.startedAt), evidence: $run"
  $deadline = (Get-Date).AddSeconds(300)
  while (-not $process.WaitForExit(1000)) {
    if ((Get-Date) -ge $deadline) {
      $processEvidence.timedOut = $true
      $processEvidence.durationSeconds = [Math]::Round(([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds, 3)
      $processEvidence | ConvertTo-Json | Set-Content -LiteralPath $processEvidenceFile -Encoding utf8
      throw "Smoke test timed out after 300 seconds. Isolated process: $($process.Id), evidence: $run"
    }
  }
  $process.WaitForExit() # Flush redirected output after the bounded wait observes exit.
  $process.Refresh()
  $processEvidence.exitedAt = $process.ExitTime.ToUniversalTime().ToString('o')
  $processEvidence.durationSeconds = [Math]::Round(([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds, 3)
  $processEvidence.exitCode = $process.ExitCode
  $processEvidence | ConvertTo-Json | Set-Content -LiteralPath $processEvidenceFile -Encoding utf8
  Write-Output "Smoke exited: PID=$($process.Id), UTC=$($processEvidence.exitedAt), exitCode=$($processEvidence.exitCode), durationSeconds=$($processEvidence.durationSeconds)"
  if ($null -eq $processEvidence.exitCode -or $processEvidence.exitCode -ne 0) { throw "Smoke process did not confirm exit code 0 (actual: $($processEvidence.exitCode)); inspect $run" }
  if (-not (Test-Path -LiteralPath $report)) { throw "No report generated; inspect $run" }
  $result = Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $result.ok) { throw ($result | ConvertTo-Json -Depth 10) }
  Write-Output "Windows Electron integration passed: $report"
} finally {
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
