[CmdletBinding()]
param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture'),
    [string]$ToolchainSetup = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/vs2026/msvc/setup_x64.bat'),
    [string]$CMakeExecutable = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/cmake-4.4.4-windows-x86_64/bin/cmake.exe'),
    [string]$NinjaExecutable = (Join-Path $env:LOCALAPPDATA 'spark233/toolchains/ninja-1.13.2/ninja.exe')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$lock = (Get-Content (Join-Path $PSScriptRoot 'sources.lock.json') -Raw | ConvertFrom-Json).ocrDependencies
$opencv = Join-Path $OutputRoot 'opencv'
if (-not (Test-Path (Join-Path $opencv '.git'))) {
    & git clone --depth 1 --branch $lock.opencv.tag $lock.opencv.repository $opencv
    if ($LASTEXITCODE) { throw 'OpenCV source download failed' }
}
$revision = & git -C $opencv rev-parse HEAD
if ($revision -ne $lock.opencv.revision) { throw 'OpenCV source revision mismatch' }
$ort = Join-Path $OutputRoot "deps/$($lock.onnxruntime.directory)"
$zip = Join-Path $OutputRoot "$($lock.onnxruntime.directory).zip"
if (-not (Test-Path $zip)) { Invoke-WebRequest $lock.onnxruntime.url -OutFile $zip }
if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $lock.onnxruntime.sha256) { throw 'ONNX Runtime integrity mismatch' }
if (-not (Test-Path (Join-Path $ort 'include/onnxruntime_cxx_api.h'))) {
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $OutputRoot 'deps')
}
if ($ToolchainSetup.Contains('"')) { throw 'Invalid toolchain path' }
$environment = & $env:ComSpec /d /s /c "`"`"$ToolchainSetup`" >nul && set`""
if ($LASTEXITCODE) { throw 'Native toolchain environment setup failed' }
foreach ($line in $environment) {
    if ($line -match '^([^=]+)=(.*)$' -and $Matches[1] -notin 'HOME', 'CODEX_HOME') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
$build = Join-Path $OutputRoot 'opencv-build'
$install = Join-Path $OutputRoot 'deps/opencv'
& $CMakeExecutable -S $opencv -B $build -G Ninja "-DCMAKE_MAKE_PROGRAM=$NinjaExecutable" `
    -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_PREFIX=$install" '-DBUILD_LIST=core,imgproc' `
    -DBUILD_SHARED_LIBS=OFF -DBUILD_WITH_STATIC_CRT=ON -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF `
    -DBUILD_EXAMPLES=OFF -DBUILD_opencv_apps=OFF -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_OPENCL=OFF `
    -DWITH_OPENEXR=OFF -DWITH_JPEG=OFF -DWITH_PNG=OFF -DWITH_TIFF=OFF -DWITH_WEBP=OFF `
    -DBUILD_PROTOBUF=OFF -DWITH_PROTOBUF=OFF -DWITH_ADE=OFF -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF `
    -DBUILD_JAVA=OFF -DBUILD_opencv_python3=OFF -DCPU_DISPATCH= -DCPU_BASELINE=SSE2
if ($LASTEXITCODE) { throw 'OpenCV configure failed' }
& $CMakeExecutable --build $build --parallel 4
if ($LASTEXITCODE) { throw 'OpenCV build failed' }
& $CMakeExecutable --install $build
if ($LASTEXITCODE) { throw 'OpenCV install failed' }
Write-Host "OpenCV install: $install; ONNX Runtime: $ort"
