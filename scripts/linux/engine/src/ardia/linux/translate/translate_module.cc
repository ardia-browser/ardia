// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/translate/translate_module.h"

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/translate/translate_models.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/strings/string_split.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"

namespace ardia_linux {

namespace {

using translate::Catalog;
using translate::Manifest;
using translate::PairFiles;

constexpr char kModule[] = "ArdiaTranslate";
constexpr base::TimeDelta kCatalogMaxAge = base::Days(7);
constexpr base::TimeDelta kFetchTimeout = base::Seconds(60);
constexpr base::TimeDelta kDownloadTimeout = base::Minutes(15);
constexpr base::TimeDelta kProgressEvery = base::Milliseconds(200);
constexpr int64_t kLargestCatalog = 64 << 20;
constexpr int64_t kLargestDownload = 512 << 20;

constexpr net::NetworkTrafficAnnotationTag kModelsAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_translation_models", R"(
      semantics {
        sender: "Ardia Translate"
        description: "Downloads Mozilla's list of released translation models "
                     "and the model files for a language the first time a "
                     "page is translated from or to it."
        trigger: "Translating a page into a language whose files aren't "
                 "downloaded yet."
        data: "None."
        destination: OTHER
      }
      policy {
        cookies_allowed: NO
        setting: "None."
        policy_exception_justification: "Not implemented."
      })");

base::FilePath Folder() {
  return DataDirectory().Append("Translations");
}

base::FilePath PairFolder(const std::string& pair) {
  return Folder().Append(translate::PairFolderName(pair));
}

std::string Describe(const std::string& pair) {
  std::string text = pair;
  base::ReplaceSubstringsAfterOffset(&text, 0, ">", " to ");
  return text;
}

network::mojom::URLLoaderFactory* LoaderFactory() {
  return g_browser_process->system_network_context_manager()
      ->GetSharedURLLoaderFactory()
      .get();
}

std::unique_ptr<network::SimpleURLLoader> Loader(const std::string& url,
                                                 base::TimeDelta timeout) {
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GURL(url);
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  auto loader = network::SimpleURLLoader::Create(std::move(request),
                                                 kModelsAnnotation);
  loader->SetTimeoutDuration(timeout);
  return loader;
}

struct Download {
  std::string pair;
  PairFiles entry;
  std::map<std::string, std::unique_ptr<network::SimpleURLLoader>> loaders;
  std::map<std::string, base::FilePath> temps;
  std::map<std::string, uint64_t> received;
  std::vector<base::OnceCallback<void(std::string)>> waiters;
  bool failed = false;
};

class Models {
 public:
  static Models& Get() {
    static base::NoDestructor<Models> models;
    return *models;
  }

  void Start() {
    disk_ = base::ThreadPool::CreateSequencedTaskRunner(
        {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
         base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN});
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce([] {
          std::string json;
          if (!base::ReadFileToStringWithMaxSize(
                  Folder().Append("catalog.json"), &json, kLargestCatalog)) {
            return std::optional<Catalog>();
          }
          return translate::CatalogFromJson(json);
        }),
        base::BindOnce([](std::optional<Catalog> catalog) {
          if (catalog && !Models::Get().catalog_) {
            Models::Get().catalog_ = std::move(catalog);
          }
        }));
  }

  const std::optional<Catalog>& catalog() const { return catalog_; }

  void Installed(const std::string& pair, base::OnceCallback<void(bool)> done) {
    std::optional<std::string> expected_from_catalog_version;
    std::map<std::string, std::string> catalog_hashes;
    if (catalog_) {
      auto found = catalog_->pairs.find(pair);
      if (found != catalog_->pairs.end()) {
        expected_from_catalog_version = found->second.version;
        for (const auto& [type, file] : found->second.files) {
          catalog_hashes[type] = file.hash;
        }
      }
    }
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&translate::ReadManifest, PairFolder(pair)),
        base::BindOnce(&Models::ManifestRead, base::Unretained(this), pair,
                       std::move(expected_from_catalog_version),
                       std::move(catalog_hashes), std::move(done)));
  }

  void CurrentCatalog(
      base::OnceCallback<void(std::optional<Catalog>, std::string)> done) {
    const double now = base::Time::Now().InMillisecondsFSinceUnixEpoch();
    if (catalog_ && now - catalog_->fetched_at < kCatalogMaxAge.InMillisecondsF()) {
      std::move(done).Run(catalog_, std::string());
      return;
    }
    catalog_waiters_.push_back(std::move(done));
    if (catalog_loader_) {
      return;
    }
    catalog_loader_ = Loader(translate::kRegistry, kFetchTimeout);
    catalog_loader_->DownloadToTempFile(
        LoaderFactory(),
        base::BindOnce(&Models::CatalogDownloaded, base::Unretained(this)),
        kLargestCatalog);
  }

  void EnsurePairs(std::vector<std::string> pairs,
                   base::RepeatingCallback<void(uint64_t, uint64_t)> progress,
                   base::OnceCallback<void(int, std::string)> done) {
    auto state = std::make_shared<Ensure>();
    state->progress = std::move(progress);
    state->done = std::move(done);
    state->left = pairs.size();
    for (const std::string& pair : pairs) {
      Installed(pair, base::BindOnce(&Models::Checked, base::Unretained(this),
                                     state, pair));
    }
  }

  base::Value FilesValue(const std::string& pair, const Manifest& manifest) {
    const std::string folder =
        "translations/" + translate::PairFolderName(pair) + "/";
    base::ListValue vocabs;
    if (manifest.files.contains("vocab")) {
      vocabs.Append(folder + "vocab");
    } else {
      vocabs.Append(folder + "srcvocab");
      vocabs.Append(folder + "trgvocab");
    }
    return base::Value(base::DictValue()
                           .Set("model", folder + "model")
                           .Set("lex", folder + "lex")
                           .Set("vocabs", std::move(vocabs)));
  }

  void FilesOf(const std::string& pair,
               base::OnceCallback<void(base::Value)> done) {
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&translate::ReadManifest, PairFolder(pair)),
        base::BindOnce(
            [](std::string pair, base::OnceCallback<void(base::Value)> done,
               std::optional<Manifest> manifest) {
              Models& models = Models::Get();
              if (!manifest) {
                std::move(done).Run(base::Value());
                return;
              }
              models.Installed(
                  pair, base::BindOnce(
                            [](std::string pair, Manifest manifest,
                               base::OnceCallback<void(base::Value)> done,
                               bool installed) {
                              std::move(done).Run(
                                  installed
                                      ? Models::Get().FilesValue(pair, manifest)
                                      : base::Value());
                            },
                            pair, std::move(*manifest), std::move(done)));
            },
            pair, std::move(done)));
  }

 private:
  friend class base::NoDestructor<Models>;
  Models() = default;

  struct Ensure {
    size_t left = 0;
    std::vector<std::string> missing;
    base::RepeatingCallback<void(uint64_t, uint64_t)> progress;
    base::OnceCallback<void(int, std::string)> done;
    std::string error;
    size_t downloads_left = 0;
  };

  static std::string VerificationKey(const std::string& pair,
                                     const Manifest& manifest) {
    std::string key = pair + '\0' + manifest.version;
    for (const auto& [type, file] : manifest.files) {
      base::StrAppend(&key, {"\1", type, "\1", file.hash, "\1",
                             base::NumberToString(file.size)});
    }
    return key;
  }

  void ManifestRead(std::string pair,
                    std::optional<std::string> catalog_version,
                    std::map<std::string, std::string> catalog_hashes,
                    base::OnceCallback<void(bool)> done,
                    std::optional<Manifest> manifest) {
    if (!manifest) {
      std::move(done).Run(false);
      return;
    }
    const std::string key = VerificationKey(pair, *manifest);
    auto known = verified_.find(key);
    if (known != verified_.end()) {
      std::move(done).Run(known->second);
      return;
    }
    std::map<std::string, std::string> expected;
    for (const auto& [type, file] : manifest->files) {
      if (!file.hash.empty()) {
        expected[type] = file.hash;
      } else if (catalog_version == manifest->version &&
                 !catalog_hashes[type].empty()) {
        expected[type] = catalog_hashes[type];
      }
    }
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath folder, std::map<std::string, std::string> expected,
               std::string pair) {
              for (const auto& [type, hash] : expected) {
                std::optional<translate::Digest> digest =
                    translate::DigestOf(folder.Append(type));
                if (!digest || digest->hash != hash) {
                  CountLinux("translate_model_corrupt");
                  Note("translate",
                       base::StrCat({"the cached ", pair, " ", type,
                                     " file doesn't match its checksum; it "
                                     "will be downloaded again"}));
                  return false;
                }
              }
              return true;
            },
            PairFolder(pair), std::move(expected), pair),
        base::BindOnce(
            [](std::string key, base::OnceCallback<void(bool)> done,
               bool matches) {
              Models::Get().verified_[key] = matches;
              std::move(done).Run(matches);
            },
            key, std::move(done)));
  }

  void CatalogDownloaded(base::FilePath temp) {
    const int code = catalog_loader_->ResponseInfo() &&
                             catalog_loader_->ResponseInfo()->headers
                         ? catalog_loader_->ResponseInfo()->headers->response_code()
                         : 0;
    catalog_loader_.reset();
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath temp, int code) {
              std::string json;
              const bool read =
                  !temp.empty() &&
                  base::ReadFileToStringWithMaxSize(temp, &json,
                                                    kLargestCatalog);
              if (!temp.empty()) {
                base::DeleteFile(temp);
              }
              if (!read) {
                return std::make_pair(
                    std::optional<Catalog>(),
                    std::string(code ? "the language list answered " +
                                           base::NumberToString(code)
                                     : "the language list didn't download"));
              }
              std::optional<base::Value> parsed =
                  base::JSONReader::Read(json, base::JSON_PARSE_RFC);
              const base::Value* models =
                  parsed && parsed->is_dict() ? parsed->GetDict().Find("models")
                                              : nullptr;
              Catalog catalog;
              catalog.pairs = models ? translate::CatalogFromRegistry(*models)
                                     : translate::Pairs();
              if (catalog.pairs.empty()) {
                return std::make_pair(std::optional<Catalog>(),
                                      std::string("the language list was empty"));
              }
              catalog.fetched_at =
                  base::Time::Now().InMillisecondsFSinceUnixEpoch();
              base::CreateDirectory(Folder());
              const base::FilePath staging = Folder().Append("catalog.json.tmp");
              if (base::WriteFile(staging, translate::CatalogToJson(catalog))) {
                base::Move(staging, Folder().Append("catalog.json"));
              }
              return std::make_pair(std::optional<Catalog>(std::move(catalog)),
                                    std::string());
            },
            temp, code),
        base::BindOnce(
            [](std::pair<std::optional<Catalog>, std::string> result) {
              Models& models = Models::Get();
              if (result.first) {
                models.catalog_ = std::move(result.first);
              }
              std::vector<base::OnceCallback<void(std::optional<Catalog>,
                                                  std::string)>>
                  waiters = std::move(models.catalog_waiters_);
              for (auto& waiter : waiters) {
                if (models.catalog_) {
                  std::move(waiter).Run(models.catalog_, std::string());
                } else {
                  std::move(waiter).Run(std::nullopt, result.second);
                }
              }
            }));
  }

  void Checked(std::shared_ptr<Ensure> state, std::string pair, bool present) {
    if (!present) {
      state->missing.push_back(pair);
    }
    if (--state->left > 0) {
      return;
    }
    if (state->missing.empty()) {
      std::move(state->done).Run(0, std::string());
      return;
    }
    CurrentCatalog(base::BindOnce(&Models::CatalogReady,
                                  base::Unretained(this), state));
  }

  void CatalogReady(std::shared_ptr<Ensure> state,
                    std::optional<Catalog> catalog,
                    std::string error) {
    if (!catalog) {
      std::move(state->done).Run(0, error);
      return;
    }
    for (const std::string& pair : state->missing) {
      if (!catalog->pairs.contains(pair)) {
        std::move(state->done)
            .Run(0, "Mozilla doesn't offer " + Describe(pair) + " any more");
        return;
      }
    }
    state->downloads_left = state->missing.size();
    for (const std::string& pair : state->missing) {
      auto done = base::BindOnce(&Models::PairDone, base::Unretained(this),
                                 state);
      auto running = downloads_.find(pair);
      if (running != downloads_.end()) {
        running->second->waiters.push_back(std::move(done));
        continue;
      }
      StartDownload(pair, catalog->pairs.at(pair), state->progress,
                    std::move(done));
    }
  }

  void PairDone(std::shared_ptr<Ensure> state, std::string error) {
    if (!error.empty() && state->error.empty()) {
      state->error = error;
    }
    if (--state->downloads_left > 0) {
      return;
    }
    std::move(state->done)
        .Run(static_cast<int>(state->missing.size()), state->error);
  }

  void StartDownload(const std::string& pair,
                     const PairFiles& entry,
                     base::RepeatingCallback<void(uint64_t, uint64_t)> progress,
                     base::OnceCallback<void(std::string)> done) {
    auto download = std::make_unique<Download>();
    download->pair = pair;
    download->entry = entry;
    download->waiters.push_back(std::move(done));
    Download* raw = download.get();
    downloads_[pair] = std::move(download);
    auto totals = std::make_shared<std::pair<uint64_t, uint64_t>>(0, 0);
    for (const auto& [type, file] : entry.files) {
      std::unique_ptr<network::SimpleURLLoader> loader =
          Loader(std::string(translate::kStore) + file.path, kDownloadTimeout);
      loader->SetOnResponseStartedCallback(base::BindOnce(
          [](std::shared_ptr<std::pair<uint64_t, uint64_t>> totals,
             base::RepeatingCallback<void(uint64_t, uint64_t)> progress,
             const GURL&, const network::mojom::URLResponseHead& head) {
            if (head.content_length > 0) {
              totals->second += static_cast<uint64_t>(head.content_length);
            }
            progress.Run(std::min(totals->first, totals->second),
                         totals->second);
          },
          totals, progress));
      loader->SetOnDownloadProgressCallback(base::BindRepeating(
          [](Download* raw, std::string type,
             std::shared_ptr<std::pair<uint64_t, uint64_t>> totals,
             base::RepeatingCallback<void(uint64_t, uint64_t)> progress,
             uint64_t current) {
            uint64_t& seen = raw->received[type];
            totals->first += current - std::min(current, seen);
            seen = current;
            progress.Run(std::min(totals->first, totals->second),
                         totals->second);
          },
          raw, type, totals, progress));
      network::SimpleURLLoader* started = loader.get();
      raw->loaders[type] = std::move(loader);
      started->DownloadToTempFile(
          LoaderFactory(),
          base::BindOnce(&Models::FileDownloaded, base::Unretained(this), pair,
                         type),
          kLargestDownload);
    }
  }

  void FileDownloaded(std::string pair,
                      std::string type,
                      base::FilePath temp) {
    auto found = downloads_.find(pair);
    if (found == downloads_.end()) {
      if (!temp.empty()) {
        disk_->PostTask(FROM_HERE, base::GetDeleteFileCallback(temp));
      }
      return;
    }
    Download& download = *found->second;
    network::SimpleURLLoader* loader = download.loaders[type].get();
    const int code = loader && loader->ResponseInfo() &&
                             loader->ResponseInfo()->headers
                         ? loader->ResponseInfo()->headers->response_code()
                         : 0;
    download.loaders.erase(type);
    if (temp.empty() || code != 200) {
      if (!temp.empty()) {
        disk_->PostTask(FROM_HERE, base::GetDeleteFileCallback(temp));
      }
      Fail(pair, code ? "the download answered " + base::NumberToString(code)
                      : "the download didn't finish");
      return;
    }
    download.temps[type] = temp;
    if (!download.loaders.empty()) {
      return;
    }
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&Models::InstallFiles, pair, download.entry,
                       download.temps),
        base::BindOnce(&Models::Installed_, base::Unretained(this), pair));
  }

  static std::pair<std::optional<Manifest>, std::string> InstallFiles(
      std::string pair,
      PairFiles entry,
      std::map<std::string, base::FilePath> temps) {
    const base::FilePath folder = PairFolder(pair);
    base::CreateDirectory(folder);
    base::DeleteFile(folder.Append("manifest.json"));
    Manifest manifest;
    manifest.version = entry.version;
    std::string error;
    for (const auto& [type, temp] : temps) {
      const translate::RemoteFile& file = entry.files.at(type);
      const base::FilePath staging = folder.Append(type + ".part");
      std::optional<translate::Digest> digest =
          error.empty() ? translate::GunzipInto(temp, staging, file.size)
                        : std::nullopt;
      base::DeleteFile(temp);
      if (!error.empty()) {
        continue;
      }
      if (!digest || (file.size && digest->size != file.size) ||
          (!file.hash.empty() && digest->hash != file.hash)) {
        base::DeleteFile(staging);
        error = "the download didn't match Mozilla's checksum";
        continue;
      }
      if (!base::Move(staging, folder.Append(type))) {
        error = "the language files couldn't be saved";
        continue;
      }
      manifest.files[type] = {digest->size, digest->hash};
    }
    if (!error.empty() || !translate::WriteManifest(folder, manifest)) {
      return {std::nullopt,
              error.empty() ? "the language files couldn't be saved" : error};
    }
    return {std::move(manifest), std::string()};
  }

  void Installed_(std::string pair,
                  std::pair<std::optional<Manifest>, std::string> result) {
    if (result.first) {
      verified_[VerificationKey(pair, *result.first)] = true;
    }
    Finish(pair, result.second);
  }

  void Fail(const std::string& pair, const std::string& error) {
    auto found = downloads_.find(pair);
    if (found == downloads_.end()) {
      return;
    }
    for (auto& [type, temp] : found->second->temps) {
      disk_->PostTask(FROM_HERE, base::GetDeleteFileCallback(temp));
    }
    found->second->temps.clear();
    found->second->loaders.clear();
    Finish(pair, error);
  }

  void Finish(const std::string& pair, const std::string& error) {
    auto found = downloads_.find(pair);
    if (found == downloads_.end()) {
      return;
    }
    std::unique_ptr<Download> download = std::move(found->second);
    downloads_.erase(found);
    for (auto& waiter : download->waiters) {
      std::move(waiter).Run(error);
    }
  }

  scoped_refptr<base::SequencedTaskRunner> disk_;
  std::optional<Catalog> catalog_;
  std::unique_ptr<network::SimpleURLLoader> catalog_loader_;
  std::vector<base::OnceCallback<void(std::optional<Catalog>, std::string)>>
      catalog_waiters_;
  std::map<std::string, bool> verified_;
  std::map<std::string, std::unique_ptr<Download>> downloads_;
};

Models& TheModels() {
  return Models::Get();
}

void Status(base::ListValue args, ModuleReply reply) {
  std::optional<std::vector<std::string>> pairs = translate::Route(
      StringArg(args, 0), StringArg(args, 1), TheModels().catalog());
  if (!pairs) {
    std::move(reply).Run(base::Value("unsupported"));
    return;
  }
  auto left = std::make_shared<size_t>(pairs->size());
  auto all = std::make_shared<bool>(true);
  auto shared_reply = std::make_shared<ModuleReply>(std::move(reply));
  for (const std::string& pair : *pairs) {
    TheModels().Installed(
        pair, base::BindOnce(
                  [](std::shared_ptr<size_t> left, std::shared_ptr<bool> all,
                     std::shared_ptr<ModuleReply> reply, bool installed) {
                    *all = *all && installed;
                    if (--*left == 0) {
                      std::move(*reply).Run(
                          base::Value(*all ? "installed" : "supported"));
                    }
                  },
                  left, all, shared_reply));
  }
}

void Prepare(base::ListValue args, ModuleReply reply) {
  const std::string source = StringArg(args, 0);
  const std::string target = StringArg(args, 1);
  std::optional<std::vector<std::string>> pairs =
      translate::Route(source, target, TheModels().catalog());
  if (!pairs) {
    std::move(reply).Run(ModuleFailure(
        source + " to " + target + " isn't available"));
    return;
  }
  base::ListValue languages;
  for (const std::string& pair : *pairs) {
    for (const std::string& language : base::SplitString(
             pair, ">", base::KEEP_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
      if (language != translate::kPivot &&
          !std::ranges::contains(languages, base::Value(language))) {
        languages.Append(language);
      }
    }
  }
  auto shown_at = std::make_shared<base::TimeTicks>();
  auto progress = base::BindRepeating(
      [](std::string source, std::string target, base::ListValue* languages,
         std::shared_ptr<base::TimeTicks> shown_at, uint64_t received,
         uint64_t total) {
        const base::TimeTicks now = base::TimeTicks::Now();
        if (received < total && now - *shown_at < kProgressEvery) {
          return;
        }
        *shown_at = now;
        ModuleRegistry::Get().Emit(
            kModule, "onDownload",
            base::Value(base::DictValue()
                            .Set("source", source)
                            .Set("target", target)
                            .Set("languages", languages->Clone())
                            .Set("received", static_cast<double>(received))
                            .Set("total", static_cast<double>(total))));
      },
      source, target, base::Owned(new base::ListValue(std::move(languages))),
      shown_at);
  TheModels().EnsurePairs(
      *pairs, std::move(progress),
      base::BindOnce(
          [](std::vector<std::string> pairs, std::string source,
             ModuleReply reply, int downloaded, std::string error) {
            if (!error.empty()) {
              CountLinux("translate_model_download_failures");
              Note("translate", "downloading " + base::JoinString(pairs, ", ") +
                                    " failed: " + error);
              std::move(reply).Run(ModuleFailure(
                  "couldn't download the " + source +
                  " language files: " + error));
              return;
            }
            if (downloaded) {
              CountLinux("translate_model_downloads");
            }
            std::move(reply).Run(base::Value());
          },
          *pairs, source, std::move(reply)));
}

void ModelFiles(base::ListValue args, ModuleReply reply) {
  std::optional<std::vector<std::string>> pairs = translate::Route(
      StringArg(args, 0), StringArg(args, 1), TheModels().catalog());
  if (!pairs) {
    std::move(reply).Run(base::Value());
    return;
  }
  auto collected = std::make_shared<base::ListValue>();
  auto results = std::make_shared<std::map<std::string, base::Value>>();
  auto left = std::make_shared<size_t>(pairs->size());
  auto shared_reply = std::make_shared<ModuleReply>(std::move(reply));
  for (const std::string& pair : *pairs) {
    TheModels().FilesOf(
        pair, base::BindOnce(
                  [](std::vector<std::string> order, std::string pair,
                     std::shared_ptr<std::map<std::string, base::Value>> results,
                     std::shared_ptr<size_t> left,
                     std::shared_ptr<ModuleReply> reply, base::Value files) {
                    (*results)[pair] = std::move(files);
                    if (--*left > 0) {
                      return;
                    }
                    base::ListValue out;
                    for (const std::string& key : order) {
                      base::Value& found = (*results)[key];
                      if (found.is_none()) {
                        std::move(*reply).Run(base::Value());
                        return;
                      }
                      out.Append(base::DictValue()
                                     .Set("key", key)
                                     .Set("files", std::move(found)));
                    }
                    std::move(*reply).Run(base::Value(std::move(out)));
                  },
                  *pairs, pair, results, left, shared_reply));
  }
}

}

void RegisterTranslateModule(ModuleRegistry& registry) {
  TheModels().Start();
  registry.Define(kModule)
      .Constant("available", base::Value(true))
      .Sync("userLanguages", SyncOf([](const base::ListValue&) {
              base::ListValue languages;
              languages.Append(g_browser_process->GetApplicationLocale());
              return ModuleResult(base::Value(std::move(languages)));
            }))
      .Async("status", base::BindRepeating(&Status))
      .Async("supportedLanguages", AnswerOf([](const base::ListValue&) {
               base::ListValue out;
               for (const std::string& language :
                    translate::Languages(TheModels().catalog())) {
                 out.Append(language);
               }
               return ModuleResult(base::Value(std::move(out)));
             }))
      .Async("prepare", base::BindRepeating(&Prepare))
      .Async("modelFiles", base::BindRepeating(&ModelFiles))
      .Async("count", AnswerOf([](const base::ListValue& args) {
               static constexpr std::string_view kEngineCounts[] = {
                   "translate_engine_failures", "translate_engine_timeouts",
                   "translate_requests_refused", "translate_passages_refused",
                   "translate_cancel_stops"};
               const std::string name = StringArg(args, 0);
               if (std::ranges::contains(kEngineCounts, name)) {
                 CountLinux(name);
               }
               return ModuleResult(base::Value());
             }))
      .Async("note", AnswerOf([](const base::ListValue& args) {
               Note("translate", StringArg(args, 0).substr(0, 300));
               return ModuleResult(base::Value());
             }));
}

}
