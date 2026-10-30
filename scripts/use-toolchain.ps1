# Dot-source this file to select the repository's Node/pnpm in this shell.
# Prefer the selected nvm runtime; dependencies remain pinned by the repository.
$sparkRepoRoot = Split-Path $PSScriptRoot -Parent
$sparkNodeVersion = (Get-Content -LiteralPath (Join-Path $sparkRepoRoot '.node-version') -Raw).Trim()
if ($env:NVM_SYMLINK -and (Test-Path -LiteralPath (Join-Path $env:NVM_SYMLINK 'node.exe'))) {
  $env:PATH = $env:NVM_SYMLINK + [IO.Path]::PathSeparator + $env:PATH
}
if ((& node --version) -ne "v$sparkNodeVersion" -and (Get-Command nvm.exe -ErrorAction SilentlyContinue)) {
  & nvm.exe use $sparkNodeVersion
}
if ((& node --version) -ne "v$sparkNodeVersion") {
  throw "Run nvm install $sparkNodeVersion and nvm use $sparkNodeVersion before selecting the toolchain."
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
