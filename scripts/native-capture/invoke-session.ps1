[CmdletBinding()]
param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture'),
    [string]$ImagePath,
    [int]$TimeoutSeconds = 60,
    [switch]$CaptureOnly,
    [int]$CancelAfterMilliseconds = 0
)
$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -le 0 -or $CancelAfterMilliseconds -lt 0) { throw 'Invalid session timeout/cancellation.' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$session = [Guid]::NewGuid().ToString('N')
$directory = Join-Path $OutputRoot "sessions/$session"
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$children = [Collections.Generic.List[Diagnostics.Process]]::new()
$timer = [Diagnostics.Stopwatch]::StartNew()
$status = 'failed'

# PowerShell/.NET already provide managed child processes and per-process arguments.
# Native adapters publish into this unique directory, never shared clipboard state.
function Invoke-Managed([string]$Executable, [string[]]$Arguments, [string]$ResultName) {
    if (-not (Test-Path -LiteralPath $Executable)) { throw "Missing adapted binary: $Executable" }
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.WorkingDirectory = $directory
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($start)
    $children.Add($process)
    while (-not $process.WaitForExit(50)) {
        if ($CancelAfterMilliseconds -gt 0 -and $timer.ElapsedMilliseconds -ge $CancelAfterMilliseconds) {
            $script:status = 'cancelled'
            throw [OperationCanceledException]::new('Native session cancelled')
        }
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'Native session timed out' }
    }
    if ($process.ExitCode -ne 0) { throw "Native process exited $($process.ExitCode)" }
    $file = Join-Path $directory $ResultName
    if (-not (Test-Path -LiteralPath $file)) {
        if ($ResultName -ne 'capture.json') { throw 'OCR exited without a session result' }
        $script:status = 'cancelled'
        throw [OperationCanceledException]::new('Native window closed without a result')
    }
    $result = Get-Content -LiteralPath $file -Raw -Encoding utf8 | ConvertFrom-Json
    if ($result.protocol -ne 1 -or $result.sessionId -ne $session -or $result.pid -ne $process.Id) {
        throw 'Native result identity mismatch'
    }
    return $result
}

try {
    $common = @("--spark233-session=$session", "--spark233-session-dir=$directory")
    if ($ImagePath) {
        if ($CaptureOnly) { throw 'CaptureOnly cannot be used with ImagePath.' }
        Copy-Item -LiteralPath ([IO.Path]::GetFullPath($ImagePath)) -Destination (Join-Path $directory 'selection.png')
    } else {
        $capture = Invoke-Managed (Join-Path $OutputRoot 'build/ScreenCapture.exe') ($common + @('--auto-quit=true', '--enter=ocr')) 'capture.json'
        if ($capture.kind -ne 'capture' -or $capture.image -ne 'selection.png' -or $capture.width -le 0 -or $capture.height -le 0) {
            throw 'Invalid capture result'
        }
    }
    if (-not $CaptureOnly) {
        $ocr = Invoke-Managed (Join-Path $OutputRoot 'build/ImageReader.exe') ($common + @("--image-path=$(Join-Path $directory 'selection.png')", '--spark233-batch=true')) 'ocr.json'
        if ($ocr.kind -ne 'ocr') { throw 'Invalid OCR result' }
        $ocr | ConvertTo-Json -Depth 10 | Write-Output
    }
    $status = 'completed'
} finally {
    foreach ($child in $children) {
        if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() }
    }
    [ordered]@{
        sessionId = $session; status = $status; elapsedMs = $timer.ElapsedMilliseconds
        processes = @($children | ForEach-Object { @{ pid = $_.Id; exited = $_.HasExited; exitCode = $_.ExitCode } })
    } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $directory 'host-session.json') -Encoding utf8
    foreach ($child in $children) { $child.Dispose() }
    Write-Host "Session evidence: $directory"
}
