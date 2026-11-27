#include "ardia/win/webui/webui_updates.h"

#include <windows.h>

#include <bcrypt.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/webui/webui_mode.h"
#include "ardia/win/webui/webui_policy.h"
#include "ardia/win/webui/webui_update_policy.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/logging.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/rand_util.h"
#include "base/path_service.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/threading/scoped_blocking_call.h"
#include "base/threading/sequence_bound.h"
#include "base/time/time.h"
#include "base/values.h"
#include "base/win/scoped_handle.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/cpp/simple_url_loader_stream_consumer.h"
#include "services/network/public/mojom/fetch_api.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace ardia_win::webui {

namespace {

namespace policy = webui_update;

constexpr net::NetworkTrafficAnnotationTag kUpdateTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_windows_update_download", R"(
      semantics {
        sender: "Ardia Windows self-update"
        description:
          "Downloads Ardia's signed Windows update feed from its GitHub "
          "release: windows-update.json, its Ed25519 signature "
          "windows-update.json.sig and, when the verified feed offers a "
          "newer build for this CPU, that build's installer, so Ardia can "
          "install it when the user restarts to update."
        trigger:
          "Check for Updates, or an automatic check while automatic update "
          "checks are on, and a download the user accepted or automatic "
          "downloads allowed."
        user_data {
          type: NONE
        }
        data: "None. GETs of public release assets."
        destination: OTHER
        destination_other:
          "github.com and GitHub's release asset hosts "
          "(objects.githubusercontent.com, "
          "release-assets.githubusercontent.com)."
        last_reviewed: "2026-11-24"
      }
      policy {
        cookies_allowed: NO
        setting: "Settings > General > Updates."
        policy_exception_justification: "Not implemented."
      })");

constexpr base::TaskTraits kFileTraits = {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
                                          base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN};

std::string_view Cpu() {
#if defined(_M_ARM64)
  return "arm64";
#else
  return "x64";
#endif
}

struct Identity {
  std::string version;
  uint64_t build = 0;
};

struct Installation {
  std::optional<Identity> identity;
  std::string kind = std::string(policy::kUnsupportedKind);
  base::FilePath verifier;
  base::FilePath key;
  base::FilePath app_data;
  policy::Feed feed = policy::ReleaseFeed();
  bool test_feed = false;
  bool isolated = true;
};

std::wstring EnvironmentText(const wchar_t* name) {
  wchar_t buffer[policy::kInstanceLimit + 1] = {};
  const DWORD length = ::GetEnvironmentVariableW(name, buffer, static_cast<DWORD>(std::size(buffer)));
  if (length == 0 || length >= std::size(buffer)) {
    return std::wstring();
  }
  return std::wstring(buffer, length);
}

std::optional<std::string> TestInstanceValue(std::string_view key) {
  if (!ardiacore::TestInstance()) {
    return std::nullopt;
  }
  return policy::InstanceValue(base::WideToUTF8(EnvironmentText(L"ARDIA_INSTANCE")), key);
}

std::optional<std::wstring> DosPath(const std::wstring& final_path) {
  constexpr std::wstring_view kLongPrefix = L"\\\\?\\";
  constexpr std::wstring_view kNetworkPrefix = L"\\\\?\\UNC\\";
  std::wstring path = final_path;
  if (path.starts_with(kNetworkPrefix) || (path.starts_with(L"\\\\") && !path.starts_with(kLongPrefix))) {
    return std::nullopt;
  }
  if (path.starts_with(kLongPrefix)) {
    path.erase(0, kLongPrefix.size());
  }
  if (path.size() < 3 || path[1] != L':' || path[2] != L'\\') {
    return std::nullopt;
  }
  return path;
}

std::optional<std::wstring> FinalPathOf(HANDLE handle) {
  constexpr DWORD kFlags = VOLUME_NAME_DOS | FILE_NAME_NORMALIZED;
  const DWORD size = ::GetFinalPathNameByHandleW(handle, nullptr, 0, kFlags);
  if (size == 0) {
    return std::nullopt;
  }
  std::wstring value(size, L'\0');
  const DWORD written = ::GetFinalPathNameByHandleW(handle, value.data(), size, kFlags);
  if (written == 0 || written >= size) {
    return std::nullopt;
  }
  value.resize(written);
  if (!NormalizeWinFinalPath(value)) {
    return std::nullopt;
  }
  return DosPath(value);
}

struct FileFacts {
  uint64_t size = 0;
  DWORD links = 0;
  std::wstring final_path;
};

std::optional<FileFacts> RegularFileFacts(HANDLE handle) {
  if (::GetFileType(handle) != FILE_TYPE_DISK) {
    return std::nullopt;
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(handle, &info) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return std::nullopt;
  }
  const std::optional<std::wstring> final_path = FinalPathOf(handle);
  if (!final_path) {
    return std::nullopt;
  }
  return FileFacts{(static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow, info.nNumberOfLinks,
                   *final_path};
}

base::win::ScopedHandle OpenWithoutFollowing(const std::wstring& path, DWORD access, DWORD share) {
  return base::win::ScopedHandle(::CreateFileW(path.c_str(), access, share, nullptr, OPEN_EXISTING,
                                               FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
}

bool IsRegularFile(const base::FilePath& path) {
  base::win::ScopedHandle file = OpenWithoutFollowing(path.value(), FILE_READ_ATTRIBUTES,
                                                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  return file.is_valid() && RegularFileFacts(file.get()).has_value();
}

std::optional<std::wstring> DirectoryFinalPath(const std::wstring& path, bool follow) {
  base::win::ScopedHandle directory(::CreateFileW(
      path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | (follow ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), nullptr));
  if (!directory.is_valid()) {
    return std::nullopt;
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(directory.get(), &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (!follow && (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)) {
    return std::nullopt;
  }
  return FinalPathOf(directory.get());
}

std::optional<std::wstring> RealChildDirectory(const std::wstring& parent_final, const std::wstring& leaf) {
  const std::wstring path = parent_final + L"\\" + leaf;
  if (!::CreateDirectoryW(path.c_str(), nullptr) && ::GetLastError() != ERROR_ALREADY_EXISTS) {
    return std::nullopt;
  }
  const std::optional<std::wstring> final_path = DirectoryFinalPath(path, false);
  if (!final_path || !IsDirectChildOfWinDirectory(parent_final, *final_path)) {
    return std::nullopt;
  }
  return final_path;
}

std::optional<std::wstring> UpdatesFolder(const base::FilePath& app_data) {
  if (app_data.empty()) {
    return std::nullopt;
  }
  const std::optional<std::wstring> root = DirectoryFinalPath(app_data.value(), true);
  if (!root) {
    return std::nullopt;
  }
  return RealChildDirectory(*root, policy::kUpdatesFolder);
}

struct FileIdentity {
  DWORD volume = 0;
  DWORD high = 0;
  DWORD low = 0;
  bool operator==(const FileIdentity&) const = default;
};

std::optional<FileIdentity> IdentityOf(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(handle, &info)) {
    return std::nullopt;
  }
  return FileIdentity{info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow};
}

static_assert(policy::kHeldInstallerAccess == (FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE));
static_assert(policy::kDeleteAccess == DELETE);
static_assert(policy::kHeldInstallerShare == FILE_SHARE_READ);
static_assert(policy::HeldInstallerLetsItRun(policy::kHeldInstallerAccess, policy::kHeldInstallerShare));

bool Dispose(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  return ::SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition)) != FALSE;
}

void DisposePlainChild(const std::wstring& folder, const std::wstring& path) {
  base::win::ScopedHandle file =
      OpenWithoutFollowing(path, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_DELETE);
  if (!file.is_valid()) {
    return;
  }
  const std::optional<FileFacts> facts = RegularFileFacts(file.get());
  if (facts && facts->links == 1 && IsDirectChildOfWinDirectory(folder, facts->final_path)) {
    Dispose(file.get());
  }
}

void DisposeIfSame(const std::wstring& folder, const std::wstring& path, const FileIdentity& identity) {
  base::win::ScopedHandle file =
      OpenWithoutFollowing(path, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_DELETE);
  if (!file.is_valid()) {
    return;
  }
  const std::optional<FileFacts> facts = RegularFileFacts(file.get());
  const std::optional<FileIdentity> reopened = IdentityOf(file.get());
  if (facts && reopened && *reopened == identity && facts->links == 1 &&
      IsDirectChildOfWinDirectory(folder, facts->final_path)) {
    Dispose(file.get());
  }
}

base::win::ScopedHandle HoldDirectory(const std::wstring& path, std::wstring* final_path, DWORD extra_access = 0) {
  base::win::ScopedHandle directory(::CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE | extra_access,
                                                  FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                                                  FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!directory.is_valid()) {
    return {};
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(directory.get(), &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return {};
  }
  const std::optional<std::wstring> resolved = FinalPathOf(directory.get());
  if (!resolved) {
    return {};
  }
  *final_path = *resolved;
  return directory;
}

base::win::ScopedHandle CreateExclusive(const std::wstring& folder, const std::wstring& leaf, DWORD access,
                                        std::wstring* final_path) {
  const std::wstring path = folder + L"\\" + leaf;
  base::win::ScopedHandle file(::CreateFileW(path.c_str(), access | DELETE, 0, nullptr, CREATE_NEW,
                                             FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.is_valid()) {
    return {};
  }
  const std::optional<FileFacts> facts = RegularFileFacts(file.get());
  if (!facts || facts->links != 1 || facts->size != 0 || !IsDirectChildOfWinDirectory(folder, facts->final_path)) {
    Dispose(file.get());
    return {};
  }
  *final_path = facts->final_path;
  return file;
}

bool WriteAll(HANDLE file, const char* bytes, size_t count) {
  size_t written = 0;
  while (written < count) {
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(count - written, 64 * 1024));
    DWORD stored = 0;
    if (!::WriteFile(file, bytes + written, chunk, &stored, nullptr) || stored != chunk) {
      return false;
    }
    written += stored;
  }
  return true;
}

std::optional<std::string> ReadAll(HANDLE file, size_t limit) {
  LARGE_INTEGER start{};
  if (!::SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) {
    return std::nullopt;
  }
  std::string bytes;
  char buffer[4096];
  for (;;) {
    DWORD read = 0;
    if (!::ReadFile(file, buffer, sizeof(buffer), &read, nullptr)) {
      return std::nullopt;
    }
    if (read == 0) {
      return bytes;
    }
    if (bytes.size() + read > limit) {
      return std::nullopt;
    }
    bytes.append(buffer, read);
  }
}

base::win::ScopedHandle ReopenReadOnly(const std::wstring& path, const std::wstring& folder,
                                       const FileIdentity& identity, uint64_t size, std::wstring* final_path) {
  base::win::ScopedHandle file = OpenWithoutFollowing(path, GENERIC_READ | DELETE, FILE_SHARE_READ);
  if (!file.is_valid()) {
    return {};
  }
  const std::optional<FileFacts> facts = RegularFileFacts(file.get());
  const std::optional<FileIdentity> reopened = IdentityOf(file.get());
  if (!facts || facts->links != 1 || facts->size != size || !reopened || !(*reopened == identity) ||
      !IsDirectChildOfWinDirectory(folder, facts->final_path)) {
    return {};
  }
  *final_path = facts->final_path;
  return file;
}

class Scratch {
 public:
  explicit Scratch(const std::wstring& updates) {
    std::wstring updates_final;
    updates_ = HoldDirectory(updates, &updates_final);
    if (!updates_.is_valid() || updates_final != updates) {
      return;
    }
    static std::atomic<uint64_t> sequence{0};
    for (int attempt = 0; attempt < 8 && folder_.empty(); ++attempt) {
      const std::wstring leaf = base::UTF8ToWide(policy::ScratchName(::GetCurrentProcessId(), ++sequence));
      const std::wstring path = updates + L"\\" + leaf;
      if (!::CreateDirectoryW(path.c_str(), nullptr)) {
        if (::GetLastError() == ERROR_ALREADY_EXISTS) {
          continue;
        }
        return;
      }
      std::wstring final_path;
      base::win::ScopedHandle held = HoldDirectory(path, &final_path, DELETE);
      if (!held.is_valid() || !IsDirectChildOfWinDirectory(updates, final_path)) {
        return;
      }
      folder_handle_ = std::move(held);
      folder_ = final_path;
    }
  }
  Scratch(const Scratch&) = delete;
  Scratch& operator=(const Scratch&) = delete;
  ~Scratch() {
    for (base::win::ScopedHandle& file : held_) {
      Dispose(file.get());
    }
    held_.clear();
    if (folder_handle_.is_valid()) {
      Dispose(folder_handle_.get());
    }
  }

  bool ok() const { return !folder_.empty(); }

  std::optional<std::wstring> Write(const std::wstring& leaf, const std::string& bytes) {
    if (!ok()) {
      return std::nullopt;
    }
    std::wstring created;
    base::win::ScopedHandle file = CreateExclusive(folder_, leaf, GENERIC_WRITE | GENERIC_READ, &created);
    if (!file.is_valid()) {
      return std::nullopt;
    }
    const std::optional<FileIdentity> identity = IdentityOf(file.get());
    if (!identity || !WriteAll(file.get(), bytes.data(), bytes.size()) || !::FlushFileBuffers(file.get())) {
      Dispose(file.get());
      return std::nullopt;
    }
    file.Close();
    std::wstring final_path;
    base::win::ScopedHandle held = ReopenReadOnly(created, folder_, *identity, bytes.size(), &final_path);
    if (!held.is_valid()) {
      return std::nullopt;
    }
    if (ReadAll(held.get(), bytes.size()) != bytes) {
      Dispose(held.get());
      return std::nullopt;
    }
    held_.push_back(std::move(held));
    return final_path;
  }

 private:
  base::win::ScopedHandle updates_;
  base::win::ScopedHandle folder_handle_;
  std::wstring folder_;
  std::vector<base::win::ScopedHandle> held_;
};

struct ChildRun {
  bool exited = false;
  int exit_code = -1;
  std::string output;
};

ChildRun RunHidden(const std::wstring& application, std::wstring command, uint32_t timeout_ms) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::WILL_BLOCK);
  ChildRun run;
  SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE read_end = nullptr;
  HANDLE write_end = nullptr;
  if (!::CreatePipe(&read_end, &write_end, &inherit, 0)) {
    return run;
  }
  base::win::ScopedHandle output_read(read_end);
  base::win::ScopedHandle output_write(write_end);
  ::SetHandleInformation(output_read.get(), HANDLE_FLAG_INHERIT, 0);
  base::win::ScopedHandle null_device(::CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
                                                    FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING,
                                                    FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!null_device.is_valid()) {
    return run;
  }
  HANDLE inherited[] = {output_write.get(), null_device.get()};
  SIZE_T attribute_bytes = 0;
  ::InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<uint8_t> attribute_storage(attribute_bytes);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!::InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes)) {
    return run;
  }
  if (!::UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited),
                                   nullptr, nullptr)) {
    ::DeleteProcThreadAttributeList(attributes);
    return run;
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = null_device.get();
  startup.StartupInfo.hStdOutput = output_write.get();
  startup.StartupInfo.hStdError = null_device.get();
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  const BOOL started = ::CreateProcessW(application.c_str(), command.data(), nullptr, nullptr, TRUE,
                                        CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
                                        &startup.StartupInfo, &process);
  ::DeleteProcThreadAttributeList(attributes);
  output_write.Close();
  null_device.Close();
  if (!started) {
    return run;
  }
  base::win::ScopedHandle process_handle(process.hProcess);
  base::win::ScopedHandle thread_handle(process.hThread);
  const ULONGLONG deadline = ::GetTickCount64() + timeout_ms;
  const auto drain = [&] {
    DWORD available = 0;
    while (::PeekNamedPipe(output_read.get(), nullptr, 0, nullptr, &available, nullptr) && available > 0) {
      char buffer[1024];
      DWORD read = 0;
      if (!::ReadFile(output_read.get(), buffer, std::min<DWORD>(available, sizeof(buffer)), &read, nullptr) ||
          read == 0) {
        break;
      }
      if (run.output.size() < policy::kVerifierOutputLimit) {
        run.output.append(buffer, std::min<size_t>(read, policy::kVerifierOutputLimit - run.output.size()));
      }
    }
  };
  bool timed_out = false;
  for (;;) {
    drain();
    if (::WaitForSingleObject(process_handle.get(), 50) == WAIT_OBJECT_0) {
      drain();
      break;
    }
    if (::GetTickCount64() >= deadline) {
      timed_out = true;
      ::TerminateProcess(process_handle.get(), 1);
      ::WaitForSingleObject(process_handle.get(), 2000);
      break;
    }
  }
  DWORD exit_code = 1;
  if (!timed_out && ::GetExitCodeProcess(process_handle.get(), &exit_code)) {
    run.exited = true;
    run.exit_code = static_cast<int>(exit_code);
  }
  return run;
}

class Sha256 {
 public:
  Sha256() {
    if (::BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
      algorithm_ = nullptr;
      return;
    }
    if (::BCryptCreateHash(algorithm_, &hash_, nullptr, 0, nullptr, 0, 0) != 0) {
      hash_ = nullptr;
    }
  }
  Sha256(const Sha256&) = delete;
  Sha256& operator=(const Sha256&) = delete;
  ~Sha256() {
    if (hash_) {
      ::BCryptDestroyHash(hash_);
    }
    if (algorithm_) {
      ::BCryptCloseAlgorithmProvider(algorithm_, 0);
    }
  }

  bool Add(const uint8_t* bytes, ULONG count) {
    return hash_ && ::BCryptHashData(hash_, const_cast<PUCHAR>(bytes), count, 0) == 0;
  }

  std::string Hex() {
    uint8_t digest[32] = {};
    if (!hash_ || ::BCryptFinishHash(hash_, digest, sizeof(digest), 0) != 0) {
      return std::string();
    }
    return policy::HexLower(digest, sizeof(digest));
  }

 private:
  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
};

std::string HashOf(HANDLE file) {
  LARGE_INTEGER start{};
  if (!::SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) {
    return std::string();
  }
  Sha256 hash;
  std::vector<uint8_t> buffer(256 * 1024);
  for (;;) {
    DWORD read = 0;
    if (!::ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
      return std::string();
    }
    if (read == 0) {
      return hash.Hex();
    }
    if (!hash.Add(buffer.data(), read)) {
      return std::string();
    }
  }
}

std::optional<Identity> ReadIdentity(const base::FilePath& file) {
  if (!IsRegularFile(file)) {
    return std::nullopt;
  }
  std::string text;
  if (!base::ReadFileToStringWithMaxSize(file, &text, policy::kBuildFileLimit)) {
    return std::nullopt;
  }
  const std::optional<base::Value> value = base::JSONReader::Read(text, base::JSON_PARSE_RFC);
  if (!value || !value->is_dict()) {
    return std::nullopt;
  }
  const std::string* version = value->GetDict().FindString("version");
  const base::Value* build = value->GetDict().Find("build");
  if (!version || !policy::ValidVersion(*version) || !build) {
    return std::nullopt;
  }
  double number = 0;
  if (build->is_int()) {
    number = build->GetInt();
  } else if (build->is_double()) {
    number = build->GetDouble();
  } else {
    return std::nullopt;
  }
  if (!std::isfinite(number) || number < 1 || number > static_cast<double>(policy::kLargestBuild) ||
      std::floor(number) != number) {
    return std::nullopt;
  }
  return Identity{*version, static_cast<uint64_t>(number)};
}

std::wstring ProductionAppData() {
  std::wstring local = EnvironmentText(L"LOCALAPPDATA");
  if (local.empty()) {
    base::FilePath known;
    if (base::PathService::Get(base::DIR_LOCAL_APP_DATA, &known)) {
      local = known.value();
    }
  }
  return WebUIAppDataDirectory(std::wstring(), local);
}

Installation ReadInstallation(base::FilePath app_data) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  Installation found;
  found.app_data = std::move(app_data);
  found.isolated = policy::ScratchDataDirectory(found.app_data.value(), ProductionAppData());
  base::FilePath exe_directory;
  if (!base::PathService::Get(base::DIR_EXE, &exe_directory)) {
    return found;
  }
  found.identity = ReadIdentity(exe_directory.Append(policy::kBuildFileName));
  found.verifier = exe_directory.Append(policy::kVerifierName);
  found.key = exe_directory.Append(policy::kKeyName);
  if (const std::optional<std::string> feed = TestInstanceValue("updateFeed")) {
    if (const std::optional<policy::Feed> test = policy::TestFeed(*feed)) {
      found.feed = *test;
      found.test_feed = true;
    } else {
      LOG(WARNING) << "Ardia updates: the test instance's updateFeed is not an allowed feed address";
    }
  }
  if (const std::optional<std::string> key = TestInstanceValue("updateKey")) {
    const base::FilePath override_key(base::UTF8ToWide(*key));
    if (override_key.IsAbsolute()) {
      found.key = override_key;
    }
  }
  const policy::Installation facts{found.identity.has_value(), IsRegularFile(found.verifier),
                                   IsRegularFile(found.key),
                                   IsRegularFile(exe_directory.Append(policy::kUninstallerName))};
  found.kind = std::string(policy::InstallKind(facts));
  return found;
}

struct Verified {
  policy::VerifierAnswer answer;
  std::string manifest;
  std::string signature;
};

policy::VerifierAnswer RunVerifier(const Installation& installation,
                                   const std::wstring& updates,
                                   const std::string& manifest,
                                   const std::string& signature,
                                   uint64_t current_build,
                                   const std::wstring& package) {
  policy::VerifierAnswer refused;
  refused.reason = std::string(policy::kMissingReason);
  if (!IsRegularFile(installation.verifier) || !IsRegularFile(installation.key)) {
    return refused;
  }
  Scratch scratch(updates);
  const std::optional<std::wstring> manifest_path = scratch.Write(policy::kManifestFileName, manifest);
  const std::optional<std::wstring> signature_path = scratch.Write(policy::kSignatureFileName, signature);
  if (!manifest_path || !signature_path) {
    return refused;
  }
  const policy::VerifierPaths paths{installation.verifier.value(), installation.key.value(), *manifest_path,
                                    *signature_path, package};
  const std::optional<std::wstring> command =
      policy::VerifierCommand(paths, installation.feed.published_under, Cpu(), current_build);
  if (!command) {
    refused.reason = std::string(policy::kVerifierReason);
    return refused;
  }
  const ChildRun run = RunHidden(installation.verifier.value(), *command,
                                 package.empty() ? policy::kManifestCheckTimeoutMs : policy::kPackageCheckTimeoutMs);
  return policy::ReadVerifierAnswer(run.exited, run.exit_code, run.output, current_build,
                                    installation.feed.published_under);
}

Verified VerifyManifest(Installation installation, std::string manifest, std::string signature) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  Verified verified;
  verified.manifest = std::move(manifest);
  verified.signature = std::move(signature);
  const std::optional<std::wstring> updates = UpdatesFolder(installation.app_data);
  if (!updates || !installation.identity) {
    verified.answer.reason = std::string(policy::kMissingReason);
    return verified;
  }
  verified.answer = RunVerifier(installation, *updates, verified.manifest, verified.signature,
                                installation.identity->build, std::wstring());
  return verified;
}

struct Prepared {
  bool complete = false;
  std::string reason;
};

class InstallerSink {
 public:
  InstallerSink() = default;
  InstallerSink(const InstallerSink&) = delete;
  InstallerSink& operator=(const InstallerSink&) = delete;
  ~InstallerSink() {
    if (staging_.is_valid()) {
      Dispose(staging_.get());
    }
  }

  Prepared Prepare(base::FilePath app_data, policy::Offer offer) {
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    offer_ = std::move(offer);
    Prepared prepared;
    const std::optional<std::wstring> updates = UpdatesFolder(app_data);
    if (updates) {
      updates_ = HoldDirectory(*updates, &updates_path_);
    }
    if (!updates || !updates_.is_valid() || updates_path_ != *updates) {
      prepared.reason = std::string(policy::kDiskReason);
      return prepared;
    }
    const std::wstring target_leaf = base::UTF8ToWide(policy::InstallerFileName(offer_.sha256));
    RemoveLeftovers(target_leaf);
    const std::wstring target = updates_path_ + L"\\" + target_leaf;
    if (HoldMatchingInstaller(target, std::nullopt)) {
      prepared.complete = true;
      return prepared;
    }
    DisposePlainChild(updates_path_, target);
    const std::wstring leaf = base::UTF8ToWide(policy::StagingFileName(offer_.sha256, base::RandUint64()));
    staging_ = CreateExclusive(updates_path_, leaf, GENERIC_READ | GENERIC_WRITE | DELETE, &staging_path_);
    if (!staging_.is_valid()) {
      prepared.reason = std::string(policy::kDiskReason);
      return prepared;
    }
    hash_ = std::make_unique<Sha256>();
    return prepared;
  }

  std::string Write(std::string chunk) {
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    if (!staging_.is_valid() || !hash_) {
      return std::string(policy::kDiskReason);
    }
    if (chunk.size() > offer_.bytes - written_) {
      return std::string(policy::kTooLargeReason);
    }
    if (!WriteAll(staging_.get(), chunk.data(), chunk.size()) ||
        !hash_->Add(reinterpret_cast<const uint8_t*>(chunk.data()), static_cast<ULONG>(chunk.size()))) {
      return std::string(policy::kDiskReason);
    }
    written_ += chunk.size();
    return std::string();
  }

  std::string Seal() {
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    if (!staging_.is_valid() || !hash_) {
      return std::string(policy::kDiskReason);
    }
    if (written_ != offer_.bytes) {
      return std::string(policy::kNetworkReason);
    }
    if (hash_->Hex() != offer_.sha256) {
      return std::string(policy::kChecksumReason);
    }
    const std::optional<FileIdentity> identity = IdentityOf(staging_.get());
    if (!identity || !::FlushFileBuffers(staging_.get())) {
      return std::string(policy::kDiskReason);
    }
    const std::wstring target = updates_path_ + L"\\" + base::UTF8ToWide(policy::InstallerFileName(offer_.sha256));
    const size_t name_bytes = target.size() * sizeof(wchar_t);
    std::vector<uint8_t> buffer(sizeof(FILE_RENAME_INFO) + name_bytes + sizeof(wchar_t), 0);
    auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    rename->ReplaceIfExists = TRUE;
    rename->RootDirectory = nullptr;
    rename->FileNameLength = static_cast<DWORD>(name_bytes);
    std::memcpy(rename->FileName, target.data(), name_bytes);
    if (!::SetFileInformationByHandle(staging_.get(), FileRenameInfo, rename, static_cast<DWORD>(buffer.size()))) {
      return std::string(policy::kDiskReason);
    }
    staging_.Close();
    staging_path_.clear();
    if (!HoldMatchingInstaller(target, identity)) {
      return std::string(policy::kChecksumReason);
    }
    return std::string();
  }

  std::string Verify(Installation installation, std::string manifest, std::string signature) {
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    if (!held_.is_valid() || !installation.identity) {
      return std::string(policy::kMissingReason);
    }
    const policy::VerifierAnswer answer =
        RunVerifier(installation, updates_path_, manifest, signature, installation.identity->build, held_path_);
    if (answer.verdict == policy::Verdict::kOk && policy::SameOffer(answer.offer, offer_)) {
      return std::string();
    }
    Discard();
    return answer.reason.empty() ? std::string(policy::kChecksumReason) : answer.reason;
  }

  std::string Launch() {
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    if (!held_.is_valid()) {
      return std::string(policy::kMissingReason);
    }
    const std::optional<FileFacts> facts = RegularFileFacts(held_.get());
    if (!facts || facts->links != 1 || facts->size != offer_.bytes ||
        !IsDirectChildOfWinDirectory(updates_path_, facts->final_path) || HashOf(held_.get()) != offer_.sha256) {
      return std::string(policy::kChecksumReason);
    }
    std::optional<std::wstring> command = policy::InstallerCommand(facts->final_path);
    if (!command) {
      return std::string(policy::kInstallReason);
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!::CreateProcessW(facts->final_path.c_str(), command->data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr,
                          &startup, &process)) {
      return std::string(policy::kInstallReason);
    }
    ::CloseHandle(process.hThread);
    ::CloseHandle(process.hProcess);
    return std::string();
  }

 private:
  void RemoveLeftovers(const std::wstring& keep) {
    WIN32_FIND_DATAW found{};
    const std::wstring pattern = updates_path_ + L"\\*";
    HANDLE search = ::FindFirstFileExW(pattern.c_str(), FindExInfoBasic, &found, FindExSearchNameMatch, nullptr, 0);
    if (search == INVALID_HANDLE_VALUE) {
      return;
    }
    do {
      const std::wstring name(found.cFileName);
      if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || name == keep ||
          !policy::IsInstallerLeftover(base::WideToUTF8(name))) {
        continue;
      }
      DisposePlainChild(updates_path_, updates_path_ + L"\\" + name);
    } while (::FindNextFileW(search, &found));
    ::FindClose(search);
  }

  bool HoldMatchingInstaller(const std::wstring& path, const std::optional<FileIdentity>& expected) {
    base::win::ScopedHandle file =
        OpenWithoutFollowing(path, policy::kHeldInstallerAccess, policy::kHeldInstallerShare);
    if (!file.is_valid()) {
      return false;
    }
    const std::optional<FileFacts> facts = RegularFileFacts(file.get());
    const std::optional<FileIdentity> identity = IdentityOf(file.get());
    if (!facts || !identity || facts->links != 1 || (expected && !(*identity == *expected)) ||
        !IsDirectChildOfWinDirectory(updates_path_, facts->final_path)) {
      return false;
    }
    if (facts->size != offer_.bytes || HashOf(file.get()) != offer_.sha256) {
      file.Close();
      DisposeIfSame(updates_path_, facts->final_path, *identity);
      return false;
    }
    held_ = std::move(file);
    held_path_ = facts->final_path;
    return true;
  }

  void Discard() {
    const std::optional<FileIdentity> identity = held_.is_valid() ? IdentityOf(held_.get()) : std::nullopt;
    held_.Close();
    if (identity && !held_path_.empty()) {
      DisposeIfSame(updates_path_, held_path_, *identity);
    }
    held_path_.clear();
  }

  policy::Offer offer_;
  base::win::ScopedHandle updates_;
  std::wstring updates_path_;
  base::win::ScopedHandle staging_;
  std::wstring staging_path_;
  std::unique_ptr<Sha256> hash_;
  uint64_t written_ = 0;
  base::win::ScopedHandle held_;
  std::wstring held_path_;
};

scoped_refptr<network::SharedURLLoaderFactory> LoaderFactory() {
  if (!g_browser_process || g_browser_process->IsShuttingDown()) {
    return nullptr;
  }
  SystemNetworkContextManager* manager = g_browser_process->system_network_context_manager();
  return manager ? manager->GetSharedURLLoaderFactory() : nullptr;
}

struct Fetched {
  std::optional<std::string> body;
  int status = 0;
  bool too_large = false;
  bool refused = false;
};

class Fetch {
 public:
  using Done = base::OnceCallback<void(Fetched)>;

  Fetch(const std::string& url, bool release, Done done) : release_(release), done_(std::move(done)) {
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = GURL(url);
    request->method = "GET";
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    request->redirect_mode = network::mojom::RedirectMode::kFollow;
    request->load_flags = net::LOAD_DISABLE_CACHE | net::LOAD_BYPASS_CACHE;
    request->headers.SetHeader(net::HttpRequestHeaders::kAccept, "application/octet-stream");
    loader_ = network::SimpleURLLoader::Create(std::move(request), kUpdateTrafficAnnotation);
    loader_->SetOnRedirectCallback(base::BindRepeating(&Fetch::OnRedirect, weak_factory_.GetWeakPtr()));
  }
  Fetch(const Fetch&) = delete;
  Fetch& operator=(const Fetch&) = delete;

  void ToString(size_t limit) {
    scoped_refptr<network::SharedURLLoaderFactory> factory = LoaderFactory();
    if (!factory) {
      return Finish(Fetched{});
    }
    loader_->SetTimeoutDuration(base::Seconds(policy::kSmallFileTimeoutSeconds));
    loader_->DownloadToString(factory.get(), base::BindOnce(&Fetch::OnString, weak_factory_.GetWeakPtr()), limit);
  }

 private:
  void OnRedirect(const GURL& url_before_redirect,
                  const net::RedirectInfo& redirect_info,
                  const network::mojom::URLResponseHead& response_head,
                  std::vector<std::string>* removed_headers) {
    const GURL& target = redirect_info.new_url;
    if (policy::AllowedRedirect(target.scheme(), target.host(), target.EffectiveIntPort(), release_)) {
      return;
    }
    LOG(WARNING) << "Ardia updates: refused a redirect to " << target.host();
    loader_.reset();
    Fetched refused;
    refused.refused = true;
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&Fetch::Finish, weak_factory_.GetWeakPtr(), std::move(refused)));
  }

  Fetched Outcome() const {
    Fetched fetched;
    if (!loader_) {
      return fetched;
    }
    const network::mojom::URLResponseHead* head = loader_->ResponseInfo();
    const net::HttpResponseHeaders* headers = head ? head->headers.get() : nullptr;
    fetched.status = headers ? headers->response_code() : 0;
    fetched.too_large = loader_->NetError() == net::ERR_INSUFFICIENT_RESOURCES;
    return fetched;
  }

  void OnString(std::optional<std::string> body) {
    Fetched fetched = Outcome();
    if (fetched.status == 200 && loader_ && loader_->NetError() == net::OK) {
      fetched.body = std::move(body);
    }
    Finish(std::move(fetched));
  }

  void Finish(Fetched fetched) {
    weak_factory_.InvalidateWeakPtrs();
    loader_.reset();
    if (done_) {
      std::move(done_).Run(std::move(fetched));
    }
  }

  const bool release_;
  Done done_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::WeakPtrFactory<Fetch> weak_factory_{this};
};

class InstallerStream : public network::SimpleURLLoaderStreamConsumer {
 public:
  using WriteChunk = base::RepeatingCallback<void(std::string, base::OnceCallback<void(std::string)>)>;
  using Done = base::OnceCallback<void(std::string)>;

  InstallerStream(const std::string& url, bool release, WriteChunk write, Done done)
      : release_(release), write_(std::move(write)), done_(std::move(done)) {
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = GURL(url);
    request->method = "GET";
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    request->redirect_mode = network::mojom::RedirectMode::kFollow;
    request->load_flags = net::LOAD_DISABLE_CACHE | net::LOAD_BYPASS_CACHE;
    request->headers.SetHeader(net::HttpRequestHeaders::kAccept, "application/octet-stream");
    loader_ = network::SimpleURLLoader::Create(std::move(request), kUpdateTrafficAnnotation);
    loader_->SetTimeoutDuration(base::Seconds(policy::kInstallerTimeoutSeconds));
    loader_->SetOnRedirectCallback(base::BindRepeating(&InstallerStream::OnRedirect, weak_factory_.GetWeakPtr()));
  }
  InstallerStream(const InstallerStream&) = delete;
  InstallerStream& operator=(const InstallerStream&) = delete;
  ~InstallerStream() override = default;

  void Start() {
    scoped_refptr<network::SharedURLLoaderFactory> factory = LoaderFactory();
    if (!factory) {
      return Finish(std::string(policy::kNetworkReason));
    }
    loader_->DownloadAsStream(factory.get(), this);
  }

  void OnDataReceived(std::string_view data, base::OnceClosure resume) override {
    write_.Run(std::string(data), base::BindOnce(&InstallerStream::Written, weak_factory_.GetWeakPtr(), std::move(resume)));
  }

  void OnComplete(bool success) override {
    const bool ok = success && loader_ && loader_->NetError() == net::OK;
    Finish(ok ? std::string() : std::string(policy::kNetworkReason));
  }

  void OnRetry(base::OnceClosure start_retry) override { Finish(std::string(policy::kNetworkReason)); }

 private:
  void OnRedirect(const GURL& url_before_redirect,
                  const net::RedirectInfo& redirect_info,
                  const network::mojom::URLResponseHead& response_head,
                  std::vector<std::string>* removed_headers) {
    const GURL& target = redirect_info.new_url;
    if (policy::AllowedRedirect(target.scheme(), target.host(), target.EffectiveIntPort(), release_)) {
      return;
    }
    LOG(WARNING) << "Ardia updates: refused an installer redirect to " << target.host();
    loader_.reset();
    Finish(std::string(policy::kNetworkReason));
  }

  void Written(base::OnceClosure resume, std::string reason) {
    if (!reason.empty()) {
      loader_.reset();
      return Finish(std::move(reason));
    }
    std::move(resume).Run();
  }

  void Finish(std::string reason) {
    if (!done_) {
      return;
    }
    weak_factory_.InvalidateWeakPtrs();
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                             base::BindOnce(std::move(done_), std::move(reason)));
  }

  const bool release_;
  WriteChunk write_;
  Done done_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::WeakPtrFactory<InstallerStream> weak_factory_{this};
};

base::Value Nullable(const std::string& text) {
  return text.empty() ? base::Value() : base::Value(text);
}

base::Value CheckFailure(std::string_view reason, std::string_view message) {
  return base::Value(base::DictValue().Set("status", "failed").Set("reason", reason).Set("message", message));
}

std::string_view FetchFailure(const Fetched& fetched) {
  if (fetched.too_large) {
    return policy::kTooLargeReason;
  }
  return policy::kNetworkReason;
}

class Service {
 public:
  static Service& Get() {
    static base::NoDestructor<Service> service;
    return *service;
  }

  void InstallKind(UpdateReply done) {
    WithInstallation(base::BindOnce(
        [](UpdateReply done, const Installation& installation) {
          std::move(done).Run(true, base::Value(installation.kind));
        },
        std::move(done)));
  }

  void Status(UpdateReply done) {
    WithInstallation(base::BindOnce(&Service::AnswerStatus, weak_factory_.GetWeakPtr(), std::move(done)));
  }

  void Check(UpdateReply done) {
    WithInstallation(base::BindOnce(&Service::CheckWith, weak_factory_.GetWeakPtr(), std::move(done)));
  }

  void Update(uint64_t build, UpdateReply done) {
    WithInstallation(base::BindOnce(&Service::UpdateWith, weak_factory_.GetWeakPtr(), build, std::move(done)));
  }

  void Claim(int run, UpdateReply done) {
    if (!installation_ || !policy::ClaimOutcome(state_, run)) {
      return std::move(done).Run(true, base::Value(false));
    }
    AnswerStatus(std::move(done), *installation_);
  }

  void Restart(UpdateReply done, base::OnceClosure quit) {
    if (!installation_ || installation_->kind != policy::kInstallerKind) {
      return std::move(done).Run(true, base::Value(false));
    }
    if (ardiacore::BackgroundInstance()) {
      LOG(WARNING) << "Ardia updates: a background instance never runs the installer";
      return std::move(done).Run(true, base::Value(false));
    }
    switch (policy::BeginInstall(state_)) {
      case policy::InstallStart::kNotReady:
        return std::move(done).Run(true, base::Value(false));
      case policy::InstallStart::kInstalling:
        return std::move(done).Run(true, base::Value("busy"));
      case policy::InstallStart::kStarted:
        break;
    }
    const int run = state_.run;
    if (!installer_) {
      policy::InstallRefused(state_, run, policy::kMissingReason);
      return std::move(done).Run(true, base::Value(false));
    }
    installer_.AsyncCall(&InstallerSink::Launch)
        .Then(base::BindOnce(&Service::Launched, weak_factory_.GetWeakPtr(), run, std::move(done), std::move(quit)));
  }

 private:
  friend class base::NoDestructor<Service>;
  Service() = default;

  void WithInstallation(base::OnceCallback<void(const Installation&)> use) {
    if (installation_) {
      return std::move(use).Run(*installation_);
    }
    waiting_.push_back(std::move(use));
    if (waiting_.size() > 1) {
      return;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileTraits, base::BindOnce(&ReadInstallation, base::FilePath(AppDataDirectory())),
        base::BindOnce(&Service::InstallationRead, weak_factory_.GetWeakPtr()));
  }

  void InstallationRead(Installation installation) {
    installation_ = std::move(installation);
    std::vector<base::OnceCallback<void(const Installation&)>> waiting = std::move(waiting_);
    waiting_.clear();
    for (auto& use : waiting) {
      std::move(use).Run(*installation_);
    }
  }

  void AnswerUpdate(UpdateReply done, const Installation& installation, bool started) {
    AnswerStatus(base::BindOnce(
                     [](UpdateReply done, bool started, bool ok, base::Value status) {
                       if (status.is_dict()) {
                         status.GetDict().Set("started", started);
                       }
                       std::move(done).Run(ok, std::move(status));
                     },
                     std::move(done), started),
                 installation);
  }

  void AnswerStatus(UpdateReply done, const Installation& installation) {
    base::DictValue status;
    status.Set("phase", policy::PhaseName(state_.phase));
    status.Set("kind", installation.kind);
    status.Set("reason", Nullable(state_.reason));
    status.Set("run", state_.run);
    status.Set("version", state_.offer ? base::Value(state_.offer->version) : base::Value());
    status.Set("build", state_.offer ? base::Value(static_cast<double>(state_.offer->build)) : base::Value());
    status.Set("bytes", state_.offer ? base::Value(static_cast<double>(state_.offer->bytes)) : base::Value());
    if (installation.identity) {
      status.Set("current", base::DictValue()
                                .Set("version", installation.identity->version)
                                .Set("build", static_cast<double>(installation.identity->build)));
    } else {
      status.Set("current", base::Value());
    }
    status.Set("background", ardiacore::BackgroundInstance());
    status.Set("isolated", installation.isolated);
    status.Set("testFeed", installation.test_feed);
    std::move(done).Run(true, base::Value(std::move(status)));
  }

  void CheckWith(UpdateReply done, const Installation& installation) {
    if (installation.kind == policy::kUnsupportedKind || !installation.identity) {
      return std::move(done).Run(
          true, CheckFailure(policy::kMissingReason, "this copy of Ardia has no update verifier, key or build file"));
    }
    const std::optional<int> check = policy::BeginCheck(state_);
    if (!check) {
      return std::move(done).Run(true, base::Value(base::DictValue().Set("status", "busy")));
    }
    check_reply_ = std::move(done);
    fetch_ = std::make_unique<Fetch>(installation.feed.manifest, installation.feed.release,
                                     base::BindOnce(&Service::ManifestFetched, weak_factory_.GetWeakPtr(), *check));
    fetch_->ToString(policy::kManifestLimit);
  }

  void ManifestFetched(int check, Fetched fetched) {
    fetch_.reset();
    if (!fetched.body) {
      if (fetched.status == 404 && installation_->feed.release) {
        return FinishCheck(check, policy::Verdict::kUpToDate, policy::Offer{},
                           base::Value(base::DictValue().Set("status", "notPublished")), "");
      }
      const std::string_view reason = FetchFailure(fetched);
      return FinishCheck(check, policy::Verdict::kFailed, policy::Offer{},
                         CheckFailure(reason, reason == policy::kTooLargeReason ? "the update feed is too large"
                                                                                : "the update feed could not be fetched"),
                         reason);
    }
    pending_manifest_ = std::move(*fetched.body);
    fetch_ = std::make_unique<Fetch>(installation_->feed.signature, installation_->feed.release,
                                     base::BindOnce(&Service::SignatureFetched, weak_factory_.GetWeakPtr(), check));
    fetch_->ToString(policy::kSignatureBytes);
  }

  void SignatureFetched(int check, Fetched fetched) {
    fetch_.reset();
    if (!fetched.body || fetched.body->size() != policy::kSignatureBytes) {
      const bool signature = fetched.body || fetched.too_large || fetched.status == 404;
      const std::string_view reason = signature ? policy::kSignatureReason : policy::kNetworkReason;
      return FinishCheck(check, policy::Verdict::kFailed, policy::Offer{},
                         CheckFailure(reason, signature ? "the update signature is missing or invalid"
                                                        : "the update signature could not be fetched"),
                         reason);
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileTraits,
        base::BindOnce(&VerifyManifest, *installation_, std::move(pending_manifest_), std::move(*fetched.body)),
        base::BindOnce(&Service::ManifestVerified, weak_factory_.GetWeakPtr(), check));
    pending_manifest_.clear();
  }

  void ManifestVerified(int check, Verified verified) {
    const policy::VerifierAnswer& answer = verified.answer;
    if (answer.verdict == policy::Verdict::kOk) {
      manifest_ = std::move(verified.manifest);
      signature_ = std::move(verified.signature);
      return FinishCheck(check, answer.verdict, answer.offer,
                         base::Value(base::DictValue()
                                         .Set("status", "ok")
                                         .Set("version", answer.offer.version)
                                         .Set("build", static_cast<double>(answer.offer.build))
                                         .Set("bytes", static_cast<double>(answer.offer.bytes))),
                         "");
    }
    if (answer.verdict == policy::Verdict::kUpToDate) {
      return FinishCheck(check, answer.verdict, policy::Offer{},
                         base::Value(base::DictValue().Set("status", "upToDate")), "");
    }
    return FinishCheck(check, answer.verdict, policy::Offer{},
                       CheckFailure(answer.reason, "the update feed did not pass verification"), answer.reason);
  }

  void FinishCheck(int check, policy::Verdict verdict, const policy::Offer& offer, base::Value reply,
                   std::string_view reason) {
    policy::CheckFinished(state_, check, verdict, offer, reason);
    if (verdict != policy::Verdict::kOk) {
      manifest_.clear();
      signature_.clear();
    }
    if (check_reply_) {
      std::move(check_reply_).Run(true, std::move(reply));
    }
  }

  void UpdateWith(uint64_t build, UpdateReply done, const Installation& installation) {
    if (installation.kind != policy::kInstallerKind) {
      return AnswerUpdate(std::move(done), installation, false);
    }
    const std::optional<int> run = policy::BeginDownload(state_, build);
    if (run) {
      stream_.reset();
      installer_ = base::SequenceBound<InstallerSink>(base::ThreadPool::CreateSequencedTaskRunner(kFileTraits));
      installer_.AsyncCall(&InstallerSink::Prepare)
          .WithArgs(installation.app_data, *state_.offer)
          .Then(base::BindOnce(&Service::InstallerPrepared, weak_factory_.GetWeakPtr(), *run));
    }
    AnswerUpdate(std::move(done), installation, run.has_value());
  }

  void InstallerPrepared(int run, Prepared prepared) {
    if (state_.run != run || !state_.offer) {
      return;
    }
    if (!prepared.reason.empty()) {
      return InstallerFailed(run, prepared.reason);
    }
    if (prepared.complete) {
      return VerifyInstaller(run);
    }
    stream_ = std::make_unique<InstallerStream>(
        state_.offer->url, installation_->feed.release,
        base::BindRepeating(&Service::WriteChunk, weak_factory_.GetWeakPtr()),
        base::BindOnce(&Service::StreamFinished, weak_factory_.GetWeakPtr(), run));
    stream_->Start();
  }

  void WriteChunk(std::string chunk, base::OnceCallback<void(std::string)> written) {
    if (!installer_) {
      return std::move(written).Run(std::string(policy::kDiskReason));
    }
    installer_.AsyncCall(&InstallerSink::Write).WithArgs(std::move(chunk)).Then(std::move(written));
  }

  void StreamFinished(int run, std::string reason) {
    stream_.reset();
    if (state_.run != run) {
      return;
    }
    if (!reason.empty()) {
      return InstallerFailed(run, reason);
    }
    installer_.AsyncCall(&InstallerSink::Seal)
        .Then(base::BindOnce(&Service::Sealed, weak_factory_.GetWeakPtr(), run));
  }

  void Sealed(int run, std::string reason) {
    if (state_.run != run) {
      return;
    }
    if (!reason.empty()) {
      return InstallerFailed(run, reason);
    }
    VerifyInstaller(run);
  }

  void VerifyInstaller(int run) {
    installer_.AsyncCall(&InstallerSink::Verify)
        .WithArgs(*installation_, manifest_, signature_)
        .Then(base::BindOnce(&Service::InstallerChecked, weak_factory_.GetWeakPtr(), run));
  }

  void InstallerChecked(int run, std::string reason) {
    if (!reason.empty()) {
      return InstallerFailed(run, reason);
    }
    policy::DownloadFinished(state_, run, true, reason);
  }

  void InstallerFailed(int run, std::string_view reason) {
    if (state_.run != run) {
      return;
    }
    installer_.Reset();
    policy::DownloadFinished(state_, run, false, reason);
  }

  void Launched(int run, UpdateReply done, base::OnceClosure quit, std::string reason) {
    if (!reason.empty()) {
      LOG(WARNING) << "Ardia updates: the installer did not start: " << reason;
      installer_.Reset();
      policy::InstallRefused(state_, run, reason);
      return std::move(done).Run(true, base::Value(false));
    }
    std::move(done).Run(true, base::Value(true));
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE, std::move(quit));
  }

  std::optional<Installation> installation_;
  std::vector<base::OnceCallback<void(const Installation&)>> waiting_;
  policy::UpdateState state_;
  std::unique_ptr<Fetch> fetch_;
  std::unique_ptr<InstallerStream> stream_;
  base::SequenceBound<InstallerSink> installer_;
  UpdateReply check_reply_;
  std::string pending_manifest_;
  std::string manifest_;
  std::string signature_;
  base::WeakPtrFactory<Service> weak_factory_{this};
};

std::vector<policy::CallArgument> CallArguments(const base::Value* given, policy::ArgumentsShape* shape) {
  std::vector<policy::CallArgument> arguments;
  if (!given) {
    *shape = policy::ArgumentsShape::kOmitted;
    return arguments;
  }
  if (!given->is_list()) {
    *shape = policy::ArgumentsShape::kNotList;
    return arguments;
  }
  *shape = policy::ArgumentsShape::kList;
  for (const base::Value& value : given->GetList()) {
    policy::CallArgument argument;
    if (value.is_int()) {
      argument = {policy::ArgumentKind::kInt, static_cast<double>(value.GetInt())};
    } else if (value.is_double()) {
      argument = {policy::ArgumentKind::kDouble, value.GetDouble()};
    } else if (value.is_bool()) {
      argument.kind = policy::ArgumentKind::kBool;
    } else if (value.is_string()) {
      argument.kind = policy::ArgumentKind::kString;
    } else if (value.is_list()) {
      argument.kind = policy::ArgumentKind::kList;
    } else if (value.is_dict()) {
      argument.kind = policy::ArgumentKind::kDict;
    }
    arguments.push_back(argument);
  }
  return arguments;
}

}

bool HandlesUpdateCall(std::string_view method) {
  return policy::ParseUpdateCall(method).has_value();
}

void InvokeUpdates(std::string_view method, const base::Value* given, UpdateReply done, base::OnceClosure quit) {
  policy::ArgumentsShape shape = policy::ArgumentsShape::kOmitted;
  const std::vector<policy::CallArgument> arguments = CallArguments(given, &shape);
  const policy::CallCheck checked = policy::CheckUpdateCall(method, shape, arguments);
  if (!checked.request) {
    return std::move(done).Run(false, base::Value(checked.refusal));
  }
  switch (checked.request->call) {
    case policy::UpdateCall::kInstallKind:
      return Service::Get().InstallKind(std::move(done));
    case policy::UpdateCall::kStatus:
      return Service::Get().Status(std::move(done));
    case policy::UpdateCall::kCheck:
      return Service::Get().Check(std::move(done));
    case policy::UpdateCall::kUpdate:
      return Service::Get().Update(checked.request->build, std::move(done));
    case policy::UpdateCall::kClaimOutcome:
      return Service::Get().Claim(checked.request->run, std::move(done));
    case policy::UpdateCall::kRestart:
      return Service::Get().Restart(std::move(done), std::move(quit));
  }
}

}
