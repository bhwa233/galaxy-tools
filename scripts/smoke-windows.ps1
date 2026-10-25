param([string]$ElectronExe)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $ElectronExe) { $ElectronExe = Join-Path $repo 'node_modules/electron/dist/electron.exe' }
if (-not (Test-Path -LiteralPath $ElectronExe)) { throw 'Install Windows Electron first: npm run electron:install' }
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
    node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; import { ClipboardHistory } from "./dist-electron/electron/plugins/official/clipboard-history.js"; const history = new ClipboardHistory(path.join(process.env.SPARK233_CONFIG_DIR, "plugins/data/spark233.clipboard")); history.saveSettings({paused:true}); history.close(); fs.writeFileSync(path.join(process.env.SPARK233_CONFIG_DIR, "plugins/state.json"), JSON.stringify({schemaVersion:1,plugins:{},dataVersions:{"spark233.clipboard":{dataVersion:1,pluginVersion:"0.1.0",packageName:"@spark233/plugin-clipboard"}}}));'
    if ($LASTEXITCODE -ne 0) { throw 'Could not pause the isolated clipboard recorder before smoke startup' }
  } finally { Pop-Location }
  $report = Join-Path $run 'report.json'
  $applicationArgs = @(('"' + $repo + '"'), ('"--smoke-output=' + $report + '"'))
  $process = Start-Process -FilePath $ElectronExe -ArgumentList $applicationArgs -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'stdout.log') -RedirectStandardError (Join-Path $run 'stderr.log')
  $deadline = (Get-Date).AddSeconds(120)
  while (-not $process.WaitForExit(1000)) {
    if ((Get-Date) -ge $deadline) { throw "Smoke test timed out. Isolated process: $($process.Id), evidence: $run" }
  }
  if (-not (Test-Path -LiteralPath $report)) { throw "No report generated; inspect $run" }
  $result = Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $result.ok) { throw ($result | ConvertTo-Json -Depth 10) }
  Write-Output "Windows Electron integration passed: $report"
} finally {
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
