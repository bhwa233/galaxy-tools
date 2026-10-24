param([string]$ElectronExe)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $ElectronExe) { $ElectronExe = Join-Path $repo 'node_modules/electron/dist/electron.exe' }
if (-not (Test-Path -LiteralPath $ElectronExe)) { throw 'Install Windows Electron first: npm run electron:install' }
$run = Join-Path $repo ('local-build/electron-smoke/' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $run -Force | Out-Null
$names = @('FLORAL_NOTEPAPER_CONFIG_DIR', 'FLORAL_NOTEPAPER_DATA_DIR', 'FLORAL_NOTEPAPER_SMOKE')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  $env:FLORAL_NOTEPAPER_CONFIG_DIR = Join-Path $run 'config'
  $env:FLORAL_NOTEPAPER_DATA_DIR = Join-Path $run 'data'
  $env:FLORAL_NOTEPAPER_SMOKE = '1'
  $report = Join-Path $run 'report.json'
  $applicationArgs = @(('"' + $repo + '"'), ('"--smoke-output=' + $report + '"'))
  $process = Start-Process -FilePath $ElectronExe -ArgumentList $applicationArgs -WorkingDirectory $repo -PassThru -RedirectStandardOutput (Join-Path $run 'stdout.log') -RedirectStandardError (Join-Path $run 'stderr.log')
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
