#Requires -Version 7.0
[CmdletBinding()]
param([string]$Installer, [switch]$PluginBusiness)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $Installer) { $Installer = Join-Path $repo 'release-electron/spark233-1.2.0-x64.exe' }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$run = Join-Path $repo ('local-build/installer-acceptance/' + [Guid]::NewGuid().ToString())
$destination = [IO.Path]::GetFullPath((Join-Path $run 'installed'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
function Installed-Entries {
  @('HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall', 'HKLM:/Software/Microsoft/Windows/CurrentVersion/Uninstall', 'HKLM:/Software/WOW6432Node/Microsoft/Windows/CurrentVersion/Uninstall') | ForEach-Object {
    if (Test-Path -LiteralPath $_) { Get-ChildItem -LiteralPath $_ | Get-ItemProperty | Where-Object { $_.DisplayName -like 'spark233*' } }
  }
}
function Association-Snapshot {
  $values = [ordered]@{}
  foreach ($extension in @('.md','.txt')) {
    $key = "HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/FileExts/$extension/UserChoice"
    $values[$extension] = if (Test-Path -LiteralPath $key) {
      $item = Get-ItemProperty -LiteralPath $key
      @{ ProgId = $item.ProgId; Hash = $item.Hash }
    } else { $null }
  }
  $values | ConvertTo-Json -Depth 5 -Compress
}
if (@(Installed-Entries).Count) { throw 'An existing spark233 installation must be preserved; use a clean Windows account for this acceptance.' }
if (@(Get-Process -Name spark233 -ErrorAction SilentlyContinue).Count) { throw 'A spark233 process is running. Installer acceptance must not stop a user process.' }
$before = Association-Snapshot
$report = [ordered]@{ ok = $false; installer = $Installer; sha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash; destination = $destination; silent = $true; uacServiceExecuted = $false; checks = @(); error = $null }
$installed = $false
try {
  $setup = Start-Process -FilePath $Installer -ArgumentList @('/S', ('/D=' + $destination)) -WindowStyle Hidden -PassThru -Wait
  if ($setup.ExitCode -ne 0) { throw "NSIS setup exited $($setup.ExitCode)" }
  $installed = $true
  $exe = Join-Path $destination 'spark233.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Installer did not create spark233.exe' }
  $registration = @(Installed-Entries)
  $report.registration = @($registration | Select-Object DisplayName, UninstallString, PSPath)
  if ($registration.Count -ne 1) { throw 'Installer registration is missing or ambiguous' }
  $expectedUninstaller = '"' + (Join-Path $destination 'Uninstall spark233.exe') + '"'
  if (-not $registration[0].UninstallString.StartsWith($expectedUninstaller, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer registered a different destination' }
  $report.checks += 'silentPerUserInstallAndRegistration'
  $smoke = & (Join-Path $PSScriptRoot 'smoke-windows.ps1') -ElectronExe $exe 2>&1
  $smoke | Out-String | Set-Content -LiteralPath (Join-Path $run 'smoke.log') -Encoding utf8
  $report.checks += 'installedApplicationIntegrationSmoke'
  if ($PluginBusiness) {
    $probeVariables = @('SPARK233_ACCEPTANCE_NODE', 'SPARK233_ACCEPTANCE_PACKAGE_DIR', 'ELECTRON_RUN_AS_NODE')
    $probePrevious = @{}
    foreach ($name in $probeVariables) { $probePrevious[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    Push-Location -LiteralPath $repo
    try {
      $env:SPARK233_ACCEPTANCE_NODE = (Get-Command node -ErrorAction Stop).Source
      $env:SPARK233_ACCEPTANCE_PACKAGE_DIR = Join-Path $destination 'resources/plugins'
      $env:ELECTRON_RUN_AS_NODE = $null
      $electron = & node -e 'console.log(require("./apps/desktop/node_modules/electron"))'
      if ($LASTEXITCODE) { throw 'Could not resolve acceptance Electron' }
      & $electron (Join-Path $PSScriptRoot 'verify-plugin-business.cjs') 2>&1 | Out-File -LiteralPath (Join-Path $run 'plugin-business.log') -Encoding utf8
      if ($LASTEXITCODE) { throw 'Installed plugin package business acceptance failed' }
      $report.checks += 'installedPluginPackageBusinessAcceptance'
    } finally {
      Pop-Location
      foreach ($name in $probeVariables) { [Environment]::SetEnvironmentVariable($name, $probePrevious[$name], 'Process') }
    }
  }
} catch {
  $report.error = $_.ToString()
} finally {
  if ($installed) {
    try {
      if (@(Get-Process -Name spark233 -ErrorAction SilentlyContinue).Count) { throw 'An app process remains; uninstall was withheld to preserve running work.' }
      $uninstaller = Join-Path $destination 'Uninstall spark233.exe'
      if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Installed uninstaller is missing' }
      $removal = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
      if ($removal.ExitCode -ne 0) { throw "NSIS uninstall exited $($removal.ExitCode)" }
      for ($i = 0; $i -lt 300 -and (Test-Path -LiteralPath (Join-Path $destination 'spark233.exe')); $i++) { Start-Sleep -Milliseconds 100 }
      if ((Test-Path -LiteralPath (Join-Path $destination 'spark233.exe')) -or @(Installed-Entries).Count) { throw 'Uninstall left the executable or registration behind' }
      $report.checks += 'silentUninstallRemovesExecutableAndRegistration'
    } catch { $report.error = (@($report.error, $_.ToString()) | Where-Object { $_ }) -join '; ' }
  }
  $after = Association-Snapshot
  if ($before -eq $after) { $report.checks += 'defaultUserFileAssociationsPreserved' } else { $report.error = 'Default user file associations changed' }
  $report.ok = -not $report.error -and $report.checks.Count -eq ($PluginBusiness ? 5 : 4)
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $run 'report.json') -Encoding utf8
  Write-Output "Installer acceptance evidence: $run"
}
if (-not $report.ok) { throw ($report | ConvertTo-Json -Depth 6) }
