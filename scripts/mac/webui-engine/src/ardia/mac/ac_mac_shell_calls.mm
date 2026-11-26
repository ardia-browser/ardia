#import <AppKit/AppKit.h>

#include <dlfcn.h>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "ardia/linux/ac_linux_search_engines.h"
#include "ardia/linux/ac_linux_session.h"
#include "ardia/mac/ac_mac_extension_view.h"
#include "ardia/mac/ac_mac_link_gesture.h"
#include "ardia/mac/ac_mac_pip.h"
#include "ardia/mac/ac_mac_glass.h"
#include "ardia/mac/ac_mac_menu.h"
#include "ardia/mac/ac_mac_shell_bridge.h"
#include "ardia/mac/ac_mac_page_commands.h"
#include "ardia/mac/ac_mac_page_policy.h"
#include "ardia/mac/ac_mac_shell_host.h"
#include "ardia/mac/ac_mac_popover_policy.h"
#include "ardia/mac/ac_mac_share.h"
#include "ardia/mac/ac_mac_shared_folders.h"
#include "ardia/mac/ac_mac_shell_policy.h"
#include "ardia/mac/ac_mac_swipe.h"
#include "ardia/mac/ac_mac_system.h"
#include "ardia/mac/generated/ac_desktop_routes.h"
#include "ardia/mac/generated/ac_desktop_window_commands.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/time/time.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/task_traits.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "components/version_info/version_info.h"
#include "ui/base/clipboard/clipboard.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/base/base_window.h"
#include "ui/views/widget/widget.h"

namespace ardia_mac {

namespace {

constexpr size_t kDocumentLimit = 8 * 1024 * 1024;

typedef void (*EngineReply)(void* context, const char* json);
typedef void (*EngineFunction)(const char* profile_dir,
                               const char* args_json,
                               EngineReply reply,
                               void* context);

constexpr std::string_view kPopoverCapabilities[] = {
    "shell.popover.open",
    "shell.popover.update",
    "shell.popover.close",
    "shell.popover.beyondWindow",
};

constexpr std::string_view kInvokedEngineCalls[] = {
    "engine.info",
    "tabs.strips",
    "search.setEngineName",
};

constexpr std::string_view kInertEngineCalls[] = {
    "engine.memorySaver",
    "engine.systemState",
    "webKit.setFraudWarnings",
    "webView.setSelectionPopover",
};

template <std::size_t N>
bool ListedCall(const std::string_view (&names)[N], std::string_view name) {
  return std::ranges::find(names, name) != std::end(names);
}

constexpr std::string_view kCapabilities[] = {
    "shell.inputRegions",
    "shell.glassRegions",
    "shell.glassBehindWindow",
    "shell.backdropRegions",
    "shell.backdropRegions.windowTreatment",
    "shell.windowBackdrop",
    "shell.showContextMenu",
    "shell.trafficLights",
    "ArdiaShell.setMainMenu",
    "ArdiaShell.setMenuState",
    "ArdiaShell.setMenuBookmarks",
    "ArdiaShell.windowIdentity",
    "ArdiaShell.copyText",
    "ArdiaShell.readText",
    "ArdiaShell.quit",
    "ArdiaShell.startWindowMove",
    "ArdiaShell.captionDoubleClick",
    "ArdiaShell.startDictation",
    ardia::desktop_commands::kEditCapability,
    "ArdiaShell.openWindow",
    "ArdiaShell.focusWindow",
    "ArdiaShell.windowIds",
};

scoped_refptr<base::SequencedTaskRunner> FileRunner() {
  return SessionFiles();
}

base::FilePath DocumentDirectory() {
  return DataDirectory();
}

constexpr size_t kBootstrapBudget = 8 * 1024 * 1024;

bool ValidDocumentName(const std::string& name) {
  return shell_policy::ValidDocumentName(name);
}

bool MoveSessionAside(const base::FilePath& path) {
  const std::uint64_t now = static_cast<std::uint64_t>(
      std::max<int64_t>(0, base::Time::Now().InMillisecondsSinceUnixEpoch()));
  for (int attempt = 0; attempt < shell_policy::kSetAsideAttempts; ++attempt) {
    const base::FilePath backup =
        DataDirectory().Append(shell_policy::SetAsideSessionName(now, attempt));
    if (base::PathExists(backup)) {
      continue;
    }
    return base::Move(path, backup);
  }
  return false;
}

static_assert(shell_policy::kMergeableSessionBytes == ardia::kLinuxSessionMaxBytes);

struct SessionRead {
  shell_policy::SessionLoad load = shell_policy::SessionLoad::kAbsent;
  std::optional<base::DictValue> session;
};

SessionRead ReadSessionForMerge() {
  const base::FilePath path = DataDirectory().Append("session.json");
  const std::optional<int64_t> size = base::GetFileSize(path);
  if (!size) {
    return SessionRead{};
  }
  const std::size_t bytes = static_cast<std::size_t>(std::max<int64_t>(0, *size));
  std::string text;
  std::optional<base::Value> parsed;
  if (bytes <= shell_policy::kMergeableSessionBytes &&
      base::ReadFileToStringWithMaxSize(path, &text, shell_policy::kMergeableSessionBytes)) {
    parsed = base::JSONReader::Read(text, base::JSON_PARSE_RFC);
  }
  const bool object = parsed && parsed->is_dict();
  const shell_policy::SessionFile file = shell_policy::SessionFileFor(
      true, bytes, object, object && ardia::ValidLinuxSession(parsed->GetDict()));
  const bool moved = file == shell_policy::SessionFile::kSetAside && MoveSessionAside(path);
  SessionRead read{shell_policy::SessionLoadFor(file, moved), std::nullopt};
  if (read.load == shell_policy::SessionLoad::kBlocked) {
    LOG(WARNING) << "Ardia Mac WebUI: session.json cannot be merged or set aside; saves are refused";
  }
  if (read.load == shell_policy::SessionLoad::kUse) {
    read.session = std::move(parsed->GetDict());
  }
  return read;
}

std::optional<base::DictValue> ReadSessionFile() {
  return ReadSessionForMerge().session;
}

bool WriteSessionFile(const base::DictValue& session) {
  std::optional<std::string> json = base::WriteJsonWithOptions(
      session, base::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION, ardia::kLinuxSessionMaxDepth);
  if (!json || !shell_policy::SessionFitsOnDisk(json->size())) {
    return false;
  }
  return base::ImportantFileWriter::WriteFileAtomically(
      DataDirectory().Append("session.json"), *json);
}

base::DictValue ReadDocuments() {
  base::DictValue documents;
  base::FileEnumerator files(DocumentDirectory(), false,
                             base::FileEnumerator::FILES);
  size_t budget = kBootstrapBudget;
  for (base::FilePath path = files.Next(); !path.empty(); path = files.Next()) {
    std::string text;
    const std::string name = path.BaseName().value();
    if (ValidDocumentName(name) && name.ends_with(".json") &&
        !name.starts_with("session-backup") && !DocumentSession::Reserved(name) &&
        files.GetInfo().GetSize() <= static_cast<int64_t>(kDocumentLimit) &&
        static_cast<size_t>(files.GetInfo().GetSize()) <= budget &&
        base::ReadFileToStringWithMaxSize(path, &text, kDocumentLimit)) {
      budget -= text.size();
      documents.Set(name, std::move(text));
    }
  }
  return documents;
}

void Reply(ShellHostView::Done done, base::Value value) {
  std::move(done).Run(true, std::move(value));
}

void* EngineImage() {
  static void* image = [] {
    Dl_info info;
    if (!dladdr(reinterpret_cast<void*>(&EngineImage), &info) || !info.dli_fname) {
      return static_cast<void*>(nullptr);
    }
    return dlopen(info.dli_fname, RTLD_LAZY | RTLD_NOLOAD);
  }();
  return image;
}

void ServiceCall(base::WeakPtr<ShellHostView> host,
                 std::string name,
                 std::optional<base::Value> args,
                 ShellHostView::Done done,
                 Profile* profile) {
  const base::Value* given = args ? &*args : nullptr;
  if (host && host->system() && SystemServices::HandlesEngineCall(name)) {
    return host->system()->EngineCall(name, profile, given, std::move(done));
  }
  if (host && host->extension_views() && ExtensionViews::HandlesEngineCall(name)) {
    return host->extension_views()->EngineCall(name, profile, given, std::move(done));
  }
  std::move(done).Run(false, Failure("ERR_WINDOW_CLOSED", "The window closed"));
}

}

scoped_refptr<base::SequencedTaskRunner> SessionFiles() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}

MergedSession MergeAndWriteSession(base::DictValue base, base::DictValue local) {
  MergedSession result;
  SessionRead read = ReadSessionForMerge();
  if (!shell_policy::SessionWritable(read.load)) {
    result.blocked = true;
    return result;
  }
  if (read.session) {
    result.previous = std::move(*read.session);
  }
  std::optional<base::DictValue> merged =
      ardia::MergeLinuxSession(base, local, result.previous);
  if (!merged || !WriteSessionFile(*merged)) {
    return result;
  }
  result.session = std::move(*merged);
  result.ok = true;
  return result;
}

void BroadcastSession(const MergedSession& merged,
                      const std::string& source_window,
                      const base::DictValue* source_base) {
  if (!merged.ok || merged.previous == merged.session) {
    return;
  }
  for (ShellHostView* host : Hosts()) {
    const bool source = host->window_id() == source_window;
    host->Emit("ArdiaHost", "session",
               base::Value(base::DictValue()
                               .Set("base", source && source_base
                                                ? source_base->Clone()
                                                : merged.previous.Clone())
                               .Set("session", merged.session.Clone())
                               .Set("sourceWindowId", source_window)));
  }
}

std::string ShellHostView::BootstrapJson() const {
  base::DictValue info;
  info.Set("appName", "Ardia");
  info.Set("appVersion", std::string(version_info::GetVersionNumber()));
  info.Set("appBuild", "mac-webui");
  info.Set("bundleId", "dev.ardia.mac.webui");
  info.Set("configuration", "Release");
  info.Set("osVersion", base::SysInfo::OperatingSystemVersion());
  info.Set("osBuild", "macOS");
  info.Set("arch", base::SysInfo::OperatingSystemArchitecture());
  info.Set("model", base::SysInfo::HardwareModelName());
  info.Set("memoryGB", base::SysInfo::AmountOfTotalPhysicalMemory().InBytes() /
                           (1024.0 * 1024 * 1024));
  info.Set("locale", "en-US");
  info.Set("updates", false);
  info.Set("isolatedInstance", true);
  base::ListValue capabilities;
  for (std::string_view capability : kCapabilities) {
    capabilities.Append(capability);
  }
  SystemServices::AppendCapabilities(capabilities);
  ExtensionViews::AppendCapabilities(capabilities);
  PipPresenter::AppendCapabilities(capabilities);
  ScrollGestures::AppendCapabilities(capabilities);
  if (popover::kPopoverRendererShipped) {
    for (std::string_view capability : kPopoverCapabilities) {
      capabilities.Append(capability);
    }
  }
  share::AppendCapabilities(capabilities);
  shared_folders::AppendCapabilities(capabilities);
  for (std::string_view capability : LifecycleCapabilities()) {
    capabilities.Append(capability);
  }
  for (const auto& route : ardia::desktop_routes::kRoutes) {
    capabilities.Append(route.name);
  }
  for (std::string_view route : page_policy::kZoomRoutes) {
    capabilities.Append(route);
  }
  AppendLinkCapabilities(capabilities);
  base::DictValue bootstrap;
  bootstrap.Set("windowId", window_id_);
  bootstrap.Set("startup", startup_);
  bootstrap.Set("profileId", "default");
  bootstrap.Set(
      "nativeModules",
      base::DictValue()
          .Set("ArdiaApp", base::DictValue().Set("systemInfo", std::move(info)))
          .Set("ArdiaGlassEffect",
               base::DictValue().Set("isLiquidGlass", LiquidGlassAvailable())));
  bootstrap.Set("capabilities", std::move(capabilities));
  bootstrap.Set("glassPanels", true);
  bootstrap.Set("pageProfile", page_profile_);
  bootstrap.Set("windowKind", kind_);
  if (!title_.empty()) {
    bootstrap.Set("title", title_);
  }
  if (is_utility()) {
    bootstrap.Set("utility", utility_.Clone());
  }
  bootstrap.Set("shellZoom", 1.0);
  return base::WriteJson(bootstrap).value_or("{}");
}

std::optional<std::string> BootstrapScript(const std::string& bootstrap_json,
                                           const char* host_bootstrap) {
  std::optional<base::Value> bootstrap =
      base::JSONReader::Read(bootstrap_json, base::JSON_PARSE_RFC);
  if (!bootstrap || !bootstrap->is_dict()) {
    return std::nullopt;
  }
  if (std::optional<base::DictValue> session = ReadSessionFile()) {
    bootstrap->GetDict().Set("session", std::move(*session));
  }
  bootstrap->GetDict().Set("documents", ReadDocuments());
  bootstrap->GetDict()
      .EnsureDict("nativeModules")
      ->EnsureDict("ArdiaSharedFolders")
      ->Set("location", shared_folders::Location());
  std::optional<std::string> json = base::WriteJson(*bootstrap);
  std::optional<std::string> literal = json ? base::WriteJson(base::Value(*json))
                                            : std::nullopt;
  if (!literal) {
    return std::nullopt;
  }
  return "globalThis.__ardiaBootstrap=JSON.parse(" + *literal + ");\n" +
         host_bootstrap;
}

void ShellHostView::Invoke(const std::string& method,
                           const base::DictValue& args,
                           Done done) {
  if (HandlesLifecycleCall(method)) {
    return LifecycleCall(method, args, std::move(done));
  }
  const base::ListValue* values = Arguments(args);
  const auto first_string = [values]() -> std::string {
    return values && !values->empty() && (*values)[0].is_string()
               ? (*values)[0].GetString()
               : std::string();
  };
  if (method == "tab.create") {
    return CreateTab(args, std::move(done));
  }
  if (share::Handles(method)) {
    return share::Invoke(*this, method, values, std::move(done));
  }
  if (shared_folders::Handles(method)) {
    return shared_folders::Invoke(*this, method, values, std::move(done));
  }
  if (method == "tab.viewport") {
    return SetViewport(args, std::move(done));
  }
  if (method == "tab.command") {
    return TabCommand(args, std::move(done));
  }
  if (method == "tab.release") {
    return ReleaseTab(args, std::move(done));
  }
  if (method == "tab.close") {
    return CloseTab(args, std::move(done));
  }
  if (method == "tab.presentations") {
    return SetPresentations(args, std::move(done));
  }
  if (system_ && SystemServices::Handles(method)) {
    return system_->Invoke(method, values, std::move(done));
  }
  if (extension_views_ && ExtensionViews::Handles(method)) {
    return extension_views_->Invoke(method, args, std::move(done));
  }
  if (pip_ && PipPresenter::Handles(method)) {
    return pip_->Invoke(method, args, std::move(done));
  }
  if (scroll_gestures_ && ScrollGestures::Handles(method)) {
    return scroll_gestures_->Invoke(method, args, std::move(done));
  }
  if (method == "shell.inputRegions") {
    return SetInputRegions(args, std::move(done));
  }
  if (method == "shell.glassRegions") {
    return SetGlassRegions(args, std::move(done));
  }
  if (method == "shell.backdropRegions") {
    return SetBackdropRegions(args, std::move(done));
  }
  if (method == "shell.popover.open" || method == "shell.popover.update" ||
      method == "shell.popover.close") {
    return PopoverCall(method, args, std::move(done));
  }
  if (method == "shell.showContextMenu") {
    return ShowShellContextMenu(args, std::move(done));
  }
  if (method == "shell.trafficLights") {
    return SetTrafficLights(args, std::move(done));
  }
  if (method == "ArdiaShell.setMainMenu") {
    return SetMainMenu(args, std::move(done));
  }
  if (method == "ArdiaShell.setMenuState" ||
      method == "ArdiaShell.setMenuBookmarks") {
    if (!values || values->size() != 1) {
      return std::move(done).Run(false, base::Value("One menu update is required"));
    }
    const std::optional<std::string> error =
        method == "ArdiaShell.setMenuState"
            ? SetWindowMenuState(window_id_, (*values)[0])
            : SetWindowMenuBookmarks(window_id_, (*values)[0]);
    if (error) {
      return std::move(done).Run(false, base::Value(*error));
    }
    return Reply(std::move(done), base::Value());
  }
  if (method == "ArdiaShell.setKeyboardShortcuts") {
    return SetKeyboardShortcuts(values, std::move(done));
  }
  if (method == "ArdiaShell.captionDoubleClick") {
    return CaptionDoubleClick(std::move(done));
  }
  if (method == "ArdiaShell.startWindowMove") {
    return StartWindowMove(std::move(done));
  }
  if (method == "ArdiaTabs.unclaimedTabs") {
    return ListUnclaimedTabs(std::move(done));
  }
  if (method == "session.read") {
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ReadSessionFile),
        base::BindOnce(
            [](Done done, std::optional<base::DictValue> session) {
              std::move(done).Run(true, session ? base::Value(std::move(*session))
                                                : base::Value());
            },
            std::move(done)));
    return;
  }
  if (method == "session.write") {
    return WriteSession(args, std::move(done));
  }
  if (method == "ArdiaShell.readDocument") {
    const std::string name = first_string();
    if (!ValidDocumentName(name)) {
      return std::move(done).Run(
          false, Failure("ERR_DOCUMENT_NAME", "Invalid document name"));
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath path) -> std::optional<std::string> {
              std::string text;
              if (!base::ReadFileToStringWithMaxSize(path, &text, kDocumentLimit)) {
                return std::nullopt;
              }
              return text;
            },
            DocumentDirectory().Append(name)),
        base::BindOnce(
            [](Done done, std::optional<std::string> text) {
              std::move(done).Run(true, text ? base::Value(std::move(*text))
                                             : base::Value());
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaShell.writeDocument" ||
      method == "ArdiaShell.saveDocument") {
    const std::string name = first_string();
    if (DocumentSession::Reserved(name)) {
      return std::move(done).Run(
          false, Failure("ERR_DOCUMENT_RESERVED", "Live documents change only through typed operations"));
    }
    if (!ValidDocumentName(name) || !values || values->size() != 2 ||
        !(*values)[1].is_string() ||
        (*values)[1].GetString().size() > kDocumentLimit) {
      return std::move(done).Run(
          false, Failure("ERR_DOCUMENT_REQUEST", "Invalid document write"));
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath directory, std::string name, std::string text) {
              return base::CreateDirectory(directory) &&
                     base::ImportantFileWriter::WriteFileAtomically(
                         directory.Append(name), text);
            },
            DocumentDirectory(), name, (*values)[1].GetString()),
        base::BindOnce(
            [](Done done, bool ok) {
              if (!ok) {
                return std::move(done).Run(
                    false, Failure("ERR_DOCUMENT_WRITE", "Could not save"));
              }
              std::move(done).Run(true, base::Value());
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaShell.removeDocument") {
    const std::string name = first_string();
    if (DocumentSession::Reserved(name)) {
      return std::move(done).Run(
          false, Failure("ERR_DOCUMENT_RESERVED", "Live documents change only through typed operations"));
    }
    if (!ValidDocumentName(name)) {
      return std::move(done).Run(
          false, Failure("ERR_DOCUMENT_NAME", "Invalid document name"));
    }
    FileRunner()->PostTask(
        FROM_HERE, base::BindOnce(base::IgnoreResult(&base::DeleteFile),
                                  DocumentDirectory().Append(name)));
    return Reply(std::move(done), base::Value());
  }
  if (method == "ArdiaShell.windowIdentity") {
    return Reply(std::move(done),
                 base::Value(base::DictValue()
                                 .Set("windowId", window_id_)
                                 .Set("rendererGeneration",
                                      base::NumberToString(renderer_generation_))));
  }
  if (method == "ArdiaShell.windowIds") {
    base::ListValue ids;
    for (ShellHostView* host : Hosts()) {
      if (host->browser()) {
        ids.Append(host->window_id());
      }
    }
    return Reply(std::move(done), base::Value(std::move(ids)));
  }
  if (method == "ArdiaShell.openWindow") {
    return OpenWindow(values, std::move(done));
  }
  if (method == "ArdiaShell.windowFrame") {
    const gfx::Rect bounds = browser_ ? browser_->GetWindow()->GetBounds()
                                      : gfx::Rect();
    return Reply(std::move(done), base::Value(base::ListValue()
                                                  .Append(bounds.x())
                                                  .Append(bounds.y())
                                                  .Append(bounds.width())
                                                  .Append(bounds.height())));
  }
  if (method == "ArdiaShell.windowButtonLayout") {
    return Reply(std::move(done),
                 base::Value(base::DictValue()
                                 .Set("layout", "")
                                 .Set("desktop", "macos")));
  }
  if (method == "ArdiaShell.isDarkAppearance") {
    NSAppearanceName name = [NSApp.effectiveAppearance
        bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua,
                                             NSAppearanceNameDarkAqua ]];
    return Reply(std::move(done),
                 base::Value([name isEqualToString:NSAppearanceNameDarkAqua]));
  }
  if (method == "ArdiaShell.shellPainted") {
    shell_ready_generation_ = renderer_generation_;
    if (!painted_) {
      painted_ = true;
      Note("shell painted in window " + window_id_);
    }
    return Reply(std::move(done), base::Value());
  }
  if (method == "ArdiaShell.copyText") {
    const std::string text = first_string();
    {
      ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
      writer.WriteText(base::UTF8ToUTF16(text));
    }
    return Reply(std::move(done), base::Value());
  }
  if (method == "ArdiaShell.readText") {
    ui::Clipboard* clipboard = ui::Clipboard::GetForCurrentThread();
    if (!clipboard) {
      return Reply(std::move(done), base::Value(""));
    }
    clipboard->ReadText(
        ui::ClipboardBuffer::kCopyPaste, std::nullopt,
        base::BindOnce(
            [](Done done, std::u16string text) {
              std::move(done).Run(true, base::Value(base::UTF16ToUTF8(text)));
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaShell.startDictation") {
    if (BackgroundInstance()) {
      Trace("dictation (background run, not started)");
    } else {
      dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp sendAction:@selector(startDictation:) to:nil from:nil];
      });
    }
    return Reply(std::move(done), base::Value(true));
  }
  if (method == "ArdiaShell.focusWindow") {
    ShellHostView* target =
        first_string().empty() ? this : HostForWindow(first_string());
    if (!target) {
      return std::move(done).Run(false, base::Value("No such native window"));
    }
    target->ActivateWindow();
    return Reply(std::move(done), base::Value(true));
  }
  if (method == "ArdiaShell.setActiveProfile") {
    const std::string requested = first_string();
    if (requested.empty() || requested == "default") {
      return Reply(std::move(done), base::Value(true));
    }
    WithProfile(requested,
                base::BindOnce(
                    [](base::WeakPtr<ShellHostView> host, Done done,
                       Profile* profile) {
                      std::move(done).Run(
                          true, base::Value(host && profile &&
                                            host->EnsureMember(profile)));
                    },
                    GetWeakPtr(), std::move(done)));
    return;
  }
  if (method.starts_with("ArdiaTelemetry.") || method.starts_with("ArdiaUpdates.") ||
      method == "ArdiaShell.fetchBangList") {
    return std::move(done).Run(
        false, Failure("ERR_UNAVAILABLE", "The Mac WebUI spike sends nothing"));
  }
  if (method == "tabs.strips") {
    return Reply(std::move(done), base::Value(base::DictValue()
                                                  .Set("rev", 0)
                                                  .Set("cmd", base::Value())
                                                  .Set("strips", base::ListValue())));
  }
  if (method == "search.setEngineName") {
    const auto text = [values](std::size_t index) {
      return values && values->size() > index && (*values)[index].is_string() ? (*values)[index].GetString()
                                                                               : std::string();
    };
    if (const std::optional<std::string> error = ardiacore::SetLinuxDefaultSearchEngine(text(0), text(1), text(2))) {
      return std::move(done).Run(false, Failure("ERR_ENGINE", *error));
    }
    return Reply(std::move(done), base::Value());
  }
  if (method == "engine.info") {
    return Reply(std::move(done),
                 base::Value(base::DictValue()
                                 .Set("version",
                                      std::string(version_info::GetVersionNumber()))
                                 .Set("shell", "mac-webui")));
  }
  NoteUnhandled(method);
  std::move(done).Run(true, base::Value());
}

void ShellHostView::EngineCall(const std::string& name,
                               const std::string& profile,
                               const base::Value* args,
                               Done done) {
  if (name == "profiles.loaded") {
    base::ListValue loaded;
    for (Profile* loaded_profile :
         g_browser_process->profile_manager()->GetLoadedProfiles()) {
      if (!loaded_profile->IsOffTheRecord()) {
        loaded.Append(ProfileName(loaded_profile));
      }
    }
    return std::move(done).Run(
        true, base::Value(base::WriteJson(base::DictValue().Set(
                                              "profiles", std::move(loaded)))
                              .value_or("{}")));
  }
  if (ListedCall(kInvokedEngineCalls, name)) {
    std::optional<base::Value> parsed =
        args && args->is_string() ? base::JSONReader::Read(args->GetString(), base::JSON_PARSE_RFC, 8) : std::nullopt;
    base::ListValue values;
    if (name == "search.setEngineName" && parsed && parsed->is_dict()) {
      for (const char* key : {"name", "keyword", "url"}) {
        const std::string* field = parsed->GetDict().FindString(key);
        values.Append(field ? *field : std::string());
      }
    }
    return Invoke(name, base::DictValue().Set("args", std::move(values)),
                  base::BindOnce(
                      [](Done done, bool ok, base::Value result) {
                        if (!ok) {
                          return std::move(done).Run(false, std::move(result));
                        }
                        std::move(done).Run(true, base::Value(base::WriteJson(result).value_or("null")));
                      },
                      std::move(done)));
  }
  if (ListedCall(kInertEngineCalls, name)) {
    NoteUnhandled("engine.call " + name + " (answered null)");
    return std::move(done).Run(true, base::Value("null"));
  }
  if (DocumentSession::Handles(name)) {
    if (!documents_) {
      return std::move(done).Run(false, Failure("ERR_DOCUMENT_AUTH", "Document access denied"));
    }
    return documents_->Call(name, args, renderer_generation_, std::move(done));
  }
  if (SystemServices::HandlesEngineCall(name) || ExtensionViews::HandlesEngineCall(name)) {
    return WithProfile(profile, base::BindOnce(&ServiceCall, GetWeakPtr(), name,
                                               args ? std::optional<base::Value>(args->Clone()) : std::nullopt,
                                               std::move(done)));
  }
  if (pip_ && PipPresenter::HandlesEngineCall(name)) {
    return pip_->EngineCall(name, args, std::move(done));
  }
  if (HandlesLinkRoute(name)) {
    return LinkRouteCall(name, args, std::move(done));
  }
  if (page_policy::IsZoomRoute(name)) {
    return WithProfile(profile,
                       base::BindOnce(
                           [](std::string name, std::optional<base::Value> args,
                              Done done, Profile* resolved) {
                             SiteZoomCall(name, resolved, args ? &*args : nullptr,
                                          std::move(done));
                           },
                           name, args ? std::optional<base::Value>(args->Clone())
                                      : std::nullopt,
                           std::move(done)));
  }
  const auto* route = ardia::desktop_routes::FindRoute(name);
  EngineFunction call =
      route ? reinterpret_cast<EngineFunction>(
                  dlsym(EngineImage() ? EngineImage() : RTLD_DEFAULT,
                        std::string(route->service).c_str()))
            : nullptr;
  if (!call) {
    NoteUnhandled("engine.call " + name);
    return std::move(done).Run(
        false, Failure("ERR_UNKNOWN_CALL",
                       "This engine call is not in the Mac WebUI shell"));
  }
  std::string json = args && args->is_string() ? args->GetString() : "{}";
  struct Pending {
    Done done;
    std::string field;
  };
  WithProfile(
      profile,
      base::BindOnce(
          [](EngineFunction call, std::string json, std::string field,
             Done done, Profile* resolved) {
            if (!resolved) {
              return std::move(done).Run(
                  false, Failure("ERR_PROFILE", "profile not loaded"));
            }
            const std::string path =
                resolved->GetOriginalProfile()->GetPath().value();
            auto* pending = new Pending{std::move(done), std::move(field)};
            call(
                path.c_str(), json.c_str(),
                [](void* context, const char* reply) {
                  std::unique_ptr<Pending> owned(static_cast<Pending*>(context));
                  std::optional<base::Value> value =
                      reply ? base::JSONReader::Read(reply, base::JSON_PARSE_RFC)
                            : std::nullopt;
                  if (!value) {
                    return std::move(owned->done).Run(
                        false, base::Value("The engine reply is not JSON"));
                  }
                  if (value->is_dict() && value->GetDict().Find("error")) {
                    return std::move(owned->done).Run(true, base::Value(reply));
                  }
                  if (owned->field == "null") {
                    value = base::Value();
                  } else if (!owned->field.empty()) {
                    const base::Value* field =
                        value->is_dict() ? value->GetDict().Find(owned->field)
                                         : nullptr;
                    value = field ? field->Clone() : base::Value();
                  }
                  std::move(owned->done)
                      .Run(true, base::Value(
                                     base::WriteJson(*value).value_or("null")));
                },
                pending);
          },
          call, std::move(json), std::string(route->field), std::move(done)));
}

}
