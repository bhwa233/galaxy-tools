[CmdletBinding()]
param([string]$BuildRoot, [string]$PulseSourceRoot, [string]$ToolchainSetup, [string]$CMakeExecutable, [string]$NinjaExecutable)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $BuildRoot) { $BuildRoot = Join-Path $repoRoot 'local-build/spark233/native-applications' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if (-not $PulseSourceRoot) { $PulseSourceRoot = Join-Path $repoRoot 'local-build/spark233/native-search/pulse-source' }
if (-not (Test-Path -LiteralPath (Join-Path $PulseSourceRoot 'src/index/filename_pinyin.cpp'))) {
    $dependencyRoot = Join-Path $BuildRoot 'pulse-dependency'
    & (Join-Path $repoRoot 'scripts/native-search/build.ps1') -BuildRoot $dependencyRoot -PrepareOnly
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Pulse source preparation failed' }
    $PulseSourceRoot = Join-Path $dependencyRoot 'pulse-source'
}
$PulseSourceRoot = [IO.Path]::GetFullPath($PulseSourceRoot)
$manifest = Get-Content -LiteralPath (Join-Path (Split-Path $PulseSourceRoot -Parent) 'source-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.commit -ne 'c4fe01ed82fe091f495f531972a854aa32caac2b') { throw 'Application pinyin requires the pinned Pulse revision' }
$tools = Join-Path $env:LOCALAPPDATA 'spark233/toolchains'
$setup = if ($ToolchainSetup) { $ToolchainSetup } else { Join-Path $tools 'vs2026/msvc/setup_x64.bat' }
$environment = & $env:ComSpec /d /s /c "`"`"$setup`" >nul && set`""
if ($LASTEXITCODE -ne 0) { throw 'MSVC setup failed' }
foreach ($line in $environment) {
    if ($line -match '^([^=]+)=(.*)$' -and $Matches[1] -notin 'HOME','CODEX_HOME') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$cmake = if ($CMakeExecutable) { $CMakeExecutable } else { Join-Path $tools 'cmake-4.4.4-windows-x86_64/bin/cmake.exe' }
$ninja = if ($NinjaExecutable) { $NinjaExecutable } else { Join-Path $tools 'ninja-1.13.2/ninja.exe' }
if (-not (Test-Path -LiteralPath $cmake)) { $cmake = (Get-Command cmake -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $ninja)) { $ninja = (Get-Command ninja -ErrorAction Stop).Source }
& $cmake -S (Join-Path $repoRoot 'native/applications') -B (Join-Path $BuildRoot 'build') -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" "-DSPARK233_PULSE_SOURCE=$PulseSourceRoot" -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw 'Application pinyin configure failed' }
& $cmake --build (Join-Path $BuildRoot 'build') --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'Application pinyin build failed' }
$licenseRoot = Join-Path $BuildRoot 'build/bin/licenses'
New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PulseSourceRoot 'LICENSE') -Destination (Join-Path $licenseRoot 'Pulse-Apache-2.0.txt')
Copy-Item -LiteralPath (Join-Path $PulseSourceRoot 'third_party/ib-pinyin-cpp/LICENSE.txt') -Destination (Join-Path $licenseRoot 'ib-matcher-MIT.txt')
Copy-Item -LiteralPath (Join-Path $PulseSourceRoot 'third_party/ib-pinyin-cpp/README.pulse.txt') -Destination (Join-Path $licenseRoot 'ib-matcher-provenance.txt')
$inputs = @('src/index/filename_pinyin.cpp','src/index/filename_pinyin.h','src/index/index_query.cpp','src/index/index_query.h','src/index/search_kinds.cpp','src/index/search_kinds.h','third_party/ib-pinyin-cpp/ascii_data.inc','src/common/json_utils.h','src/common/config_json.h') | ForEach-Object { [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $PulseSourceRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant() } }
[ordered]@{ protocol = 1; repository = 'https://github.com/jimmgreen/pulse'; commit = $manifest.commit; ibMatcherRevision = '70673969ca837e6eb6caf4e2d22d494a707a5846'; inputs = @($inputs) } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $licenseRoot 'source-manifest.json') -Encoding utf8
