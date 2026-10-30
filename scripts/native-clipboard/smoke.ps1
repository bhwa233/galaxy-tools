[CmdletBinding()]
param([string]$BuildRoot)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $BuildRoot) { $BuildRoot = Join-Path $repoRoot 'local-build/spark233/native-clipboard' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$boundary = Join-Path $BuildRoot 'build/spark233_clipboard_boundary.exe'
. (Join-Path $repoRoot 'scripts/use-toolchain.ps1')
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$probe = Join-Path $PSScriptRoot 'probe.mjs'
foreach ($required in @($boundary, $node, (Join-Path $BuildRoot 'node_modules/@crosscopy/clipboard/index.js'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Run the clipboard prepare/build entry first: $required" }
}
$runRoot = Join-Path $BuildRoot ('runs/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
# This only checks the station guard; it never opens the interactive clipboard.
$rejection = & $boundary context 2>&1 | Out-String
if ($LASTEXITCODE -ne 1 -or $rejection -notmatch 'requires the private spark233 window station') { throw 'Interactive clipboard guard did not reject access' }
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $boundary
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.StandardOutputEncoding = [Text.Encoding]::UTF8
$info.StandardErrorEncoding = [Text.Encoding]::UTF8
$info.WorkingDirectory = $runRoot
# The fresh-logon experiment remains a recorded diagnostic path in the native
# source, but normal MVP checks never create logon sessions or credentials.
foreach ($argument in @('isolate', $node, $probe, $runRoot, $BuildRoot, $boundary)) { $info.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::Start($info)
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
if (-not $process.WaitForExit(55000)) { $process.Kill($true); $process.WaitForExit(); throw 'Isolated clipboard launcher timed out' }
$output = $stdout.GetAwaiter().GetResult()
$errors = $stderr.GetAwaiter().GetResult()
$output | Set-Content -LiteralPath (Join-Path $runRoot 'stdout.log') -Encoding utf8
$errors | Set-Content -LiteralPath (Join-Path $runRoot 'stderr.log') -Encoding utf8
$remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'node.exe','spark233_clipboard_boundary.exe' -and $_.CommandLine.Contains($runRoot) })
[ordered]@{ launcherPid = $process.Id; exitCode = $process.ExitCode; interactiveAccessRejected = $true; remainingProcesses = @($remaining | Select-Object ProcessId,Name); stdout = $output; stderr = $errors } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runRoot 'launcher-report.json') -Encoding utf8
Write-Output $output
if ($process.ExitCode -ne 0 -or $remaining.Count) { throw "Isolated clipboard smoke failed: exit=$($process.ExitCode)`n$errors" }
Write-Output "Clipboard smoke evidence: $runRoot"
