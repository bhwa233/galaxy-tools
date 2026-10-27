[CmdletBinding()]
param([string]$BuildRoot)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $BuildRoot) { $BuildRoot = Join-Path $repoRoot 'local-build/spark233/native-clipboard' }
$tools = Join-Path $env:LOCALAPPDATA 'spark233/toolchains'
$setup = Join-Path $tools 'vs2026/msvc/setup_x64.bat'
$environment = & $env:ComSpec /d /s /c "`"`"$setup`" >nul && set`""
if ($LASTEXITCODE -ne 0) { throw 'MSVC setup failed' }
foreach ($line in $environment) {
    if ($line -match '^([^=]+)=(.*)$' -and $Matches[1] -notin 'HOME','CODEX_HOME') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
$cmake = Join-Path $tools 'cmake-4.4.4-windows-x86_64/bin/cmake.exe'
$ninja = Join-Path $tools 'ninja-1.13.2/ninja.exe'
& $cmake -S (Join-Path $repoRoot 'packages/official/clipboard/native-src') -B (Join-Path $BuildRoot 'build') -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw 'Clipboard native configure failed' }
& $cmake --build (Join-Path $BuildRoot 'build') --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'Clipboard native build failed' }
