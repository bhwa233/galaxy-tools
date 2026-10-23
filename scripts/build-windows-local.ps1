param([switch]$Installer)
$ErrorActionPreference = 'Stop'
if (-not $env:OS -or $env:OS -ne 'Windows_NT') { throw '请使用 Windows PowerShell/Windows pwsh。' }
$repo = Split-Path $PSScriptRoot -Parent
$buildRoot = $repo
if ($repo.StartsWith('\\')) {
  $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($repo))).Replace('-', '').Substring(0, 12)
  $buildRoot = Join-Path $env:LOCALAPPDATA ('FloralNotepaper/build-staging/' + $hash)
  New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
  $copyArgs = @(('"' + $repo + '"'), ('"' + $buildRoot + '"'), '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/XD', '.git', 'node_modules', 'dist', 'dist-electron', 'release-electron', 'local-build', 'src-tauri')
  $copy = Start-Process -FilePath 'robocopy.exe' -ArgumentList $copyArgs -Wait -PassThru -NoNewWindow
  if ($copy.ExitCode -ge 8) { throw 'WSL source staging failed' }
  Write-Output "Windows build staging: $buildRoot"
}
foreach ($command in @('npm.cmd ci', $(if ($Installer) { 'npm.cmd run dist:win' } else { 'npm.cmd run pack:win' }))) {
  $process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $command) -WorkingDirectory $buildRoot -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -ne 0) { throw "Failed: $command ($($process.ExitCode))" }
}
if ($buildRoot -ne $repo) {
  Copy-Item -LiteralPath (Join-Path $buildRoot 'release-electron') -Destination $repo -Recurse -Force
  Write-Output 'Build artifacts copied back; run the executable from a Windows local folder or use the installer.'
}
