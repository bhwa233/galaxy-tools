[CmdletBinding()]
param(
    [string]$SourceRepository,
    [string]$BuildRoot,
    [string]$ToolchainSetup,
    [string]$CMakeExecutable,
    [string]$NinjaExecutable,
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $BuildRoot) { $BuildRoot = Join-Path $repoRoot 'local-build/spark233/native-search' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if (-not $SourceRepository) { $SourceRepository = Join-Path $BuildRoot 'pulse-checkout' }
$commit = 'c4fe01ed82fe091f495f531972a854aa32caac2b'
$sourceRoot = Join-Path $BuildRoot 'pulse-source'
$manifestPath = Join-Path $BuildRoot 'source-manifest.json'
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null

# Export a committed snapshot: never patch the previously reviewed checkout.
# A prepared directory is immutable; use another BuildRoot to prepare afresh.
if (-not (Test-Path -LiteralPath $manifestPath)) {
    if (Test-Path -LiteralPath $sourceRoot) { throw "Unfinished preparation exists: $sourceRoot. Select a new BuildRoot." }
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRepository '.git'))) {
        $SourceRepository = Join-Path $BuildRoot 'pulse-checkout'
        & git clone --no-checkout https://github.com/jimmgreen/pulse.git $SourceRepository
        if ($LASTEXITCODE -ne 0) { throw 'Pulse clone failed' }
    }
    & git -C $SourceRepository cat-file -e "${commit}^{commit}"
    if ($LASTEXITCODE -ne 0) { throw "Pinned Pulse commit is unavailable: $commit" }
    $archive = Join-Path $BuildRoot 'pulse-source.tar'
    & git -C $SourceRepository archive --format=tar "--output=$archive" $commit
    if ($LASTEXITCODE -ne 0) { throw 'Pulse source export failed' }
    New-Item -ItemType Directory -Path $sourceRoot | Out-Null
    & tar -xf $archive -C $sourceRoot
    if ($LASTEXITCODE -ne 0) { throw 'Pulse source extraction failed' }

    # Runtime names, services, pipes, locks, data roots and environment variables
    # are separate from Pulse. Keep upstream C++ namespaces and compile macros.
    $changedFiles = @()
    $files = @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'src') -Recurse -File |
        Where-Object Extension -in '.h', '.cpp', '.rc')
    $files += Get-Item -LiteralPath (Join-Path $sourceRoot 'CMakeLists.txt')
    foreach ($file in $files) {
        $original = [IO.File]::ReadAllText($file.FullName)
        $adapted = $original.Replace('Pulse', 'spark233').Replace('"PULSE_', '"SPARK233_').Replace('pulse-index', 'spark233-index')
        if ($adapted -cne $original) {
            [IO.File]::WriteAllText($file.FullName, $adapted, [Text.UTF8Encoding]::new($false))
            $changedFiles += [IO.Path]::GetRelativePath($sourceRoot, $file.FullName)
        }
    }
    $manifest = [ordered]@{
        repository = 'https://github.com/jimmgreen/pulse'
        commit = $commit
        archiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        adaptation = 1
        runtimeNamespace = 'spark233'
        modifiedFiles = $changedFiles
        preparedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.commit -ne $commit -or $manifest.adaptation -notin 1, 2, 3, 4, 5, 6, 7, 8) { throw 'Prepared source manifest mismatch' }
if ($manifest.adaptation -eq 1) {
    # SHGetFolderPath ignores LOCALAPPDATA/PROGRAMDATA environment overrides.
    # Give the native boundary explicit data-root overrides for isolated runs.
    $folderCall = '    if (FAILED(SHGetFolderPathW(nullptr, csidl, nullptr, SHGFP_TYPE_CURRENT, path))) return {};'
    $isolatedFolderCall = @'
    const wchar_t* isolated_variable = csidl == CSIDL_COMMON_APPDATA
        ? L"SPARK233_SEARCH_MACHINE_ROOT" : L"SPARK233_SEARCH_PROFILE_ROOT";
    const DWORD isolated_length = GetEnvironmentVariableW(isolated_variable, path, ARRAYSIZE(path));
    if (isolated_length >= ARRAYSIZE(path)) return {};
    if (!isolated_length && FAILED(SHGetFolderPathW(nullptr, csidl, nullptr, SHGFP_TYPE_CURRENT, path))) return {};
'@
    foreach ($relative in @('src/index/index_config.cpp', 'src/common/crash_reporter.cpp')) {
        $filePath = Join-Path $sourceRoot $relative
        $original = [IO.File]::ReadAllText($filePath)
        if (-not $original.Contains($folderCall)) { throw "Pinned folder adapter does not match: $relative" }
        [IO.File]::WriteAllText($filePath, $original.Replace($folderCall, $isolatedFolderCall), [Text.UTF8Encoding]::new($false))
    }
    $manifest.adaptation = 2
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}
if ($manifest.adaptation -eq 2) {
    # Upstream is normally the root project: make generated headers/resources
    # relative to its own binary directory when used as a search-only subproject.
    $cmakePath = Join-Path $sourceRoot 'CMakeLists.txt'
    $original = [IO.File]::ReadAllText($cmakePath)
    [IO.File]::WriteAllText($cmakePath, $original.Replace('CMAKE_BINARY_DIR', 'CMAKE_CURRENT_BINARY_DIR'), [Text.UTF8Encoding]::new($false))
    $manifest.adaptation = 3
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}
if ($manifest.adaptation -eq 3) {
    # Production bridge must never enter upstream's user-profile fallback, even
    # if the service disappears between our initial check and pipe connection.
    $clientPath = Join-Path $sourceRoot 'src/index/index_client.cpp'
    $original = [IO.File]::ReadAllText($clientPath)
    $boundary = '    const std::wstring exe = ExePath();'
    $guarded = "#ifdef SPARK233_SERVICE_ONLY`n    return false;`n#endif`n$boundary"
    if (-not $original.Contains($boundary)) { throw 'Pinned service-only adapter does not match' }
    [IO.File]::WriteAllText($clientPath, $original.Replace($boundary, $guarded), [Text.UTF8Encoding]::new($false))
    $manifest.adaptation = 4
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}
if ($manifest.adaptation -eq 4) {
    # Carry the user's hidden-file policy through the existing Instant protocol.
    # Admission stays before extraction, including directories during DFS.
    $patches = @(
        @('src/index/content_search.h', '    bool whole_word = false;', "    bool whole_word = false;`n    bool include_hidden = true;"),
        @('src/index/content_search_client.cpp', '    if (request.whole_word) flags |= 8u;', "    if (request.whole_word) flags |= 8u;`n    if (!request.include_hidden) flags |= 16u;"),
        @('src/index/content_agent.cpp', '    request.whole_word = (flags & 8) != 0;', "    request.whole_word = (flags & 8) != 0;`n    request.include_hidden = (flags & 16) == 0;"),
        @('src/index/content_task_search.cpp', '                                read = read && !(data.dwFileAttributes & unsafe);', "                                read = read && !(data.dwFileAttributes & unsafe);`n                                if (!request.include_hidden && (data.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN)) read = false;"),
        @('src/index/content_task_search.cpp', '                            if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {', "                            if (!request.include_hidden && (data.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN)) continue;`n                            if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {"),
        @('src/index/content_task_search.cpp', '                            if (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE)) return false;', "                            if (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE)) return false;`n                            if (!request.include_hidden && (attributes & FILE_ATTRIBUTE_HIDDEN)) return false;"),
        @('src/index/content_index.cpp', '            if (InternalContentPath(path)) continue;', "            if (InternalContentPath(path)) continue;`n            if (!r.include_hidden && (GetFileAttributesW(path.c_str()) & FILE_ATTRIBUTE_HIDDEN)) continue;")
    )
    foreach ($patch in $patches) {
        $filename = Join-Path $sourceRoot $patch[0]
        $original = [IO.File]::ReadAllText($filename)
        if (-not $original.Contains($patch[1])) { throw "Pinned hidden-policy adapter does not match: $($patch[0])" }
        [IO.File]::WriteAllText($filename, $original.Replace($patch[1], $patch[2]), [Text.UTF8Encoding]::new($false))
    }
    $manifest.adaptation = 5
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}
if ($manifest.adaptation -eq 5) {
    $filename = Join-Path $sourceRoot 'src/index/content_task_search.cpp'
    $original = [IO.File]::ReadAllText($filename)
    $anchor = '                                if (!request.include_hidden && (data.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN)) read = false;'
    $hiddenAncestors = @'
                                if (!request.include_hidden) {
                                    if (data.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN) read = false;
                                    for (auto parent = std::filesystem::path(job.path).parent_path(); read && !parent.empty() && parent != parent.parent_path(); parent = parent.parent_path()) {
                                        const DWORD attributes = GetFileAttributesW(NativePath(parent.wstring()).c_str());
                                        if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_HIDDEN)) read = false;
                                    }
                                }
'@
    if (-not $original.Contains($anchor)) { throw 'Pinned hidden ancestor adapter does not match' }
    [IO.File]::WriteAllText($filename, $original.Replace($anchor, $hiddenAncestors), [Text.UTF8Encoding]::new($false))
    $manifest.adaptation = 6
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}
if ($manifest.adaptation -eq 6) {
    # Preserve the read-handle identity/version across the Instant wire boundary.
    $patches = @(
        @('src/index/content_task_search.cpp', '#include <map>', "#include <map>`n#include <sstream>"),
        @('src/index/content_search.h', '    uint64_t file_id = 0;', "    uint64_t file_id = 0;`n    std::wstring file_version;"),
        @('src/index/content_task_search.cpp', '                                            result.hit->file_id = 0;', @'
                                            result.hit->file_version = job.version;
                                            std::wistringstream identity(job.version);
                                            uint64_t volume = 0, high = 0, low = 0;
                                            wchar_t separator = 0;
                                            if (identity >> volume >> separator >> high >> separator >> low)
                                                result.hit->file_id = (high << 32) | low;
'@),
        @('src/index/content_agent.cpp', '    for(const auto& hit:hits) writer.PutU64(hit.file_id);', "    for(const auto& hit:hits) writer.PutU64(hit.file_id);`n    for(const auto& hit:hits) writer.PutString(hit.file_version);"),
        @('src/index/content_search_client.cpp', '        for(auto& hit:update.hits) if(!reader.GetU64(hit.file_id)) return false;', "        for(auto& hit:update.hits) if(!reader.GetU64(hit.file_id)) return false;`n        for(auto& hit:update.hits) if(!reader.GetString(hit.file_version)) return false;")
    )
    foreach ($patch in $patches) {
        $filename = Join-Path $sourceRoot $patch[0]
        $original = [IO.File]::ReadAllText($filename)
        if (-not $original.Contains($patch[1])) { throw "Pinned file-version adapter does not match: $($patch[0])" }
        [IO.File]::WriteAllText($filename, $original.Replace($patch[1], $patch[2]), [Text.UTF8Encoding]::new($false))
    }
    $manifest.adaptation = 7
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}
if ($manifest.adaptation -eq 7) {
    # A normal hit cap cancels outstanding synchronous worker I/O during Join.
    # Keep genuine version/read failures, but preserve cancellation identity so
    # that teardown cannot turn a successful truncated page into error 995/1237.
    $patches = @(
        @('src/index/text_task_reader.cpp', @'
bool Stable(HANDLE file, const std::wstring& path, const BY_HANDLE_FILE_INFORMATION& before,
            const FILE_BASIC_INFO& before_basic) {
    BY_HANDLE_FILE_INFORMATION after{}, current{};
    FILE_BASIC_INFO after_basic{}, current_basic{};
    if (!GetFileInformationByHandle(file, &after) || before.nFileSizeHigh != after.nFileSizeHigh ||
        before.nFileSizeLow != after.nFileSizeLow || CompareFileTime(&before.ftLastWriteTime, &after.ftLastWriteTime) ||
        !GetFileInformationByHandleEx(file, FileBasicInfo, &after_basic, sizeof(after_basic)) ||
        before_basic.ChangeTime.QuadPart != after_basic.ChangeTime.QuadPart)
        return false;
    File path_file{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    return path_file.handle != INVALID_HANDLE_VALUE && GetFileInformationByHandle(path_file.handle, &current) &&
        GetFileInformationByHandleEx(path_file.handle, FileBasicInfo, &current_basic, sizeof(current_basic)) &&
        current.nFileIndexHigh == before.nFileIndexHigh && current.nFileIndexLow == before.nFileIndexLow &&
        current.dwVolumeSerialNumber == before.dwVolumeSerialNumber &&
        current_basic.ChangeTime.QuadPart == before_basic.ChangeTime.QuadPart;
}
'@, @'
DWORD Stable(HANDLE file, const std::wstring& path, const BY_HANDLE_FILE_INFORMATION& before,
             const FILE_BASIC_INFO& before_basic) {
    BY_HANDLE_FILE_INFORMATION after{}, current{};
    FILE_BASIC_INFO after_basic{}, current_basic{};
    if (!GetFileInformationByHandle(file, &after) ||
        !GetFileInformationByHandleEx(file, FileBasicInfo, &after_basic, sizeof(after_basic))) {
        const auto code = GetLastError();
        return code ? code : ERROR_READ_FAULT;
    }
    if (before.nFileSizeHigh != after.nFileSizeHigh || before.nFileSizeLow != after.nFileSizeLow ||
        CompareFileTime(&before.ftLastWriteTime, &after.ftLastWriteTime) ||
        before_basic.ChangeTime.QuadPart != after_basic.ChangeTime.QuadPart)
        return ERROR_RETRY;
    File path_file{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    if (path_file.handle == INVALID_HANDLE_VALUE ||
        !GetFileInformationByHandle(path_file.handle, &current) ||
        !GetFileInformationByHandleEx(path_file.handle, FileBasicInfo, &current_basic, sizeof(current_basic))) {
        const auto code = GetLastError();
        return code ? code : ERROR_READ_FAULT;
    }
    return current.nFileIndexHigh == before.nFileIndexHigh && current.nFileIndexLow == before.nFileIndexLow &&
        current.dwVolumeSerialNumber == before.dwVolumeSerialNumber &&
        current_basic.ChangeTime.QuadPart == before_basic.ChangeTime.QuadPart ? ERROR_SUCCESS : ERROR_RETRY;
}
'@),
        @('src/index/text_task_reader.cpp', @'
    result = {};
    auto fail = [&](DWORD code) {
        result.body.clear(); result.version.clear(); result.skipped_lines = 0;
'@, @'
    result = {};
    auto stopped = [&] { return cancelled && cancelled(); };
    auto fail = [&](DWORD code) {
        // Only an I/O abort after our cancellation signal is a cancellation.
        // Real short reads, identity changes and unrelated errors stay failures.
        if (code == ERROR_OPERATION_ABORTED && stopped()) code = ERROR_CANCELLED;
        result.body.clear(); result.version.clear(); result.skipped_lines = 0;
'@),
        @('src/index/text_task_reader.cpp', @'
    };
    auto stopped = [&] { return cancelled && cancelled(); };
    if (stopped()) return fail(ERROR_CANCELLED);
'@, @'
    };
    if (stopped()) return fail(ERROR_CANCELLED);
'@),
        @('src/index/text_task_reader.cpp',
            '    if (!Stable(file.handle, path, before, before_basic)) return fail(ERROR_RETRY);',
            '    if (const auto version_error = Stable(file.handle, path, before, before_basic)) return fail(version_error);'),
        @('src/index/content_task_search.cpp', @'
                                if (read_error && read_error != ERROR_CANCELLED)
                                    error = read_error;
'@, @'
                                if (read_error && read_error != ERROR_CANCELLED &&
                                    !(read_error == ERROR_OPERATION_ABORTED && interrupted()))
                                    error = read_error;
'@)
    )
    foreach ($patch in $patches) {
        $filename = Join-Path $sourceRoot $patch[0]
        $original = [IO.File]::ReadAllText($filename).Replace("`r`n", "`n")
        if (-not $original.Contains($patch[1]) -or $original.IndexOf($patch[1]) -ne $original.LastIndexOf($patch[1])) {
            throw "Pinned hit-limit cancellation adapter does not uniquely match: $($patch[0])"
        }
        [IO.File]::WriteAllText($filename, $original.Replace($patch[1], $patch[2]), [Text.UTF8Encoding]::new($false))
    }
    $manifest.modifiedFiles = @($manifest.modifiedFiles + @('src/index/text_task_reader.cpp', 'src/index/content_task_search.cpp') | Sort-Object -Unique)
    $manifest.adaptation = 8
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}
if ($PrepareOnly) { Write-Output "Prepared pinned, namespaced source: $sourceRoot"; return }

$portableTools = Join-Path $env:LOCALAPPDATA 'spark233/toolchains'
if (-not $ToolchainSetup) {
    $portableSetup = Join-Path $portableTools 'vs2026/msvc/setup_x64.bat'
    if (Test-Path -LiteralPath $portableSetup) { $ToolchainSetup = $portableSetup }
}
if ($ToolchainSetup) {
    $ToolchainSetup = [IO.Path]::GetFullPath($ToolchainSetup)
    if ($ToolchainSetup.Contains('"')) { throw 'Invalid toolchain setup path' }
    $environment = & $env:ComSpec /d /s /c "`"`"$ToolchainSetup`" >nul && set`""
    if ($LASTEXITCODE -ne 0) { throw 'Portable MSVC environment setup failed' }
    foreach ($line in $environment) {
        if ($line -match '^([^=]+)=(.*)$' -and $Matches[1] -notin 'HOME', 'CODEX_HOME') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
        }
    }
} elseif (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsPath) { throw 'MSVC x64 compiler is missing. Prepare the agreed C++ toolchain first.' }
    Import-Module (Join-Path $vsPath 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
}
if (-not $CMakeExecutable) {
    $portableCmake = Join-Path $portableTools 'cmake-4.4.4-windows-x86_64/bin/cmake.exe'
    $CMakeExecutable = if (Test-Path -LiteralPath $portableCmake) { $portableCmake } else { (Get-Command cmake -ErrorAction Stop).Source }
}
if (-not $NinjaExecutable) {
    $portableNinja = Join-Path $portableTools 'ninja-1.13.2/ninja.exe'
    $NinjaExecutable = if (Test-Path -LiteralPath $portableNinja) { $portableNinja } else { (Get-Command ninja -ErrorAction Stop).Source }
}
$binaryRoot = Join-Path $BuildRoot 'build'
& $CMakeExecutable -S (Join-Path $repoRoot 'native/search') -B $binaryRoot -G Ninja "-DCMAKE_MAKE_PROGRAM=$NinjaExecutable" "-DSPARK233_PULSE_SOURCE=$sourceRoot" -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw 'Search configure failed' }
& $CMakeExecutable --build $binaryRoot --target spark233_search spark233_search_probe pulse_index_caller_filter_test --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Search build failed' }
$packageRoot = Join-Path $repoRoot 'packages/official/search'
$payloadRoot = Join-Path $packageRoot 'native'
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
foreach ($name in @('spark233.Search.exe', 'spark233.Index.exe', 'spark233.Document.exe', 'pdfium.dll')) {
    Copy-Item -LiteralPath (Join-Path $binaryRoot "bin/$name") -Destination $payloadRoot -Force
}
Copy-Item -LiteralPath (Join-Path $binaryRoot 'bin/licenses') -Destination $packageRoot -Recurse -Force
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $packageRoot 'licenses/Pulse/source-manifest.json') -Force
$resourceFiles = foreach ($name in @('spark233.Search.exe', 'spark233.Index.exe', 'spark233.Document.exe', 'pdfium.dll')) {
    $resourcePath = Join-Path $payloadRoot $name
    @{ name = $name; bytes = (Get-Item -LiteralPath $resourcePath).Length; sha256 = (Get-FileHash -LiteralPath $resourcePath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$sourceHashes = @{}
foreach ($relative in @('native/search/search.cpp', 'native/search/CMakeLists.txt', 'scripts/native-search/build.ps1')) {
    $sourceHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $repoRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
}
@{ protocol = 1; files = @($resourceFiles); inputs = $sourceHashes; upstream = @{ commit = $commit; archiveSha256 = $manifest.archiveSha256; adaptation = $manifest.adaptation } } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $payloadRoot 'resources.json') -Encoding utf8
Write-Output "Built isolated search tools in $(Join-Path $binaryRoot 'bin')"
