// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/report.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/modules/recording.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_util.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "third_party/zlib/google/compression_utils.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaReport";
constexpr size_t kLargestResponse = 1 << 20;
constexpr int64_t kLargestFile = 512 << 20;
constexpr base::TimeDelta kUploadTimeout = base::Minutes(15);

constexpr net::NetworkTrafficAnnotationTag kReportAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_problem_report", R"(
      semantics {
        sender: "Ardia Report a Problem"
        description: "Uploads a problem report the user wrote and chose to "
                     "send, with the logs and recording they kept in it."
        trigger: "The user sends a report from Report a Problem."
        data: "The report's text, the app's logs and, if the user kept it, "
              "a screen recording of an Ardia window."
        destination: OTHER
      }
      policy {
        cookies_allowed: NO
        setting: "None."
        policy_exception_justification: "Not implemented."
      })");

base::FilePath DraftFolder() {
  return ReportsFolder().Append("draft");
}

std::optional<base::FilePath> Inside(const base::FilePath& root,
                                     const std::string& path) {
  return ReportPathInside(root, path);
}

class Reports {
 public:
  static Reports& Get() {
    static base::NoDestructor<Reports> reports;
    return *reports;
  }

  void Known(const std::string& path, int64_t size) { sizes_[path] = size; }
  void Forget(const std::string& path) {
    for (auto it = sizes_.begin(); it != sizes_.end();) {
      it = it->first == path || it->first.starts_with(path + "/")
               ? sizes_.erase(it)
               : std::next(it);
    }
  }
  int64_t SizeOf(const std::string& path) const {
    auto found = sizes_.find(path);
    return found == sizes_.end() ? -1 : found->second;
  }

  struct Upload {
    std::unique_ptr<network::SimpleURLLoader> loader;
    ModuleReply reply;
    uint64_t total = 0;
  };

  std::map<std::string, Upload>& uploads() { return uploads_; }

  void CancelUploads() {
    std::map<std::string, Upload> cancelled = std::move(uploads_);
    uploads_.clear();
    for (auto& [id, upload] : cancelled) {
      upload.loader.reset();
      std::move(upload.reply)
          .Run(base::Value(base::DictValue()
                               .Set("status", 0)
                               .Set("body", "")
                               .Set("error", "cancelled")));
    }
  }

 private:
  friend class base::NoDestructor<Reports>;
  Reports() = default;

  std::map<std::string, int64_t> sizes_;
  std::map<std::string, Upload> uploads_;
};

int64_t WriteGzipped(const std::string& data, const base::FilePath& out) {
  std::string packed;
  if (!compression::GzipCompress(data, &packed) ||
      !base::CreateDirectory(out.DirName()) || !base::WriteFile(out, packed)) {
    return -1;
  }
  return static_cast<int64_t>(packed.size());
}

void Packed(std::string destination, ModuleReply reply, int64_t size) {
  if (size < 0) {
    std::move(reply).Run(ModuleFailure("the report file couldn't be written"));
    return;
  }
  Reports::Get().Known(destination, size);
  std::move(reply).Run(base::Value(static_cast<double>(size)));
}

void GzipFile(base::ListValue args, ModuleReply reply) {
  std::optional<base::FilePath> source =
      Inside(DataDirectory(), StringArg(args, 0));
  std::optional<base::FilePath> destination =
      Inside(ReportsFolder(), StringArg(args, 1));
  if (!source || !destination) {
    std::move(reply).Run(ModuleFailure("that file isn't Ardia's"));
    return;
  }
  const bool remove_source = BoolArg(args, 2);
  if (remove_source) {
    Reports::Get().Forget(source->value());
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(
          [](base::FilePath source, base::FilePath destination,
             bool remove_source) -> int64_t {
            std::string data;
            if (!base::ReadFileToStringWithMaxSize(source, &data,
                                                   kLargestFile)) {
              return -1;
            }
            const int64_t size = WriteGzipped(data, destination);
            if (size >= 0 && remove_source) {
              base::DeleteFile(source);
            }
            return size;
          },
          *source, *destination, remove_source),
      base::BindOnce(&Packed, destination->value(), std::move(reply)));
}

void GzipText(base::ListValue args, ModuleReply reply) {
  std::optional<base::FilePath> destination =
      Inside(ReportsFolder(), StringArg(args, 1));
  if (!destination) {
    std::move(reply).Run(ModuleFailure("that file isn't Ardia's"));
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&WriteGzipped, StringArg(args, 0), *destination),
      base::BindOnce(&Packed, destination->value(), std::move(reply)));
}

bool UploadAllowed(const GURL& url) {
  if (url.SchemeIs("https")) {
    return true;
  }
  return CurrentLaunchConfig().test_instance && url.SchemeIs("http") &&
         (url.host() == "127.0.0.1" || url.host() == "localhost");
}

void Finished(const std::string& id, std::optional<std::string> body) {
  auto& uploads = Reports::Get().uploads();
  auto found = uploads.find(id);
  if (found == uploads.end()) {
    return;
  }
  Reports::Upload upload = std::move(found->second);
  uploads.erase(found);
  network::SimpleURLLoader* loader = upload.loader.get();
  const int status = loader->ResponseInfo() && loader->ResponseInfo()->headers
                         ? loader->ResponseInfo()->headers->response_code()
                         : 0;
  if (status) {
    ModuleRegistry::Get().Emit(
        kModule, "onReport",
        base::Value(base::DictValue()
                        .Set("type", "upload")
                        .Set("id", id)
                        .Set("sent", static_cast<double>(upload.total))
                        .Set("total", static_cast<double>(upload.total))));
  }
  std::move(upload.reply)
      .Run(base::Value(
          base::DictValue()
              .Set("status", status)
              .Set("body", body ? base::Value(std::move(*body))
                                : base::Value(std::string()))
              .Set("error", status ? base::Value()
                                   : base::Value(net::ErrorToShortString(
                                         loader->NetError())))));
}

void UploadFile(base::ListValue args, ModuleReply reply) {
  const std::string id = StringArg(args, 0);
  const GURL url(StringArg(args, 1));
  std::string method = StringArg(args, 2);
  const base::DictValue* headers = DictArg(args, 3);
  std::optional<base::FilePath> path =
      Inside(DataDirectory(), StringArg(args, 4));
  if (id.empty() || !url.is_valid() || !UploadAllowed(url) || !path) {
    std::move(reply).Run(base::Value(base::DictValue()
                                         .Set("status", 0)
                                         .Set("body", "")
                                         .Set("error", "refused")));
    return;
  }
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = url;
  request->method = method.empty() ? "PUT" : base::ToUpperASCII(method);
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  std::string content_type = "application/octet-stream";
  if (headers) {
    for (const auto [name, value] : *headers) {
      if (!value.is_string()) {
        continue;
      }
      if (base::EqualsCaseInsensitiveASCII(name, "content-type")) {
        content_type = value.GetString();
      } else if (net::HttpUtil::IsValidHeaderName(name) &&
                 net::HttpUtil::IsValidHeaderValue(value.GetString())) {
        request->headers.SetHeader(name, value.GetString());
      }
    }
  }
  auto loader = network::SimpleURLLoader::Create(std::move(request),
                                                 kReportAnnotation);
  loader->SetAllowHttpErrorResults(true);
  loader->SetTimeoutDuration(kUploadTimeout);
  loader->AttachFileForUpload(*path, content_type);
  loader->SetOnUploadProgressCallback(base::BindRepeating(
      [](std::string id, uint64_t position, uint64_t total) {
        auto& uploads = Reports::Get().uploads();
        auto found = uploads.find(id);
        if (found != uploads.end()) {
          found->second.total = total;
        }
        ModuleRegistry::Get().Emit(
            kModule, "onReport",
            base::Value(base::DictValue()
                            .Set("type", "upload")
                            .Set("id", id)
                            .Set("sent", static_cast<double>(position))
                            .Set("total", static_cast<double>(total))));
      },
      id));
  network::SimpleURLLoader* raw = loader.get();
  Reports::Get().uploads()[id] = {std::move(loader), std::move(reply), 0};
  raw->DownloadToString(
      g_browser_process->system_network_context_manager()
          ->GetSharedURLLoaderFactory()
          .get(),
      base::BindOnce(&Finished, id),
      kLargestResponse);
}

}

base::FilePath ReportsFolder() {
  return DataDirectory().Append("Reports");
}

std::optional<base::FilePath> ReportPathInside(const base::FilePath& root,
                                               const std::string& path) {
  base::FilePath asked(path);
  if (!asked.IsAbsolute() || asked.ReferencesParent() ||
      !(root == asked || root.IsParent(asked))) {
    return std::nullopt;
  }
  return asked;
}

void NoteReportFileSize(const std::string& path, int64_t size) {
  Reports::Get().Known(path, size);
}

void RegisterReportModule(ModuleRegistry& registry) {
  base::ThreadPool::PostTask(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
      base::BindOnce(base::IgnoreResult(&base::CreateDirectory), DraftFolder()));
  ModuleRegistry::Module module = registry.Define(kModule);
  AddRecordingMethods(module);
  module
      .Sync("draftDirectory", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(DraftFolder().value()));
            }))
      .Sync("fileSize", SyncOf([](const base::ListValue& args) {
              return ModuleResult(base::Value(static_cast<double>(
                  Reports::Get().SizeOf(StringArg(args, 0)))));
            }))
      .Sync("removeFile", SyncOf([](const base::ListValue& args) {
              std::optional<base::FilePath> path =
                  Inside(ReportsFolder(), StringArg(args, 0));
              if (path) {
                Reports::Get().Forget(path->value());
                base::ThreadPool::PostTask(
                    FROM_HERE, {base::MayBlock()},
                    base::BindOnce(
                        base::IgnoreResult(&base::DeletePathRecursively),
                        *path));
              }
              return ModuleResult(base::Value());
            }))
      .Sync("cancelUploads", SyncOf([](const base::ListValue&) {
              Reports::Get().CancelUploads();
              return ModuleResult(base::Value());
            }))
      .Async("gzipFile", base::BindRepeating(&GzipFile))
      .Async("gzipText", base::BindRepeating(&GzipText))
      .Async("upload", base::BindRepeating(&UploadFile));
}

}
