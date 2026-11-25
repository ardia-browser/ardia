#include "ardia/win/webui/webui_storage.h"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/desktop/ac_desktop_policy.h"
#include "ardia/linux/ac_linux_session.h"
#include "ardia/linux/host_bootstrap.h"
#include "ardia/linux/ac_linux_documents.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/main.h"
#include "ardia/win/webui/webui_window_policy.h"
#include "ardia/win/webui/webui_caption_script.h"
#include "ardia/win/webui/webui_policy.h"
#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "url/gurl.h"

namespace ardia_win::webui {

base::FilePath AssetDirectory() {
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  if (command->HasSwitch("ardia-ui-dir")) {
    return command->GetSwitchValuePath("ardia-ui-dir");
  }
  base::FilePath directory;
  base::PathService::Get(base::DIR_EXE, &directory);
  return directory.AppendASCII("ardia-ui");
}

std::string AssetPath(const GURL& url) {
  const std::string path(url.path());
  return path == "/" || path.empty() ? "index.html" : path.substr(1);
}

std::string MimeType(std::string_view path) {
  const size_t dot = path.rfind('.');
  const std::string_view ext =
      dot == std::string_view::npos ? std::string_view() : path.substr(dot);
  if (ext == ".html") return "text/html";
  if (ext == ".js" || ext == ".mjs") return "application/javascript";
  if (ext == ".css") return "text/css";
  if (ext == ".json") return "application/json";
  if (ext == ".svg") return "image/svg+xml";
  if (ext == ".png") return "image/png";
  if (ext == ".ico") return "image/x-icon";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".webp") return "image/webp";
  if (ext == ".gif") return "image/gif";
  if (ext == ".avif") return "image/avif";
  if (ext == ".woff") return "font/woff";
  if (ext == ".woff2") return "font/woff2";
  if (ext == ".ttf") return "font/ttf";
  if (ext == ".wav") return "audio/wav";
  return std::string();
}

base::FilePath SessionDirectory() {
  return base::FilePath(AppDataDirectory());
}

std::optional<base::DictValue> ReadSession(const base::FilePath& directory) {
  std::string text;
  if (!base::ReadFileToStringWithMaxSize(directory.AppendASCII(kSessionName),
                                         &text,
                                         ardia::kLinuxSessionMaxBytes)) {
    return std::nullopt;
  }
  std::optional<base::Value> value = base::JSONReader::Read(
      text, base::JSON_PARSE_RFC, ardia::kLinuxSessionMaxDepth);
  if (!value || !value->is_dict()) {
    return std::nullopt;
  }
  return ardia::MergeLinuxSession(base::DictValue(), base::DictValue(),
                                      value->GetDict());
}

SessionWrite::SessionWrite() = default;
SessionWrite::SessionWrite(SessionWrite&&) = default;
SessionWrite& SessionWrite::operator=(SessionWrite&&) = default;
SessionWrite::~SessionWrite() = default;

SessionWrite WriteSessionTracked(const base::FilePath& directory,
                                 base::DictValue base,
                                 base::DictValue local) {
  SessionWrite result;
  std::optional<base::DictValue> previous = ReadSession(directory);
  if (previous) {
    result.previous = previous->Clone();
  }
  result.session = WriteSession(directory, std::move(base), std::move(local));
  return result;
}

std::optional<base::DictValue> WriteSession(const base::FilePath& directory,
                                            base::DictValue base,
                                            base::DictValue local) {
  const std::optional<base::DictValue> previous = ReadSession(directory);
  const base::DictValue empty;
  std::optional<base::DictValue> merged =
      ardia::MergeLinuxSession(base, local, previous ? *previous : empty);
  if (!merged) {
    return std::nullopt;
  }
  const std::optional<std::string> json = base::WriteJsonWithOptions(
      *merged, base::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION,
      ardia::kLinuxSessionMaxDepth);
  if (!json || json->size() > ardia::kLinuxSessionMaxBytes ||
      !base::CreateDirectory(directory) ||
      !base::ImportantFileWriter::WriteFileAtomically(
          directory.AppendASCII(kSessionName), *json)) {
    return std::nullopt;
  }
  return std::move(*merged);
}

class ScopedHandle {
 public:
  ScopedHandle() = default;
  explicit ScopedHandle(HANDLE handle) : handle_(handle) {}
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept
      : handle_(std::exchange(other.handle_, INVALID_HANDLE_VALUE)) {}
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) {
      Reset();
      handle_ = std::exchange(other.handle_, INVALID_HANDLE_VALUE);
    }
    return *this;
  }
  ~ScopedHandle() { Reset(); }

  bool valid() const {
    return handle_ != INVALID_HANDLE_VALUE && handle_ != nullptr;
  }
  HANDLE get() const { return handle_; }

  void Reset() {
    if (valid()) {
      ::CloseHandle(handle_);
    }
    handle_ = INVALID_HANDLE_VALUE;
  }

 private:
  HANDLE handle_ = INVALID_HANDLE_VALUE;
};

std::optional<std::wstring> HandleFinalPath(HANDLE handle) {
  constexpr DWORD kFlags = VOLUME_NAME_DOS | FILE_NAME_NORMALIZED;
  const DWORD size = ::GetFinalPathNameByHandleW(handle, nullptr, 0, kFlags);
  if (size == 0) {
    return std::nullopt;
  }
  std::wstring value(size, L'\0');
  const DWORD written =
      ::GetFinalPathNameByHandleW(handle, value.data(), size, kFlags);
  if (written == 0 || written >= size) {
    return std::nullopt;
  }
  value.resize(written);
  return value;
}

struct NtIoStatusBlock {
  union {
    LONG status;
    void* pointer;
  };
  ULONG_PTR information;
};

struct NtFileRenameInfo {
  ULONG flags;
  HANDLE root_directory;
  ULONG file_name_length;
  wchar_t file_name[1];
};

static_assert(offsetof(NtFileRenameInfo, root_directory) == sizeof(void*));
static_assert(offsetof(NtFileRenameInfo, file_name) ==
              sizeof(void*) * 2 + sizeof(ULONG));

using NtSetInformationFileFn = LONG(NTAPI*)(HANDLE file_handle,
                                            NtIoStatusBlock* io_status_block,
                                            void* file_information,
                                            ULONG length,
                                            ULONG file_information_class);

NtSetInformationFileFn ResolveNtSetInformationFile() {
  static NtSetInformationFileFn fn = []() -> NtSetInformationFileFn {
    HMODULE ntdll = ::GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) {
      return nullptr;
    }
    return reinterpret_cast<NtSetInformationFileFn>(
        ::GetProcAddress(ntdll, "NtSetInformationFile"));
  }();
  return fn;
}

bool DisposeOpenHandle(HANDLE file_handle) {
  constexpr ULONG kFileDispositionInformationEx = 64;
  constexpr ULONG kFileDispositionDelete = 0x00000001u;
  constexpr ULONG kFileDispositionPosixSemantics = 0x00000002u;
  if (NtSetInformationFileFn set_info = ResolveNtSetInformationFile()) {
    ULONG flags = kFileDispositionDelete | kFileDispositionPosixSemantics;
    NtIoStatusBlock status_block{};
    if (set_info(file_handle, &status_block, &flags, sizeof(flags),
                 kFileDispositionInformationEx) >= 0) {
      return true;
    }
  }
  FILE_DISPOSITION_INFO dispose{};
  dispose.DeleteFile = TRUE;
  return ::SetFileInformationByHandle(file_handle, FileDispositionInfo,
                                      &dispose, sizeof(dispose)) != FALSE;
}

bool RenameHandleIntoDirectory(HANDLE dir_handle,
                               HANDLE file_handle,
                               const std::wstring& leaf_name) {
  if (!ValidWinRenameLeafName(leaf_name)) {
    return false;
  }
  NtSetInformationFileFn set_info = ResolveNtSetInformationFile();
  if (!set_info) {
    return false;
  }
  constexpr ULONG kFileRenameInformation = 10;
  constexpr ULONG kFileRenameInformationEx = 65;
  constexpr ULONG kFileRenameReplaceIfExists = 0x00000001u;
  constexpr ULONG kFileRenamePosixSemantics = 0x00000002u;
  const size_t header = offsetof(NtFileRenameInfo, file_name);
  const size_t name_bytes = leaf_name.size() * sizeof(wchar_t);
  const size_t buffer_bytes = WinFileRenameInfoBufferBytes(
      header, sizeof(NtFileRenameInfo), leaf_name.size());
  auto attempt = [&](ULONG flags, ULONG info_class) {
    std::vector<uint64_t> storage((buffer_bytes + sizeof(wchar_t) + 7) / 8, 0);
    auto* info = reinterpret_cast<NtFileRenameInfo*>(storage.data());
    info->flags = flags;
    info->root_directory = dir_handle;
    info->file_name_length = static_cast<ULONG>(name_bytes);
    std::memcpy(reinterpret_cast<unsigned char*>(storage.data()) + header,
                leaf_name.data(), name_bytes);
    NtIoStatusBlock status_block{};
    return set_info(file_handle, &status_block, storage.data(),
                    static_cast<ULONG>(buffer_bytes), info_class) >= 0;
  };
  if (attempt(kFileRenameReplaceIfExists | kFileRenamePosixSemantics,
              kFileRenameInformationEx)) {
    return true;
  }
  return attempt(kFileRenameReplaceIfExists, kFileRenameInformation);
}

ScopedHandle OpenDirectoryHandle(const base::FilePath& directory,
                                 DWORD access,
                                 bool allow_reparse,
                                 std::wstring* final_path,
                                 bool* missing = nullptr) {
  if (missing) {
    *missing = false;
  }
  if (directory.empty()) {
    return {};
  }
  const DWORD flags =
      FILE_FLAG_BACKUP_SEMANTICS |
      (allow_reparse ? 0 : FILE_FLAG_OPEN_REPARSE_POINT);
  ScopedHandle handle(::CreateFileW(
      directory.value().c_str(), access,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, flags, nullptr));
  if (!handle.valid()) {
    const DWORD error = ::GetLastError();
    if (missing &&
        (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) {
      *missing = true;
    }
    return {};
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(handle.get(), &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (!allow_reparse &&
       (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)) {
    return {};
  }
  const std::optional<std::wstring> resolved = HandleFinalPath(handle.get());
  if (!resolved || !NormalizeWinFinalPath(*resolved)) {
    return {};
  }
  if (final_path) {
    *final_path = *resolved;
  }
  return handle;
}

std::optional<std::wstring> OpenDirectoryFinalPath(
    const base::FilePath& directory,
    bool allow_reparse,
    bool* missing = nullptr) {
  std::wstring final_path;
  ScopedHandle handle = OpenDirectoryHandle(
      directory, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      allow_reparse, &final_path, missing);
  if (!handle.valid()) {
    return std::nullopt;
  }
  return final_path;
}

std::optional<std::string> ReadHandleBytes(HANDLE handle, size_t limit) {
  if (::GetFileType(handle) != FILE_TYPE_DISK) {
    return std::nullopt;
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(handle, &info) ||
      (info.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      info.nNumberOfLinks != 1) {
    return std::nullopt;
  }
  const uint64_t size =
      (static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
  if (size > limit) {
    return std::nullopt;
  }
  std::string contents;
  contents.reserve(static_cast<size_t>(size));
  char buffer[65536];
  for (;;) {
    DWORD read = 0;
    if (!::ReadFile(handle, buffer, sizeof(buffer), &read, nullptr)) {
      return std::nullopt;
    }
    if (read == 0) {
      break;
    }
    if (contents.size() + read > limit) {
      return std::nullopt;
    }
    contents.append(buffer, read);
  }
  return contents;
}

bool WriteAllToHandle(HANDLE handle, std::string_view contents) {
  size_t offset = 0;
  while (offset < contents.size()) {
    const DWORD chunk = static_cast<DWORD>(
        std::min<size_t>(contents.size() - offset, 1024 * 1024));
    DWORD written = 0;
    if (!::WriteFile(handle, contents.data() + offset, chunk, &written,
                     nullptr) ||
        written == 0) {
      return false;
    }
    offset += written;
  }
  return ::FlushFileBuffers(handle) != FALSE;
}


StoredDocument ReadDocumentFile(const base::FilePath& directory,
                                const std::string& name) {
  if (!ValidWindowsDocumentName(name)) {
    return {};
  }
  bool dir_missing = false;
  const std::optional<std::wstring> root_final =
      OpenDirectoryFinalPath(directory, true, &dir_missing);
  if (!root_final) {
    return {dir_missing ? ardia::desktop_policy::StoredRead::kMissing
                        : ardia::desktop_policy::StoredRead::kFailed,
            std::string()};
  }
  const base::FilePath target = directory.AppendASCII(name);
  ScopedHandle file(::CreateFileW(
      target.value().c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
      nullptr));
  if (!file.valid()) {
    const DWORD error = ::GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
      return {ardia::desktop_policy::StoredRead::kMissing, std::string()};
    }
    return {};
  }
  if (::GetFileType(file.get()) != FILE_TYPE_DISK) {
    return {};
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(file.get(), &info) ||
      (info.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      info.nNumberOfLinks != 1) {
    return {};
  }
  const std::optional<std::wstring> file_final = HandleFinalPath(file.get());
  if (!file_final || !IsDirectChildOfWinDirectory(*root_final, *file_final)) {
    return {};
  }
  std::optional<std::string> contents =
      ReadHandleBytes(file.get(), kWindowsDocumentReadLimit);
  if (!contents || !base::IsStringUTF8(*contents)) {
    return {};
  }
  return {ardia::desktop_policy::StoredRead::kFound, std::move(*contents)};
}

bool WriteDocumentFile(const base::FilePath& directory,
                       const std::string& name,
                       const std::string& contents) {
  if (!ValidWindowsDocumentName(name) || !base::IsStringUTF8(contents) ||
      contents.size() > WindowsDocumentLimit(name) ||
      !base::CreateDirectory(directory)) {
    return false;
  }
  std::wstring root_final;
  ScopedHandle dir_handle = OpenDirectoryHandle(
      directory,
      FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_TRAVERSE |
          FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      true, &root_final);
  if (!dir_handle.valid()) {
    return false;
  }
  const base::FilePath target = directory.AppendASCII(name);
  {
    ScopedHandle existing(::CreateFileW(
        target.value().c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (existing.valid()) {
      BY_HANDLE_FILE_INFORMATION info{};
      const std::optional<std::wstring> existing_final =
          HandleFinalPath(existing.get());
      if (::GetFileType(existing.get()) != FILE_TYPE_DISK ||
          !::GetFileInformationByHandle(existing.get(), &info) ||
          (info.dwFileAttributes &
           (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
          info.nNumberOfLinks != 1 || !existing_final ||
          !IsDirectChildOfWinDirectory(root_final, *existing_final)) {
        return false;
      }
    } else {
      const DWORD error = ::GetLastError();
      if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) {
        return false;
      }
    }
  }
  const std::string suffix =
      base::ToLowerASCII(base::HexEncode(base::RandBytesAsVector(8)));
  const base::FilePath temp = directory.AppendASCII(
      ".ardia-doc-" + base::NumberToString(::GetCurrentProcessId()) + "-" +
      suffix + ".tmp");
  ScopedHandle staged(::CreateFileW(
      temp.value().c_str(),
      GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, 0, nullptr,
      CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (!staged.valid()) {
    return false;
  }
  BY_HANDLE_FILE_INFORMATION staged_info{};
  const std::optional<std::wstring> staged_final =
      HandleFinalPath(staged.get());
  if (::GetFileType(staged.get()) != FILE_TYPE_DISK ||
      !::GetFileInformationByHandle(staged.get(), &staged_info) ||
      (staged_info.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      staged_info.nNumberOfLinks != 1 || !staged_final ||
      !IsDirectChildOfWinDirectory(root_final, *staged_final) ||
      !WriteAllToHandle(staged.get(), contents)) {
    DisposeOpenHandle(staged.get());
    return false;
  }
  if (!RenameHandleIntoDirectory(dir_handle.get(), staged.get(),
                                 base::UTF8ToWide(name))) {
    DisposeOpenHandle(staged.get());
    return false;
  }
  return true;
}

StoredDocument ReadStoredDocument(const base::FilePath& directory,
                                  const std::string& name) {
  if (ReservedWindowsDocumentName(name)) {
    return {};
  }
  return ReadDocumentFile(directory, name);
}

bool WriteStoredDocument(const base::FilePath& directory,
                         const std::string& name,
                         const std::string& contents) {
  return WritableWindowsDocumentName(name) &&
         WriteDocumentFile(directory, name, contents);
}

bool RemoveStoredDocument(const base::FilePath& directory,
                          const std::string& name) {
  if (!WritableWindowsDocumentName(name)) {
    return false;
  }
  bool dir_missing = false;
  const std::optional<std::wstring> root_final =
      OpenDirectoryFinalPath(directory, true, &dir_missing);
  if (!root_final) {
    return dir_missing;
  }
  const base::FilePath target = directory.AppendASCII(name);
  ScopedHandle file(::CreateFileW(
      target.value().c_str(), DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.valid()) {
    const DWORD error = ::GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
  }
  if (::GetFileType(file.get()) != FILE_TYPE_DISK) {
    return false;
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(file.get(), &info) ||
      (info.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      info.nNumberOfLinks != 1) {
    return false;
  }
  const std::optional<std::wstring> file_final = HandleFinalPath(file.get());
  if (!file_final || !IsDirectChildOfWinDirectory(*root_final, *file_final)) {
    return false;
  }
  return DisposeOpenHandle(file.get());
}

base::DictValue ReadBootstrapDocuments(const base::FilePath& directory) {
  base::DictValue documents;
  const std::optional<std::wstring> root_final =
      OpenDirectoryFinalPath(directory, true);
  if (!root_final) {
    return documents;
  }
  const std::wstring pattern = directory.value() + L"\\*";
  WIN32_FIND_DATAW data{};
  HANDLE find = ::FindFirstFileExW(pattern.c_str(), FindExInfoBasic, &data,
                                   FindExSearchNameMatch, nullptr, 0);
  if (find == INVALID_HANDLE_VALUE) {
    return documents;
  }
  size_t total_bytes = 0;
  do {
    if (documents.size() >= kBootstrapDocumentMaxCount ||
        total_bytes >= kBootstrapDocumentMaxBytes) {
      break;
    }
    if ((data.dwFileAttributes &
         (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
      continue;
    }
    const uint64_t listed_bytes =
        (static_cast<uint64_t>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
    if (listed_bytes > kBootstrapDocumentMaxBytes ||
        !BootstrapDocumentFits(documents.size(), total_bytes,
                               static_cast<size_t>(listed_bytes))) {
      continue;
    }
    const std::wstring_view file_name(data.cFileName);
    std::string name;
    if (!base::WideToUTF8(file_name.data(), file_name.size(), &name) ||
        !BootstrapDocumentEligible(name)) {
      continue;
    }
    StoredDocument stored = ReadStoredDocument(directory, name);
    if (stored.outcome != ardia::desktop_policy::StoredRead::kFound ||
        !BootstrapDocumentFits(documents.size(), total_bytes,
                               stored.contents.size())) {
      continue;
    }
    total_bytes += stored.contents.size();
    documents.Set(name, std::move(stored.contents));
  } while (::FindNextFileW(find, &data));
  ::FindClose(find);
  return documents;
}

std::atomic<int>& AssetReadsServed() {
  static std::atomic<int> served{0};
  return served;
}

std::atomic<int>& AssetReadsRefused() {
  static std::atomic<int> refused{0};
  return refused;
}

std::atomic<int>& AssetReadsOutsideRoot() {
  static std::atomic<int> outside{0};
  return outside;
}

std::atomic<int>& AssetReadsUnreadable() {
  static std::atomic<int> unreadable{0};
  return unreadable;
}

void CountAssetRead(std::atomic<int>& counter) {
  if (ardiacore::TestInstance()) {
    ++counter;
  }
}

std::optional<std::string> ReadAsset(base::FilePath directory,
                                     std::string path,
                                     std::string bootstrap_json,
                                     base::FilePath documents) {
  if (!ValidWindowsAssetPath(path) || MimeType(path).empty()) {
    CountAssetRead(AssetReadsRefused());
    return std::nullopt;
  }
  if (path == "host-bootstrap.js") {
    std::optional<base::Value> bootstrap =
        base::JSONReader::Read(bootstrap_json, base::JSON_PARSE_RFC);
    if (!bootstrap || !bootstrap->is_dict()) {
      CountAssetRead(AssetReadsUnreadable());
      return std::nullopt;
    }
    if (std::optional<base::DictValue> session = ReadSession(documents)) {
      bootstrap->GetDict().Set("session", std::move(*session));
    }
    base::DictValue bootstrap_documents = ReadBootstrapDocuments(documents);
    LOG(WARNING) << "Ardia WebUI shell: bootstrap documents: "
                 << bootstrap_documents.size();
    bootstrap->GetDict().Set("documents", std::move(bootstrap_documents));
    const std::optional<std::string> json = base::WriteJson(*bootstrap);
    if (!json) {
      CountAssetRead(AssetReadsUnreadable());
      return std::nullopt;
    }
    CountAssetRead(AssetReadsServed());
    return BootstrapAssignmentScript(*json) + "\n" +
           ardia::kArdiaHostBootstrap + "\n" + kWindowsCaptionScript;
  }
  const std::optional<std::wstring> root_final =
      OpenDirectoryFinalPath(directory, true);
  if (!root_final) {
    CountAssetRead(AssetReadsUnreadable());
    return std::nullopt;
  }
  const base::FilePath candidate = directory.AppendASCII(path);
  ScopedHandle file(::CreateFileW(
      candidate.value().c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
      nullptr));
  if (!file.valid()) {
    CountAssetRead(AssetReadsUnreadable());
    return std::nullopt;
  }
  const std::optional<std::wstring> file_final = HandleFinalPath(file.get());
  if (!file_final) {
    CountAssetRead(AssetReadsUnreadable());
    return std::nullopt;
  }
  if (!IsStrictlyWithinWinDirectory(*root_final, *file_final)) {
    CountAssetRead(AssetReadsOutsideRoot());
    return std::nullopt;
  }
  std::optional<std::string> contents =
      ReadHandleBytes(file.get(), kAssetLimit);
  if (!contents) {
    CountAssetRead(AssetReadsUnreadable());
    return std::nullopt;
  }
  if (path == "index.html") {
    const size_t head = contents->find("<head>");
    if (head == std::string::npos) {
      CountAssetRead(AssetReadsUnreadable());
      return std::nullopt;
    }
    contents->insert(head + 6, "<script src=\"/host-bootstrap.js\"></script>");
  }
  CountAssetRead(AssetReadsServed());
  return contents;
}

scoped_refptr<base::SequencedTaskRunner> FileRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}

std::optional<webui_window::Placement> ReadPlacement(
    const base::FilePath& directory) {
  StoredDocument stored =
      ReadDocumentFile(directory, webui_window::kPlacementDocument);
  if (stored.outcome != ardia::desktop_policy::StoredRead::kFound) {
    return std::nullopt;
  }
  return webui_window::ParsePlacement(stored.contents);
}

bool WritePlacement(const base::FilePath& directory,
                    const webui_window::Placement& placement) {
  return WriteDocumentFile(directory, webui_window::kPlacementDocument,
                           webui_window::SerializePlacement(placement));
}

ardia::LinuxDocumentRead ReadCanonicalDocument(const base::FilePath& directory,
                                               std::string_view name) {
  ardia::LinuxDocumentRead result;
  if (!ardia::LinuxDocuments::Reserved(name)) {
    result.state = ardia::LinuxDocumentRead::State::kError;
    return result;
  }
  StoredDocument stored = ReadDocumentFile(directory, std::string(name));
  if (stored.outcome == ardia::desktop_policy::StoredRead::kMissing) {
    result.state = ardia::LinuxDocumentRead::State::kMissing;
    return result;
  }
  if (stored.outcome != ardia::desktop_policy::StoredRead::kFound) {
    result.state = ardia::LinuxDocumentRead::State::kError;
    return result;
  }
  result.state = ardia::LinuxDocumentRead::State::kFound;
  std::optional<base::Value> value = base::JSONReader::Read(
      stored.contents, base::JSON_PARSE_RFC, kCanonicalDocumentDepth);
  if (value && value->is_dict()) {
    result.value = std::move(value->GetDict());
  } else {
    result.value.Set("format", "invalid");
  }
  return result;
}

bool WriteCanonicalEnvelope(const base::FilePath& directory,
                            const base::DictValue& envelope) {
  const std::optional<std::string> json = base::WriteJsonWithOptions(
      envelope, base::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION,
      kCanonicalDocumentDepth);
  return json && json->size() <= ardia::kLinuxLiveMaxBytes &&
         WriteDocumentFile(directory, ardia::kLinuxLiveEnvelope, *json);
}

}
