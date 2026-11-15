// Copyright 2026 Ardia. Apache-2.0.

#include <sys/statvfs.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/app_lifetime.h"
#include "ardia/linux/log.h"
#include "ardia/linux/main.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/process/process.h"
#include "base/process/process_iterator.h"
#include "base/process/process_metrics.h"
#include "base/strings/escape.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/strcat.h"
#include "base/system/sys_info.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/platform_util.h"
#include "chrome/common/chrome_paths.h"
#include "chrome/grit/chrome_unscaled_resources.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/gpu_data_manager.h"
#include "gpu/config/gpu_info.h"
#include "third_party/re2/src/re2/re2.h"
#include "ui/base/resource/resource_bundle.h"
#include "ui/base/webui/web_ui_util.h"
#include "ui/display/screen.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaApp";
constexpr char kHostModule[] = "ArdiaLinuxHost";
constexpr int kNativeApiVersion = 64;
constexpr char kBundleId[] = "dev.ardia.browser";
constexpr char kReleaseNotesPage[] = "https://ardia.dev/release-notes";
constexpr char kBuildFile[] = "ardia.build.json";
constexpr size_t kMostCrashReports = 20;
constexpr base::TimeDelta kKeepCrashDumps = base::Days(30);
constexpr double kBytesPerGiB = 1073741824.0;

struct StartupFacts {
  std::string version = "0.0.0";
  std::string build = "0";
  bool debug = false;
  bool packaged = false;
  std::map<std::string, std::string, std::less<>> os_release;
  std::optional<double> boot_time;
  std::optional<double> load_average;
  double process_start = 0;
};

StartupFacts& Facts() {
  static base::NoDestructor<StartupFacts> facts;
  return *facts;
}

std::map<std::string, std::string, std::less<>> ReadOsRelease() {
  std::map<std::string, std::string, std::less<>> fields;
  std::string text;
  if (!base::ReadFileToString(base::FilePath("/etc/os-release"), &text) &&
      !base::ReadFileToString(base::FilePath("/usr/lib/os-release"), &text)) {
    return fields;
  }
  static const base::NoDestructor<re2::RE2> line(R"(([A-Z_]+)=(.*))");
  for (std::string_view row : base::SplitStringPiece(
           text, "\n", base::KEEP_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    std::string key;
    std::string value;
    if (!re2::RE2::FullMatch(row, *line, &key, &value)) {
      continue;
    }
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
      value = value.substr(1, value.size() - 2);
    }
    fields[key] = value;
  }
  return fields;
}

std::optional<double> ReadBootTime() {
  std::string text;
  if (!base::ReadFileToString(base::FilePath("/proc/stat"), &text)) {
    return std::nullopt;
  }
  for (std::string_view row : base::SplitStringPiece(
           text, "\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    if (base::StartsWith(row, "btime ")) {
      int64_t seconds = 0;
      if (base::StringToInt64(row.substr(6), &seconds)) {
        return static_cast<double>(seconds) * 1000;
      }
    }
  }
  return std::nullopt;
}

std::optional<double> ReadLoadAverage() {
  std::string text;
  if (!base::ReadFileToString(base::FilePath("/proc/loadavg"), &text)) {
    return std::nullopt;
  }
  double load = 0;
  const size_t space = text.find(' ');
  if (!base::StringToDouble(text.substr(0, space), &load)) {
    return std::nullopt;
  }
  return load;
}

std::vector<base::FilePath> BuildFileCandidates() {
  std::vector<base::FilePath> candidates;
  base::FilePath exe_dir;
  if (base::PathService::Get(base::DIR_EXE, &exe_dir)) {
    candidates.push_back(exe_dir.Append(kBuildFile));
  }
  const base::FilePath ui_dir =
      base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(kUiDirSwitch);
  if (!ui_dir.empty()) {
    candidates.push_back(ui_dir.Append(kBuildFile));
  }
  return candidates;
}

StartupFacts ReadStartupFacts(std::vector<base::FilePath> build_files,
                              double process_start) {
  StartupFacts facts;
  facts.process_start = process_start;
  for (size_t i = 0; i < build_files.size(); ++i) {
    std::string text;
    if (!base::ReadFileToString(build_files[i], &text)) {
      continue;
    }
    std::optional<base::DictValue> build =
        base::JSONReader::ReadDict(text, base::JSON_PARSE_RFC);
    if (!build) {
      continue;
    }
    if (const std::string* version = build->FindString("version")) {
      facts.version = *version;
    }
    if (const std::string* number = build->FindString("build")) {
      facts.build = *number;
    } else if (std::optional<int> build_number = build->FindInt("build")) {
      facts.build = base::NumberToString(*build_number);
    }
    facts.debug = build->FindBool("debug").value_or(false);
    facts.packaged = i == 0;
    break;
  }
  facts.os_release = ReadOsRelease();
  facts.boot_time = ReadBootTime();
  facts.load_average = ReadLoadAverage();
  return facts;
}

std::string ArchName() {
  const std::string arch = base::SysInfo::OperatingSystemArchitecture();
  if (arch == "x86_64") {
    return "x64";
  }
  if (arch == "aarch64" || arch == "arm64") {
    return "arm64";
  }
  return arch;
}

std::string KernelRelease() {
  return base::SysInfo::OperatingSystemVersion();
}

base::Value Nullable(std::optional<double> number) {
  return number ? base::Value(*number) : base::Value();
}

std::string OsReleaseField(std::string_view key) {
  auto found = Facts().os_release.find(key);
  return found == Facts().os_release.end() ? std::string() : found->second;
}

base::Value SystemInfo() {
  const LaunchConfig& config = CurrentLaunchConfig();
  const StartupFacts& facts = Facts();
  base::DictValue info;
  info.Set("appName", "Ardia");
  info.Set("appVersion", facts.version);
  info.Set("appBuild", facts.build);
  info.Set("bundleId", kBundleId);
  info.Set("configuration", facts.debug ? "Debug" : "Release");
  std::string os_version = OsReleaseField("VERSION_ID");
  if (os_version.empty()) {
    os_version = KernelRelease().substr(0, KernelRelease().find('-'));
  }
  info.Set("osVersion", os_version.empty() ? "0" : os_version);
  info.Set("osBuild", KernelRelease());
  std::string os_name = OsReleaseField("PRETTY_NAME");
  if (os_name.empty()) {
    os_name = OsReleaseField("NAME");
  }
  info.Set("osName", os_name.empty() ? "Linux" : os_name);
  info.Set("arch", ArchName());
  info.Set("model", "PC");
  info.Set("memoryGB",
           static_cast<double>(
               base::SysInfo::AmountOfTotalPhysicalMemory().InBytes()) /
               kBytesPerGiB);
  info.Set("locale", g_browser_process
                         ? g_browser_process->GetApplicationLocale()
                         : std::string("en-US"));
  info.Set("feedbackURL", config.feedback_url.empty()
                              ? base::Value()
                              : base::Value(config.feedback_url));
  info.Set("releaseNotesURL", kReleaseNotesPage);
  info.Set("isolatedInstance", !config.data_directory.empty());
  info.Set("forceReleaseNotes", config.InstanceFlag("releaseNotes"));
  info.Set("processStart", facts.process_start);
  info.Set("bootTime", Nullable(facts.boot_time));
  info.Set("launchedHidden", config.background);
  info.Set("loadAverage1m", Nullable(facts.load_average));
  info.Set("inApplicationsFolder", facts.packaged);
  info.Set("linuxBackend", "chromium");
  info.Set("engineVersion", std::string(version_info::GetVersionNumber()));
  return base::Value(std::move(info));
}

bool OpensExternally(const GURL& url) {
  if (!url.is_valid()) {
    return false;
  }
  static const base::NoDestructor<std::set<std::string_view>> refused(
      {"javascript", "data", "file", "about", "chrome", "devtools",
       "chrome-extension", "blob", "filesystem"});
  return !refused->contains(url.scheme());
}

bool OpenExternal(const std::string& text) {
  const GURL url(text);
  if (!OpensExternally(url)) {
    return false;
  }
  if (CurrentLaunchConfig().background) {
    Note("app", base::StrCat({"background instance, not opening an external "
                              "URL (",
                              url.scheme(), ")"}));
    NoteActivation(base::StrCat({"open external (not opened): ",
                                 url.scheme()}));
    return true;
  }
  platform_util::OpenExternal(url);
  return true;
}

void Share(const std::string& url, const std::string& title) {
  OpenExternal(base::StrCat(
      {"mailto:?subject=", base::EscapeAllExceptUnreserved(title),
       "&body=", base::EscapeAllExceptUnreserved(url)}));
}

struct DecodeSupport {
  bool av1 = false;
  bool vp9 = false;
  bool hevc = false;
  bool h264 = false;
};

DecodeSupport DecodesOf(const gpu::GPUInfo& gpu) {
  DecodeSupport found;
  for (const auto& entry : gpu.video_decode_accelerator_supported_profiles) {
    const int profile = entry.profile;
    if (profile >= gpu::H264PROFILE_BASELINE &&
        profile <= gpu::H264PROFILE_MULTIVIEWHIGH) {
      found.h264 = true;
    } else if (profile >= gpu::VP9PROFILE_PROFILE0 &&
               profile <= gpu::VP9PROFILE_PROFILE3) {
      found.vp9 = true;
    } else if ((profile >= gpu::HEVCPROFILE_MAIN &&
                profile <= gpu::HEVCPROFILE_MAIN_STILL_PICTURE) ||
               (profile >= gpu::HEVCPROFILE_REXT &&
                profile <= gpu::HEVCPROFILE_HIGH_THROUGHPUT_SCREEN_EXTENDED)) {
      found.hevc = true;
    } else if (profile >= gpu::AV1PROFILE_PROFILE_MAIN &&
               profile <= gpu::AV1PROFILE_PROFILE_PRO) {
      found.av1 = true;
    }
  }
  return found;
}

base::Value HardwareInfo() {
  base::DictValue info;
  std::string chip = base::SysInfo::CPUModelName();
  info.Set("chip", chip.empty() ? ArchName() : chip);
  const gpu::GPUInfo gpu = content::GpuDataManager::GetInstance()->GetGPUInfo();
  const gpu::GPUInfo::GPUDevice& device = gpu.active_gpu();
  std::string gpu_name = base::JoinString(
      {device.vendor_string, device.device_string}, " ");
  base::TrimWhitespaceASCII(gpu_name, base::TRIM_ALL, &gpu_name);
  if (gpu_name.empty()) {
    gpu_name = device.driver_vendor;
  }
  if (!gpu_name.empty()) {
    info.Set("gpu", gpu_name);
  }
  info.Set("memoryGB",
           static_cast<int>(std::round(
               static_cast<double>(
                   base::SysInfo::AmountOfTotalPhysicalMemory().InBytes()) /
               kBytesPerGiB)));
  double max_scale = 1;
  int displays = 0;
  if (display::Screen* screen = display::Screen::Get()) {
    for (const display::Display& each : screen->GetAllDisplays()) {
      ++displays;
      max_scale = std::max(max_scale,
                           static_cast<double>(each.device_scale_factor()));
    }
  }
  info.Set("displays", displays);
  info.Set("maxScale", max_scale);
  const DecodeSupport decodes = DecodesOf(gpu);
  base::DictValue decode;
  decode.Set("av1", decodes.av1);
  decode.Set("vp9", decodes.vp9);
  decode.Set("hevc", decodes.hevc);
  decode.Set("h264", decodes.h264);
  info.Set("hardwareDecode", std::move(decode));
  return base::Value(std::move(info));
}

std::vector<base::ProcessId> AppProcesses() {
  const base::ProcessId browser = base::GetCurrentProcId();
  std::map<base::ProcessId, base::ProcessId> parents;
  base::ProcessIterator processes(nullptr);
  while (const base::ProcessEntry* entry = processes.NextProcessEntry()) {
    parents[entry->pid()] = entry->parent_pid();
  }
  std::vector<base::ProcessId> ours;
  for (const auto& [pid, parent] : parents) {
    base::ProcessId step = pid;
    for (int depth = 0; depth < 16 && step > 1; ++depth) {
      if (step == browser) {
        ours.push_back(pid);
        break;
      }
      auto up = parents.find(step);
      if (up == parents.end()) {
        break;
      }
      step = up->second;
    }
  }
  return ours;
}

base::Value DiagnosticsSample(base::FilePath data_dir) {
  base::DictValue sample;
  uint64_t resident = 0;
  for (base::ProcessId pid : AppProcesses()) {
    auto metrics = base::ProcessMetrics::CreateProcessMetrics(pid);
    if (auto memory = metrics->GetMemoryInfo(); memory.has_value()) {
      resident += memory->resident_set_bytes;
    }
  }
  if (resident) {
    sample.Set("footprintMB",
               static_cast<int>(resident / (1024 * 1024)));
  }
  if (std::optional<int64_t> free =
          base::SysInfo::AmountOfFreeDiskSpace(data_dir)) {
    sample.Set("freeDiskGB",
               std::round(static_cast<double>(*free) / 107374182.4) / 10);
  }
  return base::Value(std::move(sample));
}

std::optional<std::string> AnnotationOf(std::string_view dump,
                                        std::string_view key) {
  const std::string needle = base::StrCat({key, std::string_view("\0", 1)});
  const size_t at = dump.find(needle);
  if (at == std::string_view::npos) {
    return std::nullopt;
  }
  std::string_view tail = dump.substr(at + needle.size(), 200);
  size_t start = 0;
  while (start < tail.size()) {
    size_t end = start;
    while (end < tail.size() && tail[end] >= 0x20 && tail[end] <= 0x7e &&
           end - start < 64) {
      ++end;
    }
    if (end - start >= 2) {
      return std::string(tail.substr(start, end - start));
    }
    start = end + 1;
  }
  return std::nullopt;
}

std::string CrashedProcessOf(std::string_view dump) {
  std::optional<std::string> type = AnnotationOf(dump, "ptype");
  if (!type) {
    type = AnnotationOf(dump, "process_type");
  }
  static const base::NoDestructor<std::map<std::string, std::string>> kinds(
      std::map<std::string, std::string>{{"browser", "browser"},
                                         {"renderer", "renderer"},
                                         {"gpu-process", "gpu"},
                                         {"utility", "utility"},
                                         {"ppapi", "plugin"}});
  if (type) {
    if (auto found = kinds->find(*type); found != kinds->end()) {
      return found->second;
    }
  }
  return "browser";
}

base::Value CrashReports(double since,
                         base::FilePath crash_dir,
                         std::string app_version,
                         std::string app_build) {
  struct Dump {
    base::FilePath path;
    double file_time;
  };
  std::vector<Dump> dumps;
  const base::Time now = base::Time::Now();
  for (const char* state : {"completed", "pending"}) {
    base::FileEnumerator files(crash_dir.Append(state), false,
                               base::FileEnumerator::FILES,
                               FILE_PATH_LITERAL("*.dmp"));
    for (base::FilePath path = files.Next(); !path.empty();
         path = files.Next()) {
      const base::Time modified = files.GetInfo().GetLastModifiedTime();
      if (now - modified > kKeepCrashDumps) {
        base::DeleteFile(path);
        continue;
      }
      const double file_time = modified.InMillisecondsFSinceUnixEpoch();
      if (file_time > since) {
        dumps.push_back({path, file_time});
      }
    }
  }
  std::sort(dumps.begin(), dumps.end(), [](const Dump& a, const Dump& b) {
    return a.file_time < b.file_time;
  });
  if (dumps.size() > kMostCrashReports) {
    dumps.erase(dumps.begin(), dumps.end() - kMostCrashReports);
  }
  base::ListValue reports;
  for (const Dump& dump : dumps) {
    std::string bytes;
    base::ReadFileToStringWithMaxSize(dump.path, &bytes, 8 << 20);
    const std::string crashed = CrashedProcessOf(bytes);
    base::DictValue report;
    report.Set("time", dump.file_time);
    report.Set("fileTime", dump.file_time);
    report.Set("process", crashed);
    if (crashed == "browser") {
      report.Set("appVersion", app_version);
      report.Set("build", app_build);
    }
    report.Set("engineVersion", std::string(version_info::GetVersionNumber()));
    report.Set("frames", base::ListValue());
    reports.Append(std::move(report));
  }
  return base::Value(std::move(reports));
}

base::Value AppIcon() {
  std::string_view png = ui::ResourceBundle::GetSharedInstance()
                             .GetRawDataResource(IDR_PRODUCT_LOGO_256);
  if (png.empty()) {
    return base::Value("");
  }
  return base::Value(webui::GetPngDataUrl(base::as_byte_span(png)));
}

ModuleResult Done() {
  return base::Value();
}

}

void RegisterAppModule(ModuleRegistry& registry) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&ReadStartupFacts, BuildFileCandidates(),
                     base::Process::Current()
                         .CreationTime()
                         .InMillisecondsFSinceUnixEpoch()),
      base::BindOnce(
          [](base::OnceClosure release, StartupFacts facts) {
            Facts() = std::move(facts);
            Note("app", base::StrCat({"version ", Facts().version, " (",
                                      Facts().build, ")"}));
            if (ModuleRegistry::Exists()) {
              ModuleRegistry::Get()
                  .Define(kModule)
                  .Constant("appVersion", base::Value(Facts().version))
                  .Constant("appBuild", base::Value(Facts().build));
            }
            std::move(release).Run();
          },
          registry.HoldUiLoad()));

  registry.Define(kModule)
      .Constant("apiVersion", base::Value(kNativeApiVersion))
      .Constant("linuxApiVersion", base::Value(kNativeApiVersion))
      .Constant("linuxBackend", base::Value("chromium"))
      .Sync("systemInfo", SyncOf([](const base::ListValue&) {
              return ModuleResult(SystemInfo());
            }))
      .Sync("launchConfig", SyncOf([](const base::ListValue&) {
              return ModuleResult(
                  base::Value(CurrentLaunchConfig().ToValue()));
            }))
      .Sync("launchEnvironment", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value());
            }))
      .Async("openExternalURL", AnswerOf([](const base::ListValue& args) {
               return ModuleResult(base::Value(OpenExternal(StringArg(args, 0))));
             }))
      .Async("hardwareInfo", AnswerOf([](const base::ListValue&) {
               return ModuleResult(HardwareInfo());
             }))
      .Async("diagnosticsSample",
             AsyncOf([](base::ListValue, ModuleReply reply) {
               base::ThreadPool::PostTaskAndReplyWithResult(
                   FROM_HERE,
                   {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
                   base::BindOnce(&DiagnosticsSample, DataDirectory()),
                   base::BindOnce(
                       [](ModuleReply reply, base::Value sample) {
                         std::move(reply).Run(std::move(sample));
                       },
                       std::move(reply)));
             }))
      .Async("crashReports", AsyncOf([](base::ListValue args,
                                        ModuleReply reply) {
               base::FilePath crash_dir;
               base::PathService::Get(chrome::DIR_CRASH_DUMPS, &crash_dir);
               if (!DataDirectory().IsParent(crash_dir)) {
                 Note("app", "crash dumps are outside the data folder; not "
                             "reading them");
                 std::move(reply).Run(base::Value(base::ListValue()));
                 return;
               }
               base::ThreadPool::PostTaskAndReplyWithResult(
                   FROM_HERE,
                   {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
                   base::BindOnce(&CrashReports, NumberArg(args, 0),
                                  crash_dir, Facts().version, Facts().build),
                   base::BindOnce(
                       [](ModuleReply reply, base::Value reports) {
                         std::move(reply).Run(std::move(reports));
                       },
                       std::move(reply)));
             }))
      .Async("appIcons", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(base::ListValue()));
             }))
      .Async("appIcon", AnswerOf([](const base::ListValue&) {
               return ModuleResult(AppIcon());
             }))
      .Async("setAppIcon",
             AnswerOf([](const base::ListValue&) { return Done(); }))
      .Async("isInDock", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(false));
             }))
      .Async("addToDock", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(false));
             }))
      .Async("setWindowActivity",
             AnswerOf([](const base::ListValue&) { return Done(); }))
      .Async("share", AnswerOf([](const base::ListValue& args) {
               Share(StringArg(args, 0), StringArg(args, 1));
               return Done();
             }))
      .Async("shareVia", AnswerOf([](const base::ListValue& args) {
               const std::string service = StringArg(args, 0);
               if (service == "mail" || service == "email") {
                 Share(StringArg(args, 1), StringArg(args, 2));
               }
               return Done();
             }))
      .Async("shareText",
             AnswerOf([](const base::ListValue&) { return Done(); }))
      .Async("quitApp", AnswerOf([](const base::ListValue&) {
               AppLifetime::Get().RequestQuit();
               return Done();
             }));

  registry.Define(kHostModule)
      .Sync("dataDirectory", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(DataDirectory().value()));
            }))
      .Sync("configDirectory", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(
                  CurrentLaunchConfig().config_directory.value()));
            }))
      .Sync("background", SyncOf([](const base::ListValue&) {
              return ModuleResult(
                  base::Value(CurrentLaunchConfig().background));
            }))
      .Sync("version", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(Facts().version));
            }));
}

}
