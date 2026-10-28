#Requires -Version 7.0
[CmdletBinding()]
param([string]$PythonExecutable = 'python')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
    # Reuse the pinned source/build recipes; CI does not depend on local ignored binaries.
    & ./scripts/native-capture/prepare-toolchain.ps1 -PythonExecutable $PythonExecutable -PythonArguments @()
    $setup = Join-Path $env:LOCALAPPDATA 'spark233/toolchains/vs2026/msvc/setup_x64.bat'
    $tools = @{
        ToolchainSetup = $setup
        CMakeExecutable = (Get-Command cmake -ErrorAction Stop).Source
        NinjaExecutable = (Get-Command ninja -ErrorAction Stop).Source
    }
    $capture = Join-Path $repoRoot 'local-build/spark233/native-capture-p4'
    & ./scripts/native-capture/prepare.ps1 -OutputRoot $capture -SkipReleases
    & ./scripts/native-capture/adapt.ps1 -OutputRoot $capture
    & ./scripts/native-capture/prepare-ocr-deps.ps1 @tools
    & ./scripts/native-capture/build.ps1 @tools -OutputRoot $capture `
        -OpenCVDirectory (Join-Path $repoRoot 'local-build/spark233/native-capture/deps/opencv/x64/vc18/staticlib') `
        -OnnxRuntimeRoot (Join-Path $repoRoot 'local-build/spark233/native-capture/deps/onnxruntime-win-x64-1.23.2')
    & ./scripts/native-capture/prepare-vc-runtime.ps1
    & ./scripts/native-clipboard/build.ps1 @tools -BuildRoot (Join-Path $repoRoot 'local-build/spark233/native-clipboard-p6')
    & ./scripts/native-search/build.ps1 @tools
    & ./scripts/native-applications/build.ps1 @tools
    & $PythonExecutable scripts/dictionary/build.py
    if ($LASTEXITCODE -ne 0) { throw 'Dictionary preparation failed' }
    & pnpm.cmd sdk:build
    if ($LASTEXITCODE -ne 0) { throw 'SDK build failed' }
    & pnpm.cmd plugins:build
    if ($LASTEXITCODE -ne 0) { throw 'Official resource verification failed' }
} finally { Pop-Location }
