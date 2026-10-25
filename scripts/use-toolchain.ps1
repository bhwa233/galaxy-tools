# Dot-source this file to select the repository's portable Node/npm in this shell.
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
$sparkRequiredNpm = ((Get-Content -LiteralPath (Join-Path $sparkRepoRoot 'package.json') -Raw | ConvertFrom-Json).packageManager -split '@')[1]
if ((& npm.cmd --version) -ne $sparkRequiredNpm) {
  throw "This repository requires npm $sparkRequiredNpm. Update npm in the selected project runtime."
}
Write-Output "Project toolchain: Node $sparkNodeVersion / npm $sparkRequiredNpm"
