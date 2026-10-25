// Apache-2.0 Pulse protocol/client reuse is confined to this native boundary.
// No Electron SDK or Node dependency provides Pulse's Instant agent contract;
// this CLI only drives the upstream clients against isolated P1V fixtures.
#include "index/content_search_client.h"
#include "index/index_protocol.h"
#include <objbase.h>
#include <tlhelp32.h>
#include <filesystem>
#include <iostream>
#include <set>

namespace idx = pulse::index;
namespace ipc = pulse::ipc;

namespace {
std::string Utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const auto count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(count), '\0');
    if (count) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), out.data(), count, nullptr, nullptr);
    return out;
}

bool Send(HANDLE pipe, uint32_t type, uint32_t id, const std::vector<uint8_t>& bytes) {
    const auto header = idx::MakeIndexHdr(type, id, static_cast<uint32_t>(bytes.size()));
    return ipc::PipeWrite(pipe, reinterpret_cast<const uint8_t*>(&header), sizeof(header)) &&
        (bytes.empty() || ipc::PipeWrite(pipe, bytes.data(), static_cast<DWORD>(bytes.size())));
}

bool Reply(HANDLE pipe, uint32_t id, std::vector<uint8_t>& bytes, uint32_t type = idx::RSP_IDX_SEARCH) {
    const auto deadline = GetTickCount64() + 15000;
    while (GetTickCount64() < deadline) {
        DWORD available = 0;
        if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) return false;
        if (available < sizeof(ipc::MsgHeader)) { Sleep(10); continue; }
        ipc::MsgHeader header{};
        if (!ipc::PipeRead(pipe, reinterpret_cast<uint8_t*>(&header), sizeof(header)) ||
            header.magic != idx::kIndexMagic || header.payload_size > idx::kIndexMaxPayload) return false;
        bytes.resize(header.payload_size);
        if (!bytes.empty() && !ipc::PipeRead(pipe, bytes.data(), header.payload_size)) return false;
        if (header.type == type && header.request_id == id) return true;
    }
    return false;
}

int Filename(const std::wstring& pipe_name, const std::wstring& needle, bool shutdown) {
    // Only explicitly isolated fixture pipes are accepted by the probe.
    if (!pipe_name.starts_with(L"\\\\.\\pipe\\spark233Index.Test.")) return 2;
    const auto deadline = GetTickCount64() + 15000;
    HANDLE pipe = INVALID_HANDLE_VALUE;
    while (pipe == INVALID_HANDLE_VALUE && GetTickCount64() < deadline) {
        pipe = CreateFileW(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) { WaitNamedPipeW(pipe_name.c_str(), 25); Sleep(10); }
    }
    if (pipe == INVALID_HANDLE_VALUE) { std::cerr << "CONNECT_ERROR\t" << GetLastError() << '\n'; return 1; }
    // Complete a server round trip before shutdown. Closing a brand-new pipe
    // immediately after writing can race the server's caller-token capture.
    if (shutdown) {
        std::vector<uint8_t> status;
        const bool accepted = Send(pipe, idx::REQ_IDX_STATUS, 2, {}) && Reply(pipe, 2, status, idx::RSP_IDX_STATUS);
        const bool ok = accepted && Send(pipe, idx::REQ_IDX_TEST_SHUTDOWN, 1, {});
        CloseHandle(pipe); return ok ? 0 : 1;
    }
    bool ready = false;
    const auto ready_deadline = GetTickCount64() + 15000;
    while (!ready && GetTickCount64() < ready_deadline) {
        std::vector<uint8_t> status;
        if (!Send(pipe, idx::REQ_IDX_STATUS, 2, {}) || !Reply(pipe, 2, status, idx::RSP_IDX_STATUS)) break;
        ipc::PayloadReader reader(status.data(), status.size());
        uint32_t state = 0;
        ready = reader.GetU32(state) && state != 0;
        if (!ready) Sleep(20);
    }
    if (!ready) { CloseHandle(pipe); std::cerr << "FILENAME_NOT_READY\n"; return 1; }
    ipc::PayloadWriter writer;
    writer.PutU32(1); writer.PutU32(static_cast<uint32_t>(idx::ResultSort::Index));
    writer.PutU32(48); writer.PutU32(0); writer.PutString(needle); writer.PutString(L"");
    std::vector<uint8_t> bytes;
    const bool ok = Send(pipe, idx::REQ_IDX_SEARCH, 1, writer.data()) && Reply(pipe, 1, bytes);
    CloseHandle(pipe);
    if (!ok) return 1;
    ipc::PayloadReader reader(bytes.data(), bytes.size());
    uint32_t total = 0, hits = 0;
    if (!reader.GetU32(total) || !reader.GetU32(hits)) return 1;
    std::cout << "FILENAME_TOTAL\t" << total << '\n';
    for (uint32_t i = 0; i < hits; ++i) {
        std::wstring path, name;
        uint32_t dir = 0, low_size = 0, high_size = 0, low_time = 0, high_time = 0;
        if (!reader.GetString(path) || !reader.GetString(name) || !reader.GetU32(dir) ||
            !reader.GetU32(low_size) || !reader.GetU32(high_size) ||
            !reader.GetU32(low_time) || !reader.GetU32(high_time)) return 1;
        std::cout << "FILENAME_HIT\t" << Utf8(path) << '\n';
    }
    return 0;
}

std::set<DWORD> AgentChildren() {
    std::set<DWORD> ids;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return ids;
    PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) do {
        if (entry.th32ParentProcessID == GetCurrentProcessId() &&
            _wcsicmp(entry.szExeFile, L"spark233.Index.exe") == 0) ids.insert(entry.th32ProcessID);
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot); return ids;
}

int Content(const std::filesystem::path& files, const std::filesystem::path& profile,
            const std::wstring& needle, bool exercise_cancel) {
    if (!files.is_absolute() || !profile.is_absolute() || !std::filesystem::is_directory(files)) return 2;
    std::filesystem::create_directories(profile / L"tmp");
    SetEnvironmentVariableW(L"LOCALAPPDATA", profile.c_str());
    SetEnvironmentVariableW(L"SPARK233_SEARCH_PROFILE_ROOT", profile.c_str());
    SetEnvironmentVariableW(L"TEMP", (profile / L"tmp").c_str());
    SetEnvironmentVariableW(L"TMP", (profile / L"tmp").c_str());
    SetEnvironmentVariableW(L"SPARK233_CONTENT_TIMING_DIR", (profile / L"logs").c_str());
    SetEnvironmentVariableW(L"SPARK233_DOCUMENT_ADMISSION_DIR", (profile / L"admission").c_str());
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    idx::ContentSearchClient client;
    idx::ContentIndexConfig config;
    config.roots = {{files.wstring()}};
    client.Start(nullptr, 0, idx::ContentAgentMode::Instant);
    client.Configure(config);
    idx::ContentSearchRequest request;
    request.generation = 1001; request.session_id = 501;
    request.root = files.wstring(); request.needle = needle;
    request.indexed = request.task_scan = true;
    request.subscribe = exercise_cancel;
    client.SearchAsync(request);
    bool completed = false;
    DWORD error = ERROR_TIMEOUT;
    size_t hits = 0;
    const auto started = GetTickCount64();
    const auto deadline = started + 20000;
    while (GetTickCount64() < deadline && !completed) {
        idx::ContentSearchUpdate update;
        if (!client.TakeUpdate(update)) { Sleep(10); continue; }
        if (update.progress.generation != request.generation) continue;
        for (const auto& hit : update.hits) {
            ++hits;
            std::cout << "CONTENT_HIT\t" << Utf8(hit.path) << "\t" << hit.line << '\n';
        }
        if (update.progress.done) { error = update.progress.error; completed = true; }
    }
    std::cout << "CONTENT_DONE\t" << completed << "\terror=" << error << "\thits=" << hits
              << "\tms=" << GetTickCount64() - started << '\n';
    bool cancelled_cleanly = true;
    if (exercise_cancel && completed && !error) {
        const auto cancel_started = GetTickCount64();
        client.Cancel(request.session_id);
        idx::ContentSearchUpdate discarded;
        while (client.TakeUpdate(discarded)) {}
        request.generation = 1002;
        request.needle = L"spark233-cancel-verification-absent-2cd3533e";
        request.subscribe = false;
        client.SearchAsync(request);
        bool replacement_done = false;
        const auto cancel_deadline = GetTickCount64() + 10000;
        while (GetTickCount64() < cancel_deadline && !replacement_done) {
            idx::ContentSearchUpdate update;
            if (!client.TakeUpdate(update)) { Sleep(10); continue; }
            if (update.progress.generation != request.generation || !update.hits.empty()) cancelled_cleanly = false;
            if (update.progress.done && update.progress.generation == request.generation) {
                replacement_done = true;
                if (update.progress.error) cancelled_cleanly = false;
            }
        }
        cancelled_cleanly = cancelled_cleanly && replacement_done;
        std::cout << "CANCEL_REPLACE\t" << cancelled_cleanly << "\tms=" << GetTickCount64() - cancel_started << '\n';
    }
    const auto children = AgentChildren();
    std::cout << "AGENT_CHILDREN_ACTIVE\t" << children.size() << '\n';
    const auto stop_started = GetTickCount64();
    client.Stop();
    const auto stop_deadline = GetTickCount64() + 2000;
    while (!AgentChildren().empty() && GetTickCount64() < stop_deadline) Sleep(20);
    const bool stopped = AgentChildren().empty();
    std::cout << "AGENT_STOPPED\t" << stopped << "\tms=" << GetTickCount64() - stop_started << '\n';
    if (SUCCEEDED(initialized)) CoUninitialize();
    return completed && !error && cancelled_cleanly && stopped && !children.empty() ? 0 : 1;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc == 4 && std::wstring_view(argv[1]) == L"filename") return Filename(argv[2], argv[3], false);
    if (argc == 3 && std::wstring_view(argv[1]) == L"shutdown") return Filename(argv[2], {}, true);
    if ((argc == 5 || argc == 6) && std::wstring_view(argv[1]) == L"content")
        return Content(argv[2], argv[3], argv[4], argc == 6 && std::wstring_view(argv[5]) == L"--exercise-cancel");
    std::cerr << "usage: spark233_search_probe filename <fixture-pipe> <needle> | shutdown <fixture-pipe> | "
        "content <absolute-fixture-dir> <absolute-profile-dir> <needle> [--exercise-cancel]\n";
    return 2;
}
