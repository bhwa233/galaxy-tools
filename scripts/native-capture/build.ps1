[CmdletBinding()]
param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture'),
    [string]$ToolchainSetup = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/vs2026/msvc/setup_x64.bat'),
    [string]$CMakeExecutable = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/cmake-4.4.4-windows-x86_64/bin/cmake.exe'),
    [string]$NinjaExecutable = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/ninja-1.13.2/ninja.exe'),
    [string]$OpenCVDirectory,
    [string]$OnnxRuntimeRoot,
    [string]$SourceRoot,
    [switch]$WithOcr
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
$dependencyRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../local-build/spark233/native-capture'))
if (-not $SourceRoot) {
    $SourceRoot = Join-Path $OutputRoot 'sources'
    if (-not (Test-Path -LiteralPath $SourceRoot)) { $SourceRoot = Join-Path $dependencyRoot 'sources' }
}
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
if (-not (Test-Path -LiteralPath $SourceRoot)) {
    & (Join-Path $PSScriptRoot 'prepare.ps1') -OutputRoot (Split-Path $SourceRoot -Parent) -SkipReleases
}

# Each generation applies the current adapters to pinned upstream archives. Never
# silently compile a previous adapted tree after changing session protocol code.
$inputs = @((Join-Path $PSScriptRoot 'adapt.ps1'), (Join-Path $PSScriptRoot 'sources.lock.json'))
$inputs += Get-ChildItem (Join-Path $PSScriptRoot '../../native/capture') -File -Recurse | Sort-Object FullName | Select-Object -ExpandProperty FullName
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes((($inputs | Get-FileHash -Algorithm SHA256).Hash -join "`n")))).Substring(0, 16).ToLowerInvariant()
$adapted = Join-Path $OutputRoot "adapted-$digest"
if (-not (Test-Path -LiteralPath $adapted)) {
    $stage = [IO.Path]::GetFullPath((Join-Path $OutputRoot "source-stage-$([Guid]::NewGuid().ToString('N'))"))
    $prefix = $OutputRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $stage.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not $adapted.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native source generation escaped its output directory' }
    try {
        & (Join-Path $PSScriptRoot 'adapt.ps1') -OutputRoot $stage -SourceRoot $SourceRoot
        Move-Item -LiteralPath (Join-Path $stage 'adapted') -Destination $adapted
    } finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
}

if ($WithOcr -and -not $OpenCVDirectory -and -not $OnnxRuntimeRoot) {
    $lock = (Get-Content (Join-Path $PSScriptRoot 'sources.lock.json') -Raw | ConvertFrom-Json).ocrDependencies
    $opencvRoot = Join-Path $dependencyRoot 'deps/opencv'
    $OnnxRuntimeRoot = Join-Path $dependencyRoot "deps/$($lock.onnxruntime.directory)"
    $opencvConfig = Get-ChildItem $opencvRoot -Filter 'OpenCVConfig.cmake' -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'OpenCVModules.cmake') } | Select-Object -First 1
    if (-not $opencvConfig -or -not (Test-Path -LiteralPath (Join-Path $OnnxRuntimeRoot 'include/onnxruntime_cxx_api.h'))) {
        & (Join-Path $PSScriptRoot 'prepare-ocr-deps.ps1') -OutputRoot $dependencyRoot -ToolchainSetup $ToolchainSetup -CMakeExecutable $CMakeExecutable -NinjaExecutable $NinjaExecutable
        $opencvConfig = Get-ChildItem $opencvRoot -Filter 'OpenCVConfig.cmake' -File -Recurse |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'OpenCVModules.cmake') } | Select-Object -First 1
    }
    if (-not $opencvConfig) { throw 'OpenCV preparation did not produce its CMake package configuration' }
    $OpenCVDirectory = $opencvConfig.DirectoryName
}
$build = Join-Path $OutputRoot 'build'
$options = @('-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$NinjaExecutable", '-DCMAKE_BUILD_TYPE=Release',
    "-DSPARK233_NATIVE_SOURCE_ROOT=$adapted", '-DSPARK233_BUILD_IMAGE_READER=OFF')
if ($OpenCVDirectory -or $OnnxRuntimeRoot) {
    if (-not $OpenCVDirectory -or -not $OnnxRuntimeRoot) { throw 'Supply both OpenCVDirectory and OnnxRuntimeRoot for ImageReader.' }
    $OpenCVDirectory = [IO.Path]::GetFullPath($OpenCVDirectory)
    $OnnxRuntimeRoot = [IO.Path]::GetFullPath($OnnxRuntimeRoot)
    if (-not (Test-Path -LiteralPath (Join-Path $OpenCVDirectory 'OpenCVConfig.cmake'))) { throw "OpenCV package configuration not found: $OpenCVDirectory" }
    if (-not (Test-Path -LiteralPath (Join-Path $OnnxRuntimeRoot 'include/onnxruntime_cxx_api.h'))) { throw "ONNX Runtime headers not found: $OnnxRuntimeRoot" }
    $options += '-DSPARK233_BUILD_IMAGE_READER=ON', "-DOpenCV_DIR=$OpenCVDirectory", "-DONNXRUNTIME_ROOT=$OnnxRuntimeRoot"
}
& $CMakeExecutable -S (Join-Path $PSScriptRoot '../../native/capture') -B $build @options
if ($LASTEXITCODE) { throw 'Native capture configure failed' }
& $CMakeExecutable --build $build --parallel 4
if ($LASTEXITCODE) { throw 'Native capture build failed' }
Get-ChildItem $build -Filter '*.exe' | Get-FileHash -Algorithm SHA256
