param([switch]$Installer, [switch]$CleanInstall)
$ErrorActionPreference = 'Stop'
if (-not $env:OS -or $env:OS -ne 'Windows_NT') { throw '请使用 Windows PowerShell/Windows pwsh。' }
$repo = Split-Path $PSScriptRoot -Parent
$buildRoot = $repo
if ($repo.StartsWith('\\')) {
  $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($repo))).Replace('-', '').Substring(0, 12)
  $stagingBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'spark233/build-staging'))
  $buildRoot = [IO.Path]::GetFullPath((Join-Path $stagingBase $hash))
  # /MIR removes stale staged files. Check the final target and every existing
  # ancestor before asking robocopy to mirror into this dedicated checkout.
  if (-not $buildRoot.StartsWith($stagingBase.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $buildRoot -eq $repo) {
    throw 'Build staging target escaped the dedicated staging directory.'
  }
  $stagingAncestor = $buildRoot
  while ($stagingAncestor -and $stagingAncestor -ne [IO.Path]::GetPathRoot($stagingAncestor)) {
    if ((Test-Path -LiteralPath $stagingAncestor) -and ((Get-Item -LiteralPath $stagingAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Build staging cannot follow a reparse point: $stagingAncestor"
    }
    $stagingAncestor = Split-Path $stagingAncestor -Parent
  }
  New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
  $copyArgs = @(('"' + $repo + '"'), ('"' + $buildRoot + '"'), '/MIR', '/XF', 'ecdict.sqlite', 'provenance.json', '/NFL', '/NDL', '/NJH', '/NJS', '/XD', '.git', 'node_modules', 'dist', 'dist-electron', 'release-electron', 'local-build', 'src-tauri', '.workbuddy', '.codex', '.vitest', 'dist-host', 'dist-plugins',
    (Join-Path $repo 'packages/official/applications/native'), (Join-Path $repo 'packages/official/clipboard/native'),
    (Join-Path $repo 'packages/official/ocr/native'), (Join-Path $repo 'packages/official/screenshot/native'), (Join-Path $repo 'packages/official/search/native'),
    (Join-Path $buildRoot 'packages/official/applications/native'), (Join-Path $buildRoot 'packages/official/clipboard/native'),
    (Join-Path $buildRoot 'packages/official/ocr/native'), (Join-Path $buildRoot 'packages/official/screenshot/native'), (Join-Path $buildRoot 'packages/official/search/native'))
  $copy = Start-Process -FilePath 'robocopy.exe' -ArgumentList $copyArgs -Wait -PassThru -WindowStyle Hidden
  if ($copy.ExitCode -ge 8) { throw 'WSL source staging failed' }
  $dictionaryRoot = Join-Path $buildRoot 'packages/official/translation/data'
  $dictionaryFiles = @('ecdict.sqlite', 'provenance.json')
  $dictionaryPresent = @($dictionaryFiles | Where-Object { Test-Path -LiteralPath (Join-Path $dictionaryRoot $_) })
  if ($dictionaryPresent.Count -eq 1) { throw 'Windows dictionary/provenance pair is incomplete. Rebuild the pair together before packaging.' }
  if ($dictionaryPresent.Count -eq 0) {
    New-Item -ItemType Directory -Force -Path $dictionaryRoot | Out-Null
    foreach ($dictionaryFile in $dictionaryFiles) {
      Copy-Item -LiteralPath (Join-Path $repo "packages/official/translation/data/$dictionaryFile") -Destination (Join-Path $dictionaryRoot $dictionaryFile)
    }
  }
  # Seed only a missing native directory. Existing Windows output is validated
  # against source hashes by plugins:build, never overwritten by WSL binaries.
  foreach ($plugin in @('applications', 'clipboard', 'ocr', 'screenshot', 'search')) {
    $relative = "packages/official/$plugin/native"
    $sourceNative = Join-Path $repo $relative
    $targetNative = Join-Path $buildRoot $relative
    if (-not (Test-Path -LiteralPath $targetNative) -and (Test-Path -LiteralPath $sourceNative)) {
      Copy-Item -LiteralPath $sourceNative -Destination $targetNative -Recurse
    }
  }
  Write-Output "Windows build staging: $buildRoot"
}
Push-Location $buildRoot
try {
  . (Join-Path $buildRoot 'scripts/use-toolchain.ps1')
  # Always verify every workspace against the committed lockfile. pnpm reuses
  # its store for normal builds; CleanInstall additionally refreshes links.
  $installArgs = @('install', '--frozen-lockfile')
  if ($CleanInstall) { $installArgs += '--force' }
  & pnpm.cmd @installArgs
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed ($LASTEXITCODE)" }
  # plugins:build verifies/recreates every offline payload before packaging.
  $target = if ($Installer) { 'dist:win' } else { 'pack:win' }
  & pnpm.cmd run $target
  if ($LASTEXITCODE -ne 0) { throw "pnpm run $target failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}
if ($buildRoot -ne $repo) {
  Copy-Item -LiteralPath (Join-Path $buildRoot 'release-electron') -Destination $repo -Recurse -Force
  Write-Output 'Build artifacts copied back; run the executable from a Windows local folder or use the installer.'
}
