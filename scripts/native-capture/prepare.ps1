[CmdletBinding()]
param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture'),
    [switch]$SkipReleases
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$lock = Get-Content (Join-Path $PSScriptRoot 'sources.lock.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutputRoot | Out-Null

# Existing project scripts have no native-source fetcher. Git provides exact revisions and
# PowerShell provides SHA-256/downloads, so this small entry point needs no package dependency.
foreach ($source in $lock.sources) {
    $directory = Join-Path $OutputRoot "sources/$($source.name)"
    if (-not (Test-Path (Join-Path $directory '.git'))) {
        New-Item -ItemType Directory -Force $directory | Out-Null
        & git -C $directory init --quiet
        if ($LASTEXITCODE) { throw "git init failed: $($source.name)" }
        & git -C $directory remote add origin $source.repository
        if ($LASTEXITCODE) { throw "git remote failed: $($source.name)" }
    }
    $origin = & git -C $directory remote get-url origin
    if ($origin -ne $source.repository) { throw "Unexpected origin: $directory" }
    $dirty = & git -C $directory status --porcelain
    if ($dirty) { throw "Refusing to overwrite changed upstream source: $directory" }
    & git -C $directory fetch --quiet --depth 1 origin $source.revision
    if ($LASTEXITCODE) { throw "git fetch failed: $($source.name)" }
    & git -C $directory checkout --quiet --detach $source.revision
    if ($LASTEXITCODE) { throw "git checkout failed: $($source.name)" }
    $revision = & git -C $directory rev-parse HEAD
    if ($revision -ne $source.revision) { throw "Source revision mismatch: $($source.name)" }
    Write-Host "$($source.name) $revision"
}

if (-not $SkipReleases) {
    $releases = Join-Path $OutputRoot 'upstream'
    New-Item -ItemType Directory -Force $releases | Out-Null
    foreach ($release in $lock.releases) {
        $file = Join-Path $releases $release.name
        if (-not (Test-Path $file)) {
            $partial = "$file.download"
            Invoke-WebRequest -Uri $release.url -OutFile $partial
            if ((Get-Item $partial).Length -ne $release.bytes -or
                (Get-FileHash $partial -Algorithm SHA256).Hash -ne $release.sha256) {
                throw "Release integrity check failed: $partial"
            }
            Move-Item -LiteralPath $partial -Destination $file
        }
        if ((Get-Item $file).Length -ne $release.bytes -or
            (Get-FileHash $file -Algorithm SHA256).Hash -ne $release.sha256) {
            throw "Release integrity check failed: $file"
        }
        Write-Host "$($release.name) SHA256 $($release.sha256)"
    }
}

$lock | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $OutputRoot 'sources-resolved.json') -Encoding utf8
