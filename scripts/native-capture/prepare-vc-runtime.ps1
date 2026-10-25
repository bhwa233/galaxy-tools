[CmdletBinding()]
param([string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture/runtime'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$lock = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'sources.lock.json') -Raw | ConvertFrom-Json).ocrDependencies.vcRuntime
$cache = Join-Path $OutputRoot 'downloads'
$payload = Join-Path $OutputRoot 'x64'
New-Item -ItemType Directory -Path $cache, $payload -Force | Out-Null
$archive = Join-Path $cache $lock.archive
if (-not (Test-Path -LiteralPath $archive)) {
    $toolchainCache = Join-Path $env:LOCALAPPDATA ('spark233/toolchains/vs2026/downloads/' + $lock.archive)
    if ((Test-Path -LiteralPath $toolchainCache) -and (Get-FileHash -LiteralPath $toolchainCache -Algorithm SHA256).Hash -eq $lock.sha256) {
        Copy-Item -LiteralPath $toolchainCache -Destination $archive
    } else { Invoke-WebRequest -Uri $lock.url -OutFile $archive -TimeoutSec 60 }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $lock.sha256) { throw 'Official VC runtime archive integrity mismatch.' }
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
$files = @()
try {
    foreach ($file in $lock.files) {
        if ([IO.Path]::GetFileName($file.name) -ne $file.name -or $file.name -match 'd\.dll$') { throw 'Only the pinned release CRT files may be redistributed.' }
        $entry = $zip.GetEntry($lock.prefix + $file.name)
        if (-not $entry) { throw "Pinned VC runtime archive entry is missing: $($file.name)" }
        $target = Join-Path $payload $file.name
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) { throw "VC runtime file integrity mismatch: $($file.name)" }
        $files += @{ name = $file.name; bytes = (Get-Item -LiteralPath $target).Length; sha256 = $file.sha256 }
    }
} finally { $zip.Dispose() }
$license = Join-Path $OutputRoot $lock.license.file
if (-not (Test-Path -LiteralPath $license)) { Invoke-WebRequest -Uri $lock.license.url -OutFile $license -TimeoutSec 60 }
if ((Get-FileHash -LiteralPath $license -Algorithm SHA256).Hash -ne $lock.license.sha256) { throw 'Official VC runtime license integrity mismatch.' }
# Preserve the original Microsoft document, with a plain-text reading copy.
# Only a verified ZIP entry is read; no Office application or installer runs.
$document = [IO.Compression.ZipFile]::OpenRead($license)
try {
    $reader = [IO.StreamReader]::new($document.GetEntry('word/document.xml').Open())
    try { [xml]$xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $paragraphs = $xml.GetElementsByTagName('w:p') | ForEach-Object { $_.InnerText }
    [IO.File]::WriteAllText((Join-Path $OutputRoot 'Microsoft-VC-Runtime-LICENSE.txt'), ($paragraphs -join "`r`n`r`n"), [Text.UTF8Encoding]::new($false))
} finally { $document.Dispose() }
@{ schemaVersion = 1; architecture = 'x64'; source = @{ packageId = $lock.packageId; version = $lock.version; url = $lock.url; sha256 = $lock.sha256 }; license = $lock.license; files = $files } |
    ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $OutputRoot 'provenance.json') -Encoding utf8
Write-Output "Prepared verified app-local VC runtime $($lock.version): $payload"
