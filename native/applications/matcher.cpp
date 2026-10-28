// The pinned Pulse matcher supplies Unicode folding and the full ib-matcher
// pinyin data/algorithm. This executable only bounds and owns one application
// name query; it never receives application targets or launches other programs.
#include <windows.h>
#include "index/filename_pinyin.h"
#include "index/index_query.h"
#include "common/json_utils.h"
#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;
namespace idx = pulse::index;
namespace json = pulse::json;

namespace {
std::wstring Wide(const std::string& text) {
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (!count && !text.empty()) throw std::runtime_error("Invalid UTF-8");
  std::wstring result(static_cast<size_t>(count), L'\0');
  if (count) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count);
  return result;
}
std::string Utf8(const std::wstring& text) {
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (!count && !text.empty()) throw std::runtime_error("Invalid UTF-16");
  std::string result(static_cast<size_t>(count), '\0');
  if (count) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count, nullptr, nullptr);
  return result;
}
std::string ReadBytes(const fs::path& file, uintmax_t limit) {
  if (!fs::is_regular_file(file) || fs::file_size(file) > limit) throw std::runtime_error("Request file is invalid or too large");
  std::ifstream stream(file, std::ios::binary);
  std::string result{std::istreambuf_iterator<char>(stream), {}};
  if (!stream.eof() && stream.fail()) throw std::runtime_error("Request read failed");
  return result;
}
std::wstring Quote(const std::wstring& value) {
  std::wstring result = L"\""; json::Escape(value, result); return result + L"\"";
}
std::vector<std::wstring> Tokens(std::wstring_view query) {
  std::wistringstream stream{std::wstring(query)};
  std::vector<std::wstring> result;
  for (std::wstring word; stream >> word;) result.push_back(idx::Fold(word));
  return result;
}
void Publish(const fs::path& directory, std::wstring text) {
  const auto temporary = directory / L"result.partial";
  const auto bytes = Utf8(text);
  { std::ofstream stream(temporary, std::ios::binary); stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size())); if (!stream) throw std::runtime_error("Result write failed"); }
  if (!MoveFileExW(temporary.c_str(), (directory / L"result.json").c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("Result publish failed");
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 5 || std::wstring_view(argv[1]) != L"--request" || std::wstring_view(argv[3]) != L"--parent-pid") return 2;
  HANDLE parent = nullptr;
  try {
    const fs::path requestFile{argv[2]};
    if (!requestFile.is_absolute()) throw std::runtime_error("Absolute host request required");
    const unsigned long parsedParent = std::stoul(argv[4]);
    if (!parsedParent || parsedParent == GetCurrentProcessId()) throw std::runtime_error("Invalid parent identity");
    parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(parsedParent));
    if (!parent) throw std::runtime_error("Parent process unavailable");
    const auto request = Wide(ReadBytes(requestFile, 8 * 1024 * 1024));
    if (!json::ValidConfigObject(request) || json::ExtractInt(request, L"protocol") != 1) throw std::runtime_error("Invalid application match request");
    const auto session = json::ExtractString(request, L"sessionId");
    const auto query = json::ExtractString(request, L"query");
    if (session.size() != 36 || !std::all_of(session.begin(), session.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || c == L'-'; }) || query.size() > 2000) throw std::runtime_error("Invalid session/query bounds");
    std::vector<std::wstring> names;
    if (!json::ConfigSyntax(request, false).StringArrayMember(L"names", names) || names.size() > 20000) throw std::runtime_error("Invalid application names");
    const auto directory = requestFile.parent_path();
    const auto cancelled = [&] {
      if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) return true;
      const auto file = directory / L"cancel.request";
      try { return fs::exists(file) && Wide(ReadBytes(file, 128)) == session; }
      catch (...) { return false; }
    };
    const auto tokens = Tokens(query);
    const ULONGLONG started = GetTickCount64();
    std::wstring matches;
    bool wasCancelled = false;
    for (size_t index = 0; index < names.size(); ++index) {
      if ((index % 256 == 0) && cancelled()) { wasCancelled = true; break; }
      if (GetTickCount64() - started > 5000) throw std::runtime_error("Application pinyin query exceeded its work budget");
      if (names[index].size() > 2048) throw std::runtime_error("Application name exceeds its bounds");
      if (!idx::HasPinyinCharacters(names[index])) continue;
      bool all = !tokens.empty(), hasPinyin = false, initials = false;
      uint32_t start = 0, length = 0;
      const auto folded = idx::Fold(names[index]);
      for (const auto& token : tokens) {
        if (folded.find(token) != std::wstring::npos) continue;
        const auto found = idx::FindPinyinMatch(folded, token);
        if (!found) { all = false; break; }
        if (!hasPinyin) { start = found.start; length = found.length; }
        hasPinyin = true;
        initials = initials || found.kind == idx::PinyinMatchKind::Initials;
      }
      if (!all || !hasPinyin) continue;
      if (!matches.empty()) matches += L",";
      matches += L"{\"index\":" + std::to_wstring(index) + L",\"kind\":" + Quote(initials ? L"initials" : L"full") + L",\"start\":" + std::to_wstring(start) + L",\"length\":" + std::to_wstring(length) + L"}";
    }
    wasCancelled = wasCancelled || cancelled();
    Publish(directory, L"{\"protocol\":1,\"sessionId\":" + Quote(session) + L",\"pid\":" + std::to_wstring(GetCurrentProcessId()) + L",\"status\":" + Quote(wasCancelled ? L"cancelled" : L"ok") + L",\"matches\":[" + (wasCancelled ? L"" : matches) + L"]}");
    CloseHandle(parent);
    return 0;
  } catch (const std::exception& error) {
    if (parent) CloseHandle(parent);
    std::cerr << error.what() << '\n';
    return 2;
  }
}
