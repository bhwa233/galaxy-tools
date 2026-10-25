[CmdletBinding()]
param(
    [string]$ToolchainRoot = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/vs2026'),
    [string]$PythonExecutable = 'py',
    [string[]]$PythonArguments = @('-3.12')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ToolchainRoot = [IO.Path]::GetFullPath($ToolchainRoot)
New-Item -ItemType Directory -Force $ToolchainRoot | Out-Null
$setup = Join-Path $ToolchainRoot 'msvc/setup_x64.bat'
if (-not (Test-Path -LiteralPath $setup)) {

# Reviewed upstream downloader, not redistributed here: its gist has no explicit
# code licence. Payloads come from Microsoft manifests and are SHA-256 checked.
# The downloader uses only msiexec /a extraction; it does not install Visual Studio.
$url = 'https://gist.githubusercontent.com/mmozeiko/7f3162ec2988e81e56d5c4e22cde9977/raw/553d55bb7f0405a2fbd0228b8ed87c2b8ad200f8/portable-msvc.py'
$expected = '1791cccca594ff083ce8d3e0a139e6156d2c312e24332a909e608010f0230a51'
$original = Join-Path $ToolchainRoot 'portable-msvc.upstream.py'
Invoke-WebRequest $url -OutFile $original
if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -ne $expected) { throw 'Toolchain downloader integrity mismatch' }
$text = [IO.File]::ReadAllText($original)
# Absolute MSI paths avoid error 1619 under the Codex Store virtual AppData path.
# Bound network timeouts make a failed download resumable using the verified cache.
$adapted = $text.Replace('msiexec /a "{m}" /quiet', 'msiexec /a "{m.resolve()}" /quiet').Replace(
    'urllib.request.urlopen(url.replace(" ", "%20"), context=ssl_context)',
    'urllib.request.urlopen(url.replace(" ", "%20"), context=ssl_context, timeout=45)')
$script = Join-Path $ToolchainRoot 'portable-msvc.spark233.py'
[IO.File]::WriteAllText($script, $adapted, [Text.UTF8Encoding]::new($false))
Push-Location $ToolchainRoot
try {
    & $PythonExecutable @PythonArguments -u $script --vs 2026 --msvc-version 14.51 --sdk-version 28000 --target x64 --host x64 --accept-license
    if ($LASTEXITCODE) { throw 'Portable toolchain preparation failed. The verified downloads remain resumable.' }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath $setup)) { throw 'Toolchain setup entry is missing' }
}
# ScreenCapture's existing MP4 source includes ATL. Add just its official header
# and x64 library payloads; extraction does not touch the shared compiler files.
$addons = (Get-Content (Join-Path $PSScriptRoot 'sources.lock.json') -Raw | ConvertFrom-Json).toolchainAddons
$destination = [IO.Path]::GetFullPath((Join-Path $ToolchainRoot 'msvc')) + [IO.Path]::DirectorySeparatorChar
foreach ($addon in $addons) {
    $archive = Join-Path $ToolchainRoot $addon.name
    if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest $addon.url -OutFile $archive }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $addon.sha256) { throw 'ATL integrity mismatch' }
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            if (-not $entry.FullName.StartsWith('Contents/') -or -not $entry.Name) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName.Substring(9)))
            if (-not $target.StartsWith($destination, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path' }
            New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($target)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally { $zip.Dispose() }
}
Write-Output $setup
