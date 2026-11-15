// Copyright 2026 Ardia. Apache-2.0.

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/modules/telemetry_files.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/callback_list.h"
#include "base/files/file_util.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/thread_pool.h"
#include "base/threading/sequence_bound.h"
#include "base/timer/elapsed_timer.h"
#include "base/timer/timer.h"
#include "chrome/browser/lifetime/application_lifetime_desktop.h"
#include "chrome/common/chrome_paths.h"
#include "third_party/zlib/google/compression_utils.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaTelemetryLocal";
constexpr char kCountsModule[] = "ArdiaLinuxCounts";
constexpr base::TimeDelta kFlushAfter = base::Seconds(2);
constexpr size_t kMostWriteTimings = 4096;

using Buffered = std::map<std::string, std::vector<std::string>, std::less<>>;

struct Exported {
  std::string path;
  int64_t bytes = 0;
  int64_t lines = 0;
};

class TelemetryDisk {
 public:
  explicit TelemetryDisk(base::FilePath data_dir)
      : data_dir_(std::move(data_dir)),
        files_(data_dir_.Append("Telemetry").Append("local")) {}

  void Write(Buffered buffered) {
    for (const auto& [day, lines] : buffered) {
      base::ElapsedTimer timer;
      files_.Append(day, lines);
      write_ms_.push_back(timer.Elapsed().InMillisecondsF());
      if (write_ms_.size() > kMostWriteTimings) {
        write_ms_.erase(write_ms_.begin());
      }
    }
  }

  base::Value Prune(base::Time now, int64_t max_bytes, base::TimeDelta keep) {
    base::ElapsedTimer timer;
    const TelemetryPruned pruned = files_.Prune(now, max_bytes, keep);
    base::DictValue stats;
    stats.Set("bytes", static_cast<double>(pruned.bytes));
    stats.Set("lines", static_cast<double>(pruned.lines));
    stats.Set("files", pruned.files);
    stats.Set("droppedLines", static_cast<double>(pruned.dropped_lines));
    stats.Set("pruneMs", timer.Elapsed().InMillisecondsF());
    base::ListValue writes;
    for (double ms : write_ms_) {
      writes.Append(ms);
    }
    write_ms_.clear();
    stats.Set("writeMs", std::move(writes));
    return base::Value(std::move(stats));
  }

  std::optional<Exported> ExportForReport(base::Time since) {
    int64_t lines = 0;
    const std::string data = files_.Collect(since, &lines);
    if (!lines) {
      return std::nullopt;
    }
    std::string gz;
    if (!compression::GzipCompress(base::as_byte_span(data), &gz)) {
      return std::nullopt;
    }
    const base::FilePath folder =
        data_dir_.Append("Telemetry").Append("export");
    base::CreateDirectory(folder);
    const base::FilePath target = folder.Append("local-events.jsonl.gz");
    if (!base::WriteFile(target, gz)) {
      return std::nullopt;
    }
    return Exported{target.value(), static_cast<int64_t>(gz.size()), lines};
  }

  std::optional<Exported> ExportToDownloads(base::Time now,
                                            base::TimeDelta keep,
                                            base::FilePath downloads) {
    int64_t lines = 0;
    const std::string data = files_.Collect(now - keep, &lines);
    if (!lines) {
      return std::nullopt;
    }
    base::CreateDirectory(downloads);
    const std::string stem = "Ardia data " + UtcDay(now);
    base::FilePath target = downloads.Append(stem + ".jsonl");
    for (int n = 2; base::PathExists(target); ++n) {
      target = downloads.Append(
          base::StrCat({stem, " ", base::NumberToString(n), ".jsonl"}));
    }
    if (!base::WriteFile(target, data)) {
      return std::nullopt;
    }
    return Exported{target.value(), static_cast<int64_t>(data.size()), lines};
  }

  void Clear() { files_.Clear(); }

 private:
  const base::FilePath data_dir_;
  TelemetryFiles files_;
  std::vector<double> write_ms_;
};

base::Value ExportedValue(std::optional<Exported> exported) {
  if (!exported) {
    return base::Value();
  }
  base::DictValue value;
  value.Set("path", exported->path);
  value.Set("bytes", static_cast<double>(exported->bytes));
  value.Set("lines", static_cast<double>(exported->lines));
  return base::Value(std::move(value));
}

base::Time TimeArg(const base::ListValue& args, size_t index) {
  return base::Time::FromMillisecondsSinceUnixEpoch(NumberArg(args, index));
}

class TelemetryLocal {
 public:
  static TelemetryLocal& Get() {
    static base::NoDestructor<TelemetryLocal> local;
    return *local;
  }

  void Start() {
    if (quit_flush_) {
      return;
    }
    quit_flush_ = chrome::AddClosingAllBrowsersCallback(base::BindRepeating(
        [](bool closing) {
          if (closing) {
            TelemetryLocal::Get().Flush();
          }
        }));
  }

  void Append(const std::string& day, std::string text) {
    if (!IsTelemetryDay(day) || text.empty()) {
      return;
    }
    buffered_[day].push_back(std::move(text));
    if (!flush_timer_.IsRunning()) {
      flush_timer_.Start(FROM_HERE, kFlushAfter,
                         base::BindOnce(&TelemetryLocal::Flush,
                                        base::Unretained(this)));
    }
  }

  void AppendNow(const std::string& day, std::string text) {
    if (!IsTelemetryDay(day) || text.empty()) {
      return;
    }
    buffered_[day].push_back(std::move(text));
    Flush();
  }

  void Flush() {
    flush_timer_.Stop();
    if (buffered_.empty()) {
      return;
    }
    disk_.AsyncCall(&TelemetryDisk::Write).WithArgs(std::exchange(buffered_, {}));
  }

  void Configure(double bytes, double days) {
    if (bytes > 0) {
      max_bytes_ = static_cast<int64_t>(bytes);
    }
    if (days > 0) {
      keep_ = base::Days(1) * days;
    }
  }

  void Prune(base::Time now, ModuleReply reply) {
    Flush();
    disk_.AsyncCall(&TelemetryDisk::Prune)
        .WithArgs(now, max_bytes_, keep_)
        .Then(base::BindOnce(
            [](ModuleReply reply, base::Value stats) {
              std::move(reply).Run(std::move(stats));
            },
            std::move(reply)));
  }

  void Clear(ModuleReply reply) {
    buffered_.clear();
    flush_timer_.Stop();
    disk_.AsyncCall(&TelemetryDisk::Clear)
        .Then(base::BindOnce(
            [](ModuleReply reply) { std::move(reply).Run(base::Value()); },
            std::move(reply)));
  }

  void ExportForReport(base::Time since, ModuleReply reply) {
    Flush();
    disk_.AsyncCall(&TelemetryDisk::ExportForReport)
        .WithArgs(since)
        .Then(base::BindOnce(
            [](ModuleReply reply, std::optional<Exported> exported) {
              std::move(reply).Run(ExportedValue(std::move(exported)));
            },
            std::move(reply)));
  }

  void ExportToDownloads(base::Time now, ModuleReply reply) {
    Flush();
    base::FilePath downloads;
    if (!CurrentLaunchConfig().data_directory.empty()) {
      downloads = DataDirectory().Append("Downloads");
    } else {
      base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &downloads);
    }
    disk_.AsyncCall(&TelemetryDisk::ExportToDownloads)
        .WithArgs(now, keep_, downloads)
        .Then(base::BindOnce(
            [](ModuleReply reply, std::optional<Exported> exported) {
              std::move(reply).Run(ExportedValue(std::move(exported)));
            },
            std::move(reply)));
  }

 private:
  friend class base::NoDestructor<TelemetryLocal>;

  TelemetryLocal()
      : disk_(base::ThreadPool::CreateSequencedTaskRunner(
                  {base::MayBlock(), base::TaskPriority::BEST_EFFORT,
                   base::TaskShutdownBehavior::BLOCK_SHUTDOWN}),
              DataDirectory()) {}

  Buffered buffered_;
  base::OneShotTimer flush_timer_;
  int64_t max_bytes_ = 20 * 1024 * 1024;
  base::TimeDelta keep_ = base::Days(30);
  base::SequenceBound<TelemetryDisk> disk_;
  base::CallbackListSubscription quit_flush_;
};

std::map<std::string, int, std::less<>>& LinuxCounts() {
  static base::NoDestructor<std::map<std::string, int, std::less<>>> counts;
  return *counts;
}

}

void CountLinux(std::string_view name) {
  ++LinuxCounts()[std::string(name)];
}

void RegisterTelemetryLocalModule(ModuleRegistry& registry) {
  TelemetryLocal::Get().Start();
  registry.Define(kModule)
      .Sync("append", SyncOf([](const base::ListValue& args) {
              TelemetryLocal::Get().Append(StringArg(args, 0),
                                           StringArg(args, 1));
              return ModuleResult(base::Value());
            }))
      .Sync("appendNow", SyncOf([](const base::ListValue& args) {
              TelemetryLocal::Get().AppendNow(StringArg(args, 0),
                                              StringArg(args, 1));
              return ModuleResult(base::Value());
            }))
      .Sync("configure", SyncOf([](const base::ListValue& args) {
              TelemetryLocal::Get().Configure(NumberArg(args, 0),
                                              NumberArg(args, 1));
              return ModuleResult(base::Value());
            }))
      .Async("prune", AsyncOf([](base::ListValue args, ModuleReply reply) {
               TelemetryLocal::Get().Prune(
                   args.empty() ? base::Time::Now() : TimeArg(args, 0),
                   std::move(reply));
             }))
      .Async("clear", AsyncOf([](base::ListValue, ModuleReply reply) {
               TelemetryLocal::Get().Clear(std::move(reply));
             }))
      .Async("exportForReport",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               TelemetryLocal::Get().ExportForReport(TimeArg(args, 0),
                                                     std::move(reply));
             }))
      .Async("exportToDownloads",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               TelemetryLocal::Get().ExportToDownloads(
                   args.empty() ? base::Time::Now() : TimeArg(args, 0),
                   std::move(reply));
             }));
  registry.Define(kCountsModule)
      .Sync("take", SyncOf([](const base::ListValue&) {
              base::DictValue taken;
              for (const auto& [name, count] : LinuxCounts()) {
                taken.Set(name, count);
              }
              LinuxCounts().clear();
              const ModuleRegistry::SyncTimings timings =
                  ModuleRegistry::Get().TakeSyncTimings();
              if (timings.calls) {
                taken.Set("linux_engine_sync_calls", timings.calls);
              }
              if (timings.slow) {
                taken.Set("linux_engine_sync_slow", timings.slow);
              }
              return ModuleResult(base::Value(std::move(taken)));
            }));
}

}
