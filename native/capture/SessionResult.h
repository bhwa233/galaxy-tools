#pragma once
#include <windows.h>
#include <shellapi.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <filesystem>
#include <string>
#include <stdexcept>
#include <fstream>
#include <atomic>
#include <thread>
#include <chrono>

// Reuse the same Windows.Data.Json serializer already used by Ling/ScreenCapture.
// The upstream CLI has no session/result transport. This adapter only writes a result
// into the host-created task directory; it never reads or changes the clipboard.
namespace Spark233Session {
using namespace winrt::Windows::Data::Json;
inline std::atomic_bool cancellationRequested{ false };
// The persistent OCR worker changes only its current task's output identity.
// The control watcher captures its immutable worker identity before tasks start.
#ifdef SPARK233_OCR_WORKER
inline thread_local std::wstring taskIdentity;
inline thread_local std::filesystem::path taskDirectory;
#endif

inline std::wstring argument(const std::wstring& name) {
#ifdef SPARK233_OCR_WORKER
    if (name == L"--spark233-session" && !taskIdentity.empty()) return taskIdentity;
#endif
    int count = 0;
    auto argv = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!argv) throw std::runtime_error("Cannot parse command line");
    const auto prefix = name + L"=";
    std::wstring result;
    for (int i = 1; i < count; ++i)
        if (std::wstring_view(argv[i]).starts_with(prefix)) result = argv[i] + prefix.size();
    LocalFree(argv);
    return result;
}

inline bool enabled() { return !argument(L"--spark233-session").empty(); }

inline std::filesystem::path directory() {
#ifdef SPARK233_OCR_WORKER
    if (!taskDirectory.empty()) return taskDirectory;
#endif
    const auto id = argument(L"--spark233-session");
    if (id.empty() || id.size() > 80 || id.find_first_not_of(L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::wstring::npos)
        throw std::runtime_error("Invalid spark233 session identity");
    const std::filesystem::path path(argument(L"--spark233-session-dir"));
    if (!path.is_absolute() || !std::filesystem::is_directory(path))
        throw std::runtime_error("Session directory must already exist and be absolute");
    return path;
}

inline JsonObject envelope(const wchar_t* kind) {
    JsonObject out;
    out.SetNamedValue(L"protocol", JsonValue::CreateNumberValue(1));
    out.SetNamedValue(L"sessionId", JsonValue::CreateStringValue(argument(L"--spark233-session")));
    out.SetNamedValue(L"kind", JsonValue::CreateStringValue(kind));
    out.SetNamedValue(L"pid", JsonValue::CreateNumberValue(GetCurrentProcessId()));
    return out;
}

inline void trace(const char* event) {
    if (!enabled()) return;
    std::ofstream file(directory() / L"native-lifecycle.log", std::ios::app);
    file << GetTickCount64() << ' ' << GetCurrentProcessId() << ' ' << event << '\n';
}

inline void publishUtf8(const wchar_t* filename, const std::string& utf8) {
    const auto finalPath = directory() / filename;
    const auto partialPath = std::filesystem::path(finalPath.wstring() + L".partial");
    auto file = CreateFileW(partialPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create session result");
    DWORD written = 0;
    const bool success = WriteFile(file, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr)
        && written == utf8.size() && FlushFileBuffers(file);
    CloseHandle(file);
    // Never replace a result from another task or a prior invocation.
    if (!success || !MoveFileExW(partialPath.c_str(), finalPath.c_str(), MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(partialPath.c_str());
        throw std::runtime_error("Cannot publish session result");
    }
}

inline void publish(const wchar_t* filename, const JsonObject& value) {
    publishUtf8(filename, winrt::to_string(value.Stringify()));
}

// A host-created request is bound to both this unique session and this actual
// process. The watcher only requests a normal message-loop exit; it never kills
// the process or touches another window. In-flight OCR completes cooperatively
// and its late result is suppressed before publication.
struct ControlGuard {
    std::jthread watcher;
    ControlGuard() {
        if (!enabled()) return;
        const auto dir = directory();
        const auto expected = winrt::to_string(argument(L"--spark233-session")) + ":" + std::to_string(GetCurrentProcessId()) + ":cancel";
        const auto threadId = GetCurrentThreadId();
        MSG message;
        PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
        watcher = std::jthread([dir, expected, threadId](std::stop_token stop) {
            while (!stop.stop_requested()) {
                std::ifstream file(dir / L"cancel.request", std::ios::binary);
                std::string request;
                if (file) std::getline(file, request);
                if (request == expected) {
                    cancellationRequested = true;
                    PostThreadMessageW(threadId, WM_QUIT, 0, 0);
                    break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(25));
            }
        });
    }
    void acknowledge() {
        if (!enabled() || !cancellationRequested) return;
        const auto id = winrt::to_string(argument(L"--spark233-session"));
        publishUtf8(L"cancel.json", "{\"protocol\":1,\"sessionId\":\"" + id + "\",\"pid\":" + std::to_string(GetCurrentProcessId()) + ",\"kind\":\"cancelled\",\"action\":\"cancel\"}");
    }
};

inline bool ocrAllowed() {
    return !enabled() || (argument(L"--spark233-ocr-enabled") != L"false" && !std::filesystem::exists(directory() / L"ocr.disabled"));
}

inline void capture(const int width, const int height) {
    if (cancellationRequested) return;
    auto out = envelope(L"capture");
    out.SetNamedValue(L"action", JsonValue::CreateStringValue(L"ocr"));
    out.SetNamedValue(L"image", JsonValue::CreateStringValue(L"selection.png"));
    out.SetNamedValue(L"width", JsonValue::CreateNumberValue(width));
    out.SetNamedValue(L"height", JsonValue::CreateNumberValue(height));
    publish(L"capture.json", out);
}

template<class Result>
inline void recognition(const Result& result, const int width, const int height) {
    if (cancellationRequested) return;
    auto out = envelope(L"ocr");
    out.SetNamedValue(L"width", JsonValue::CreateNumberValue(width));
    out.SetNamedValue(L"height", JsonValue::CreateNumberValue(height));
    out.SetNamedValue(L"detectionMs", JsonValue::CreateNumberValue(result.det_elapse_ms));
    out.SetNamedValue(L"recognitionMs", JsonValue::CreateNumberValue(result.rec_elapse_ms));
    JsonArray lines;
    std::string text;
    for (const auto& line : result.lines) {
        JsonObject item;
        item.SetNamedValue(L"text", JsonValue::CreateStringValue(winrt::to_hstring(line.text)));
        item.SetNamedValue(L"score", JsonValue::CreateNumberValue(line.score));
        JsonArray box;
        for (const auto& point : line.box) {
            JsonArray pair;
            pair.Append(JsonValue::CreateNumberValue(point.x));
            pair.Append(JsonValue::CreateNumberValue(point.y));
            box.Append(pair);
        }
        item.SetNamedValue(L"box", box);
        lines.Append(item);
        if (!text.empty()) text += '\n';
        text += line.text;
    }
    out.SetNamedValue(L"text", JsonValue::CreateStringValue(winrt::to_hstring(text)));
    out.SetNamedValue(L"lines", lines);
    publish(L"ocr.json", out);
}
}
