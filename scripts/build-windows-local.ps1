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
  $copyArgs = @(('"' + $repo + '"'), ('"' + $buildRoot + '"'), '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/XD', '.git', 'node_modules', 'dist', 'dist-electron', 'release-electron', 'local-build', 'src-tauri')
  $copy = Start-Process -FilePath 'robocopy.exe' -ArgumentList $copyArgs -Wait -PassThru -WindowStyle Hidden
  if ($copy.ExitCode -ge 8) { throw 'WSL source staging failed' }
  Write-Output "Windows build staging: $buildRoot"
}
Push-Location $buildRoot
try {
  . (Join-Path $buildRoot 'scripts/use-toolchain.ps1')
  if ($CleanInstall -or -not (Test-Path -LiteralPath (Join-Path $buildRoot 'node_modules/.package-lock.json'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
  }
  # plugins:build verifies/recreates every offline payload before packaging.
  $target = if ($Installer) { 'dist:win' } else { 'pack:win' }
  & npm.cmd run $target
  if ($LASTEXITCODE -ne 0) { throw "npm run $target failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}
if ($buildRoot -ne $repo) {
  Copy-Item -LiteralPath (Join-Path $buildRoot 'release-electron') -Destination $repo -Recurse -Force
  Write-Output 'Build artifacts copied back; run the executable from a Windows local folder or use the installer.'
}
