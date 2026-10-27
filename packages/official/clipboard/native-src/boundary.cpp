#include "clipboard-common.h"

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc >= 7 && std::wstring_view(argv[1]) == L"fresh") return FreshSession(argc, argv);
        if (argc >= 7 && std::wstring_view(argv[1]) == L"isolate" && GetEnvironmentVariableW(L"SPARK233_CLIPBOARD_FRESH_SESSION", nullptr, 0)) {
            FILE* file = nullptr;
            const auto run = std::filesystem::path(argv[4]);
            if (_wfreopen_s(&file, (run / L"native-session.stdout.log").c_str(), L"w", stdout) ||
                _wfreopen_s(&file, (run / L"native-session.stderr.log").c_str(), L"w", stderr)) return 1;
        }
        if (argc >= 4 && std::wstring_view(argv[1]) == L"isolate") return Isolate(argc, argv);
        RequireIsolation();
        if (argc == 2 && std::wstring_view(argv[1]) == L"context") {
            const auto station = ObjectName(GetProcessWindowStation());
            std::cout << "PRIVATE_STATION\t" << std::string(station.begin(), station.end()) << '\n'; return 0;
        }
        if (argc == 3 && (std::wstring_view(argv[1]) == L"seed" || std::wstring_view(argv[1]) == L"seed-sensitive")) { Seed(argv[2], std::wstring_view(argv[1]) == L"seed-sensitive"); return 0; }
        if (argc == 3 && std::wstring_view(argv[1]) == L"snapshot") return Snapshot(argv[2]);
        if (argc == 3 && std::wstring_view(argv[1]) == L"restore") { Restore(argv[2]); return 0; }
        return 2;
    } catch (const std::exception& error) { std::cerr << error.what() << ": " << GetLastError() << '\n'; return 1; }
}
