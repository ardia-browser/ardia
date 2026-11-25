#pragma once

#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "NativeModules.h"

#include "AppImage.h"
#include "AppModule.h"
#include "DocumentsModule.h"
#include "LaunchLog.h"
#include "Paths.h"

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "bcrypt.lib")

namespace Ardia {

namespace AppUpdate {

inline constexpr std::wstring_view kPublishedUnder = L"https://github.com/ardia-browser/ardia/releases/download/";
inline constexpr uint64_t kLargestManifestBytes = 64 * 1024;
inline constexpr uint64_t kSignatureBytes = 64;
inline constexpr uint64_t kLargestInstallerBytes = 1ull << 30;
inline constexpr uint64_t kLargestBuildNumber = (1ull << 53) - 1;
inline constexpr size_t kLargestBuildFileBytes = 4096;
inline constexpr size_t kLargestVerifierOutputBytes = 8192;
inline constexpr ULONGLONG kVerifierTimeoutMs = 15000;

inline std::string Cpu() noexcept {
#if defined(_M_ARM64)
  return "arm64";
#else
  return "x64";
#endif
}

inline std::filesystem::path AppFolder() noexcept {
  try {
    return std::filesystem::path(AppImage::Directory());
  } catch (...) {
    return {};
  }
}

inline bool Installed() noexcept {
  try {
    std::filesystem::path folder = AppFolder();
    if (folder.empty()) return false;
    DWORD attributes = GetFileAttributesW((folder / L"unins000.exe").c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
  } catch (...) {
    return false;
  }
}

inline std::string BuildFile() noexcept {
  try {
    std::filesystem::path folder = AppFolder();
    if (folder.empty()) return {};
    auto contents = Files::ReadAll(folder / L"Ardia.build.json");
    if (!contents || contents->size() > kLargestBuildFileBytes || !Files::IsValidUtf8(*contents)) return {};
    return *contents;
  } catch (...) {
    return {};
  }
}

inline std::wstring FeedOverride() noexcept {
  if (!AppLaunch::Shared().testInstance) return {};
  try {
    auto const &settings = AppLaunch::Shared().instance;
    auto found = settings.find("updateFeed");
    return found == settings.end() ? std::wstring{} : Paths::Wide(found->second);
  } catch (...) {
    return {};
  }
}

inline std::wstring KeyOverride() noexcept {
  if (!AppLaunch::Shared().testInstance) return {};
  try {
    auto const &settings = AppLaunch::Shared().instance;
    auto found = settings.find("updateKey");
    return found == settings.end() ? std::wstring{} : Paths::Wide(found->second);
  } catch (...) {
    return {};
  }
}

inline bool StartsWith(std::wstring_view text, std::wstring_view prefix) noexcept {
  return text.size() >= prefix.size() && text.substr(0, prefix.size()) == prefix;
}

inline std::wstring FolderOf(std::wstring_view address) {
  size_t folderEnd = address.find_last_of(L'/');
  if (folderEnd == std::wstring_view::npos || folderEnd < 8) return {};
  return std::wstring(address.substr(0, folderEnd + 1));
}

inline bool Allowed(std::wstring_view url) noexcept {
  if (url.find(L"..") != std::wstring_view::npos || url.find_first_of(L"%\\?#@ ") != std::wstring_view::npos) return false;
  if (StartsWith(url, kPublishedUnder)) return true;
  std::wstring feed = FeedOverride();
  size_t folderEnd = feed.find_last_of(L'/');
  if (folderEnd == std::wstring::npos || folderEnd < 8) return false;
  return StartsWith(url, std::wstring_view(feed).substr(0, folderEnd + 1));
}

inline std::wstring PublishedPrefix(std::wstring_view url) {
  std::wstring feed = FeedOverride();
  if (!feed.empty()) {
    std::wstring folder = FolderOf(feed);
    if (!folder.empty() && StartsWith(url, folder)) return folder;
  }
  return std::wstring(kPublishedUnder);
}

struct Connection {
  HINTERNET handle = nullptr;
  explicit Connection(HINTERNET value) noexcept : handle(value) {}
  ~Connection() noexcept {
    if (handle) WinHttpCloseHandle(handle);
  }
  Connection(Connection const &) = delete;
  Connection &operator=(Connection const &) = delete;
  explicit operator bool() const noexcept { return handle != nullptr; }
};

inline std::string Failed(const char *step) noexcept {
  try {
    return std::string{step} + " failed (" + std::to_string(GetLastError()) + ")";
  } catch (...) {
    return {};
  }
}

using Received = std::function<bool(const BYTE *, DWORD)>;

struct FetchOutcome {
  std::string failure;
  DWORD status = 0;
  bool tooLarge = false;
};

inline FetchOutcome FetchWithStatus(std::wstring const &address, uint64_t largest, Received const &received) noexcept {
  FetchOutcome outcome;
  try {
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = static_cast<DWORD>(-1);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(address.c_str(), static_cast<DWORD>(address.size()), 0, &parts)) {
      outcome.failure = "the address could not be read";
      return outcome;
    }
    std::wstring host{parts.lpszHostName, parts.dwHostNameLength};
    std::wstring path{parts.lpszUrlPath, parts.dwUrlPathLength};
    if (parts.lpszExtraInfo) path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    if (path.empty()) path = L"/";
    bool secure = parts.nScheme == INTERNET_SCHEME_HTTPS;

    Connection session{WinHttpOpen(L"Ardia", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
    if (!session) session.handle = WinHttpOpen(L"Ardia", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) {
      outcome.failure = Failed("WinHttpOpen");
      return outcome;
    }
    WinHttpSetTimeouts(session.handle, 30000, 30000, 30000, 60000);
    Connection server{WinHttpConnect(session.handle, host.c_str(), parts.nPort, 0)};
    if (!server) {
      outcome.failure = Failed("WinHttpConnect");
      return outcome;
    }
    Connection request{
        WinHttpOpenRequest(server.handle, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_REFRESH | (secure ? WINHTTP_FLAG_SECURE : 0))};
    if (!request) {
      outcome.failure = Failed("WinHttpOpenRequest");
      return outcome;
    }
    DWORD disabled = WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
    WinHttpSetOption(request.handle, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled));
    if (!WinHttpSendRequest(request.handle, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
      outcome.failure = Failed("WinHttpSendRequest");
      return outcome;
    }
    if (!WinHttpReceiveResponse(request.handle, nullptr)) {
      outcome.failure = Failed("WinHttpReceiveResponse");
      return outcome;
    }
    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    if (!WinHttpQueryHeaders(request.handle, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX)) {
      outcome.failure = "the server gave no status";
      return outcome;
    }
    outcome.status = status;
    if (status != 200) {
      outcome.failure = "the server answered " + std::to_string(status);
      return outcome;
    }
    std::vector<BYTE> buffer(64 * 1024);
    uint64_t total = 0;
    for (;;) {
      DWORD read = 0;
      if (!WinHttpReadData(request.handle, buffer.data(), static_cast<DWORD>(buffer.size()), &read)) {
        outcome.failure = Failed("WinHttpReadData");
        return outcome;
      }
      if (read == 0) return outcome;
      total += read;
      if (total > largest) {
        outcome.tooLarge = true;
        outcome.failure = "the download is larger than it should be";
        return outcome;
      }
      if (!received(buffer.data(), read)) {
        outcome.failure = "the download could not be kept";
        return outcome;
      }
    }
  } catch (...) {
    outcome.failure = "the download failed";
    return outcome;
  }
}

inline std::string Fetch(std::wstring const &address, uint64_t largest, Received const &received) noexcept {
  return FetchWithStatus(address, largest, received).failure;
}

class Sha256 {
 public:
  Sha256() noexcept {
    if (BCryptOpenAlgorithmProvider(&m_algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
      m_algorithm = nullptr;
      return;
    }
    if (BCryptCreateHash(m_algorithm, &m_hash, nullptr, 0, nullptr, 0, 0) != 0) m_hash = nullptr;
  }

  ~Sha256() noexcept {
    if (m_hash) BCryptDestroyHash(m_hash);
    if (m_algorithm) BCryptCloseAlgorithmProvider(m_algorithm, 0);
  }

  Sha256(Sha256 const &) = delete;
  Sha256 &operator=(Sha256 const &) = delete;

  bool Add(const BYTE *bytes, DWORD count) noexcept {
    return m_hash && BCryptHashData(m_hash, const_cast<PUCHAR>(bytes), count, 0) == 0;
  }

  std::string Hex() noexcept {
    BYTE digest[32]{};
    if (!m_hash || BCryptFinishHash(m_hash, digest, sizeof(digest), 0) != 0) return {};
    static constexpr char digits[] = "0123456789abcdef";
    std::string hex;
    try {
      hex.reserve(sizeof(digest) * 2);
      for (BYTE byte : digest) {
        hex.push_back(digits[byte >> 4]);
        hex.push_back(digits[byte & 0xF]);
      }
    } catch (...) {
      return {};
    }
    return hex;
  }

 private:
  BCRYPT_ALG_HANDLE m_algorithm = nullptr;
  BCRYPT_HASH_HANDLE m_hash = nullptr;
};

inline bool IsSha256(std::string_view text) noexcept {
  if (text.size() != 64) return false;
  return std::all_of(text.begin(), text.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

inline std::filesystem::path UpdatesFolder() {
  return Paths::DataDirectory() / L"Updates";
}

inline std::string HashOfOpenFile(HANDLE file) noexcept {
  try {
    Sha256 hash;
    std::vector<BYTE> buffer(256 * 1024);
    LARGE_INTEGER start{};
    if (!SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) return {};
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) return {};
      if (read == 0) return hash.Hex();
      if (!hash.Add(buffer.data(), read)) return {};
    }
  } catch (...) {
    return {};
  }
}

inline HANDLE OpenUnchanging(std::filesystem::path const &path) noexcept {
  return CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
}

inline bool IsLink(std::filesystem::path const &path) noexcept {
  DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

inline bool IsRegularLocalFile(std::filesystem::path const &path) noexcept {
  DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
}

inline std::wstring WhereItReallyIs(HANDLE file) noexcept {
  try {
    std::wstring path(1024, L'\0');
    DWORD length = GetFinalPathNameByHandleW(file, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0 || length >= path.size()) return {};
    path.resize(length);
    constexpr std::wstring_view kLongPathMark = L"\\\\?\\";
    constexpr std::wstring_view kNetworkMark = L"\\\\?\\UNC\\";
    if (StartsWith(path, kNetworkMark)) return {};
    if (StartsWith(path, kLongPathMark)) path.erase(0, kLongPathMark.size());
    return path;
  } catch (...) {
    return {};
  }
}

inline bool AlreadyHere(std::filesystem::path const &path, std::string const &sha256) noexcept {
  HANDLE file = OpenUnchanging(path);
  if (file == INVALID_HANDLE_VALUE) return false;
  bool same = HashOfOpenFile(file) == sha256;
  CloseHandle(file);
  return same;
}

inline std::string JsonEscape(std::string_view text) {
  std::string out;
  out.reserve(text.size() + 8);
  for (unsigned char ch : text) {
    if (ch == '"') out += "\\\"";
    else if (ch == '\\') out += "\\\\";
    else if (ch == '\n') out += "\\n";
    else if (ch == '\r') out += "\\r";
    else if (ch == '\t') out += "\\t";
    else if (ch < 0x20) continue;
    else out.push_back(static_cast<char>(ch));
  }
  return out;
}

inline std::string JsonFailed(std::string_view reason, std::string_view message) {
  return "{\"status\":\"failed\",\"reason\":\"" + JsonEscape(reason) + "\",\"message\":\"" + JsonEscape(message) + "\"}";
}

inline std::wstring QuoteArg(std::wstring_view arg) {
  std::wstring out;
  out.push_back(L'"');
  size_t backslashes = 0;
  for (wchar_t ch : arg) {
    if (ch == L'\\') {
      backslashes += 1;
    } else if (ch == L'"') {
      out.append(backslashes * 2 + 1, L'\\');
      out.push_back(L'"');
      backslashes = 0;
    } else {
      out.append(backslashes, L'\\');
      backslashes = 0;
      out.push_back(ch);
    }
  }
  out.append(backslashes * 2, L'\\');
  out.push_back(L'"');
  return out;
}

inline bool WriteExactFile(std::filesystem::path const &path, std::string const &bytes) noexcept {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD total = 0;
  bool ok = true;
  while (total < bytes.size()) {
    DWORD written = 0;
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(bytes.size() - total, 64 * 1024));
    if (!WriteFile(file, bytes.data() + total, chunk, &written, nullptr) || written != chunk) {
      ok = false;
      break;
    }
    total += written;
  }
  if (ok) ok = FlushFileBuffers(file) != FALSE;
  CloseHandle(file);
  return ok;
}

inline std::string LastLine(std::string_view output) {
  while (!output.empty() && (output.back() == '\n' || output.back() == '\r')) output.remove_suffix(1);
  size_t newline = output.find_last_of('\n');
  std::string_view tail = newline == std::string_view::npos ? output : output.substr(newline + 1);
  if (!tail.empty() && tail.back() == '\r') tail.remove_suffix(1);
  return std::string(tail);
}

inline bool ParseUnsigned(std::string_view text, uint64_t &out) noexcept {
  if (text.empty() || text[0] < '1' || text[0] > '9') return false;
  uint64_t value = 0;
  for (char ch : text) {
    if (ch < '0' || ch > '9') return false;
    uint64_t digit = static_cast<uint64_t>(ch - '0');
    if (value > (UINT64_MAX - digit) / 10) return false;
    value = value * 10 + digit;
  }
  out = value;
  return true;
}

inline std::string RunVerifier(
    std::filesystem::path const &verifier,
    std::filesystem::path const &keyPath,
    std::filesystem::path const &manifestPath,
    std::filesystem::path const &signaturePath,
    std::wstring const &publishedUnder,
    uint64_t currentBuild) noexcept {
  try {
    SECURITY_ATTRIBUTES inherit{};
    inherit.nLength = sizeof(inherit);
    inherit.bInheritHandle = TRUE;
    HANDLE readPipe = nullptr;
    HANDLE writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &inherit, 0)) return JsonFailed("verifier", "the update verifier could not start");
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);

    std::wstring command = QuoteArg(verifier.wstring()) + L" windows-manifest --key " + QuoteArg(keyPath.wstring()) + L" --manifest " + QuoteArg(manifestPath.wstring()) + L" --signature " + QuoteArg(signaturePath.wstring()) + L" --published-under " + QuoteArg(publishedUnder) + L" --cpu " + QuoteArg(Paths::Wide(Cpu())) + L" --current-build " + std::to_wstring(currentBuild);

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = nul != INVALID_HANDLE_VALUE ? nul : nullptr;
    startup.hStdOutput = writePipe;
    startup.hStdError = nul != INVALID_HANDLE_VALUE ? nul : nullptr;
    PROCESS_INFORMATION process{};
    BOOL started = CreateProcessW(verifier.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    CloseHandle(writePipe);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!started) {
      CloseHandle(readPipe);
      return JsonFailed("verifier", "the update verifier could not start");
    }

    std::string output;
    bool timedOut = false;
    ULONGLONG deadline = GetTickCount64() + kVerifierTimeoutMs;
    auto drain = [&]() {
      DWORD available = 0;
      while (PeekNamedPipe(readPipe, nullptr, 0, nullptr, &available, nullptr) && available > 0) {
        char buffer[1024];
        DWORD wanted = static_cast<DWORD>(std::min<DWORD>(available, sizeof(buffer)));
        DWORD read = 0;
        if (!ReadFile(readPipe, buffer, wanted, &read, nullptr) || read == 0) break;
        if (output.size() < kLargestVerifierOutputBytes) {
          size_t keep = std::min<size_t>(read, kLargestVerifierOutputBytes - output.size());
          output.append(buffer, keep);
        }
      }
    };
    for (;;) {
      drain();
      DWORD wait = WaitForSingleObject(process.hProcess, 50);
      if (wait == WAIT_OBJECT_0) {
        drain();
        break;
      }
      if (GetTickCount64() >= deadline) {
        timedOut = true;
        TerminateProcess(process.hProcess, 1);
        WaitForSingleObject(process.hProcess, 2000);
        break;
      }
    }
    DWORD exitCode = 1;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(readPipe);

    if (timedOut) return JsonFailed("verifier", "the update verifier timed out");
    std::string line = LastLine(output);
    if (exitCode == 0 && line.rfind("ok ", 0) == 0) {
      std::istringstream tokens(line.substr(3));
      std::string version, buildStr, url, sha256, bytesStr, extra;
      uint64_t build = 0;
      uint64_t bytes = 0;
      if ((tokens >> version >> buildStr >> url >> sha256 >> bytesStr) && !(tokens >> extra) && ParseUnsigned(buildStr, build) && build > currentBuild && build <= kLargestBuildNumber && ParseUnsigned(bytesStr, bytes) && bytes >= 1 && bytes <= kLargestInstallerBytes && IsSha256(sha256) && Allowed(Paths::Wide(url))) {
        return "{\"status\":\"ok\",\"version\":\"" + JsonEscape(version) + "\",\"build\":" + std::to_string(build) + ",\"url\":\"" + JsonEscape(url) + "\",\"sha256\":\"" + sha256 + "\",\"bytes\":" + std::to_string(bytes) + "}";
      }
      return JsonFailed("verifier", "the update verifier returned an unreadable answer");
    }
    if (line.rfind("failed ", 0) == 0) {
      std::string reason = line.substr(7);
      if (reason == "notNewer" || reason == "kind") return "{\"status\":\"upToDate\"}";
      if (reason == "signature") return JsonFailed("signature", "the update signature could not be verified");
      if (reason == "manifest") return JsonFailed("manifest", "the update feed could not be read");
      if (reason == "missing") return JsonFailed("missing", "the update verifier could not read the files");
      return JsonFailed("verifier", "the update verifier refused the feed");
    }
    return JsonFailed("verifier", "the update verifier failed");
  } catch (...) {
    return JsonFailed("verifier", "the update verifier failed");
  }
}

inline std::string VerifyUpdate(std::wstring const &feedUrl, uint64_t currentBuild) noexcept {
  try {
    std::wstring sigUrl = feedUrl + L".sig";
    if (!Allowed(feedUrl) || !Allowed(sigUrl)) return JsonFailed("manifest", "Updates do not come from that address");
    std::filesystem::path folder = AppFolder();
    std::filesystem::path verifier = folder / L"ardia-update-verify.exe";
    std::wstring keyOverride = KeyOverride();
    std::filesystem::path keyPath = keyOverride.empty() ? (folder / L"windows-update.pem") : std::filesystem::path(keyOverride);
    if (!IsRegularLocalFile(verifier) || !IsRegularLocalFile(keyPath)) return JsonFailed("missing", "the update verifier or key is missing");

    std::string manifestBytes;
    FetchOutcome manifestFetch = FetchWithStatus(feedUrl, kLargestManifestBytes, [&manifestBytes](const BYTE *data, DWORD count) {
      manifestBytes.append(reinterpret_cast<const char *>(data), count);
      return true;
    });
    if (!manifestFetch.failure.empty()) {
      if (manifestFetch.status == 404) return "{\"status\":\"notPublished\"}";
      if (manifestFetch.tooLarge) return JsonFailed("tooLarge", "the update feed is too large");
      return JsonFailed("network", manifestFetch.failure);
    }

    std::string signatureBytes;
    FetchOutcome sigFetch = FetchWithStatus(sigUrl, kSignatureBytes, [&signatureBytes](const BYTE *data, DWORD count) {
      signatureBytes.append(reinterpret_cast<const char *>(data), count);
      return true;
    });
    if (!sigFetch.failure.empty()) {
      if (sigFetch.status == 404 || sigFetch.tooLarge) return JsonFailed("signature", "the update signature is missing or invalid");
      return JsonFailed("network", sigFetch.failure);
    }
    if (signatureBytes.size() != kSignatureBytes) return JsonFailed("signature", "the update signature is invalid");

    std::filesystem::path updatesDir = UpdatesFolder();
    std::error_code ignored;
    std::filesystem::create_directories(updatesDir, ignored);
    if (IsLink(updatesDir)) return JsonFailed("missing", "the updates folder is a link");

    static std::atomic<uint64_t> nextScratch{1};
    std::filesystem::path scratch;
    bool created = false;
    for (int attempt = 0; attempt < 8; ++attempt) {
      std::filesystem::path candidate = updatesDir / (L"verify-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(nextScratch.fetch_add(1)));
      if (CreateDirectoryW(candidate.c_str(), nullptr)) {
        scratch = std::move(candidate);
        created = true;
        break;
      }
      if (GetLastError() != ERROR_ALREADY_EXISTS) break;
    }
    if (!created) return JsonFailed("missing", "the update check could not stage its files");
    struct ScratchGuard {
      std::filesystem::path dir;
      ~ScratchGuard() noexcept {
        if (dir.empty()) return;
        std::error_code ec;
        std::filesystem::remove_all(dir, ec);
      }
    } guard{scratch};
    if (IsLink(scratch)) {
      guard.dir.clear();
      return JsonFailed("missing", "the update check could not stage its files");
    }
    std::filesystem::path manifestFile = scratch / L"windows-update.json";
    std::filesystem::path sigFile = scratch / L"windows-update.json.sig";
    if (!WriteExactFile(manifestFile, manifestBytes) || !WriteExactFile(sigFile, signatureBytes)) return JsonFailed("missing", "the update check could not save its files");
    return RunVerifier(verifier, keyPath, manifestFile, sigFile, PublishedPrefix(feedUrl), currentBuild);
  } catch (...) {
    return JsonFailed("other", "the update check failed");
  }
}

struct Downloaded {
  std::string path;
  std::string failure;
};

inline Downloaded Download(std::wstring const &address, std::string const &sha256, uint64_t bytes) noexcept {
  Downloaded result;
  try {
    std::filesystem::path folder = UpdatesFolder();
    std::error_code ignored;
    std::filesystem::create_directories(folder, ignored);
    if (IsLink(folder)) {
      result.failure = "the updates folder is a link";
      return result;
    }
    std::filesystem::path target = folder / (L"Ardia-Setup-" + Paths::Wide(sha256.substr(0, 16)) + L".exe");
    if (AlreadyHere(target, sha256)) {
      result.path = Paths::Utf8(target.wstring());
      return result;
    }
    for (auto const &entry : std::filesystem::directory_iterator(folder, ignored)) {
      if (entry.is_directory()) continue;
      std::error_code unremoved;
      std::filesystem::remove(entry.path(), unremoved);
    }
    std::filesystem::path partial = target;
    partial += L".part";
    HANDLE file = CreateFileW(partial.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
      result.failure = Failed("creating the download");
      return result;
    }
    Sha256 hash;
    uint64_t written = 0;
    std::string failure = Fetch(address, bytes, [&](const BYTE *data, DWORD count) {
      DWORD stored = 0;
      if (!WriteFile(file, data, count, &stored, nullptr) || stored != count) return false;
      written += count;
      return hash.Add(data, count);
    });
    bool flushed = FlushFileBuffers(file) != FALSE;
    CloseHandle(file);
    if (failure.empty() && !flushed) failure = "the download could not be saved";
    if (failure.empty() && written != bytes) failure = "the download is " + std::to_string(written) + " bytes, not " + std::to_string(bytes);
    if (failure.empty() && hash.Hex() != sha256) failure = "the download is not the published file";
    if (failure.empty() && !MoveFileExW(partial.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING)) failure = Failed("keeping the download");
    if (!failure.empty()) {
      DeleteFileW(partial.c_str());
      result.failure = failure;
      return result;
    }
    result.path = Paths::Utf8(target.wstring());
    return result;
  } catch (...) {
    result.failure = "the download failed";
    return result;
  }
}

inline std::string RunInstaller(std::string const &chosen, std::string const &sha256) noexcept {
  try {
    std::filesystem::path path{Paths::Wide(chosen)};
    std::error_code compared;
    if (!std::filesystem::equivalent(path.parent_path(), UpdatesFolder(), compared) || compared) return "the installer is not in the updates folder";
    if (IsLink(UpdatesFolder()) || IsLink(path)) return "the installer is behind a link";
    HANDLE file = OpenUnchanging(path);
    if (file == INVALID_HANDLE_VALUE) return Failed("opening the installer");
    std::string failure;
    if (HashOfOpenFile(file) != sha256) failure = "the installer is not the published file";
    std::wstring real = WhereItReallyIs(file);
    if (failure.empty() && real.empty()) failure = "the installer's place could not be read";
    if (failure.empty()) {
      path = std::filesystem::path(real);
      std::wstring command = L"\"" + path.wstring() + L"\" /SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS /relaunch=1";
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      PROCESS_INFORMATION process{};
      if (CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process)) {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
      } else {
        failure = Failed("starting the installer");
      }
    }
    CloseHandle(file);
    return failure;
  } catch (...) {
    return "the installer could not be started";
  }
}

}

REACT_MODULE(UpdateModule, L"ArdiaWindowsUpdate")
struct UpdateModule {
  REACT_CONSTANT(cpu)
  const std::string cpu = AppUpdate::Cpu();

  REACT_CONSTANT(installed)
  const bool installed = AppUpdate::Installed();

  REACT_CONSTANT(buildFile)
  const std::string buildFile = AppUpdate::BuildFile();

  REACT_CONSTANT(feedOverride)
  const std::string feedOverride = Paths::Utf8(AppUpdate::FeedOverride());

  REACT_METHOD(fetchText)
  void fetchText(std::string url, winrt::Microsoft::ReactNative::ReactPromise<std::string> promise) noexcept {
    std::wstring address = Paths::Wide(url);
    if (!AppUpdate::Allowed(address)) return promise.Reject("Updates do not come from that address");
    OnAThread(promise, [address, promise]() noexcept {
      std::string text;
      std::string failure;
      try {
        failure = AppUpdate::Fetch(address, AppUpdate::kLargestManifestBytes, [&text](const BYTE *data, DWORD count) {
          text.append(reinterpret_cast<const char *>(data), count);
          return true;
        });
      } catch (...) {
        failure = "the download failed";
      }
      if (failure.empty() && !Files::IsValidUtf8(text)) failure = "the answer is not text";
      if (!failure.empty()) return promise.Reject(failure.c_str());
      promise.Resolve(text);
    });
  }

  REACT_METHOD(fetchVerifiedManifest)
  void fetchVerifiedManifest(std::string url, double currentBuild, winrt::Microsoft::ReactNative::ReactPromise<std::string> promise) noexcept {
    std::wstring address = Paths::Wide(url);
    if (!AppUpdate::Allowed(address)) return promise.Reject("Updates do not come from that address");
    if (!std::isfinite(currentBuild) || currentBuild < 0 || currentBuild > static_cast<double>(AppUpdate::kLargestBuildNumber) || std::floor(currentBuild) != currentBuild) {
      return promise.Reject("The build number is not valid");
    }
    uint64_t build = static_cast<uint64_t>(currentBuild);
    OnAThread(promise, [address, build, promise]() noexcept {
      promise.Resolve(AppUpdate::VerifyUpdate(address, build));
    });
  }

  REACT_METHOD(download)
  void download(std::string url, std::string sha256, double bytes, winrt::Microsoft::ReactNative::ReactPromise<std::string> promise) noexcept {
    std::wstring address = Paths::Wide(url);
    if (!AppUpdate::Allowed(address)) return promise.Reject("Updates do not come from that address");
    if (!AppUpdate::IsSha256(sha256)) return promise.Reject("The update has no usable SHA-256");
    if (!(bytes >= 1) || bytes > static_cast<double>(AppUpdate::kLargestInstallerBytes)) return promise.Reject("The update has no usable size");
    uint64_t size = static_cast<uint64_t>(bytes);
    OnAThread(promise, [address, sha256, size, promise]() noexcept {
      AppUpdate::Downloaded downloaded = AppUpdate::Download(address, sha256, size);
      if (!downloaded.failure.empty()) return promise.Reject(downloaded.failure.c_str());
      promise.Resolve(downloaded.path);
    });
  }

  REACT_METHOD(install)
  void install(std::string path, std::string sha256, winrt::Microsoft::ReactNative::ReactPromise<bool> promise) noexcept {
    if (!AppUpdate::IsSha256(sha256)) return promise.Reject("The update has no usable SHA-256");
    if (AppLaunch::Background()) {
      AppLaunch::Note(L"ArdiaWindowsUpdate: background instance, not running the installer");
      return promise.Resolve(false);
    }
    OnAThread(promise, [path, sha256, promise]() noexcept {
      std::string failure = AppUpdate::RunInstaller(path, sha256);
      if (!failure.empty()) return promise.Reject(failure.c_str());
      promise.Resolve(true);
    });
  }

 private:
  template <class TPromise, class TWork>
  static void OnAThread(TPromise const &promise, TWork &&work) noexcept {
    try {
      std::thread(std::forward<TWork>(work)).detach();
    } catch (...) {
      promise.Reject("The update could not start");
    }
  }
};

}
