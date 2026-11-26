#include "ardia/linux/ac_linux_report.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/desktop/ac_desktop_paths.h"
#include "ardia/desktop/ac_desktop_report_core.h"
#include "base/compiler_specific.h"
#include "base/containers/span.h"
#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/uuid.h"
#include "build/build_config.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "content/public/browser/browser_thread.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/fetch_api.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>

#include "base/files/file_enumerator.h"
#include "base/win/scoped_handle.h"
#else
#include <sys/stat.h>
#endif

namespace ardiacore {

namespace {

namespace report = ardia::desktop_report;
namespace paths = ardia::desktop_paths;

using Done = base::OnceCallback<void(bool, base::Value)>;

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_linux_problem_report", R"(
      semantics {
        sender: "Ardia Report a Problem"
        description:
          "Sends a problem report the user wrote, and the files they chose "
          "to attach to it, to Ardia's feedback service."
        trigger:
          "The user pressing Send in the Report a Problem sheet."
        user_data {
          type: USER_CONTENT
          type: OTHER
        }
        data:
          "The report's title, description, optional contact, app and "
          "system versions, diagnostics, and the attachments the user left "
          "ticked. No cookies or browsing data."
        destination: OTHER
        destination_other: "Ardia's feedback service at ardia.dev."
        last_reviewed: "2026-11-15"
      }
      policy {
        cookies_allowed: NO
        setting: "Nothing is sent unless the user sends a report."
        policy_exception_justification: "Not implemented."
      })");

void Fail(Done done, std::string_view message) {
  std::move(done).Run(false, base::Value(base::DictValue().Set("code", report::kErrorCode).Set("message", message)));
}

base::Value Reply(int status, std::string body, std::optional<std::string> error) {
  return base::Value(base::DictValue()
      .Set("status", status)
      .Set("body", std::move(body))
      .Set("error", error ? base::Value(std::move(*error)) : base::Value()));
}

void Refuse(Done done, std::string_view why) {
  std::move(done).Run(true, Reply(0, std::string(), std::string(why)));
}

base::FilePath DraftsFolder(const base::FilePath& documents) {
  return documents.AppendASCII(report::kDraftsFolder);
}

constexpr char kSeparator = static_cast<char>(base::FilePath::kSeparators[0]);

bool Inside(const base::FilePath& drafts, std::string_view path) {
  return report::InsideDrafts(paths::Text(drafts), path, kSeparator);
}

void OwnerOnly(const base::FilePath& folder) {
#if BUILDFLAG(IS_POSIX)
  base::SetPosixFilePermissions(folder, 0700);
#endif
}

#if BUILDFLAG(IS_WIN)
constexpr DWORD kShareAll = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
constexpr DWORD kShareReadWrite = FILE_SHARE_READ | FILE_SHARE_WRITE;
constexpr int kMaxRemoveDepth = 16;

base::win::ScopedHandle OpenOnDisk(const base::FilePath& path, DWORD access, DWORD disposition, bool follow_leaf,
                                   DWORD share = kShareAll) {
  return base::win::ScopedHandle(::CreateFileW(
      path.value().c_str(), access, share, nullptr, disposition,
      FILE_FLAG_BACKUP_SEMANTICS | (follow_leaf ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), nullptr));
}

bool DirectoryHandle(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info = {};
  return ::GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) &&
         (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool DeleteThroughHandle(HANDLE handle) {
  FILE_DISPOSITION_INFO remove = {TRUE};
  return ::SetFileInformationByHandle(handle, FileDispositionInfo, &remove, sizeof(remove)) != 0;
}

bool ReparsePoint(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info = {};
  return !::GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) ||
         (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

std::optional<base::FilePath> FinalPathOf(HANDLE handle) {
  std::wstring buffer(MAX_PATH, L'\0');
  DWORD length = ::GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()),
                                             FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length >= buffer.size()) {
    buffer.resize(length + 1);
    length = ::GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()),
                                         FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  }
  if (length == 0 || length >= buffer.size()) return std::nullopt;
  buffer.resize(length);
  const std::optional<std::string> dos = report::DosFinalPath(paths::Text(base::FilePath(buffer)));
  if (!dos) return std::nullopt;
  return paths::FromText<base::FilePath>(*dos);
}

bool ExistingReparsePoint(const base::FilePath& path) {
  base::win::ScopedHandle handle = OpenOnDisk(path, FILE_READ_ATTRIBUTES, OPEN_EXISTING, false);
  return handle.is_valid() && ReparsePoint(handle.get());
}

bool HandleInside(const base::FilePath& drafts, HANDLE handle) {
  base::win::ScopedHandle folder = OpenOnDisk(drafts, FILE_READ_ATTRIBUTES, OPEN_EXISTING, true);
  const std::optional<base::FilePath> real_drafts =
      folder.is_valid() ? FinalPathOf(folder.get()) : std::nullopt;
  const std::optional<base::FilePath> final_path = FinalPathOf(handle);
  return real_drafts && final_path && !ReparsePoint(handle) && Inside(*real_drafts, paths::Text(*final_path));
}

base::win::ScopedHandle OpenDraftHandle(const base::FilePath& drafts, const base::FilePath& path, DWORD access,
                                        DWORD share) {
  base::win::ScopedHandle handle = OpenOnDisk(path, access, OPEN_EXISTING, false, share);
  if (!handle.is_valid() || !HandleInside(drafts, handle.get())) return base::win::ScopedHandle();
  return handle;
}

bool RemoveTree(const base::FilePath& drafts, const base::FilePath& path, int depth) {
  base::win::ScopedHandle handle =
      OpenOnDisk(path, DELETE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY, OPEN_EXISTING, false, kShareReadWrite);
  if (!handle.is_valid()) return false;
  if (ReparsePoint(handle.get())) return depth > 0 && DeleteThroughHandle(handle.get());
  if (!HandleInside(drafts, handle.get())) return false;
  if (DirectoryHandle(handle.get())) {
    if (depth >= kMaxRemoveDepth) return false;
    base::FileEnumerator children(path, false, base::FileEnumerator::FILES | base::FileEnumerator::DIRECTORIES);
    for (base::FilePath child = children.Next(); !child.empty(); child = children.Next()) {
      if (!RemoveTree(drafts, child, depth + 1)) return false;
    }
  }
  return DeleteThroughHandle(handle.get());
}
#else
bool ExistingReparsePoint(const base::FilePath& path) {
  return base::IsLink(path);
}
#endif

std::optional<base::FilePath> RealPath(const base::FilePath& path, bool follow_leaf) {
#if BUILDFLAG(IS_WIN)
  base::win::ScopedHandle handle = OpenOnDisk(path, FILE_READ_ATTRIBUTES, OPEN_EXISTING, follow_leaf);
  if (!handle.is_valid() || (!follow_leaf && ReparsePoint(handle.get()))) return std::nullopt;
  return FinalPathOf(handle.get());
#else
  base::FilePath real = base::MakeAbsoluteFilePath(path);
  if (real.empty()) return std::nullopt;
  return real;
#endif
}

std::optional<base::FilePath> ExistingDraftPath(const base::FilePath& drafts, const std::string& path) {
  if (!Inside(drafts, path)) return std::nullopt;
  const std::optional<base::FilePath> real_drafts = RealPath(drafts, true);
  const std::optional<base::FilePath> real = RealPath(paths::FromText<base::FilePath>(path), false);
  if (!real_drafts || !real || !Inside(*real_drafts, paths::Text(*real))) return std::nullopt;
  return real;
}

std::optional<base::FilePath> NewDraftPath(const base::FilePath& drafts, const std::string& path) {
  if (!Inside(drafts, path)) return std::nullopt;
  const base::FilePath given = paths::FromText<base::FilePath>(path);
  const std::optional<base::FilePath> real_drafts = RealPath(drafts, true);
  const std::optional<base::FilePath> parent = RealPath(given.DirName(), false);
  if (!real_drafts || !parent) return std::nullopt;
  const base::FilePath real = parent->Append(given.BaseName());
  if (!Inside(*real_drafts, paths::Text(real)) || ExistingReparsePoint(real)) return std::nullopt;
  return real;
}

std::optional<std::string> CreateDraft(const base::FilePath& documents) {
  const base::FilePath drafts = DraftsFolder(documents);
  if (!base::CreateDirectory(drafts)) return std::nullopt;
  OwnerOnly(drafts);
  const base::FilePath draft = drafts.AppendASCII(base::Uuid::GenerateRandomV4().AsLowercaseString());
  if (!base::CreateDirectory(draft)) return std::nullopt;
  OwnerOnly(draft);
  return paths::Text(draft);
}

double FileSize(const base::FilePath& documents, const std::string& path) {
  const std::optional<base::FilePath> real = ExistingDraftPath(DraftsFolder(documents), path);
  if (!real || base::DirectoryExists(*real)) return -1;
  const std::optional<int64_t> size = base::GetFileSize(*real);
  return size ? static_cast<double>(*size) : -1;
}

bool RemovePath(const base::FilePath& documents, const std::string& path) {
  const base::FilePath drafts = DraftsFolder(documents);
  if (!Inside(drafts, path)) return false;
  const base::FilePath given = paths::FromText<base::FilePath>(path);
  const std::optional<base::FilePath> real_drafts = RealPath(drafts, true);
  const std::optional<base::FilePath> parent = RealPath(given.DirName(), false);
  if (!real_drafts || !parent) return false;
  const base::FilePath real = parent->Append(given.BaseName());
  if (!Inside(*real_drafts, paths::Text(real))) return false;
#if BUILDFLAG(IS_WIN)
  return RemoveTree(drafts, real, 0);
#else
  return base::DeletePathRecursively(real);
#endif
}

base::File OpenDraftOutput(const base::FilePath& drafts, const base::FilePath& destination) {
#if BUILDFLAG(IS_WIN)
  if (base::PathExists(destination)) {
    base::win::ScopedHandle existing =
        OpenDraftHandle(drafts, destination, DELETE | FILE_READ_ATTRIBUTES, kShareReadWrite);
    if (!existing.is_valid() || DirectoryHandle(existing.get()) || !DeleteThroughHandle(existing.get())) {
      return base::File();
    }
  }
  base::win::ScopedHandle created = OpenOnDisk(destination, GENERIC_WRITE | DELETE, CREATE_NEW, false, FILE_SHARE_READ);
  if (!created.is_valid()) return base::File();
  if (!HandleInside(drafts, created.get())) {
    DeleteThroughHandle(created.get());
    return base::File();
  }
  return base::File(std::move(created));
#else
  return base::File(destination, base::File::FLAG_CREATE_ALWAYS | base::File::FLAG_WRITE);
#endif
}

bool SameFileAs(const base::File& input, const base::FilePath& destination) {
#if BUILDFLAG(IS_WIN)
  BY_HANDLE_FILE_INFORMATION source = {};
  if (!::GetFileInformationByHandle(input.GetPlatformFile(), &source)) return true;
  base::win::ScopedHandle other = OpenOnDisk(destination, FILE_READ_ATTRIBUTES, OPEN_EXISTING, false);
  if (!other.is_valid()) return false;
  BY_HANDLE_FILE_INFORMATION target = {};
  if (!::GetFileInformationByHandle(other.get(), &target)) return true;
  return source.dwVolumeSerialNumber == target.dwVolumeSerialNumber && source.nFileIndexHigh == target.nFileIndexHigh &&
         source.nFileIndexLow == target.nFileIndexLow;
#else
  struct stat source = {};
  if (fstat(input.GetPlatformFile(), &source) != 0) return true;
  struct stat target = {};
  if (lstat(destination.value().c_str(), &target) != 0) return false;
  return source.st_dev == target.st_dev && source.st_ino == target.st_ino;
#endif
}

base::File OpenDraftInput(const base::FilePath& drafts, const base::FilePath& source) {
#if BUILDFLAG(IS_WIN)
  base::win::ScopedHandle handle = OpenDraftHandle(drafts, source, GENERIC_READ | DELETE, FILE_SHARE_READ);
  if (!handle.is_valid() || DirectoryHandle(handle.get())) return base::File();
  return base::File(std::move(handle));
#else
  return base::File(source, base::File::FLAG_OPEN | base::File::FLAG_READ);
#endif
}

void RemoveDraftFile(base::File& file, const base::FilePath& path) {
#if BUILDFLAG(IS_WIN)
  DeleteThroughHandle(file.GetPlatformFile());
  file.Close();
#else
  file.Close();
  base::DeleteFile(path);
#endif
}

double GzipInto(const base::FilePath& drafts, const base::FilePath& destination, const report::GzipRead& read) {
  base::File output = OpenDraftOutput(drafts, destination);
  if (!output.IsValid()) return -1;
  const int64_t written = report::Gzip(read, [&output](const uint8_t* data, size_t size) {
    return output.WriteAtCurrentPosAndCheck(UNSAFE_BUFFERS(base::span<const uint8_t>(data, size)));
  });
  if (written < 0) {
    RemoveDraftFile(output, destination);
    return -1;
  }
  output.Close();
  return static_cast<double>(written);
}

double GzipFile(const base::FilePath& documents, const std::string& source, const std::string& destination, bool remove_source) {
  const base::FilePath drafts = DraftsFolder(documents);
  const std::optional<base::FilePath> from = ExistingDraftPath(drafts, source);
  const std::optional<base::FilePath> to = NewDraftPath(drafts, destination);
  if (!from || !to || *from == *to || base::DirectoryExists(*from)) return -1;
  base::File input = OpenDraftInput(drafts, *from);
  if (!input.IsValid() || SameFileAs(input, *to)) return -1;
  const double written = GzipInto(drafts, *to, [&input](uint8_t* buffer, size_t capacity) -> int64_t {
    const std::optional<size_t> count = input.ReadAtCurrentPos(UNSAFE_BUFFERS(base::span<uint8_t>(buffer, capacity)));
    return count ? static_cast<int64_t>(*count) : -1;
  });
  if (written >= 0 && remove_source) {
    RemoveDraftFile(input, *from);
  } else {
    input.Close();
  }
  return written;
}

double GzipText(const base::FilePath& documents, const std::string& text, const std::string& destination) {
  const base::FilePath drafts = DraftsFolder(documents);
  const std::optional<base::FilePath> to = NewDraftPath(drafts, destination);
  if (!to) return -1;
  size_t offset = 0;
  return GzipInto(drafts, *to, [&text, &offset](uint8_t* buffer, size_t capacity) -> int64_t {
    const size_t count = std::min(capacity, text.size() - offset);
    UNSAFE_BUFFERS(std::copy_n(text.data() + offset, count, buffer));
    offset += count;
    return static_cast<int64_t>(count);
  });
}

struct UploadFile {
  base::FilePath path;
  int64_t bytes = -1;
  std::optional<std::string> body;
};

UploadFile FindUploadFile(const base::FilePath& documents, const std::string& path, int64_t max_bytes,
                          std::shared_ptr<std::atomic<bool>> cancelled) {
  if (cancelled && cancelled->load(std::memory_order_relaxed)) return {};
  const base::FilePath drafts = DraftsFolder(documents);
  const std::optional<base::FilePath> real = ExistingDraftPath(drafts, path);
  if (!real || base::DirectoryExists(*real)) return {};
#if BUILDFLAG(IS_WIN)
  base::win::ScopedHandle held = OpenDraftHandle(drafts, *real, GENERIC_READ, FILE_SHARE_READ);
  LARGE_INTEGER size = {};
  if (!held.is_valid() || DirectoryHandle(held.get()) || !::GetFileSizeEx(held.get(), &size)) return {};
  UploadFile file;
  file.path = *real;
  file.bytes = size.QuadPart;
  if (file.bytes < 1 || file.bytes > max_bytes) return file;
  base::File verified(std::move(held));
  std::string body(static_cast<size_t>(file.bytes), '\0');
  constexpr size_t kReadChunk = 256 * 1024;
  size_t offset = 0;
  auto output = base::as_writable_byte_span(body);
  while (offset < output.size()) {
    if (cancelled && cancelled->load(std::memory_order_relaxed)) return {};
    const size_t chunk = std::min(kReadChunk, output.size() - offset);
    if (!verified.ReadAndCheck(static_cast<int64_t>(offset), output.subspan(offset, chunk))) return {};
    offset += chunk;
  }
  file.body = std::move(body);
  return file;
#else
  return {*real, base::GetFileSize(*real).value_or(-1)};
#endif
}

scoped_refptr<network::SharedURLLoaderFactory> SystemLoaderFactory() {
  if (!g_browser_process || g_browser_process->IsShuttingDown()) return nullptr;
  SystemNetworkContextManager* manager = g_browser_process->system_network_context_manager();
  return manager ? manager->GetSharedURLLoaderFactory() : nullptr;
}

class Transfer;

std::vector<std::unique_ptr<Transfer>>& Running() {
  static base::NoDestructor<std::vector<std::unique_ptr<Transfer>>> running;
  return *running;
}

class Transfer {
 public:
  Transfer(int caller, std::string id, size_t reply_limit, LinuxReportEvent emit, Done done)
      : caller_(caller), id_(std::move(id)), reply_limit_(reply_limit), emit_(std::move(emit)), done_(std::move(done)) {}
  Transfer(const Transfer&) = delete;
  Transfer& operator=(const Transfer&) = delete;
  ~Transfer() = default;

  int caller() const { return caller_; }
  std::shared_ptr<std::atomic<bool>> CancelFlag() const { return cancelled_; }
  base::WeakPtr<Transfer> Weak() { return weak_.GetWeakPtr(); }

  void Post(network::mojom::URLLoaderFactory* factory, const std::string& url, const std::vector<report::Header>& headers,
            std::string body) {
    Create(url, "POST", headers, report::kPostTimeoutSeconds);
    loader_->AttachStringForUpload(std::move(body), "application/json");
    Start(factory);
  }

  void Put(network::mojom::URLLoaderFactory* factory, const std::string& url, const std::vector<report::Header>& headers,
           const base::FilePath& file, std::optional<std::string> body) {
    std::string type;
    for (const auto& [name, value] : headers) {
      if (name == "Content-Type") type = value;
    }
    Create(url, "PUT", headers, report::kUploadTimeoutSeconds);
    if (body) {
      loader_->AttachStringForUpload(std::move(*body), type);
    } else {
      loader_->AttachFileForUpload(file, type);
    }
    loader_->SetOnUploadProgressCallback(base::BindRepeating(&Transfer::OnProgress, base::Unretained(this)));
    Start(factory);
  }

  void Cancel() {
    cancelled_->store(true, std::memory_order_relaxed);
    loader_.reset();
    if (done_) std::move(done_).Run(true, Reply(0, std::string(), "cancelled"));
  }

  void RefuseAndRemove(const char* message) {
    cancelled_->store(true, std::memory_order_relaxed);
    Done done = std::move(done_);
    std::erase_if(Running(), [this](const std::unique_ptr<Transfer>& owned) { return owned.get() == this; });
    Refuse(std::move(done), message);
  }

 private:
  void Create(const std::string& url, const char* method, const std::vector<report::Header>& headers, int timeout_seconds) {
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = GURL(url);
    request->method = method;
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    request->redirect_mode = network::mojom::RedirectMode::kError;
    request->load_flags = net::LOAD_DISABLE_CACHE;
    for (const auto& [name, value] : headers) {
      if (name != "Content-Type") request->headers.SetHeader(name, value);
    }
    loader_ = network::SimpleURLLoader::Create(std::move(request), kTrafficAnnotation);
    loader_->SetTimeoutDuration(base::Seconds(timeout_seconds));
    loader_->SetAllowHttpErrorResults(true);
    loader_->SetAllowPartialResults(true);
  }

  void Start(network::mojom::URLLoaderFactory* factory) {
    loader_->DownloadToString(factory, base::BindOnce(&Transfer::OnLoaded, base::Unretained(this)), reply_limit_);
  }

  void OnProgress(uint64_t sent, uint64_t total) {
    if (!emit_) return;
    emit_.Run(base::Value(base::DictValue()
        .Set("type", "upload").Set("id", id_)
        .Set("sent", static_cast<double>(sent)).Set("total", static_cast<double>(total))));
  }

  void OnLoaded(std::optional<std::string> body) {
    const int error = loader_->NetError();
    const network::mojom::URLResponseHead* head = loader_->ResponseInfo();
    const net::HttpResponseHeaders* headers = head ? head->headers.get() : nullptr;
    const bool answered = headers && (error == net::OK || error == net::ERR_INSUFFICIENT_RESOURCES ||
                                      error == net::ERR_HTTP_RESPONSE_CODE_FAILURE);
    base::Value reply = answered
        ? Reply(headers->response_code(), report::ReplyText(body ? *body : std::string(), reply_limit_), std::nullopt)
        : Reply(0, std::string(), net::ErrorToString(error));
    Done done = std::move(done_);
    std::erase_if(Running(), [this](const std::unique_ptr<Transfer>& owned) { return owned.get() == this; });
    std::move(done).Run(true, std::move(reply));
  }

  const int caller_;
  const std::string id_;
  const size_t reply_limit_;
  LinuxReportEvent emit_;
  Done done_;
  std::shared_ptr<std::atomic<bool>> cancelled_ = std::make_shared<std::atomic<bool>>(false);
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::WeakPtrFactory<Transfer> weak_{this};
};

std::optional<std::vector<report::Header>> HeadersFrom(const base::Value& value) {
  if (!value.is_dict()) return std::nullopt;
  std::vector<report::Header> headers;
  for (const auto [name, text] : value.GetDict()) {
    if (!text.is_string()) return std::nullopt;
    headers.emplace_back(name, text.GetString());
  }
  return headers;
}

Transfer* Admit(int caller, std::string id, size_t reply_limit, LinuxReportEvent emit, Done* done) {
  if (static_cast<int>(Running().size()) >= report::kMaxTransfers) {
    Refuse(std::move(*done), "Too many report transfers are running");
    return nullptr;
  }
  Running().push_back(std::make_unique<Transfer>(caller, std::move(id), reply_limit, std::move(emit), std::move(*done)));
  return Running().back().get();
}

void CancelTransfers(std::optional<int> caller) {
  std::vector<std::unique_ptr<Transfer>> cancelled;
  auto& running = Running();
  for (auto at = running.begin(); at != running.end();) {
    if (caller && (*at)->caller() != *caller) {
      ++at;
      continue;
    }
    cancelled.push_back(std::move(*at));
    at = running.erase(at);
  }
  for (auto& transfer : cancelled) transfer->Cancel();
}

void StartPost(const base::ListValue& args, int caller, Done done) {
  if (args.size() != 3 || !args[0].is_string() || !args[1].is_string()) {
    return Fail(std::move(done), "post takes a URL, a JSON body and headers");
  }
  const report::Request request = report::ClassifyUrl(report::kEndpoint, args[0].GetString());
  if (request.target != report::Target::kCreate && request.target != report::Target::kComplete) {
    return Refuse(std::move(done), "Reports go to Ardia's feedback service only");
  }
  const std::optional<std::vector<report::Header>> given = HeadersFrom(args[2]);
  const auto headers = given ? report::AllowedHeaders(request.target, *given) : std::nullopt;
  if (!headers) return Refuse(std::move(done), "These headers are not sent with a report");
  if (args[1].GetString().size() > report::kJsonMaxBytes) return Refuse(std::move(done), "The report is too large");
  if (BackgroundInstance()) return Refuse(std::move(done), "Background instances send no reports");
  scoped_refptr<network::SharedURLLoaderFactory> factory = SystemLoaderFactory();
  if (!factory) return Refuse(std::move(done), "The network is unavailable");
  Transfer* transfer = Admit(caller, std::string(), report::kPostReplyMaxBytes, LinuxReportEvent(), &done);
  if (transfer) transfer->Post(factory.get(), args[0].GetString(), *headers, args[1].GetString());
}

void StartUpload(const base::ListValue& args, const base::FilePath& documents, int caller, LinuxReportEvent emit, Done done) {
  if (args.size() != 5 || !args[0].is_string() || args[0].GetString().empty() || args[0].GetString().size() > 64 ||
      !args[1].is_string() || !args[2].is_string() || !args[4].is_string()) {
    return Fail(std::move(done), "upload takes an id, a URL, a method, headers and a file path");
  }
  const report::Request request = report::ClassifyUrl(report::kEndpoint, args[1].GetString());
  if (request.target != report::Target::kFile || !report::MethodAllowed(request.target, args[2].GetString())) {
    return Refuse(std::move(done), "Report files go to Ardia's feedback service only");
  }
  const std::optional<std::vector<report::Header>> given = HeadersFrom(args[3]);
  auto headers = given ? report::AllowedHeaders(request.target, *given) : std::nullopt;
  if (!headers) return Refuse(std::move(done), "These headers are not sent with a report file");
  if (BackgroundInstance()) return Refuse(std::move(done), "Background instances send no reports");
  Transfer* transfer = Admit(caller, args[0].GetString(), report::kUploadReplyMaxBytes, std::move(emit), &done);
  if (!transfer) return;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&FindUploadFile, documents, args[4].GetString(), request.max_bytes, transfer->CancelFlag()),
      base::BindOnce(
          [](base::WeakPtr<Transfer> transfer, report::Request request, std::string url,
             std::vector<report::Header> headers, UploadFile file) {
            if (!transfer) return;
            if (!report::UploadSizeAllowed(request, file.bytes)) {
              return transfer->RefuseAndRemove("The file is missing, empty, too large or outside the report's folder");
            }
            scoped_refptr<network::SharedURLLoaderFactory> factory = SystemLoaderFactory();
            if (!factory) return transfer->RefuseAndRemove("The network is unavailable");
            transfer->Put(factory.get(), url, headers, file.path, std::move(file.body));
          },
          transfer->Weak(), request, args[1].GetString(), std::move(*headers)));
}

void ReplyWithBytes(Done done, const char* failure, double bytes) {
  if (bytes < 0) return Fail(std::move(done), failure);
  std::move(done).Run(true, base::Value(bytes));
}

}

bool LinuxReportInvokes(std::string_view method) {
  return std::ranges::any_of(report::kReportCalls, [&](const char* known) { return method == known; });
}

void LinuxReportInvoke(std::string_view method, const base::ListValue& args, const base::FilePath& documents,
                       int caller, LinuxReportEvent emit, Done done) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const base::TaskTraits files = {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
                                  base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN};
  if (method == "ArdiaReport.cancelUploads") {
    if (!args.empty()) return Fail(std::move(done), "cancelUploads takes no arguments");
    CancelTransfers(std::nullopt);
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaReport.post") return StartPost(args, caller, std::move(done));
  if (method == "ArdiaReport.upload") return StartUpload(args, documents, caller, std::move(emit), std::move(done));
  if (documents.empty()) return Fail(std::move(done), "The profile has no folder for report drafts");
  if (method == "ArdiaReport.draftDirectory") {
    if (!args.empty()) return Fail(std::move(done), "draftDirectory takes no arguments");
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, files, base::BindOnce(&CreateDraft, documents),
        base::BindOnce([](Done done, std::optional<std::string> path) {
          if (!path) return Fail(std::move(done), "The report draft folder could not be created");
          std::move(done).Run(true, base::Value(std::move(*path)));
        }, std::move(done)));
    return;
  }
  if (method == "ArdiaReport.fileSize" || method == "ArdiaReport.removeFile") {
    if (args.size() != 1 || !args[0].is_string()) return Fail(std::move(done), "A file path is required");
    if (method == "ArdiaReport.fileSize") {
      base::ThreadPool::PostTaskAndReplyWithResult(
          FROM_HERE, files, base::BindOnce(&FileSize, documents, args[0].GetString()),
          base::BindOnce([](Done done, double size) { std::move(done).Run(true, base::Value(size)); }, std::move(done)));
      return;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, files, base::BindOnce(&RemovePath, documents, args[0].GetString()),
        base::BindOnce([](Done done, bool) { std::move(done).Run(true, base::Value()); }, std::move(done)));
    return;
  }
  if (method == "ArdiaReport.gzipFile") {
    if (args.size() != 3 || !args[0].is_string() || !args[1].is_string() || !args[2].is_bool()) {
      return Fail(std::move(done), "gzipFile takes a source, a destination and whether to remove the source");
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, files, base::BindOnce(&GzipFile, documents, args[0].GetString(), args[1].GetString(), args[2].GetBool()),
        base::BindOnce(&ReplyWithBytes, std::move(done), "The file could not be compressed inside the report's folder"));
    return;
  }
  if (method == "ArdiaReport.gzipText") {
    if (args.size() != 2 || !args[0].is_string() || !args[1].is_string() ||
        args[0].GetString().size() > report::kTextMaxBytes) {
      return Fail(std::move(done), "gzipText takes text and a destination");
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, files, base::BindOnce(&GzipText, documents, args[0].GetString(), args[1].GetString()),
        base::BindOnce(&ReplyWithBytes, std::move(done), "The text could not be compressed inside the report's folder"));
    return;
  }
  Fail(std::move(done), "Unknown report call");
}

void LinuxReportCallerGone(int caller) {
  CancelTransfers(caller);
}

}
