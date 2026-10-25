[CmdletBinding()]
param([string]$BuildRoot)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $BuildRoot) { $BuildRoot = Join-Path $repoRoot 'local-build/spark233/native-search' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$binaryRoot = Join-Path $BuildRoot 'build/bin'
$probe = Join-Path $binaryRoot 'spark233_search_probe.exe'
$hostExe = Join-Path $binaryRoot 'spark233.Index.exe'
$permissions = Join-Path $binaryRoot 'pulse_index_caller_filter_test.exe'
foreach ($required in @($probe, $hostExe, $permissions)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Build the search tools first: $required" }
}
$runRoot = Join-Path $BuildRoot ('runs/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$files = Join-Path $runRoot 'files'
$working = Join-Path $runRoot 'tools'
foreach ($directory in @($files, $working, (Join-Path $runRoot 'profile'), (Join-Path $runRoot 'machine'), (Join-Path $runRoot 'temp'))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
[IO.File]::WriteAllText((Join-Path $files 'spark233-note.md'), "# spark233`n中文连续取字与 English mixed.`n")
[IO.File]::WriteAllText((Join-Path $files 'spark233-worker.ts'), "export const spark233Code = 'needle::code_symbols';`n")
[IO.File]::WriteAllText((Join-Path $files 'spark233-读我.txt'), "中文短词验证 needle::code_symbols`n")
$evidence = [Collections.Generic.List[object]]::new()

function New-IsolatedProcess([string]$Executable, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.WorkingDirectory = $working
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $info.Environment['LOCALAPPDATA'] = Join-Path $runRoot 'profile'
    $info.Environment['APPDATA'] = Join-Path $runRoot 'profile'
    $info.Environment['PROGRAMDATA'] = Join-Path $runRoot 'machine'
    $info.Environment['SPARK233_SEARCH_PROFILE_ROOT'] = Join-Path $runRoot 'profile'
    $info.Environment['SPARK233_SEARCH_MACHINE_ROOT'] = Join-Path $runRoot 'machine'
    $info.Environment['TEMP'] = Join-Path $runRoot 'temp'
    $info.Environment['TMP'] = Join-Path $runRoot 'temp'
    return [Diagnostics.Process]::Start($info)
}

function Invoke-Probe([string]$Name, [string]$Executable, [string[]]$Arguments) {
    $process = New-IsolatedProcess $Executable $Arguments
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(45000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "Search probe timed out: $Name, pid=$($process.Id)"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $record = [ordered]@{ name = $Name; pid = $process.Id; exitCode = $process.ExitCode; arguments = $Arguments; stdout = $stdout; stderr = $stderr }
    $evidence.Add($record)
    $stdout | Set-Content -LiteralPath (Join-Path $runRoot "$Name.stdout.log") -Encoding utf8
    $stderr | Set-Content -LiteralPath (Join-Path $runRoot "$Name.stderr.log") -Encoding utf8
    Write-Host "$Name exit=$($process.ExitCode)"
    if ($process.ExitCode -ne 0) { throw "Search probe failed: $Name`n$stdout`n$stderr" }
    return $stdout
}

$indexHost = $null
try {
    $token = 'spark233-' + [Guid]::NewGuid().ToString('N')
    $pipe = '\\.\pipe\spark233Index.Test.' + $token
    $cache = Join-Path $runRoot 'name-index'
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $indexHost = New-IsolatedProcess $hostExe @('--test-host', $token, $files, $cache)
    $hostStdout = $indexHost.StandardOutput.ReadToEndAsync()
    $hostStderr = $indexHost.StandardError.ReadToEndAsync()
    $names = Invoke-Probe 'filename' $probe @('filename', $pipe, 'spark233')
    if ($names -notmatch 'FILENAME_HIT\s+.*spark233-note\.md') { throw "Filename result did not include the fixture markdown: $names" }
    Invoke-Probe 'shutdown' $probe @('shutdown', $pipe) | Out-Null
    if (-not $indexHost.WaitForExit(10000)) { throw "Filename fixture host did not stop: pid=$($indexHost.Id)" }
    $evidence.Add([ordered]@{ name = 'filename-host'; pid = $indexHost.Id; exitCode = $indexHost.ExitCode; stdout = $hostStdout.GetAwaiter().GetResult(); stderr = $hostStderr.GetAwaiter().GetResult() })
    if ($indexHost.ExitCode -ne 0) { throw 'Filename fixture host failed on shutdown' }

    Invoke-Probe 'caller-permissions' $permissions @() | Out-Null
    foreach ($query in @(@('chinese', '中文'), @('code', 'needle::code_symbols'))) {
        $probeArguments = @('content', $files, (Join-Path $runRoot "content-$($query[0])-profile"), $query[1])
        if ($query[0] -eq 'code') { $probeArguments += '--exercise-cancel' }
        $result = Invoke-Probe "content-$($query[0])" $probe $probeArguments
        if ($result -notmatch 'CONTENT_HIT\s+' -or $result -notmatch 'AGENT_STOPPED\s+1' -or ($query[0] -eq 'code' -and $result -notmatch 'CANCEL_REPLACE\s+1')) {
            throw "Instant query, cancellation or cleanup was not observed: $result"
        }
    }
    $bodyDatabases = @(Get-ChildItem -LiteralPath $runRoot -Filter 'content-v1.sqlite' -File -Recurse)
    $evidence.Add([ordered]@{ name = 'instant-no-body-writer'; bodyDatabases = @($bodyDatabases | Select-Object -ExpandProperty FullName) })
    if ($bodyDatabases.Count) { throw 'Instant unexpectedly created a persistent body index' }
} finally {
    if ($indexHost -and -not $indexHost.HasExited) { $indexHost.Kill($true); $indexHost.WaitForExit() }
    [ordered]@{ upstreamCommit = 'c4fe01ed82fe091f495f531972a854aa32caac2b'; dataRoot = $runRoot; timestampUtc = (Get-Date).ToUniversalTime().ToString('o'); probes = $evidence } |
        ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $runRoot 'report.json') -Encoding utf8
}
Write-Output "Search smoke evidence: $(Join-Path $runRoot 'report.json')"
