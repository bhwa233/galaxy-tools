# Dot-source this file to select the repository's Node/pnpm in this shell.
# Reuses the official Node distribution; it does not change global runtimes or install packages.
$sparkRepoRoot = Split-Path $PSScriptRoot -Parent
$sparkNodeVersion = (Get-Content -LiteralPath (Join-Path $sparkRepoRoot '.node-version') -Raw).Trim()
$sparkPortableRoot = Join-Path $env:LOCALAPPDATA "spark233/toolchains/node-v$sparkNodeVersion-win-x64"
$sparkPortableExe = Join-Path $sparkPortableRoot 'node.exe'
if (Test-Path -LiteralPath $sparkPortableExe) {
  $sparkPreviousPath = $env:PATH
  $env:PATH = $sparkPortableRoot + [IO.Path]::PathSeparator + $env:PATH
  if ((& node --version) -ne "v$sparkNodeVersion") {
    $env:PATH = $sparkPreviousPath
    throw "The portable runtime does not match .node-version ($sparkNodeVersion)."
  }
} elseif ((& node --version) -ne "v$sparkNodeVersion") {
  throw "Install official Node $sparkNodeVersion, or extract its Windows x64 ZIP to $sparkPortableRoot."
}
$sparkPackageManager = (Get-Content -LiteralPath (Join-Path $sparkRepoRoot 'package.json') -Raw | ConvertFrom-Json).packageManager
if ($sparkPackageManager -notmatch '^pnpm@([^+]+)') { throw 'packageManager must pin pnpm.' }
$sparkRequiredPnpm = $Matches[1]
$sparkPnpmRoot = Join-Path $env:LOCALAPPDATA "spark233/toolchains/pnpm-v$sparkRequiredPnpm"
$sparkNodeCommand = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$sparkPnpmCandidates = @(
  (Join-Path (Split-Path $sparkNodeCommand -Parent) 'pnpm.cmd'),
  (Join-Path $sparkPnpmRoot 'node_modules/.bin/pnpm.cmd')
) + @(Get-Command pnpm.cmd -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
$sparkSelectedPnpm = $null
$sparkPreviousPnpmManagement = [Environment]::GetEnvironmentVariable('npm_config_manage_package_manager_versions', 'Process')
try {
  # Older pnpm shims must report their own version without downloading the pin.
  $env:npm_config_manage_package_manager_versions = 'false'
  foreach ($sparkPnpmCandidate in ($sparkPnpmCandidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $sparkPnpmCandidate)) { continue }
    # npm shims prefer an adjacent node.exe. Reject shims bound to another Node.
    $sparkAdjacentNode = Join-Path (Split-Path $sparkPnpmCandidate -Parent) 'node.exe'
    if ((Test-Path -LiteralPath $sparkAdjacentNode) -and (& $sparkAdjacentNode --version) -ne "v$sparkNodeVersion") { continue }
    try {
      $sparkPnpmVersion = & $sparkPnpmCandidate --version 2>$null
    } catch {
      # An incomplete pnpm installation must not hide a later working candidate.
      continue
    }
    if ($LASTEXITCODE -eq 0 -and $sparkPnpmVersion -eq $sparkRequiredPnpm) {
      $sparkSelectedPnpm = $sparkPnpmCandidate
      break
    }
  }
} finally {
  [Environment]::SetEnvironmentVariable('npm_config_manage_package_manager_versions', $sparkPreviousPnpmManagement, 'Process')
}
if (-not $sparkSelectedPnpm) {
  throw "This repository requires pnpm $sparkRequiredPnpm. Follow the complete pnpm toolchain setup in $sparkRepoRoot/README.md (install, approve pnpm scripts, rebuild), then dot-source this script again."
}
$env:PATH = (Split-Path $sparkSelectedPnpm -Parent) + [IO.Path]::PathSeparator + $env:PATH
Write-Output "Project toolchain: Node $sparkNodeVersion / pnpm $sparkRequiredPnpm"
