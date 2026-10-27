#pragma once
// Existing Electron/crosscopy APIs do not isolate the Windows clipboard or
// atomically replay a raw multi-format snapshot. No extra FFI library is needed:
// this thin Win32 boundary only launches the private station and copies a small
// whitelist of HGLOBAL formats. It refuses clipboard access on WinSta0.
#include <windows.h>
#include <sddl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr size_t kMaximumBytes = 64 * 1024 * 1024;
std::wstring ObjectName(HANDLE object) {
    wchar_t name[512]{}; DWORD bytes = 0;
    if (!GetUserObjectInformationW(object, UOI_NAME, name, sizeof(name), &bytes)) throw std::runtime_error("user object name failed");
    return name;
}
inline bool productionAccess = false;
void RequireIsolation() {
    if (productionAccess) return;
    const auto station = ObjectName(GetProcessWindowStation());
    wchar_t expected[512]{};
    const auto count = GetEnvironmentVariableW(L"SPARK233_CLIPBOARD_STATION", expected, ARRAYSIZE(expected));
    if (!count || count >= ARRAYSIZE(expected) || station != expected || _wcsicmp(station.c_str(), L"WinSta0") == 0)
        throw std::runtime_error("clipboard access requires the private spark233 window station");
}
std::wstring Quote(const std::wstring& value) {
    std::wstring out = L"\""; size_t slashes = 0;
    for (const auto ch : value) {
        if (ch == L'\\') { ++slashes; continue; }
        if (ch == L'\"') out.append(slashes * 2 + 1, L'\\');
        else out.append(slashes, L'\\');
        slashes = 0; out += ch;
    }
    out.append(slashes * 2, L'\\'); return out + L'\"';
}
int FreshSession(int argc, wchar_t** argv) {
    if (argc < 7) return 2;
    std::wstring command = Quote(argv[0]) + L" isolate";
    for (int i = 2; i < argc; ++i) command += L' ' + Quote(argv[i]);
    SetEnvironmentVariableW(L"SPARK233_CLIPBOARD_FRESH_SESSION", L"1");
    auto environment = GetEnvironmentStringsW();
    STARTUPINFOW startup{sizeof(startup)}; PROCESS_INFORMATION child{};
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        if (job) CloseHandle(job); FreeEnvironmentStringsW(environment); throw std::runtime_error("fresh session job");
    }
    // NETCREDENTIALS_ONLY creates a temporary LSA logon LUID using the same local
    // identity. Dummy credentials are not validated and are never used online.
    // No account, profile, service, desktop ACL or persistent credential is added.
    const bool started = CreateProcessWithLogonW(L"spark233-fixture", L".", L"NotARealCredential-LocalProbeOnly",
        LOGON_NETCREDENTIALS_ONLY, argv[0], command.data(), CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        environment, nullptr, &startup, &child) != FALSE;
    const auto error = GetLastError(); FreeEnvironmentStringsW(environment);
    if (!started) { CloseHandle(job); SetLastError(error); throw std::runtime_error("fresh local logon session"); }
    DWORD code = ERROR_ACCESS_DENIED;
    if (AssignProcessToJobObject(job, child.hProcess)) {
        ResumeThread(child.hThread);
        std::cout << "FRESH_SESSION_PID\t" << child.dwProcessId << std::endl;
        if (WaitForSingleObject(child.hProcess, 50000) == WAIT_OBJECT_0) GetExitCodeProcess(child.hProcess, &code);
        else { TerminateJobObject(job, ERROR_TIMEOUT); code = ERROR_TIMEOUT; WaitForSingleObject(child.hProcess, 5000); }
    } else { TerminateProcess(child.hProcess, code); WaitForSingleObject(child.hProcess, 5000); }
    CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job);
    return static_cast<int>(code);
}
int Isolate(int argc, wchar_t** argv) {
    if (argc < 4) return 2;
    const auto original = GetProcessWindowStation();
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) throw std::runtime_error("OpenProcessToken isolation");
    DWORD bytes = 0; GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
    std::vector<BYTE> user(bytes); LPWSTR sid = nullptr;
    const bool got_user = GetTokenInformation(token, TokenUser, user.data(), bytes, &bytes) &&
        ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid);
    CloseHandle(token);
    if (!got_user) throw std::runtime_error("current-user SID isolation");
    const auto dacl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")"; LocalFree(sid);
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) throw std::runtime_error("private station security descriptor");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    SetLastError(ERROR_SUCCESS);
    // A NULL name reuses the logon-session name and may already exist. Request
    // one unique, private station instead; never fall back to a shared station.
    const auto private_name=L"spark233-clipboard-"+std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64());
    HWINSTA station = CreateWindowStationW(private_name.c_str(), CWF_CREATE_ONLY, WINSTA_ALL_ACCESS, &security);
    const auto station_error = GetLastError();
    if (!station || station_error == ERROR_ALREADY_EXISTS) { if (station) CloseWindowStation(station); LocalFree(descriptor); SetLastError(station_error); throw std::runtime_error("CreateWindowStation isolation"); }
    const auto station_name = ObjectName(station);
    if (_wcsicmp(station_name.c_str(), L"WinSta0") == 0) { CloseWindowStation(station); LocalFree(descriptor); throw std::runtime_error("interactive station is forbidden"); }
    if (!SetProcessWindowStation(station)) { const auto error = GetLastError(); CloseWindowStation(station); LocalFree(descriptor); SetLastError(error); throw std::runtime_error("SetProcessWindowStation isolation"); }
    HDESK desktop = CreateDesktopW(L"probe", nullptr, nullptr, 0, GENERIC_ALL, &security);
    const auto desktop_error = GetLastError();
    const bool restored = SetProcessWindowStation(original) != FALSE;
    LocalFree(descriptor);
    if (!desktop || !restored) { const auto error = desktop ? GetLastError() : desktop_error; if (desktop) CloseDesktop(desktop); CloseWindowStation(station); SetLastError(error); throw std::runtime_error("CreateDesktop or station restore isolation"); }
    SetEnvironmentVariableW(L"SPARK233_CLIPBOARD_STATION", station_name.c_str());
    std::wstring command;
    for (int i = 2; i < argc; ++i) { if (!command.empty()) command += L' '; command += Quote(argv[i]); }
    auto desktop_name = station_name + L"\\probe";
    STARTUPINFOW startup{sizeof(startup)};
    startup.lpDesktop = desktop_name.data(); startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    for (const auto handle : {startup.hStdInput, startup.hStdOutput, startup.hStdError})
        if (handle && handle != INVALID_HANDLE_VALUE) SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    PROCESS_INFORMATION child{};
    const bool started = job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) &&
        CreateProcessW(argv[2], command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED,
                       nullptr, nullptr, &startup, &child);
    if (!started) { std::cerr << "LAUNCH_ERROR\t" << GetLastError() << '\n'; if (job) CloseHandle(job); CloseDesktop(desktop); CloseWindowStation(station); return 1; }
    DWORD code = ERROR_ACCESS_DENIED;
    if (AssignProcessToJobObject(job, child.hProcess)) {
        ResumeThread(child.hThread);
        std::cout << "ISOLATED_NODE_PID\t" << child.dwProcessId << std::endl;
        if (WaitForSingleObject(child.hProcess, 45000) == WAIT_OBJECT_0) GetExitCodeProcess(child.hProcess, &code);
        else { TerminateJobObject(job, ERROR_TIMEOUT); code = ERROR_TIMEOUT; WaitForSingleObject(child.hProcess, 5000); }
    } else { TerminateProcess(child.hProcess, code); WaitForSingleObject(child.hProcess, 5000); }
    CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job);
    CloseDesktop(desktop); CloseWindowStation(station);
    std::cout << "ISOLATED_NODE_EXIT\t" << code << std::endl;
    return static_cast<int>(code);
}

struct Clipboard {
    HWND window = nullptr;
    Clipboard() {
        RequireIsolation();
        window = CreateWindowExW(0, L"STATIC", L"spark233 clipboard probe", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, nullptr, nullptr);
        if (!window) throw std::runtime_error("clipboard owner window failed");
        for (int i = 0; i < 40; ++i) { if (OpenClipboard(window)) return; Sleep(10); }
        DestroyWindow(window); throw std::runtime_error("clipboard busy");
    }
    ~Clipboard() { CloseClipboard(); DestroyWindow(window); }
};
struct Format { uint32_t id; std::wstring name; std::vector<uint8_t> bytes; };
std::vector<uint8_t> Read(UINT format) {
    const auto memory = GetClipboardData(format);
    if (!memory) throw std::runtime_error("GetClipboardData failed");
    const auto length = GlobalSize(memory);
    if (length > kMaximumBytes) throw std::runtime_error("clipboard format exceeds limit");
    if (!length) return {};
    const auto pointer = static_cast<const uint8_t*>(GlobalLock(memory));
    if (!pointer) throw std::runtime_error("GlobalLock failed");
    std::vector<uint8_t> bytes(pointer, pointer + length); GlobalUnlock(memory); return bytes;
}
void Put(UINT format, const std::vector<uint8_t>& bytes) {
    const auto memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.empty() ? 1 : bytes.size());
    if (!memory) throw std::runtime_error("GlobalAlloc failed");
    const auto pointer = GlobalLock(memory);
    if (!pointer) { GlobalFree(memory); throw std::runtime_error("GlobalLock write failed"); }
    if (!bytes.empty()) memcpy(pointer, bytes.data(), bytes.size());
    GlobalUnlock(memory);
    if (!SetClipboardData(format, memory)) { GlobalFree(memory); throw std::runtime_error("SetClipboardData failed"); }
}
std::vector<uint8_t> Bytes(const std::string& value) { return {value.begin(), value.end()}; }
std::vector<uint8_t> WideBytes(const std::wstring& value) {
    const auto first = reinterpret_cast<const uint8_t*>(value.data()); return {first, first + value.size() * sizeof(wchar_t)};
}
bool Sensitive() {
    if (IsClipboardFormatAvailable(RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing"))) return true;
    const auto format = RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
    if (!IsClipboardFormatAvailable(format)) return false;
    const auto bytes = Read(format); return bytes.size() >= 4 && !bytes[0] && !bytes[1] && !bytes[2] && !bytes[3];
}
std::wstring FormatName(UINT id) {
    if (id < 0xc000) return {};
    wchar_t name[256]{};
    const auto count = GetClipboardFormatNameW(id, name, ARRAYSIZE(name)); return {name, static_cast<size_t>(count)};
}
bool Allowed(UINT id, const std::wstring& name) {
    if (name.empty()) return id == CF_UNICODETEXT || id == CF_HDROP || id == CF_DIB || id == CF_DIBV5;
    return id >= 0xc000 && (name == L"HTML Format" || name == L"Rich Text Format" || name == L"PNG");
}
void Seed(const std::wstring& file, bool sensitive) {
    Clipboard clipboard;
    if (!EmptyClipboard()) throw std::runtime_error("EmptyClipboard failed");
    auto text = std::wstring(L"spark233 中文\r\nraw"); text.push_back(L'\0');
    Put(CF_UNICODETEXT, WideBytes(text));
    const std::string fragment = "<b>spark233 中文</b>";
    const std::string html = "<html><body><!--StartFragment-->" + fragment + "<!--EndFragment--></body></html>";
    const std::string pattern = "Version:0.9\r\nStartHTML:%010u\r\nEndHTML:%010u\r\nStartFragment:%010u\r\nEndFragment:%010u\r\n";
    char header[256]{};
    const auto header_length = snprintf(header, sizeof(header), pattern.c_str(), 0u, 0u, 0u, 0u);
    snprintf(header, sizeof(header), pattern.c_str(), header_length, header_length + static_cast<unsigned>(html.size()),
             header_length + static_cast<unsigned>(html.find(fragment)), header_length + static_cast<unsigned>(html.find(fragment) + fragment.size()));
    auto html_bytes = Bytes(std::string(header) + html); html_bytes.push_back(0);
    Put(RegisterClipboardFormatW(L"HTML Format"), html_bytes);
    auto rtf = Bytes("{\\rtf1\\ansi spark233 \\b raw\\b0 }"); rtf.push_back(0);
    Put(RegisterClipboardFormatW(L"Rich Text Format"), rtf);
    DROPFILES drop{}; drop.pFiles = sizeof(drop); drop.fWide = TRUE;
    auto files = WideBytes(file + std::wstring(2, L'\0'));
    std::vector<uint8_t> raw(sizeof(drop) + files.size()); memcpy(raw.data(), &drop, sizeof(drop)); memcpy(raw.data() + sizeof(drop), files.data(), files.size()); Put(CF_HDROP, raw);
    if (sensitive) {
        Put(RegisterClipboardFormatW(L"CanIncludeInClipboardHistory"), {0, 0, 0, 0});
        Put(RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing"), {0});
    }
    std::cout << "SEEDED\t4\tsensitive=" << sensitive << '\n';
}
void U32(std::ostream& stream, uint32_t value) { stream.write(reinterpret_cast<const char*>(&value), sizeof(value)); }
uint32_t U32(std::istream& stream) { uint32_t value = 0; stream.read(reinterpret_cast<char*>(&value), sizeof(value)); if (!stream) throw std::runtime_error("truncated snapshot"); return value; }
int Snapshot(const std::filesystem::path& file) {
    Clipboard clipboard;
    if (Sensitive()) { std::cout << "CAPTURE_SUPPRESSED\t1\n"; return 3; }
    std::vector<Format> formats; size_t total = 0;
    for (UINT id = EnumClipboardFormats(0); id; id = EnumClipboardFormats(id)) {
        auto name = FormatName(id); if (!Allowed(id, name)) continue;
        auto bytes = Read(id); total += bytes.size();
        if (total > kMaximumBytes || formats.size() >= 8) throw std::runtime_error("snapshot exceeds limit");
        formats.push_back({id, std::move(name), std::move(bytes)});
    }
    std::ofstream out(file, std::ios::binary | std::ios::trunc); U32(out, 0x31424353); U32(out, static_cast<uint32_t>(formats.size()));
    for (const auto& format : formats) {
        U32(out, format.id); U32(out, static_cast<uint32_t>(format.name.size())); U32(out, static_cast<uint32_t>(format.bytes.size()));
        out.write(reinterpret_cast<const char*>(format.name.data()), static_cast<std::streamsize>(format.name.size() * 2));
        out.write(reinterpret_cast<const char*>(format.bytes.data()), static_cast<std::streamsize>(format.bytes.size()));
    }
    if (!out) throw std::runtime_error("snapshot write failed");
    std::cout << "RAW_SNAPSHOT\t" << formats.size() << "\tbytes=" << total << '\n'; return 0;
}
void Restore(const std::filesystem::path& file) {
    std::ifstream in(file, std::ios::binary);
    if (U32(in) != 0x31424353) throw std::runtime_error("invalid snapshot header");
    const auto count = U32(in); if (count > 8) throw std::runtime_error("too many formats");
    std::vector<Format> formats; size_t total = 0;
    for (uint32_t i = 0; i < count; ++i) {
        const auto id = U32(in), length = U32(in), bytes = U32(in); total += bytes;
        if (length > 255 || total > kMaximumBytes) throw std::runtime_error("invalid snapshot lengths");
        Format format{id, std::wstring(length, L'\0'), std::vector<uint8_t>(bytes)};
        in.read(reinterpret_cast<char*>(format.name.data()), length * 2); in.read(reinterpret_cast<char*>(format.bytes.data()), bytes);
        if (!in || !Allowed(id, format.name)) throw std::runtime_error("invalid snapshot format");
        formats.push_back(std::move(format));
    }
    if (in.peek() != std::char_traits<char>::eof()) throw std::runtime_error("trailing snapshot data");
    Clipboard clipboard; if (!EmptyClipboard()) throw std::runtime_error("restore clear failed");
    for (const auto& format : formats) Put(format.name.empty() ? format.id : RegisterClipboardFormatW(format.name.c_str()), format.bytes);
    std::cout << "RAW_RESTORED\t" << count << '\n';
}
} // namespace

