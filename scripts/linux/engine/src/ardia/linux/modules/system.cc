// Copyright 2026 Ardia. Apache-2.0.

#include <unistd.h>

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
#include "ardia/linux/modules/desktop_entry.h"
#include "ardia/linux/modules/document_store.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/base_paths.h"
#include "base/environment.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/json/json_writer.h"
#include "base/nix/xdg_util.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/cstring_view.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/functional/callback_helpers.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/icon_manager.h"
#include "chrome/browser/platform_util.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "net/base/filename_util.h"
#include "ui/base/webui/web_ui_util.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/image/image.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaSystem";
constexpr char kScrollBarsFile[] = "scroll-bars.json";
constexpr base::TimeDelta kQueryDeadline = base::Seconds(5);
constexpr base::TimeDelta kSetDeadline = base::Seconds(3);
constexpr base::TimeDelta kToolDeadline = base::Seconds(20);

const DesktopPlaces& Places() {
  static const base::NoDestructor<DesktopPlaces> places([] {
    std::unique_ptr<base::Environment> env = base::Environment::Create();
    return PlacesFor(
        DataDirectory(), !CurrentLaunchConfig().data_directory.empty(),
        base::nix::GetXDGDirectory(env.get(), "XDG_DATA_HOME",
                                   ".local/share"),
        base::nix::GetXDGDirectory(env.get(), base::nix::kXdgConfigHomeEnvVar,
                                   base::nix::kDotConfigDir),
        CurrentLaunchConfig().TestFlag("desktopTools"));
  }());
  return *places;
}

std::string LauncherPath() {
  std::unique_ptr<base::Environment> env = base::Environment::Create();
  for (base::cstring_view name : {base::cstring_view("APPIMAGE"),
                                  base::cstring_view("ARDIA_LAUNCHER")}) {
    if (std::optional<std::string> value = env->GetVar(name);
        value && !value->empty()) {
      return *value;
    }
  }
  base::FilePath exe;
  base::PathService::Get(base::FILE_EXE, &exe);
  return exe.value();
}

bool Background() {
  return CurrentLaunchConfig().background;
}

base::FilePath NativePath(const std::string& text) {
  if (base::StartsWith(text, "file:")) {
    base::FilePath path;
    return net::FileURLToFilePath(GURL(text), &path) ? path : base::FilePath();
  }
  return base::FilePath(text);
}

bool InstalledSystemWide() {
  for (const char* folder :
       {"/usr/share/applications", "/usr/local/share/applications"}) {
    if (base::PathExists(base::FilePath(folder).Append(kDesktopFile))) {
      return true;
    }
  }
  return false;
}

void InstallIcons(const DesktopPlaces& places) {
  base::FilePath exe_dir;
  base::PathService::Get(base::DIR_EXE, &exe_dir);
  base::FileEnumerator icons(exe_dir.Append("icons"), false,
                             base::FileEnumerator::FILES,
                             FILE_PATH_LITERAL("*.png"));
  for (base::FilePath icon = icons.Next(); !icon.empty(); icon = icons.Next()) {
    const base::FilePath folder =
        places.IconsFolder()
            .Append(icon.BaseName().RemoveFinalExtension())
            .Append("apps");
    base::CreateDirectory(folder);
    base::CopyFile(icon, folder.Append("ardia.png"));
  }
}

void EnsureUserDesktopEntry(const DesktopPlaces& places,
                            const std::string& launcher) {
  std::unique_ptr<base::Environment> env = base::Environment::Create();
  if (InstalledSystemWide() && !env->HasVar("APPIMAGE")) {
    return;
  }
  const base::FilePath file = places.UserDesktopFile();
  base::CreateDirectory(file.DirName());
  base::ImportantFileWriter::WriteFileAtomically(file,
                                                 DesktopEntryText(launcher));
  InstallIcons(places);
  if (places.runs_tools) {
    RunTool({"update-desktop-database", file.DirName().value()},
            kToolDeadline, places.tool_environment);
  }
}

std::optional<std::string> Xdg(const DesktopPlaces& places,
                               std::vector<std::string> argv) {
  if (!places.runs_tools) {
    return std::nullopt;
  }
  const bool slow = argv.size() > 1 && (argv[1] == "set" || argv[1] == "default");
  ToolRun run = RunTool(argv, slow ? kToolDeadline : kQueryDeadline,
                        places.tool_environment);
  return run.ok && !run.out.empty() ? std::optional<std::string>(run.out)
                                    : std::nullopt;
}

std::optional<std::string> MimeAppsDefault(const DesktopPlaces& places,
                                           std::string_view type) {
  std::string text;
  if (!base::ReadFileToString(places.MimeAppsFile(), &text)) {
    return std::nullopt;
  }
  return DefaultApplicationIn(text, type);
}

base::DictValue DefaultBrowserState(DesktopPlaces places) {
  std::optional<std::string> browser =
      Xdg(places, {"xdg-settings", "get", "default-web-browser"});
  std::optional<std::string> http =
      Xdg(places, {"xdg-mime", "query", "default", "x-scheme-handler/http"});
  if (!http) {
    http = MimeAppsDefault(places, "x-scheme-handler/http");
  }
  std::optional<std::string> https =
      Xdg(places, {"xdg-mime", "query", "default", "x-scheme-handler/https"});
  if (!https) {
    https = MimeAppsDefault(places, "x-scheme-handler/https");
  }
  base::DictValue state;
  state.Set("desktopFile", kDesktopFile);
  const bool is_default =
      browser == kDesktopFile || (http == kDesktopFile && https == kDesktopFile);
  state.Set("browser", OrNull(browser));
  state.Set("http", OrNull(http));
  state.Set("https", OrNull(https));
  state.Set("isDefault", is_default);
  return state;
}

base::DictValue SetAsDefaultBrowser(DesktopPlaces places, std::string launcher) {
  EnsureUserDesktopEntry(places, launcher);
  bool set = false;
  if (places.runs_tools) {
    ToolRun run = RunTool(
        {"xdg-settings", "set", "default-web-browser", kDesktopFile},
        kSetDeadline, places.tool_environment);
    set = run.ok;
    if (!run.ok) {
      Note("system", base::StrCat({"xdg-settings ",
                                   run.timed_out ? "timed out"
                                                 : "failed: " + run.err,
                                   "; writing mimeapps.list"}));
    }
  } else {
    Note("system",
         "custom data directory: the default browser is set in its own "
         "Desktop folder");
  }
  if (!set) {
    std::vector<std::string> types = BrowserMimeTypes();
    types.push_back("x-scheme-handler/about");
    types.push_back("x-scheme-handler/unknown");
    std::string existing;
    base::ReadFileToString(places.MimeAppsFile(), &existing);
    base::CreateDirectory(places.config_home);
    if (!base::ImportantFileWriter::WriteFileAtomically(
            places.MimeAppsFile(),
            WithDefaultApplications(existing, kDesktopFile, types))) {
      Note("system", "mimeapps.list could not be written");
    }
  }
  return DefaultBrowserState(places);
}

void SetLaunchAtLogin(DesktopPlaces places, std::string launcher, bool on) {
  if (!on) {
    base::DeleteFile(places.AutostartFile());
    return;
  }
  EnsureUserDesktopEntry(places, launcher);
  base::CreateDirectory(places.AutostartFile().DirName());
  base::ImportantFileWriter::WriteFileAtomically(places.AutostartFile(),
                                                 AutostartEntryText(launcher));
}

template <typename Result>
void OnPool(base::OnceCallback<Result()> work,
            base::OnceCallback<void(Result)> done) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      std::move(work), std::move(done));
}

void ReplyWith(ModuleReply reply, base::Value value) {
  std::move(reply).Run(std::move(value));
}

Profile* OriginalProfile() {
  Profile* profile = ProfileManager::GetLastUsedProfileIfLoaded();
  return profile ? profile->GetOriginalProfile() : nullptr;
}

class FilePresence {
 public:
  static FilePresence& Get() {
    static base::NoDestructor<FilePresence> presence;
    return *presence;
  }

  bool Answer(const base::FilePath& path) {
    if (path.empty()) {
      return false;
    }
    auto known = known_.find(path);
    const bool answer = known == known_.end() || known->second;
    Probe(path);
    return answer;
  }

  void Probe(const base::FilePath& path) {
    if (!probing_.insert(path).second) {
      return;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&base::PathExists, path),
        base::BindOnce(&FilePresence::Learn, base::Unretained(this), path));
  }

  void Learn(const base::FilePath& path, bool exists) {
    probing_.erase(path);
    if (known_.size() >= kMostKnownPaths && !known_.contains(path)) {
      known_.clear();
    }
    known_[path] = exists;
  }

 private:
  friend class base::NoDestructor<FilePresence>;
  static constexpr size_t kMostKnownPaths = 1024;

  FilePresence() = default;

  std::map<base::FilePath, bool> known_;
  std::set<base::FilePath> probing_;
};

void WhenFileExists(const std::string& text,
                    ModuleReply reply,
                    base::OnceCallback<base::Value(base::FilePath)> act) {
  const base::FilePath path = NativePath(text);
  if (path.empty()) {
    std::move(reply).Run(base::Value(false));
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&base::PathExists, path),
      base::BindOnce(
          [](base::FilePath path, ModuleReply reply,
             base::OnceCallback<base::Value(base::FilePath)> act,
             bool exists) {
            FilePresence::Get().Learn(path, exists);
            if (!exists) {
              std::move(reply).Run(base::Value(false));
              return;
            }
            std::move(reply).Run(std::move(act).Run(path));
          },
          path, std::move(reply), std::move(act)));
}

void FileIcon(base::ListValue args, ModuleReply reply) {
  const base::FilePath path = NativePath(StringArg(args, 0));
  const double size = NumberArg(args, 1, 32);
  if (path.empty() || !g_browser_process->icon_manager()) {
    std::move(reply).Run(base::Value());
    return;
  }
  static base::NoDestructor<base::CancelableTaskTracker> tracker;
  g_browser_process->icon_manager()->LoadIcon(
      path,
      size <= 16   ? IconLoader::SMALL
      : size <= 32 ? IconLoader::NORMAL
                   : IconLoader::LARGE,
      1.0f,
      base::BindOnce(
          [](ModuleReply reply, gfx::Image image) {
            if (image.IsEmpty()) {
              std::move(reply).Run(base::Value());
              return;
            }
            std::move(reply).Run(
                base::Value(webui::GetBitmapDataUrl(image.AsBitmap())));
          },
          std::move(reply)),
      tracker.get());
}

}

void RegisterSystemModule(ModuleRegistry& registry) {
  registry.Define(kModule)
      .Constant("backgroundInstance", base::Value(Background()))
      .Sync("fileExists", SyncOf([](const base::ListValue& args) {
              return ModuleResult(base::Value(
                  FilePresence::Get().Answer(NativePath(StringArg(args, 0)))));
            }))
      .Sync("hapticTick", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value());
            }))
      .Async("isDefaultBrowser", AsyncOf([](base::ListValue,
                                            ModuleReply reply) {
               OnPool<base::Value>(
                   base::BindOnce([] {
                     return base::Value(
                         DefaultBrowserState(Places()).FindBool("isDefault")
                             .value_or(false));
                   }),
                   base::BindOnce(&ReplyWith, std::move(reply)));
             }))
      .Async("defaultBrowserState", AsyncOf([](base::ListValue,
                                               ModuleReply reply) {
               OnPool<base::Value>(base::BindOnce([] {
                                     return base::Value(
                                         DefaultBrowserState(Places()));
                                   }),
                                   base::BindOnce(&ReplyWith, std::move(reply)));
             }))
      .Async("setAsDefaultBrowser", AsyncOf([](base::ListValue,
                                               ModuleReply reply) {
               if (Background()) {
                 Note("system",
                      "background instance, not setting the default browser");
                 std::move(reply).Run(base::Value(false));
                 return;
               }
               OnPool<base::Value>(
                   base::BindOnce(
                       [](DesktopPlaces places, std::string launcher) {
                         return base::Value(
                             SetAsDefaultBrowser(places, launcher));
                       },
                       Places(), LauncherPath()),
                   base::BindOnce(
                       [](ModuleReply reply, base::Value state) {
                         const bool is_default =
                             state.GetDict().FindBool("isDefault").value_or(false);
                         if (!is_default) {
                           const std::string* browser =
                               state.GetDict().FindString("browser");
                           const std::string* http =
                               state.GetDict().FindString("http");
                           std::string other = browser && !browser->empty()
                                                   ? *browser
                                               : http ? *http
                                                      : "another browser";
                           Note("system",
                                "couldn't make Ardia the default browser");
                           base::DictValue options;
                           options.Set(
                               "title",
                               "Ardia couldn't make itself your default "
                               "browser");
                           options.Set(
                               "message",
                               base::StrCat(
                                   {"The desktop still opens links with ",
                                    other,
                                    ".\n\nYou can choose Ardia as your web "
                                    "browser in your desktop's settings "
                                    "(Default Applications)."}));
                           options.Set("confirmTitle", "OK");
                           options.Set("cancelTitle", "");
                           ConfirmWithUser(options, base::DoNothing());
                         }
                         std::move(reply).Run(base::Value(is_default));
                       },
                       std::move(reply)));
             }))
      .Async("launchAtLoginStatus", AsyncOf([](base::ListValue,
                                               ModuleReply reply) {
               OnPool<base::Value>(
                   base::BindOnce([] {
                     return base::Value(
                         base::PathExists(Places().AutostartFile())
                             ? "enabled"
                             : "notRegistered");
                   }),
                   base::BindOnce(&ReplyWith, std::move(reply)));
             }))
      .Async("setLaunchAtLogin", AsyncOf([](base::ListValue args,
                                            ModuleReply reply) {
               if (Background()) {
                 Note("system",
                      "background instance, not changing launch at login");
                 std::move(reply).Run(base::Value());
                 return;
               }
               OnPool<base::Value>(
                   base::BindOnce(
                       [](DesktopPlaces places, std::string launcher, bool on) {
                         SetLaunchAtLogin(places, launcher, on);
                         return base::Value();
                       },
                       Places(), LauncherPath(), BoolArg(args, 0)),
                   base::BindOnce(&ReplyWith, std::move(reply)));
             }))
      .Async("openFile", AsyncOf([](base::ListValue args, ModuleReply reply) {
               WhenFileExists(
                   StringArg(args, 0), std::move(reply),
                   base::BindOnce([](base::FilePath path) {
                     if (!Background()) {
                       platform_util::OpenItem(
                           OriginalProfile(), path, platform_util::OPEN_FILE,
                           platform_util::OpenOperationCallback());
                     }
                     return base::Value(true);
                   }));
             }))
      .Async("revealFile", AsyncOf([](base::ListValue args,
                                      ModuleReply reply) {
               WhenFileExists(
                   StringArg(args, 0), std::move(reply),
                   base::BindOnce([](base::FilePath path) {
                     if (!Background()) {
                       platform_util::ShowItemInFolder(OriginalProfile(), path);
                     }
                     return base::Value(true);
                   }));
             }))
      .Async("moveToTrash", AsyncOf([](base::ListValue args,
                                       ModuleReply reply) {
               const base::FilePath path = NativePath(StringArg(args, 0));
               if (path.empty()) {
                 std::move(reply).Run(base::Value(false));
                 return;
               }
               OnPool<base::Value>(
                   base::BindOnce(
                       [](base::FilePath path) {
                         return base::Value(
                             base::PathExists(path) &&
                             RunTool({"gio", "trash", "--", path.value()},
                                     kToolDeadline)
                                 .ok);
                       },
                       path),
                   base::BindOnce(
                       [](base::FilePath path, ModuleReply reply,
                          base::Value trashed) {
                         if (trashed.GetBool()) {
                           FilePresence::Get().Learn(path, false);
                         }
                         std::move(reply).Run(std::move(trashed));
                       },
                       path, std::move(reply)));
             }))
      .Async("fileIcon", base::BindRepeating(&FileIcon))
      .Async("runningAppIcon", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value());
             }))
      .Async("setThinScrollBars", AnswerOf([](const base::ListValue& args) {
               base::DictValue saved;
               saved.Set("pageScrollBars",
                         BoolArg(args, 0) ? "thin" : "system");
               Documents().Write(kScrollBarsFile,
                                 base::WriteJson(saved).value_or("{}"));
               return ModuleResult(base::Value());
             }));
}

}
