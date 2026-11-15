// Copyright 2026 Ardia. Apache-2.0.

#include <sys/stat.h>

#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_path_watcher.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/strcat.h"
#include "base/task/bind_post_task.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/threading/sequence_bound.h"
#include "base/timer/timer.h"
#include "third_party/re2/src/re2/re2.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaConfig";
constexpr int64_t kReadLimit = 1 << 20;
constexpr base::TimeDelta kChangeSettle = base::Milliseconds(50);
constexpr const char* kSchemaNames[] = {"config.schema.json",
                                        "theme.schema.json"};

bool IsThemeFile(std::string_view name) {
  static const base::NoDestructor<re2::RE2> theme(
      R"(themes/[a-z0-9][a-z0-9_-]*\.json)");
  return re2::RE2::FullMatch(name, *theme);
}

bool IsWatchable(std::string_view name) {
  return name == "config.json" || name == "hooks.json" || IsThemeFile(name);
}

struct FileRead {
  std::string status;
  std::optional<std::string> text;
  std::optional<std::string> stamp;

  bool operator==(const FileRead&) const = default;

  base::Value ToValue() const {
    base::DictValue value;
    value.Set("status", status);
    if (text) {
      value.Set("text", *text);
    }
    if (stamp) {
      value.Set("stamp", *stamp);
    }
    return base::Value(std::move(value));
  }
};

using Snapshot = std::map<std::string, FileRead, std::less<>>;

std::string Milliseconds(const struct timespec& time) {
  return base::NumberToString(static_cast<double>(time.tv_sec) * 1000 +
                              static_cast<double>(time.tv_nsec) / 1e6);
}

std::string StampOf(const base::FilePath& path) {
  struct stat info;
  if (stat(path.value().c_str(), &info) != 0) {
    return errno == ENOENT ? "missing"
                           : base::StrCat({"unreadable:",
                                           base::NumberToString(errno)});
  }
  return base::StrCat({base::NumberToString(info.st_dev), ":",
                       base::NumberToString(info.st_ino), ":",
                       base::NumberToString(info.st_size), ":",
                       Milliseconds(info.st_mtim), ":",
                       Milliseconds(info.st_ctim)});
}

FileRead ReadOne(const base::FilePath& folder, const std::string& name) {
  const base::FilePath path = folder.Append(name);
  FileRead read;
  if (name == "hooks.json") {
    read.stamp = StampOf(path);
  }
  base::File::Info info;
  if (!base::GetFileInfo(path, &info)) {
    read.status = "missing";
    return read;
  }
  if (info.is_directory) {
    read.status = "notFile";
    return read;
  }
  if (info.size > kReadLimit) {
    read.status = "tooBig";
    return read;
  }
  std::string text;
  if (!base::ReadFileToStringWithMaxSize(path, &text, kReadLimit + 1)) {
    read.status = text.size() > static_cast<size_t>(kReadLimit) ? "tooBig"
                                                                : "unreadable";
    return read;
  }
  if (!base::IsStringUTF8AllowingNoncharacters(text)) {
    read.status = "unreadable";
    return read;
  }
  read.status = "ok";
  read.text = std::move(text);
  return read;
}

Snapshot ReadAll(const base::FilePath& folder) {
  Snapshot snapshot;
  for (const char* name : {"config.json", "hooks.json"}) {
    FileRead read = ReadOne(folder, name);
    if (read.status != "missing" || read.stamp) {
      snapshot[name] = std::move(read);
    }
  }
  base::FileEnumerator themes(folder.Append("themes"), false,
                              base::FileEnumerator::FILES |
                                  base::FileEnumerator::DIRECTORIES);
  for (base::FilePath path = themes.Next(); !path.empty();
       path = themes.Next()) {
    const std::string name = "themes/" + path.BaseName().value();
    if (IsThemeFile(name)) {
      snapshot[name] = ReadOne(folder, name);
    }
  }
  return snapshot;
}

class ConfigReader {
 public:
  using Delivery = base::RepeatingCallback<void(Snapshot)>;

  ConfigReader(base::FilePath folder, Delivery deliver)
      : folder_(std::move(folder)), deliver_(std::move(deliver)) {
    base::CreateDirectory(folder_);
    deliver_.Run(ReadAll(folder_));
    if (!watcher_.Watch(folder_, base::FilePathWatcher::Type::kRecursive,
                        base::BindRepeating(&ConfigReader::Changed,
                                            base::Unretained(this)))) {
      Note("config", "watching the config folder failed");
    }
  }

  void Reread() { deliver_.Run(ReadAll(folder_)); }

  std::vector<std::string> WriteSchemas(base::DictValue files,
                                        const base::FilePath& data_dir) {
    std::vector<std::string> written;
    std::vector<base::FilePath> targets = {data_dir.Append("config-schema")};
    if (base::DirectoryExists(folder_)) {
      targets.push_back(folder_);
    }
    for (const base::FilePath& target : targets) {
      base::CreateDirectory(target);
      for (const char* name : kSchemaNames) {
        const std::string* contents = files.FindString(name);
        if (!contents) {
          continue;
        }
        const base::FilePath path = target.Append(name);
        std::string existing;
        if (base::ReadFileToString(path, &existing) && existing == *contents) {
          continue;
        }
        if (base::ImportantFileWriter::WriteFileAtomically(path, *contents)) {
          written.push_back(path.value());
        }
      }
    }
    return written;
  }

 private:
  void Changed(const base::FilePath&, bool error) {
    if (error) {
      Note("config", "watching the config folder reported an error");
    }
    deliver_.Run(ReadAll(folder_));
  }

  const base::FilePath folder_;
  Delivery deliver_;
  base::FilePathWatcher watcher_;
};

class Config {
 public:
  static Config& Get() {
    static base::NoDestructor<Config> config;
    return *config;
  }

  void Start(base::OnceClosure first_read) {
    first_read_ = std::move(first_read);
    reader_.emplace(base::ThreadPool::CreateSequencedTaskRunner(
                        {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
                         base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN}),
                    CurrentLaunchConfig().config_directory,
                    base::BindPostTaskToCurrentDefault(base::BindRepeating(
                        &Config::Delivered, weak_factory_.GetWeakPtr())));
  }

  base::Value Read(const std::string& name) const {
    if (!IsWatchable(name)) {
      return FileRead{"unreadable", std::nullopt, std::nullopt}.ToValue();
    }
    auto found = snapshot_.find(name);
    if (found != snapshot_.end()) {
      return found->second.ToValue();
    }
    FileRead missing{"missing", std::nullopt, std::nullopt};
    if (name == "hooks.json") {
      missing.stamp = "missing";
    }
    return missing.ToValue();
  }

  void Watch(const base::ListValue* names) {
    watched_.clear();
    if (names) {
      for (const base::Value& name : *names) {
        if (name.is_string() && IsWatchable(name.GetString())) {
          watched_.insert(name.GetString());
        }
      }
    }
    if (!watched_.empty()) {
      reader_.AsyncCall(&ConfigReader::Reread);
    }
  }

  void WriteSchemas(base::DictValue files, ModuleReply reply) {
    reader_.AsyncCall(&ConfigReader::WriteSchemas)
        .WithArgs(std::move(files), DataDirectory())
        .Then(base::BindOnce(
            [](ModuleReply reply, std::vector<std::string> written) {
              base::ListValue list;
              for (std::string& path : written) {
                list.Append(std::move(path));
              }
              std::move(reply).Run(base::Value(std::move(list)));
            },
            std::move(reply)));
  }

 private:
  friend class base::NoDestructor<Config>;

  Config() = default;

  void Delivered(Snapshot snapshot) {
    bool changed = false;
    for (const std::string& name : watched_) {
      auto before = snapshot_.find(name);
      auto after = snapshot.find(name);
      const bool had = before != snapshot_.end();
      const bool has = after != snapshot.end();
      if (had != has || (had && !(before->second == after->second))) {
        changed = true;
        break;
      }
    }
    snapshot_ = std::move(snapshot);
    if (first_read_) {
      std::move(first_read_).Run();
    }
    if (changed) {
      settle_.Start(FROM_HERE, kChangeSettle, base::BindOnce([] {
                      ModuleRegistry::Get().Emit(kModule, "onChange",
                                                 base::Value(base::DictValue()));
                    }));
    }
  }

  Snapshot snapshot_;
  std::set<std::string, std::less<>> watched_;
  base::OnceClosure first_read_;
  base::OneShotTimer settle_;
  base::SequenceBound<ConfigReader> reader_;
  base::WeakPtrFactory<Config> weak_factory_{this};
};

}

void RegisterConfigModule(ModuleRegistry& registry) {
  Config::Get().Start(registry.HoldUiLoad());
  registry.Define(kModule)
      .Sync("readFile", SyncOf([](const base::ListValue& args) {
              return ModuleResult(Config::Get().Read(StringArg(args, 0)));
            }))
      .Async("watch", AnswerOf([](const base::ListValue& args) {
               Config::Get().Watch(ListArg(args, 0));
               return ModuleResult(base::Value());
             }))
      .Async("writeSchemas",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               const base::DictValue* files = DictArg(args, 0);
               Config::Get().WriteSchemas(
                   files ? files->Clone() : base::DictValue(),
                   std::move(reply));
             }));
}

}
