#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/desktop/ac_desktop_platform.h"
#include "ardia/desktop/ac_desktop_policy.h"
#include "ardia/desktop/ac_desktop_window_state.h"
#include "ardia/desktop/generated/ac_desktop_routes.h"
#include "ardia/linux/ac_linux_document_service.h"
#include "ardia/linux/ac_linux_documents.h"
#include "ardia/win/ac_calls.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/main.h"
#include "ardia/win/profiles.h"
#include "ardia/win/webui/webui_bridge.h"
#include "ardia/win/webui/webui_file_picker.h"
#include "ardia/win/webui/webui_host_internal.h"
#include "ardia/win/webui/webui_host_view.h"
#include "ardia/win/webui/webui_policy.h"
#include "ardia/win/webui/webui_storage.h"
#include "ardia/win/webui/webui_updates.h"
#include "ardia/win/webui/webui_windows.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "ui/base/base_window.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/profiles/profile.h"
#include "components/version_info/version_info.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/accelerators/accelerator_manager.h"
#include "ui/base/clipboard/clipboard.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/widget/widget.h"
#include "ui/views/win/hwnd_util.h"

namespace ardia_win::webui {

namespace {

constexpr size_t kShortcutLimit = 256;
constexpr size_t kCopyTextLimit = 1024 * 1024;
constexpr size_t kTitleLimit = 512;

constexpr std::string_view kWindowCapabilities[] = {
    "ArdiaShell.startWindowMove",
    "ArdiaShell.captionDoubleClick",
    "ArdiaShell.windowIdentity",
    "ArdiaShell.toggleFullScreen",
    "ArdiaShell.pickFolder",
    "ArdiaShell.pickFiles",
    "ArdiaShell.copyText",
    "ArdiaShell.readText",
    "ArdiaShell.quit",
    "ArdiaTelemetry.post",
    "shell.inputRegions",
    "documents.watch",
    "documents.unwatch",
    "documents.commit",
    "documents.flush",
    ardia::desktop_window_state::kWindowButtonLayoutCall,
    ardia::desktop_window_state::kWindowStateCall,
};

constexpr std::string_view kBrowserWindowCapabilities[] = {
    "ArdiaShell.startWindowMove",
    "ArdiaShell.captionDoubleClick",
    "ArdiaShell.windowIdentity",
    "ArdiaShell.toggleFullScreen",
    "ArdiaShell.pickFolder",
    "ArdiaShell.pickFiles",
    "ArdiaShell.copyText",
    "ArdiaShell.readText",
    "ArdiaShell.quit",
    "ArdiaShell.onOpenURLs",
    "ArdiaShell.listenForOpenURLs",
    "ArdiaTelemetry.post",
    "shell.inputRegions",
    "documents.watch",
    "documents.unwatch",
    "documents.commit",
    "documents.flush",
    ardia::desktop_window_state::kWindowButtonLayoutCall,
    ardia::desktop_window_state::kWindowStateCall,
};

base::Value DocumentFailure(std::string_view code, std::string_view message) {
  return Failure(code, message);
}

bool ValidDocumentRequest(const base::ListValue* values,
                          size_t count,
                          bool writes,
                          base::Value* failure) {
  if (!values || values->size() != count ||
      std::ranges::any_of(*values,
                          [](const base::Value& value) { return !value.is_string(); })) {
    *failure = Failure("ERR_DOCUMENT_REQUEST",
                       count == 1 ? "A document name is required"
                                  : "A document name and text are required");
    return false;
  }
  const std::string& name = (*values)[0].GetString();
  if (writes ? !WritableWindowsDocumentName(name)
             : !ValidWindowsDocumentName(name) ||
                   ReservedWindowsDocumentName(name)) {
    *failure = Failure("ERR_DOCUMENT_NAME", "Invalid or reserved document name");
    return false;
  }
  return true;
}

void QuitEverything() {
  WindowRegistry::Get().ResetAllCompanionConfirmations();
  for (ShellHostView* host : WindowRegistry::Get().Hosts()) {
    host->RememberPlacement();
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&QuitApp));
}

}

std::span<const std::string_view> HostCapabilities(bool utility) {
  return utility ? std::span<const std::string_view>(kWindowCapabilities)
                 : std::span<const std::string_view>(kBrowserWindowCapabilities);
}

void ShellHostView::Invoke(const std::string& method,
                           const base::DictValue& args,
                           Done done) {
  const base::ListValue* values = Arguments(args);
  if (method == "tab.create") {
    return CreateTab(args, std::move(done));
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
  if (method == "shell.inputRegions") {
    return SetInputRegions(args, std::move(done));
  }
  if (method == "ArdiaTabs.unclaimedTabs") {
    return ListUnclaimedTabs(std::move(done));
  }
  if (method == "ArdiaTabs.claimLaunchTab") {
    return ClaimLaunchTab(values, std::move(done));
  }
  if (method == "ArdiaTabs.prepareTransfer" ||
      method == "ArdiaTabs.releaseTransfer") {
    return PrepareTransfer(values, method == "ArdiaTabs.prepareTransfer",
                           std::move(done));
  }
  if (method == "session.read") {
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ReadSession, SessionDirectory()),
        base::BindOnce(
            [](Done done, std::optional<base::DictValue> session) {
              std::move(done).Run(true, session ? base::Value(std::move(*session))
                                                : base::Value());
            },
            std::move(done)));
    return;
  }
  if (method == "session.write") {
    const base::DictValue* base = args.FindDict("base");
    const base::DictValue* session = args.FindDict("session");
    if (!base || !session) {
      return std::move(done).Run(
          false, base::Value("A session write needs a base and a session"));
    }
    if (private_window()) {
      return std::move(done).Run(
          false, base::Value("A private window keeps no session"));
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&WriteSessionTracked, SessionDirectory(), base->Clone(),
                       session->Clone()),
        base::BindOnce(
            [](std::string source_window, base::DictValue source_base,
               Done done, SessionWrite result) {
              if (!result.session) {
                return std::move(done).Run(
                    false, base::Value("The session could not be saved"));
              }
              std::move(done).Run(true, base::Value(result.session->Clone()));
              WindowRegistry::Get().BroadcastSession(
                  source_window, source_base, std::move(result.previous),
                  std::move(*result.session));
            },
            config_.window_id, session->Clone(), std::move(done)));
    return;
  }
  if (method == "ArdiaShell.readDocument") {
    base::Value failure;
    if (!ValidDocumentRequest(values, 1, false, &failure)) {
      return std::move(done).Run(false, std::move(failure));
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&ReadStoredDocument, SessionDirectory(),
                       (*values)[0].GetString()),
        base::BindOnce(
            [](Done done, StoredDocument stored) {
              if (stored.outcome == ardia::desktop_policy::StoredRead::kFailed) {
                return std::move(done).Run(
                    false, DocumentFailure("ERR_DOCUMENT_READ",
                                           "The document could not be read"));
              }
              std::move(done).Run(
                  true, stored.outcome == ardia::desktop_policy::StoredRead::kFound
                            ? base::Value(std::move(stored.contents))
                            : base::Value());
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaShell.writeDocument" ||
      method == "ArdiaShell.saveDocument") {
    base::Value failure;
    if (!ValidDocumentRequest(values, 2, true, &failure)) {
      return std::move(done).Run(false, std::move(failure));
    }
    const std::string name = (*values)[0].GetString();
    std::string contents = (*values)[1].GetString();
    if (contents.size() > WindowsDocumentLimit(name)) {
      return std::move(done).Run(
          false, DocumentFailure("ERR_DOCUMENT_LIMIT",
                                 "Document storage limit exceeded"));
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&WriteStoredDocument, SessionDirectory(), name,
                       std::move(contents)),
        base::BindOnce(
            [](Done done, bool ok) {
              if (!ok) {
                return std::move(done).Run(
                    false, DocumentFailure("ERR_DOCUMENT_WRITE",
                                           "Could not persist the document"));
              }
              std::move(done).Run(true, base::Value());
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaShell.removeDocument") {
    base::Value failure;
    if (!ValidDocumentRequest(values, 1, true, &failure)) {
      return std::move(done).Run(false, std::move(failure));
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&RemoveStoredDocument, SessionDirectory(),
                       (*values)[0].GetString()),
        base::BindOnce(
            [](Done done, bool ok) {
              if (!ok) {
                return std::move(done).Run(
                    false, DocumentFailure("ERR_DOCUMENT_REMOVE",
                                           "Could not remove the document"));
              }
              std::move(done).Run(true, base::Value());
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaTelemetry.post") {
    if (!values || values->size() != 2 || !(*values)[0].is_string() ||
        !(*values)[1].is_string() ||
        !TelemetryPostAllowed((*values)[0].GetString(),
                              (*values)[1].GetString())) {
      return std::move(done).Run(
          false, Failure("ERR_TELEMETRY_REFUSED", "Telemetry request refused"));
    }
    telemetry_.Post(
        (*values)[0].GetString(), (*values)[1].GetString(),
        base::BindOnce(
            [](Done done, int status) {
              std::move(done).Run(
                  true, base::Value(base::DictValue().Set("status", status)));
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaShell.setKeyboardShortcuts") {
    return SetKeyboardShortcuts(values, std::move(done));
  }
  if (method == "ArdiaShell.startWindowMove") {
    return std::move(done).Run(
        true, base::Value(ardia::desktop::Platform().StartWindowMove(widget())));
  }
  if (method == "ArdiaShell.captionDoubleClick" ||
      method == "ArdiaShell.toggleMaximizeWindow") {
    return std::move(done).Run(
        true,
        base::Value(ardia::desktop::Platform().CaptionDoubleClick(widget())));
  }
  if (method == "ArdiaShell.minimizeWindow") {
    const std::string target = values && !values->empty() &&
                                       (*values)[0].is_string()
                                   ? (*values)[0].GetString()
                                   : std::string();
    ShellHostView* host = target.empty() || target == config_.window_id
                              ? this
                              : WindowRegistry::Get().ReachableHost(target);
    if (!host || !host->browser()) {
      return std::move(done).Run(false, base::Value("No such native window"));
    }
    host->browser()->GetWindow()->Minimize();
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.toggleFullScreen") {
    if (views::Widget* frame = widget()) {
      frame->SetFullscreen(!frame->IsFullscreen());
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.restoreFullScreen") {
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.closeWindow" ||
      method == "ArdiaShell.requestWindowClose") {
    const std::string target = values && !values->empty() &&
                                       (*values)[0].is_string()
                                   ? (*values)[0].GetString()
                                   : std::string();
    ShellHostView* host = target.empty() || target == config_.window_id
                              ? this
                              : WindowRegistry::Get().ReachableHost(target);
    if (!host || !host->browser()) {
      return std::move(done).Run(false, base::Value("No such native window"));
    }
    std::move(done).Run(true, base::Value());
    return host->RequestClose();
  }
  if (method == "ArdiaShell.utilityReady") {
    const std::string target = values && !values->empty() &&
                                       (*values)[0].is_string()
                                   ? (*values)[0].GetString()
                                   : std::string();
    if (!is_utility() || target != config_.window_id) {
      return std::move(done).Run(false, base::Value("No such utility renderer"));
    }
    utility_ready_ = true;
    return std::move(done).Run(true, base::Value(config_.utility.Clone()));
  }
  if (method == "ArdiaShell.quit") {
    std::move(done).Run(true, base::Value());
    QuitEverything();
    return;
  }
  if (HandlesUpdateCall(method)) {
    return InvokeUpdates(method, args.Find("args"), std::move(done),
                         base::BindOnce(&QuitEverything));
  }
  if (method == "ArdiaShell.focusWindow") {
    const std::string target = values && !values->empty() &&
                                       (*values)[0].is_string()
                                   ? (*values)[0].GetString()
                                   : std::string();
    if (target.empty() || target == config_.window_id) {
      FocusWindow();
      return std::move(done).Run(true, base::Value(true));
    }
    return std::move(done).Run(
        true, base::Value(WindowRegistry::Get().FocusWindow(this, target)));
  }
  if (method == "ArdiaShell.openWindow") {
    const std::string id = values && !values->empty() && (*values)[0].is_string()
                               ? (*values)[0].GetString()
                               : std::string();
    const base::DictValue* options =
        values && values->size() > 1 ? (*values)[1].GetIfDict() : nullptr;
    return WindowRegistry::Get().OpenRequested(this, id, options,
                                               std::move(done));
  }
  if (method == "ArdiaShell.privateWindows") {
    return std::move(done).Run(
        true, base::Value(WindowRegistry::Get().PrivateWindows()));
  }
  if (method == "ArdiaShell.setActiveProfile") {
    return SetActiveProfile(values, std::move(done));
  }
  if (method == "ArdiaShell.windowIdentity") {
    if (values && !values->empty()) {
      return std::move(done).Run(
          false, Failure("ERR_WINDOW_IDENTITY",
                         "Committed window identity unavailable"));
    }
    return std::move(done).Run(
        true,
        base::Value(base::DictValue()
                        .Set("windowId", config_.window_id)
                        .Set("rendererGeneration",
                             base::NumberToString(renderer_generation_))));
  }
  if (method == "ArdiaShell.windowIds") {
    return std::move(done).Run(true,
                               base::Value(WindowRegistry::Get().WindowIds()));
  }
  if (method == "ArdiaShell.windowFrame") {
    return std::move(done).Run(true, base::Value(WindowFrame()));
  }
  if (method == ardia::desktop_window_state::kWindowStateCall) {
    return std::move(done).Run(true, base::Value(WindowState()));
  }
  if (method == ardia::desktop_window_state::kWindowButtonLayoutCall) {
    return std::move(done).Run(
        true, base::Value(base::DictValue()
                              .Set("layout", ":minimize,maximize,close")
                              .Set("desktop", "windows")));
  }
  if (method == "ArdiaShell.setMaximizeButton") {
    const std::optional<gfx::Rect> bounds = RectFrom(args.FindDict("rect"));
    if (ShellBrowserFrameView* frame = ShellFrameOf(browser_view_)) {
      frame->SetMaximizeButton(bounds);
    }
    if (!bounds) {
      caption_->Reset();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.isDarkAppearance") {
    return std::move(done).Run(true, base::Value(SystemPrefersDark()));
  }
  if (method == "ArdiaShell.setWindowTitle") {
    if (values && !values->empty() && (*values)[0].is_string() &&
        (*values)[0].GetString().size() <= kTitleLimit && Hwnd()) {
      ::SetWindowTextW(Hwnd(), base::UTF8ToWide((*values)[0].GetString()).c_str());
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.restoreShortcutFocus") {
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.copyText") {
    return CopyText(values, std::move(done));
  }
  if (method == "ArdiaShell.readText") {
    return ReadText(std::move(done));
  }
  if (method == "ArdiaShell.pickFolder" || method == "ArdiaShell.pickFiles") {
    if (!file_picker_) {
      file_picker_ = std::make_unique<FilePicker>();
    }
    if (method == "ArdiaShell.pickFolder") {
      return file_picker_->PickFolder(widget(), values, std::move(done));
    }
    return file_picker_->PickFiles(widget(), values, std::move(done));
  }
  if (method == "ArdiaShell.listenForOpenURLs") {
    if (values && !values->empty()) {
      return std::move(done).Run(
          false, base::Value("listenForOpenURLs takes no arguments"));
    }
    if (!TakesOpenUrls()) {
      return std::move(done).Run(
          false, base::Value("This window takes no links from other apps"));
    }
    open_urls_listener_ = renderer_generation_;
    std::move(done).Run(true, base::Value());
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce([] { WindowRegistry::Get().DeliverOpenUrls(); }));
    return;
  }
  if (method == "ArdiaShell.shellPainted") {
    if (!painted_) {
      painted_ = true;
      MarkStartSettled();
      Note("shell painted in window " + config_.window_id);
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.testSecretRoundTrip" && ardiacore::TestInstance()) {
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&SecretRoundTrip),
        base::BindOnce(
            [](Done done, base::DictValue report) {
              std::move(done).Run(true, base::Value(std::move(report)));
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaShell.testOpenExternalSink" && ardiacore::TestInstance()) {
    return std::move(done).Run(
        true, base::Value(base::DictValue()
                              .Set("calls", ExternalOpenCount())
                              .Set("defaultBrowserCalls", DefaultAppsOpenCount())));
  }
  if (method == "ArdiaShell.testAssetSink" && ardiacore::TestInstance()) {
    return std::move(done).Run(
        true, base::Value(base::DictValue()
                              .Set("served", AssetReadsServed().load())
                              .Set("refused", AssetReadsRefused().load())
                              .Set("outsideRoot", AssetReadsOutsideRoot().load())
                              .Set("unreadable", AssetReadsUnreadable().load())));
  }
  if (method == "ArdiaShell.testTelemetrySink" && ardiacore::TestInstance()) {
    return std::move(done).Run(
        true, base::Value(base::DictValue()
                              .Set("requestsStarted", TelemetryRequestsStarted())
                              .Set("inFlight", TelemetryInFlight())));
  }
  if (method == "ArdiaShell.testWindowDecorations" && ardiacore::TestInstance()) {
    return std::move(done).Run(true, base::Value(DecorationReport()));
  }
  if (method == "ArdiaShell.testWindows" && ardiacore::TestInstance()) {
    base::ListValue windows;
    for (ShellHostView* host : WindowRegistry::Get().Hosts()) {
      windows.Append(base::DictValue()
                         .Set("windowId", host->window_id())
                         .Set("kind", webui_window::WindowKindName(host->kind()))
                         .Set("tabs", static_cast<int>(host->bindings_.size()))
                         .Set("companions",
                              static_cast<int>(host->Members().size()) - 1));
    }
    return std::move(done).Run(true, base::Value(std::move(windows)));
  }
  if (const auto capability =
          ardia::desktop::Platform().CapabilityFor(method)) {
    const base::Value* given = args.Find("args");
    if (given && !given->is_list()) {
      return std::move(done).Run(
          false, Failure("ERR_SYSTEM_REQUEST", "The arguments must be a list"));
    }
    static const base::NoDestructor<base::ListValue> kNoArguments;
    return ardia::desktop::Platform().Invoke(
        *capability,
        {method, values ? *values : *kNoArguments, SessionDirectory()},
        std::move(done));
  }
  if (method == "ArdiaShell.testDelayedReply" && ardiacore::TestInstance()) {
    const int delay = values && !values->empty() && (*values)[0].is_int()
                          ? std::clamp((*values)[0].GetInt(), 0, 10000)
                          : 1000;
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](Done done) { std::move(done).Run(true, base::Value("late")); },
            std::move(done)),
        base::Milliseconds(delay));
    return;
  }
  if (method == "engine.info") {
    return std::move(done).Run(
        true, base::Value(base::DictValue()
                              .Set("version",
                                   std::string(version_info::GetVersionNumber()))
                              .Set("shell", "webui")));
  }
  NoteUnhandled(method);
  std::move(done).Run(true, base::Value());
}

void ShellHostView::SetKeyboardShortcuts(const base::ListValue* values,
                                         Done done) {
  if (!focus_manager_ || !values || values->empty() ||
      !(*values)[0].is_list() || (*values)[0].GetList().size() > kShortcutLimit) {
    return std::move(done).Run(false,
                               base::Value("Invalid keyboard shortcut table"));
  }
  constexpr int kModifiers = ui::EF_SHIFT_DOWN | ui::EF_CONTROL_DOWN |
                             ui::EF_ALT_DOWN | ui::EF_COMMAND_DOWN;
  std::map<ui::Accelerator, base::DictValue> shortcuts;
  for (const base::Value& value : (*values)[0].GetList()) {
    if (!value.is_dict()) {
      return std::move(done).Run(false, base::Value("Invalid keyboard shortcut"));
    }
    const base::DictValue& binding = value.GetDict();
    const int key = binding.FindInt("keyCode").value_or(0);
    const int flags = binding.FindInt("modifiers").value_or(-1);
    const std::string command = Text(binding, "command");
    if (key < 1 || key > 255 || flags < 0 || (flags & ~kModifiers) ||
        command.empty() || command.size() > 64) {
      return std::move(done).Run(false, base::Value("Invalid keyboard shortcut"));
    }
    shortcuts.emplace(ui::Accelerator(static_cast<ui::KeyboardCode>(key), flags),
                      binding.Clone());
  }
  focus_manager_->UnregisterAccelerators(this);
  shortcuts_ = std::move(shortcuts);
  for (const auto& [accelerator, binding] : shortcuts_) {
    focus_manager_->RegisterAccelerator(
        accelerator, ui::AcceleratorManager::kNormalPriority, this);
  }
  std::move(done).Run(true, base::Value());
}

void ShellHostView::SetActiveProfile(const base::ListValue* values, Done done) {
  if (!values || values->size() != 2 || !(*values)[0].is_string() ||
      !(*values)[1].is_int() || (*values)[1].GetInt() < 0) {
    return std::move(done).Run(
        false, base::Value("A profile and a selection sequence are required"));
  }
  const uint64_t sequence = static_cast<uint64_t>((*values)[1].GetInt());
  if (!selection_.Admit(renderer_generation_, sequence)) {
    return std::move(done).Run(true, base::Value(false));
  }
  const std::string requested = (*values)[0].GetString();
  if (private_window() || is_utility() || requested == config_.page_profile ||
      ParseProfileName(requested).off_the_record) {
    if (requested == config_.page_profile) {
      active_profile_.reset();
    }
    return std::move(done).Run(true,
                               base::Value(requested == config_.page_profile));
  }
  WithProfile(
      requested,
      base::BindOnce(
          [](base::WeakPtr<ShellHostView> host, uint64_t generation,
             uint64_t sequence, Done done, Profile* profile) {
            if (!host || !host->selection_.Current(generation, sequence) ||
                host->renderer_generation_ != generation) {
              return std::move(done).Run(true, base::Value(false));
            }
            if (!profile || !host->EnsureMember(profile)) {
              return std::move(done).Run(
                  false, Failure("ERR_PROFILE_UNAVAILABLE",
                                 "That profile cannot open in this window"));
            }
            host->SelectProfile(profile);
            std::move(done).Run(true, base::Value(true));
          },
          GetWeakPtr(), renderer_generation_, sequence, std::move(done)));
}

void ShellHostView::CopyText(const base::ListValue* values, Done done) {
  if (!values || values->size() != 1 || !(*values)[0].is_string() ||
      !webui_window::CopyTextFits((*values)[0].GetString(), kCopyTextLimit)) {
    return std::move(done).Run(false, base::Value("Text to copy is required"));
  }
  {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(base::UTF8ToUTF16((*values)[0].GetString()));
  }
  std::move(done).Run(true, base::Value());
}

void ShellHostView::ReadText(Done done) {
  ui::Clipboard* clipboard = ui::Clipboard::GetForCurrentThread();
  if (!clipboard) {
    return std::move(done).Run(true, base::Value(""));
  }
  clipboard->ReadText(
      ui::ClipboardBuffer::kCopyPaste, std::nullopt,
      base::BindOnce(
          [](Done done, std::u16string text) {
            std::move(done).Run(
                true, base::Value(webui_window::TruncateUtf8(
                          base::UTF16ToUTF8(text), kCopyTextLimit)));
          },
          std::move(done)));
}

bool ShellHostView::TakesOpenUrls() const {
  return browser_ && !is_utility() && !private_window() && !closing_;
}

bool ShellHostView::OpenUrlsListening() const {
  return handler_ && open_urls_listener_ == renderer_generation_;
}

void ShellHostView::OpenUrls(base::ListValue urls) {
  Emit("ArdiaShell", "onOpenURLs",
       base::Value(base::DictValue().Set("urls", std::move(urls))));
}

void ShellHostView::BroadcastProfileLoaded(const std::string& profile) {
  Emit("ArdiaProfiles", "profiles",
       base::Value(base::DictValue()
                       .Set("name", "profiles.loaded")
                       .Set("data", base::DictValue().Set("profile", profile))));
}

void ShellHostView::PrivateWindowsChanged() {
  Emit("ArdiaShell", "privateWindows", base::Value(base::DictValue()));
}

bool ShellHostView::EnsureDocumentClient() {
  if (!documents_ || !handler_ || private_window() || !app_profile_ ||
      !app_profile_->IsRegularProfile()) {
    return false;
  }
  if (document_client_.id.empty()) {
    document_client_ = {documents_->scope + ":" + config_.window_id + ":" +
                            base::NumberToString(renderer_generation_),
                        documents_->scope, true, true};
    document_client_generation_ = renderer_generation_;
  }
  return document_client_generation_ == renderer_generation_ &&
         document_client_.scope == documents_->scope;
}

void ShellHostView::RetireDocuments() {
  document_subscription_.Retire();
  if (documents_ && !document_client_.id.empty()) {
    documents_->service.AsyncCall(&ardia::LinuxDocumentService::Retire)
        .WithArgs(document_client_);
  }
  document_client_ = {};
  document_client_generation_ = 0;
}

void ShellHostView::DocumentCall(webui_window::DocumentVerb verb,
                                 base::DictValue request,
                                 Done done) {
  const auto fail = [](Done done, std::string_view code,
                       std::string_view message) {
    std::move(done).Run(false, Failure(code, message));
  };
  if (!EnsureDocumentClient()) {
    return fail(std::move(done), "ERR_DOCUMENT_AUTH", "Document access denied");
  }
  if (webui_window::DocumentSubscriptionVerb(verb)) {
    const std::string* document = request.FindString("document");
    if (request.size() != 1 || !document ||
        *document != webui_window::kLiveDocument) {
      return fail(std::move(done), "ERR_DOCUMENT_REQUEST",
                  "Invalid document subscription");
    }
    if (!document_subscription_.Renew(verb == webui_window::DocumentVerb::kWatch)) {
      return fail(std::move(done), "ERR_DOCUMENT_LIMIT",
                  "Document subscription exhausted");
    }
  }
  if (closing_ && verb == webui_window::DocumentVerb::kCommit) {
    return fail(std::move(done), "ERR_DOCUMENT_CLOSING", "Window is closing");
  }
  const ardia::LinuxDocumentClient client = document_client_;
  scoped_refptr<base::SequencedTaskRunner> ui =
      base::SequencedTaskRunner::GetCurrentDefault();
  ardia::LinuxDocuments::Changed changed =
      [ui, weak = GetWeakPtr(), scope = client.scope,
       generation = renderer_generation_,
       subscription = document_subscription_.sequence()](base::DictValue payload) {
        ui->PostTask(
            FROM_HERE,
            base::BindOnce(
                [](base::WeakPtr<ShellHostView> host, std::string scope,
                   uint64_t generation, uint64_t subscription,
                   base::DictValue payload) {
                  if (!host || !host->handler_ || !host->documents_ ||
                      host->renderer_generation_ != generation ||
                      !host->document_subscription_.Delivers(subscription) ||
                      host->documents_->scope != scope) {
                    return;
                  }
                  host->Emit("ArdiaDocuments", "documents",
                             base::Value(base::DictValue()
                                             .Set("name", "documents.changed")
                                             .Set("data", std::move(payload))));
                },
                weak, scope, generation, subscription, std::move(payload)));
      };
  documents_->service.AsyncCall(&ardia::LinuxDocumentService::Dispatch)
      .WithArgs(std::string(webui_window::DocumentVerbName(verb)), client,
                std::move(request), std::move(changed))
      .Then(base::BindOnce(
          [](Done done, ardia::LinuxDocumentResult result) {
            if (!result.ok()) {
              return std::move(done).Run(
                  false, Failure(result.code, result.message));
            }
            std::optional<std::string> json =
                base::WriteJson(base::Value(std::move(result.value)));
            if (!json) {
              return std::move(done).Run(
                  false, Failure("ERR_BAD_REPLY", "The native reply is not JSON"));
            }
            std::move(done).Run(true, base::Value(std::move(*json)));
          },
          std::move(done)));
}

void ShellHostView::EngineCall(const std::string& name,
                               const std::string& profile,
                               const base::Value* args,
                               Done done) {
  if (name == "engine.systemState") {
    WatchSystemState();
    return ardia::desktop::Platform().CurrentPower(base::BindOnce(
        [](Done done, base::DictValue state) {
          std::move(done).Run(true,
                              base::Value(base::WriteJson(state).value_or("{}")));
        },
        std::move(done)));
  }
  if (const std::optional<webui_window::DocumentVerb> verb =
          webui_window::ParseDocumentVerb(name)) {
    if (!args || !args->is_string() ||
        !webui_window::DocumentEngineRequestAllowed(profile,
                                                    args->GetString().size())) {
      return std::move(done).Run(
          false, Failure("ERR_DOCUMENT_REQUEST",
                         "Invalid document transport request"));
    }
    std::optional<base::Value> parsed = base::JSONReader::Read(
        args->GetString(), base::JSON_PARSE_RFC, kCanonicalDocumentDepth);
    if (!parsed || !parsed->is_dict()) {
      return std::move(done).Run(
          false, Failure("ERR_DOCUMENT_REQUEST",
                         "Document arguments require a JSON object"));
    }
    return DocumentCall(*verb, std::move(parsed->GetDict()), std::move(done));
  }
  const auto* route = ardia::desktop_routes::FindRoute(name);
  ac_engine_call_t call =
      route ? FindEngineCall(std::string(route->service)) : nullptr;
  if (!call) {
    NoteUnhandled("engine.call " + name);
    return std::move(done).Run(
        false, Failure("ERR_UNKNOWN_CALL",
                       "This engine call is not in the Windows WebUI shell"));
  }
  if (ParseProfileName(profile).off_the_record) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE",
                       "Private engine calls are not in the Windows WebUI shell"));
  }
  std::string json = args && args->is_string() ? args->GetString() : "{}";
  if (const std::string_view download_command = DownloadCommandForRoute(name);
      !download_command.empty()) {
    std::optional<base::Value> parsed =
        base::JSONReader::Read(json, base::JSON_PARSE_RFC);
    const std::string* download_id =
        parsed && parsed->is_dict() ? parsed->GetDict().FindString("id")
                                    : nullptr;
    if (!download_id || download_id->empty()) {
      return std::move(done).Run(
          false, Failure("ERR_DOWNLOAD_REQUEST",
                         "A valid download id is required"));
    }
    std::optional<std::string> command_json = base::WriteJson(
        base::DictValue().Set("id", *download_id).Set("command", download_command));
    if (!command_json) {
      return std::move(done).Run(
          false, Failure("ERR_BAD_REPLY", "Download command arguments are not "
                                          "JSON"));
    }
    json = std::move(*command_json);
  }
  struct Pending {
    Done done;
    std::string field;
  };
  WithProfile(
      profile,
      base::BindOnce(
          [](ac_engine_call_t call, std::string json, std::string field,
             Done done, Profile* resolved) {
            if (!resolved) {
              return std::move(done).Run(
                  false, Failure("ERR_PROFILE", "profile not loaded"));
            }
            const std::string path = base::WideToUTF8(
                resolved->GetOriginalProfile()->GetPath().value());
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
