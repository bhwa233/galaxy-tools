// Production boundary around pinned Pulse clients. JSON session files are private
// host-generated input; native queries run with the ordinary caller's token.
#include "index/index_client.h"
#include "index/content_search_client.h"
#include "index/content_scope.h"
#include "common/json_utils.h"
#include "common/command_line.h"
#include <shlobj.h>
#include <shellapi.h>
#include <sddl.h>
#include <aclapi.h>
#include <fstream>
#include <filesystem>
#include <sstream>
#include <cstring>

namespace idx = pulse::index;
namespace json = pulse::json;
namespace fs = std::filesystem;
namespace {
std::wstring Wide(const std::string& value) {
    const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (!n && !value.empty()) throw std::runtime_error("Invalid UTF-8");
    std::wstring out(static_cast<size_t>(n), L'\0');
    if (n) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), out.data(), n);
    return out;
}
std::string Utf8(const std::wstring& value) {
    const int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (!n && !value.empty()) throw std::runtime_error("Invalid Unicode");
    std::string out(static_cast<size_t>(n), '\0');
    if (n) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), out.data(), n, nullptr, nullptr);
    return out;
}
std::wstring Quote(const std::wstring& value) { std::wstring out = L"\""; json::Escape(value, out); return out + L"\""; }
std::wstring Read(const fs::path& file) {
    if (fs::file_size(file) > 1024 * 1024) throw std::runtime_error("Request too large");
    std::ifstream stream(file, std::ios::binary);
    std::string bytes{std::istreambuf_iterator<char>(stream), {}};
    auto text = Wide(bytes);
    if (!json::ValidConfigObject(text)) throw std::runtime_error("Invalid JSON");
    return text;
}
struct Request {
    std::wstring session, owner, action, mode, needle, directory, profile, fixture_pipe;
    std::vector<std::wstring> fixture_roots, private_roots, extensions;
    size_t offset = 0, limit = 60;
    uint64_t maximum_file_bytes = 64ull * 1024 * 1024;
    bool include_hidden = true;
    fs::path folder;
    bool Cancelled() const { return fs::exists(folder / L"cancel.request"); }
};
struct Result {
    std::wstring status = L"ok", message, service;
    DWORD error = 0;
    uint64_t revision = 0;
    bool more = false;
    std::vector<std::wstring> hits;
};
void Write(const Request& request, const Result& result) {
    std::wstring text = L"{\"protocol\":1,\"sessionId\":" + Quote(request.session) + L",\"owner\":" + request.owner +
        L",\"status\":" + Quote(result.status) + L",\"error\":" + std::to_wstring(result.error) +
        L",\"message\":" + Quote(result.message) + L",\"revision\":" + Quote(std::to_wstring(result.revision)) +
        L",\"hasMore\":" + (result.more ? L"true" : L"false") + L",\"hits\":[";
    for (size_t i = 0; i < result.hits.size(); ++i) { if (i) text += L","; text += result.hits[i]; }
    text += L"]";
    if (!result.service.empty()) text += L",\"service\":" + result.service;
    text += L"}";
    auto bytes = Utf8(text);
    if (bytes.size() > 8 * 1024 * 1024) throw std::runtime_error("Response too large");
    const auto temporary = request.folder / L"result.pending";
    { std::ofstream stream(temporary, std::ios::binary); stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size())); if (!stream) throw std::runtime_error("Result write failed"); }
    if (!MoveFileExW(temporary.c_str(), (request.folder / L"result.json").c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("Result publish failed");
}
std::wstring Hit(const std::wstring& path, const std::wstring& name, bool directory,
                 const std::wstring& snippet = {}, uint32_t line = 0,
                 const idx::ContentHit* content = nullptr) {
    return L"{\"path\":" + Quote(path) + L",\"name\":" + Quote(name) + L",\"directory\":" +
        (directory ? L"true" : L"false") + L",\"snippet\":" + Quote(snippet) + L",\"line\":" + std::to_wstring(line) +
        (content ? L",\"fileId\":" + Quote(std::to_wstring(content->file_id)) +
            L",\"size\":" + Quote(std::to_wstring(content->size)) +
            L",\"modified\":" + Quote(std::to_wstring(content->modified)) +
            L",\"fileVersion\":" + Quote(content->file_version) : L"") + L"}";
}
Result Failure(std::wstring status, DWORD error, std::wstring message) {
    Result result; result.status = std::move(status); result.error = error; result.message = std::move(message); return result;
}
Result CheckServiceVersion(fs::path* service_executable = nullptr);
Result ServiceSnapshot(idx::IndexClient& index, const std::vector<idx::VolumeInfo>& volumes,
                       const std::vector<std::wstring>& effective_exclusions) {
    Result result;
    result.service = L"{\"connected\":true,\"message\":" + Quote(index.Status()) + L",\"volumes\":[";
    for (size_t i = 0; i < volumes.size(); ++i) {
        if (i) result.service += L",";
        const auto& v = volumes[i];
        result.service += L"{\"id\":" + Quote(v.id) + L",\"label\":" + Quote(v.label) +
            L",\"mountPoint\":" + Quote(v.mount_point) + L",\"fileSystem\":" + Quote(v.file_system) +
            L",\"online\":" + (v.online ? L"true" : L"false") + L",\"supported\":" + (v.supported ? L"true" : L"false") +
            L",\"enabled\":" + (v.enabled ? L"true" : L"false") + L",\"indexedItems\":" + std::to_wstring(v.indexed_items) +
            L",\"progress\":" + std::to_wstring(v.progress) + L",\"state\":" + Quote(v.state) + L",\"error\":" + Quote(v.error) + L"}";
    }
    result.service += L"],\"volumeIds\":[";
    for (size_t i = 0; i < volumes.size(); ++i) { if (i) result.service += L","; result.service += Quote(volumes[i].id); }
    result.service += L"],\"enabledVolumeIds\":[";
    bool first_enabled = true;
    for (const auto& volume : volumes) if (volume.enabled) { if (!first_enabled) result.service += L","; first_enabled = false; result.service += Quote(volume.id); }
    result.service += L"],\"excludedRoots\":[";
    const auto configured = index.ExcludedPaths();
    for (size_t i = 0; i < configured.size(); ++i) { if (i) result.service += L","; result.service += Quote(configured[i]); }
    result.service += L"],\"effectiveExcludedRoots\":[";
    for (size_t i = 0; i < effective_exclusions.size(); ++i) { if (i) result.service += L","; result.service += Quote(effective_exclusions[i]); }
    result.service += L"]}";
    return result;
}
Result Query(const Request& request) {
    idx::IndexClient index;
    // Upstream can start a profile-walk fallback. This product requires the
    // shared NTFS service and never invokes that fallback on an ordinary query.
    if (request.fixture_pipe.empty() && !index.ServiceInstalled())
        return Failure(L"service-not-installed", ERROR_SERVICE_DOES_NOT_EXIST, L"Install the spark233 NTFS search service with administrator confirmation.");
    if (request.fixture_pipe.empty()) {
        const auto version = CheckServiceVersion();
        if (version.status != L"ok") return version;
    }
    index.Start(nullptr, 0, 0, request.fixture_pipe.empty() ? idx::kPipeName : request.fixture_pipe);
    const auto deadline = GetTickCount64() + 120000;
    std::vector<idx::VolumeInfo> volumes;
    std::vector<std::wstring> exclusions;
    const auto connection_deadline = GetTickCount64() + 10000;
    while ((!index.Connected() || (request.fixture_roots.empty() && !index.GetScope(volumes, exclusions))) &&
           !request.Cancelled() && GetTickCount64() < connection_deadline) Sleep(10);
    if (request.Cancelled()) return Failure(L"cancelled", ERROR_CANCELLED, L"Query cancelled");
    if (!index.Connected()) return Failure(L"service-unavailable", ERROR_TIMEOUT, L"The installed search service is unavailable. Retry after it starts.");
    if (request.action == L"service-status") return ServiceSnapshot(index, volumes, exclusions);
    idx::ContentIndexConfig config;
    if (!request.fixture_roots.empty()) {
        for (const auto& root : request.fixture_roots) config.roots.push_back({root});
    } else config = idx::SharedContentScope(config, volumes, exclusions);
    config.excluded_paths.insert(config.excluded_paths.end(), request.private_roots.begin(), request.private_roots.end());
    config.maximum_file_bytes = request.maximum_file_bytes;
    Result result;
    if (request.mode == L"files") {
        idx::Query query;
        query.session_id = 1; query.needle = request.needle; query.path_prefix = request.directory;
        // Reuse Pulse's scope/exclusion rules, but count the public page only
        // after the host's private/user exclusions. Dropping hits from one raw
        // page would otherwise skip admitted files and publish false cursors.
        query.limit = idx::kSearchUiPageSize;
        size_t admitted = 0;
        uint32_t request_id = 0;
        bool complete = false;
        while (!complete && !request.Cancelled() && GetTickCount64() < deadline) {
            index.SearchAsync(query, ++request_id);
            idx::SearchResult found;
            bool ready = false;
            while (!(ready = index.TakeResult(request_id, found)) && !request.Cancelled() && GetTickCount64() < deadline) Sleep(10);
            if (request.Cancelled()) break;
            if (!ready || found.error) return Failure(L"error", ready ? found.error : ERROR_TIMEOUT, L"Filename query did not complete");
            if (request_id > 1 && result.revision != found.revision)
                return Failure(L"error", ERROR_RETRY, L"The filename index changed while applying exclusions. Retry the query.");
            result.revision = found.revision;
            for (const auto& hit : found.hits) {
                if (idx::ContentPathExcluded(config, hit.path)) continue;
                if (admitted++ < request.offset) continue;
                if (result.hits.size() == request.limit) { result.more = true; complete = true; break; }
                result.hits.push_back(Hit(hit.path, hit.name, hit.is_dir));
            }
            query.offset += found.hits.size();
            if (found.hits.empty() || query.offset >= found.total) complete = true;
            if (query.offset > UINT32_MAX) return Failure(L"error", ERROR_ARITHMETIC_OVERFLOW, L"Filename query exceeded the supported index range");
        }
        index.CancelSession(1);
        if (request.Cancelled()) return Failure(L"cancelled", ERROR_CANCELLED, L"Query cancelled");
        if (!complete) return Failure(L"error", ERROR_TIMEOUT, L"Filename query did not complete");
        return result;
    }
    if (config.roots.empty()) return Failure(L"error", ERROR_PATH_NOT_FOUND, L"No enabled supported search volumes");
    idx::ContentSearchClient content;
    content.Start(nullptr, 0, idx::ContentAgentMode::Instant);
    content.Configure(config);
    idx::ContentSearchRequest query;
    query.generation = 1; query.session_id = 1; query.needle = request.needle;
    query.root = request.directory; query.indexed = query.task_scan = true;
    query.maximum_hits = request.offset + request.limit + 1;
    query.maximum_file_bytes = request.maximum_file_bytes;
    query.include_hidden = request.include_hidden;
    // Admission happens before extraction: MVP text/code only, no PDF/Office.
    const std::wstring admitted = L"|txt|md|markdown|ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml|toml|ini|conf|config|xml|html|css|scss|less|py|rs|go|c|cpp|h|hpp|cs|java|kt|swift|rb|php|sql|sh|ps1|bat|cmd|vue|svelte|log|csv|";
    auto extensions = request.extensions;
    if (extensions.empty()) {
        std::wistringstream names(L"txt md markdown ts tsx js jsx mjs cjs json jsonc yaml yml toml ini conf config xml html css scss less py rs go c cpp h hpp cs java kt swift rb php sql sh ps1 bat cmd vue svelte log csv");
        for (std::wstring extension; names >> extension;) extensions.push_back(extension);
    }
    for (const auto& extension : extensions) {
        if (extension.empty() || extension.size() > 12 || extension.find_first_not_of(L"abcdefghijklmnopqrstuvwxyz0123456789") != std::wstring::npos ||
            admitted.find(L"|" + extension + L"|") == std::wstring::npos)
            return Failure(L"error", ERROR_INVALID_PARAMETER, L"Unsupported Instant content file type");
        if (!query.filename_query.empty()) query.filename_query += L" | ";
        query.filename_query += L"ext:" + extension;
    }
    content.SearchAsync(query);
    bool done = false; size_t count = 0;
    while (!done && !request.Cancelled() && GetTickCount64() < deadline) {
        idx::ContentSearchUpdate update;
        if (!content.TakeUpdate(update)) { Sleep(10); continue; }
        if (update.progress.generation != 1) continue;
        for (const auto& hit : update.hits) {
            if (hit.removed) continue;
            if (count >= request.offset && result.hits.size() < request.limit)
                result.hits.push_back(Hit(hit.path, hit.name, false, hit.snippet, hit.line, &hit));
            ++count;
        }
        if (update.progress.done) {
            done = true; result.error = update.progress.error;
            result.revision = update.progress.index_revision;
            result.more = update.progress.truncated || count > request.offset + request.limit;
        }
    }
    content.Cancel(1); content.Stop();
    if (request.Cancelled()) return Failure(L"cancelled", ERROR_CANCELLED, L"Query cancelled");
    if (!done || result.error) return Failure(L"error", done ? result.error : ERROR_TIMEOUT, L"Content query did not complete");
    return result;
}

fs::path Self() {
    std::wstring buffer(32768, L'\0');
    const DWORD n = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!n || n == buffer.size()) throw std::runtime_error("Executable path unavailable");
    buffer.resize(n); return fs::path(buffer);
}
bool NoReparse(const fs::path& path) {
    for (auto current = path; !current.empty() && current != current.parent_path(); current = current.parent_path()) {
        const DWORD attributes = GetFileAttributesW(current.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    }
    return true;
}
constexpr char kServiceOwner[] = "product=com.spark233.desktop\nservice=spark233Index\nformat=1\n";
constexpr wchar_t kServiceOwnerFile[] = L"spark233-service-owner.txt";
DWORD ProtectedRoot(fs::path& output) {
    PWSTR known = nullptr;
    const HRESULT found = SHGetKnownFolderPath(FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, nullptr, &known);
    if (FAILED(found)) return HRESULT_FACILITY(found) == FACILITY_WIN32 ? HRESULT_CODE(found) : ERROR_PATH_NOT_FOUND;
    output = fs::path(known) / L"spark233"; CoTaskMemFree(known); return ERROR_SUCCESS;
}
bool ProtectedOwner(const fs::path& file) {
    PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD error = GetNamedSecurityInfoW(file.c_str(), SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor);
    bool accepted = error == ERROR_SUCCESS && owner && acl &&
        (IsWellKnownSid(owner, WinBuiltinAdministratorsSid) || IsWellKnownSid(owner, WinLocalSystemSid));
    // An administrator owner alone does not exclude a user-writable DACL. No
    // unprivileged principal may replace files while elevated cleanup walks it.
    constexpr DWORD write = GENERIC_ALL | GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER |
        FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD;
    for (DWORD i = 0; accepted && i < acl->AceCount; ++i) {
        void* raw = nullptr;
        if (!GetAce(acl, i, &raw)) { accepted = false; break; }
        const auto* header = static_cast<ACE_HEADER*>(raw);
        if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { accepted = false; break; }
        const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
        PSID sid = const_cast<DWORD*>(&ace->SidStart);
        if ((ace->Mask & write) && !IsWellKnownSid(sid, WinBuiltinAdministratorsSid) && !IsWellKnownSid(sid, WinLocalSystemSid)) accepted = false;
    }
    if (descriptor) LocalFree(descriptor);
    return accepted;
}
DWORD CreateProtectedDirectory(const fs::path& directory) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)", SDDL_REVISION_1, &descriptor, nullptr)) return GetLastError();
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    const BOOL created = CreateDirectoryW(directory.c_str(), &security);
    const DWORD error = created ? ERROR_SUCCESS : GetLastError();
    LocalFree(descriptor);
    if (!created && error != ERROR_ALREADY_EXISTS) return error;
    return NoReparse(directory) && fs::is_directory(directory) && ProtectedOwner(directory) ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
}
bool SamePath(const fs::path& first, const fs::path& second) {
    const auto a = first.lexically_normal().wstring(), b = second.lexically_normal().wstring();
    return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_EQUAL;
}
bool OwnedVersion(const fs::path& directory, const fs::path& root) {
    if (!NoReparse(directory) || !fs::is_directory(directory) || !ProtectedOwner(directory) ||
        !SamePath(directory.parent_path(), root)) return false;
    const auto name = directory.filename().wstring();
    const auto guid_start = name.find(L'{'); GUID guid{};
    if (!name.starts_with(L"search-") || guid_start == std::wstring::npos || guid_start < 9 ||
        name[guid_start - 1] != L'-' || name.size() - guid_start != 38 ||
        FAILED(CLSIDFromString(name.c_str() + guid_start, &guid))) return false;
    const auto marker = directory / kServiceOwnerFile;
    if (!NoReparse(marker) || !fs::is_regular_file(marker) || !ProtectedOwner(marker) ||
        fs::file_size(marker) != sizeof(kServiceOwner) - 1) return false;
    std::ifstream stream(marker, std::ios::binary);
    const std::string bytes{std::istreambuf_iterator<char>(stream), {}};
    return bytes == kServiceOwner;
}
bool OwnedServiceConfiguration(const QUERY_SERVICE_CONFIGW* config, const fs::path& root) {
    int count = 0; auto arguments = CommandLineToArgvW(config->lpBinaryPathName, &count);
    const bool system = config->lpServiceStartName &&
        (_wcsicmp(config->lpServiceStartName, L"LocalSystem") == 0 ||
         _wcsicmp(config->lpServiceStartName, L"NT AUTHORITY\\SYSTEM") == 0);
    const fs::path binary = arguments && count == 2 ? fs::path(arguments[0]) : fs::path();
    const bool owned = arguments && count == 2 && std::wstring_view(arguments[1]) == L"--service" &&
        config->dwServiceType == SERVICE_WIN32_OWN_PROCESS && system && binary.is_absolute() &&
        binary.filename() == L"spark233.Index.exe" && NoReparse(binary) && ProtectedOwner(binary) &&
        OwnedVersion(binary.parent_path(), root);
    if (arguments) LocalFree(arguments);
    return owned;
}
bool SameContents(const fs::path& first, const fs::path& second) {
    if (!NoReparse(first) || !NoReparse(second) || !fs::is_regular_file(first) ||
        !fs::is_regular_file(second) || fs::file_size(first) != fs::file_size(second)) return false;
    std::ifstream a(first, std::ios::binary), b(second, std::ios::binary);
    if (!a || !b) return false;
    char x[65536], y[65536];
    for (;;) {
        a.read(x, sizeof(x)); b.read(y, sizeof(y));
        if (a.bad() || b.bad() || a.gcount() != b.gcount()) return false;
        if (a.gcount() && std::memcmp(x, y, static_cast<size_t>(a.gcount())) != 0) return false;
        if (a.eof() || b.eof()) return a.eof() && b.eof();
        if (!a || !b) return false;
    }
}
Result CheckServiceVersion(fs::path* service_executable) {
    fs::path root;
    DWORD error = ProtectedRoot(root);
    if (error) return Failure(L"service-unavailable", error, L"Protected search location is unavailable.");
    if (!NoReparse(root) || !fs::is_directory(root) || !ProtectedOwner(root))
        return Failure(L"service-unavailable", ERROR_ACCESS_DENIED, L"Protected search installation is unavailable.");
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!manager) return Failure(L"service-unavailable", GetLastError(), L"Search service configuration cannot be read.");
    SC_HANDLE service = OpenServiceW(manager, idx::kServiceName, SERVICE_QUERY_CONFIG);
    if (!service) {
        error = GetLastError(); CloseServiceHandle(manager);
        return Failure(error == ERROR_SERVICE_DOES_NOT_EXIST ? L"service-not-installed" : L"service-unavailable",
            error, L"The search service is not installed or its configuration is unavailable.");
    }
    DWORD needed = 0; QueryServiceConfigW(service, nullptr, 0, &needed);
    std::vector<BYTE> buffer(needed && needed <= 1024 * 1024 ? needed : 0);
    auto* config = reinterpret_cast<QUERY_SERVICE_CONFIGW*>(buffer.data());
    if (buffer.empty()) error = ERROR_INVALID_DATA;
    else if (!QueryServiceConfigW(service, config, needed, &needed)) error = GetLastError();
    CloseServiceHandle(service); CloseServiceHandle(manager);
    if (error || !OwnedServiceConfiguration(config, root))
        return Failure(L"service-unavailable", error ? error : ERROR_ACCESS_DENIED, L"The machine service does not match spark233's protected installation.");
    int count = 0; auto arguments = CommandLineToArgvW(config->lpBinaryPathName, &count);
    if (!arguments || count != 2) { if (arguments) LocalFree(arguments); return Failure(L"service-unavailable", ERROR_INVALID_DATA, L"Search service command could not be read."); }
    const auto installed = fs::path(arguments[0]).parent_path(); LocalFree(arguments);
    const auto packaged = Self().parent_path();
    for (const auto* name : {L"spark233.Index.exe", L"spark233.Document.exe", L"pdfium.dll"})
        if (!SameContents(installed / name, packaged / name))
            return Failure(L"service-update-required", ERROR_REVISION_MISMATCH,
                L"This plugin includes an updated search service. Confirm its installation to switch the protected machine service.");
    if (service_executable) *service_executable = installed / L"spark233.Index.exe";
    return Result{};
}
DWORD WriteServiceOwner(const fs::path& directory) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)", SDDL_REVISION_1, &descriptor, nullptr)) return GetLastError();
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    HANDLE file = CreateFileW((directory / kServiceOwnerFile).c_str(), GENERIC_WRITE, 0,
        &security, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    LocalFree(descriptor);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    DWORD written = 0, error = ERROR_SUCCESS;
    constexpr DWORD length = static_cast<DWORD>(sizeof(kServiceOwner) - 1);
    if (!WriteFile(file, kServiceOwner, length, &written, nullptr) || written != length || !FlushFileBuffers(file)) {
        error = GetLastError(); if (!error) error = ERROR_WRITE_FAULT;
    }
    CloseHandle(file); return error;
}
DWORD StopServiceNormally(SC_HANDLE service) {
    SERVICE_STATUS status{};
    if (!QueryServiceStatus(service, &status)) return GetLastError();
    if (status.dwCurrentState != SERVICE_STOPPED && status.dwCurrentState != SERVICE_STOP_PENDING &&
        !ControlService(service, SERVICE_CONTROL_STOP, &status) && GetLastError() != ERROR_SERVICE_NOT_ACTIVE) return GetLastError();
    const auto deadline = GetTickCount64() + 30000;
    while (status.dwCurrentState != SERVICE_STOPPED && GetTickCount64() < deadline) {
        Sleep(100);
        if (!QueryServiceStatus(service, &status)) return GetLastError();
    }
    return status.dwCurrentState == SERVICE_STOPPED ? ERROR_SUCCESS : ERROR_SERVICE_REQUEST_TIMEOUT;
}
DWORD Run(const fs::path& executable, const std::wstring& arguments) {
    // Executable and arguments are fixed by this helper, never a shell command.
    std::wstring command = L"\"" + executable.wstring() + L"\" " + arguments;
    STARTUPINFOW startup{sizeof(startup)}; startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                        executable.parent_path().c_str(), &startup, &process)) return GetLastError();
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = ERROR_GEN_FAILURE; GetExitCodeProcess(process.hProcess, &code); CloseHandle(process.hProcess); return code;
}
DWORD ConfigureProtected(const fs::path& filename) {
    // The elevated process may only run the owned SCM executable. Environment
    // overrides used by isolated fixtures must never redirect machine writes.
    SetEnvironmentVariableW(L"SPARK233_SEARCH_MACHINE_ROOT", nullptr);
    SetEnvironmentVariableW(L"SPARK233_SEARCH_PROFILE_ROOT", nullptr);
    const auto text = Read(filename);
    const auto action = json::ExtractString(text, L"action");
    if (action != L"service-configure" && action != L"service-rebuild") return ERROR_INVALID_PARAMETER;
    fs::path executable;
    const auto owned = CheckServiceVersion(&executable);
    if (owned.status != L"ok") return owned.error ? owned.error : ERROR_ACCESS_DENIED;
    if (action == L"service-rebuild") return Run(executable, L"--rebuild-index");
    const auto paths = json::ExtractStringArray(text, L"serviceExcludedRoots");
    const auto enabled = json::ExtractStringArray(text, L"enabledVolumeIds");
    const auto disabled = json::ExtractStringArray(text, L"disabledVolumeIds");
    if (paths.size() > 128 || enabled.size() + disabled.size() > 64) return ERROR_INVALID_PARAMETER;
    for (const auto& path : paths)
        if (path.size() <= 3 || path.size() > 32768 || path[1] != L':' || path[2] != L'\\' ||
            path.find_first_of(L"\"\r\n") != std::wstring::npos || !fs::path(path).is_absolute()) return ERROR_INVALID_PARAMETER;
    Request snapshot_request; snapshot_request.action = L"service-status"; snapshot_request.folder = filename.parent_path();
    const auto snapshot = Query(snapshot_request);
    if (snapshot.status != L"ok") return snapshot.error ? snapshot.error : ERROR_SERVICE_NOT_ACTIVE;
    const auto volume_ids = json::ExtractStringArray(snapshot.service, L"volumeIds");
    for (const auto& id : enabled) if (std::find(volume_ids.begin(), volume_ids.end(), id) == volume_ids.end()) return ERROR_INVALID_PARAMETER;
    for (const auto& id : disabled) if (std::find(volume_ids.begin(), volume_ids.end(), id) == volume_ids.end() ||
        std::find(enabled.begin(), enabled.end(), id) != enabled.end()) return ERROR_INVALID_PARAMETER;
    const auto old_paths = json::ExtractStringArray(snapshot.service, L"excludedRoots");
    const auto old_enabled = json::ExtractStringArray(snapshot.service, L"enabledVolumeIds");
    std::vector<std::pair<std::wstring, std::wstring>> changes;
    const auto contains = [](const auto& values, const auto& value) {
        return std::any_of(values.begin(), values.end(), [&](const auto& old) { return idx::ContentScopeKey(old) == idx::ContentScopeKey(value); });
    };
    for (const auto& path : old_paths) if (!contains(paths, path))
        changes.push_back({L"--configure-exclude " + pulse::QuoteWindowsArgument(path) + L" --disable", L"--configure-exclude " + pulse::QuoteWindowsArgument(path) + L" --enable"});
    for (const auto& path : paths) if (!contains(old_paths, path))
        changes.push_back({L"--configure-exclude " + pulse::QuoteWindowsArgument(path) + L" --enable", L"--configure-exclude " + pulse::QuoteWindowsArgument(path) + L" --disable"});
    // Volume commands are submitted only for changed settings. Inverses restore
    // their previous value if a subsequent protected command fails.
    for (const auto& id : enabled) if (!contains(old_enabled, id)) changes.push_back({L"--configure-volume " + pulse::QuoteWindowsArgument(id) + L" --enable", L"--configure-volume " + pulse::QuoteWindowsArgument(id) + L" --disable"});
    for (const auto& id : disabled) if (contains(old_enabled, id)) changes.push_back({L"--configure-volume " + pulse::QuoteWindowsArgument(id) + L" --disable", L"--configure-volume " + pulse::QuoteWindowsArgument(id) + L" --enable"});
    size_t applied = 0;
    for (; applied < changes.size(); ++applied) {
        const DWORD error = Run(executable, changes[applied].first);
        if (error) {
            bool restored = true;
            while (applied) if (Run(executable, changes[--applied].second)) restored = false;
            return restored ? error : ERROR_PARTIAL_COPY;
        }
    }
    return ERROR_SUCCESS;
}
Result AuthorizeConfiguration(const Request& request) {
    const auto executable = Self();
    const std::wstring parameters = L"--elevated-service " + pulse::QuoteWindowsArgument((request.folder / L"request.json").wstring());
    SHELLEXECUTEINFOW shell{sizeof(shell)};
    shell.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
    shell.lpVerb = L"runas"; shell.lpFile = executable.c_str(); shell.lpParameters = parameters.c_str(); shell.nShow = SW_HIDE;
    if (!ShellExecuteExW(&shell)) {
        const DWORD error = GetLastError();
        return Failure(error == ERROR_CANCELLED ? L"authorization-denied" : L"error", error, L"Windows service management was declined or could not start.");
    }
    WaitForSingleObject(shell.hProcess, INFINITE);
    DWORD code = ERROR_GEN_FAILURE; GetExitCodeProcess(shell.hProcess, &code); CloseHandle(shell.hProcess);
    return code ? Failure(L"error", code, code == ERROR_PARTIAL_COPY ? L"Some service settings could not be restored. Refresh service status before retrying." : L"Service configuration did not complete. Refresh status and retry.") : Result{};
}
DWORD CopyPayload(const fs::path& input, const fs::path& output) {
    HANDLE source = CreateFileW(input.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (source == INVALID_HANDLE_VALUE) return GetLastError();
    FILE_ATTRIBUTE_TAG_INFO tag{};
    if (!GetFileInformationByHandleEx(source, FileAttributeTagInfo, &tag, sizeof(tag)) ||
        (tag.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) {
        CloseHandle(source); return ERROR_FILE_INVALID;
    }
    // Create a new file inheriting only the protected destination's ACL; never
    // copy source security/ownership from the user-writable package directory.
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)", SDDL_REVISION_1, &descriptor, nullptr)) {
        const DWORD error = GetLastError(); CloseHandle(source); return error;
    }
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    HANDLE target = CreateFileW(output.c_str(), GENERIC_WRITE, 0, &security, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    LocalFree(descriptor);
    if (target == INVALID_HANDLE_VALUE) { const DWORD error = GetLastError(); CloseHandle(source); return error; }
    char buffer[65536]; DWORD read = 0, written = 0, error = ERROR_SUCCESS;
    for (;;) {
        if (!ReadFile(source, buffer, sizeof(buffer), &read, nullptr)) { error = GetLastError(); break; }
        if (!read) break;
        if (!WriteFile(target, buffer, read, &written, nullptr) || written != read) { error = GetLastError(); if (!error) error = ERROR_WRITE_FAULT; break; }
    }
    if (!error && !FlushFileBuffers(target)) error = GetLastError();
    CloseHandle(target); CloseHandle(source); return error;
}
DWORD SwitchService(const fs::path& executable) {
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!manager) return GetLastError();
    SC_HANDLE service = OpenServiceW(manager, idx::kServiceName,
        SERVICE_STOP | SERVICE_START | SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG | SERVICE_CHANGE_CONFIG);
    if (!service) {
        const DWORD error = GetLastError(); CloseServiceHandle(manager);
        return error == ERROR_SERVICE_DOES_NOT_EXIST ? Run(executable, L"--install") : error;
    }
    DWORD needed = 0;
    QueryServiceConfigW(service, nullptr, 0, &needed);
    if (!needed || needed > 1024 * 1024) { CloseServiceHandle(service); CloseServiceHandle(manager); return ERROR_INVALID_DATA; }
    std::vector<BYTE> buffer(needed);
    auto* config = reinterpret_cast<QUERY_SERVICE_CONFIGW*>(buffer.data());
    if (!QueryServiceConfigW(service, config, needed, &needed)) {
        const DWORD error = GetLastError(); CloseServiceHandle(service); CloseServiceHandle(manager); return error;
    }
    if (!OwnedServiceConfiguration(config, executable.parent_path().parent_path())) {
        CloseServiceHandle(service); CloseServiceHandle(manager); return ERROR_ACCESS_DENIED;
    }
    const std::wstring previous_binary = config->lpBinaryPathName;
    const DWORD previous_start = config->dwStartType;
    DWORD error = StopServiceNormally(service);
    if (!error) {
        error = Run(executable, L"--install");
        if (error) {
            // Restore the previous protected service command when switching or
            // starting the new version fails; keep both payloads for recovery.
            ChangeServiceConfigW(service, SERVICE_NO_CHANGE, previous_start, SERVICE_NO_CHANGE,
                previous_binary.c_str(), nullptr, nullptr, nullptr, nullptr, nullptr, nullptr);
            StartServiceW(service, 0, nullptr);
        }
    }
    CloseServiceHandle(service); CloseServiceHandle(manager); return error;
}
DWORD InstallProtected() {
    fs::path protected_root;
    const DWORD root_error = ProtectedRoot(protected_root);
    if (root_error) return root_error;
    // Dedicated parent ACL denies user writes, including when an earlier user
    // created this name. No reparse points may redirect an elevated copy.
    if (!NoReparse(protected_root)) return ERROR_REPARSE_TAG_INVALID;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)", SDDL_REVISION_1, &descriptor, nullptr)) return GetLastError();
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    const BOOL created = CreateDirectoryW(protected_root.c_str(), &security);
    const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
    if (!created && create_error != ERROR_ALREADY_EXISTS) { LocalFree(descriptor); return create_error; }
    PSID owner = nullptr; PSECURITY_DESCRIPTOR existing = nullptr;
    const DWORD owner_error = GetNamedSecurityInfoW(protected_root.c_str(), SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &existing);
    const bool protected_owner = owner_error == ERROR_SUCCESS && owner &&
        (IsWellKnownSid(owner, WinBuiltinAdministratorsSid) || IsWellKnownSid(owner, WinLocalSystemSid));
    if (existing) LocalFree(existing);
    if (!protected_owner) { LocalFree(descriptor); return ERROR_ACCESS_DENIED; }
    const BOOL secured = SetFileSecurityW(protected_root.c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor);
    if (!secured) { const DWORD error = GetLastError(); LocalFree(descriptor); return error; }
    // New unpredictable child avoids overwriting a currently running service.
    GUID guid{}; if (FAILED(CoCreateGuid(&guid))) return ERROR_GEN_FAILURE;
    wchar_t name[40]{}; StringFromGUID2(guid, name, 40);
    const auto destination = protected_root / (std::wstring(L"search-0.1.0-") + name);
    if (!NoReparse(destination)) return ERROR_REPARSE_TAG_INVALID;
    if (!CreateDirectoryW(destination.c_str(), &security)) { const DWORD error = GetLastError(); LocalFree(descriptor); return error; }
    LocalFree(descriptor);
    const auto source = Self().parent_path();
    for (const auto* file : {L"spark233.Index.exe", L"spark233.Document.exe", L"pdfium.dll"}) {
        const auto input = source / file;
        if (!NoReparse(input) || !fs::is_regular_file(input)) return ERROR_FILE_INVALID;
        const DWORD copied = CopyPayload(input, destination / file);
        if (copied) return copied;
    }
    const auto licenses = source.parent_path() / L"licenses";
    if (!NoReparse(licenses) || !fs::is_directory(licenses)) return ERROR_FILE_NOT_FOUND;
    const DWORD license_root = CreateProtectedDirectory(destination / L"licenses");
    if (license_root) return license_root;
    for (const auto& entry : fs::recursive_directory_iterator(licenses)) {
        if (!NoReparse(entry.path())) return ERROR_REPARSE_TAG_INVALID;
        const auto output = destination / L"licenses" / fs::relative(entry.path(), licenses);
        if (entry.is_directory()) {
            const DWORD directory_error = CreateProtectedDirectory(output); if (directory_error) return directory_error;
        }
        else if (entry.is_regular_file()) {
            const DWORD copied = CopyPayload(entry.path(), output);
            if (copied) return copied;
        } else return ERROR_FILE_INVALID;
    }
    const DWORD marked = WriteServiceOwner(destination);
    if (marked) return marked;
    // Upstream SCM installer changes existing service configuration safely and
    // applies its query/start ACL and recovery rules. Its own SelfPath is now
    // protected Program Files, so LocalSystem never executes plugin-store code.
    HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Global\\spark233IndexConfiguration");
    if (!mutex) return GetLastError();
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        const DWORD waited = WaitForSingleObject(mutex, 30000);
        if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) { CloseHandle(mutex); return ERROR_BUSY; }
    }
    const DWORD switched = SwitchService(destination / L"spark233.Index.exe");
    ReleaseMutex(mutex); CloseHandle(mutex); return switched;
}
DWORD UninstallProtected() {
    fs::path root;
    const DWORD root_error = ProtectedRoot(root);
    if (root_error) return root_error;
    if (!NoReparse(root) || (fs::exists(root) && !ProtectedOwner(root))) return ERROR_ACCESS_DENIED;
    HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Global\\spark233IndexConfiguration");
    if (!mutex) return GetLastError();
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        const DWORD waited = WaitForSingleObject(mutex, 30000);
        if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) { CloseHandle(mutex); return ERROR_BUSY; }
    }
    DWORD result = ERROR_SUCCESS;
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!manager) result = GetLastError();
    SC_HANDLE service = manager ? OpenServiceW(manager, idx::kServiceName,
        SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | SERVICE_STOP | DELETE) : nullptr;
    if (manager && !service && GetLastError() != ERROR_SERVICE_DOES_NOT_EXIST) result = GetLastError();
    if (service) {
        DWORD needed = 0; QueryServiceConfigW(service, nullptr, 0, &needed);
        if (!needed || needed > 1024 * 1024) result = ERROR_INVALID_DATA;
        std::vector<BYTE> buffer(needed);
        auto* config = reinterpret_cast<QUERY_SERVICE_CONFIGW*>(buffer.data());
        if (!result && !QueryServiceConfigW(service, config, needed, &needed)) result = GetLastError();
        if (!result) {
            if (!OwnedServiceConfiguration(config, root)) result = ERROR_ACCESS_DENIED;
        }
        if (!result) result = StopServiceNormally(service);
        if (!result && !DeleteService(service) && GetLastError() != ERROR_SERVICE_MARKED_FOR_DELETE) result = GetLastError();
        CloseServiceHandle(service);
    }
    if (manager) CloseServiceHandle(manager);
    // Only directories with our exact marker and protected owner are eligible.
    // Index/config/user data and unrelated children of Program Files are kept.
    if (!result && fs::exists(root)) {
        for (const auto& entry : fs::directory_iterator(root)) {
            if (!OwnedVersion(entry.path(), root)) continue;
            bool regular = true;
            for (const auto& child : fs::recursive_directory_iterator(entry.path())) {
                if (!NoReparse(child.path()) || !ProtectedOwner(child.path()) ||
                    (!child.is_regular_file() && !child.is_directory())) { regular = false; break; }
            }
            if (!regular) { result = ERROR_ACCESS_DENIED; break; }
            std::error_code error; fs::remove_all(entry.path(), error);
            if (error) { result = static_cast<DWORD>(error.value()); break; }
        }
    }
    ReleaseMutex(mutex); CloseHandle(mutex); return result;
}
Result AuthorizeServiceAction(bool uninstall = false) {
    if (!uninstall && CheckServiceVersion().status == L"ok") return Result{};
    if (uninstall) {
        // A user who declined the optional service should not see an unrelated
        // administrator prompt while uninstalling the desktop application.
        SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
        if (!manager) return Failure(L"error", GetLastError(), L"Search service state could not be checked; no removal was attempted.");
        SC_HANDLE service = OpenServiceW(manager, idx::kServiceName, SERVICE_QUERY_CONFIG);
        const DWORD service_error = service ? ERROR_SUCCESS : GetLastError();
        if (service) CloseServiceHandle(service);
        CloseServiceHandle(manager);
        if (service_error == ERROR_SERVICE_DOES_NOT_EXIST) {
            fs::path root; const DWORD root_error = ProtectedRoot(root);
            if (root_error) return Failure(L"error", root_error, L"Protected search location could not be resolved.");
            bool owned = false;
            if (fs::is_directory(root) && NoReparse(root) && ProtectedOwner(root))
                for (const auto& entry : fs::directory_iterator(root))
                    if (OwnedVersion(entry.path(), root)) { owned = true; break; }
            if (!owned) return Result{};
        } else if (service_error && service_error != ERROR_ACCESS_DENIED)
            return Failure(L"error", service_error, L"Search service state could not be checked; no removal was attempted.");
    }
    const auto executable = Self();
    SHELLEXECUTEINFOW shell{sizeof(shell)};
    shell.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
    shell.lpVerb = L"runas"; shell.lpFile = executable.c_str();
    shell.lpParameters = uninstall ? L"--elevated-uninstall" : L"--elevated-install"; shell.nShow = SW_HIDE;
    if (!ShellExecuteExW(&shell)) {
        const DWORD error = GetLastError();
        return Failure(error == ERROR_CANCELLED ? L"authorization-denied" : L"error", error,
                       uninstall ? L"Windows service removal was declined or could not start. The service was retained." :
                                   L"Windows service installation was declined or could not start. You can retry.");
    }
    WaitForSingleObject(shell.hProcess, INFINITE);
    DWORD code = ERROR_GEN_FAILURE; GetExitCodeProcess(shell.hProcess, &code); CloseHandle(shell.hProcess);
    return code ? Failure(L"error", code, uninstall ? L"Search service removal failed. Remaining protected files were retained." :
                                                       L"Search service installation failed. You can retry.") : Result{};
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    int code = 0;
    struct ManagementGuard {
        HANDLE mutex = nullptr;
        ~ManagementGuard() { if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); } }
    } management;
    try {
        if (argc >= 2 && std::wstring_view(argv[1]).starts_with(L"--elevated-")) {
            management.mutex = CreateMutexW(nullptr, FALSE, L"Global\\spark233HostServiceManagement");
            if (!management.mutex) throw std::runtime_error("Service management lock unavailable");
            const DWORD waited = WaitForSingleObject(management.mutex, 30000);
            if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) { CloseHandle(management.mutex); management.mutex = nullptr; throw std::runtime_error("Service management is busy"); }
        }
        if (argc == 2 && std::wstring_view(argv[1]) == L"--elevated-install") code = static_cast<int>(InstallProtected());
        else if (argc == 2 && std::wstring_view(argv[1]) == L"--elevated-uninstall") code = static_cast<int>(UninstallProtected());
        else if (argc == 3 && std::wstring_view(argv[1]) == L"--elevated-service") code = static_cast<int>(ConfigureProtected(fs::path(argv[2])));
        else if (argc == 2 && std::wstring_view(argv[1]) == L"--install-service") {
            // NSIS uses the same fixed UAC helper as the host confirmation path.
            const auto result = AuthorizeServiceAction(); code = static_cast<int>(result.error);
        }
        else if (argc == 2 && std::wstring_view(argv[1]) == L"--uninstall-service") {
            const auto result = AuthorizeServiceAction(true); code = static_cast<int>(result.error);
        }
        else if (argc == 3 && std::wstring_view(argv[1]) == L"--request") {
            const fs::path filename(argv[2]);
            if (!filename.is_absolute() || filename.filename() != L"request.json") throw std::runtime_error("Invalid request path");
            const auto text = Read(filename);
            Request request;
            request.folder = filename.parent_path();
            request.session = json::ExtractString(text, L"sessionId"); request.owner = json::ExtractObject(text, L"owner");
            request.action = json::ExtractString(text, L"action"); request.mode = json::ExtractString(text, L"mode");
            request.needle = json::ExtractString(text, L"query"); request.directory = json::ExtractString(text, L"directory");
            request.profile = json::ExtractString(text, L"profile"); request.fixture_pipe = json::ExtractString(text, L"fixturePipe");
            request.fixture_roots = json::ExtractStringArray(text, L"fixtureRoots"); request.private_roots = json::ExtractStringArray(text, L"privateRoots");
            request.extensions = json::ExtractStringArray(text, L"extensions");
            const int maximum_mib = json::ExtractInt(text, L"maxFileMiB", 64);
            if (maximum_mib < 1 || maximum_mib > 64 || request.extensions.size() > 64) throw std::runtime_error("Invalid content policy");
            request.maximum_file_bytes = static_cast<uint64_t>(maximum_mib) * 1024 * 1024;
            request.include_hidden = json::ExtractBool(text, L"includeHidden", true);
            // Host sends bounded integers. Validate lexical shape before the
            // permissive upstream config integer reader to avoid overflow.
            for (const auto* key : {L"offset", L"limit"}) {
                const auto position = json::ValuePosition(text, key);
                if (position != std::wstring::npos) {
                    size_t end = position; while (end < text.size() && text[end] >= L'0' && text[end] <= L'9') ++end;
                    if (end == position || end - position > 6) throw std::runtime_error("Invalid page bounds");
                }
            }
            request.offset = static_cast<size_t>(json::ExtractInt(text, L"offset", 0));
            request.limit = static_cast<size_t>(json::ExtractInt(text, L"limit", 60));
            if (json::ExtractInt(text, L"protocol") != 1 || request.session.empty() || request.session.size() > 128 ||
                request.owner.empty() || request.needle.size() > 8192 || request.limit < 1 || request.limit > 200 || request.offset > 100000 ||
                (!request.directory.empty() && !fs::path(request.directory).is_absolute()) ||
                (!request.fixture_pipe.empty() && !request.fixture_pipe.starts_with(L"\\\\.\\pipe\\spark233Index.Test.")))
                throw std::runtime_error("Invalid search request");
            for (const auto& root : request.fixture_roots) if (!fs::path(root).is_absolute()) throw std::runtime_error("Invalid fixture root");
            if (request.action == L"search" || request.action == L"service-status") {
                if (!fs::path(request.profile).is_absolute() || (request.action == L"search" && request.mode != L"files" && request.mode != L"content")) throw std::runtime_error("Invalid search mode/profile");
                fs::create_directories(fs::path(request.profile) / L"tmp");
                SetEnvironmentVariableW(L"SPARK233_SEARCH_PROFILE_ROOT", request.profile.c_str());
                SetEnvironmentVariableW(L"SPARK233_CONTENT_TIMING_DIR", (fs::path(request.profile) / L"logs").c_str());
                SetEnvironmentVariableW(L"SPARK233_DOCUMENT_ADMISSION_DIR", (fs::path(request.profile) / L"admission").c_str());
                SetEnvironmentVariableW(L"TEMP", (fs::path(request.profile) / L"tmp").c_str());
                SetEnvironmentVariableW(L"TMP", (fs::path(request.profile) / L"tmp").c_str());
                Write(request, Query(request));
            } else if (request.action == L"install") Write(request, AuthorizeServiceAction());
            else if (request.action == L"service-configure" || request.action == L"service-rebuild") Write(request, AuthorizeConfiguration(request));
            else if (request.action == L"uninstall") Write(request, AuthorizeServiceAction(true));
            else throw std::runtime_error("Unknown action");
        } else code = ERROR_INVALID_PARAMETER;
    } catch (...) { code = ERROR_INVALID_DATA; }
    if (SUCCEEDED(com)) CoUninitialize();
    return code;
}
