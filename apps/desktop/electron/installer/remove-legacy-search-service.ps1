# Removes the retired Pulse-based spark233 file index service (spark233Index),
# its protected binaries under Program Files and its machine index data.
# The installer runs this elevated once; file search now uses Everything, so
# every failure here is reported and otherwise ignored.
$ErrorActionPreference = 'Stop'
$name = 'spark233Index'
$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$protected = Join-Path $programFiles 'spark233'
$machine = Join-Path $env:ProgramData 'spark233'
$exitCode = 0

function Test-NoReparse([string]$Root) {
    # Walk without following junctions; refuse to delete through one.
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count) {
        $current = $pending.Pop()
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        if ($item.PSIsContainer) {
            foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($current)) { $pending.Push($child) }
        }
    }
    return $true
}
function Remove-Owned([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (-not (Test-NoReparse $Path)) { Write-Output "Skipped (reparse point): $Path"; $script:exitCode = 3; return }
    Remove-Item -LiteralPath $Path -Recurse -Force
    Write-Output "Removed: $Path"
}

try {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$name"
    if (Test-Path -LiteralPath $key) {
        $image = [string](Get-ItemProperty -LiteralPath $key).ImagePath
        $binary = if ($image -match '^\s*"([^"]+)"') { $Matches[1] } elseif ($image -match '^\s*(\S+)') { $Matches[1] } else { '' }
        $owned = $binary -and
            ([IO.Path]::GetFileName($binary) -ieq 'spark233.Index.exe') -and
            ([IO.Path]::GetFullPath($binary).StartsWith("$protected\", [StringComparison]::OrdinalIgnoreCase))
        if (-not $owned) {
            Write-Output "Service $name does not point to the spark233 install; left unchanged."
            exit 2
        }
        Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
        & "$env:SystemRoot\System32\sc.exe" delete $name | Out-Null
        Write-Output "Removed service: $name"
    }
    # Only version directories carrying the Pulse owner marker are spark233's.
    if (Test-Path -LiteralPath $protected) {
        Get-ChildItem -LiteralPath $protected -Directory -Force |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'spark233-service-owner.txt') } |
            ForEach-Object { Remove-Owned $_.FullName }
        if (-not (Get-ChildItem -LiteralPath $protected -Force)) { Remove-Item -LiteralPath $protected -Force }
    }
    Remove-Owned (Join-Path $machine 'Index')
    Remove-Owned (Join-Path $machine 'index-config.json')
    if ((Test-Path -LiteralPath $machine) -and -not (Get-ChildItem -LiteralPath $machine -Force)) {
        Remove-Item -LiteralPath $machine -Force
    }
} catch {
    Write-Output "Legacy search service cleanup failed: $($_.Exception.Message)"
    exit 1
}
exit $exitCode
