[CmdletBinding()]
param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture'),
    [string]$ToolchainSetup = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/vs2026/msvc/setup_x64.bat'),
    [string]$CMakeExecutable = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/cmake-4.4.4-windows-x86_64/bin/cmake.exe'),
    [string]$NinjaExecutable = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/ninja-1.13.2/ninja.exe'),
    [string]$OpenCVDirectory,
    [string]$OnnxRuntimeRoot
)
$ErrorActionPreference = 'Stop'
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
foreach ($tool in @($ToolchainSetup, $CMakeExecutable, $NinjaExecutable)) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "Missing build tool: $tool" }
    if ($tool.Contains('"')) { throw 'Invalid build tool path' }
}
$environment = & $env:ComSpec /d /s /c "`"`"$ToolchainSetup`" >nul && set`""
if ($LASTEXITCODE) { throw 'Native toolchain environment setup failed' }
foreach ($line in $environment) {
    if ($line -match '^([^=]+)=(.*)$' -and $Matches[1] -notin 'HOME', 'CODEX_HOME') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
$build = Join-Path $OutputRoot 'build'
$options = @('-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$NinjaExecutable", '-DCMAKE_BUILD_TYPE=Release',
    "-DSPARK233_NATIVE_SOURCE_ROOT=$(Join-Path $OutputRoot 'adapted')")
if ($OpenCVDirectory -or $OnnxRuntimeRoot) {
    if (-not $OpenCVDirectory -or -not $OnnxRuntimeRoot) { throw 'Supply both OpenCVDirectory and OnnxRuntimeRoot for ImageReader.' }
    $OpenCVDirectory = [IO.Path]::GetFullPath($OpenCVDirectory)
    $OnnxRuntimeRoot = [IO.Path]::GetFullPath($OnnxRuntimeRoot)
    $options += '-DSPARK233_BUILD_IMAGE_READER=ON', "-DOpenCV_DIR=$OpenCVDirectory", "-DONNXRUNTIME_ROOT=$OnnxRuntimeRoot"
}
& $CMakeExecutable -S (Join-Path $PSScriptRoot '../../native/capture') -B $build @options
if ($LASTEXITCODE) { throw 'Native capture configure failed' }
& $CMakeExecutable --build $build --parallel 4
if ($LASTEXITCODE) { throw 'Native capture build failed' }
Get-ChildItem $build -Filter '*.exe' | Get-FileHash -Algorithm SHA256
