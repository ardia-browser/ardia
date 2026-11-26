#include "ardia/mac/ac_mac_shell_host.h"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/linux/ac_linux_session.h"
#include "ardia/mac/ac_mac_dialog.h"
#include "ardia/mac/ac_mac_swipe.h"
#include "ardia/mac/ac_mac_shell_bridge.h"
#include "ardia/mac/ac_mac_window.h"
#include "ardia/mac/ac_mac_window_policy.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/functional/function_ref.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/download/chrome_download_manager_delegate.h"
#include "chrome/browser/download/download_core_service.h"
#include "chrome/browser/download/download_core_service_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/unload_controller.h"
#include "components/download/public/common/download_item.h"
#include "content/public/browser/download_manager.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/base_window.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/widget/widget.h"

namespace ardia_mac {

namespace {

constexpr std::string_view kAdvertised[] = {
    "ArdiaShell.beginDialog",
    "ArdiaShell.cancelDialog",
    "ArdiaShell.downloadsInProgress",
    "ArdiaShell.requestWindowClose",
    "ArdiaShell.beginWindowCloseDrain",
    "ArdiaShell.acknowledgeWindowClose",
    "ArdiaShell.rejectWindowClose",
    "ArdiaShell.windowState",
    "ArdiaShell.toggleFullScreen",
    "ArdiaShell.restoreFullScreen",
    "ArdiaShell.setWindowTitle",
    "ArdiaShell.minimizeWindow",
    "ArdiaShell.toggleMaximizeWindow",
    "ArdiaShell.setWindowFrame",
    "ArdiaShell.setAppearance",
    "ArdiaShell.watchSidebarEdge",
    "ArdiaShell.setShortcutRecording",
    "ArdiaShell.setSwitcherCapture",
    "ArdiaShell.restoreShortcutFocus",
};

constexpr std::string_view kServed[] = {
    "ArdiaShell.quit",
    "ArdiaShell.closeWindow",
    "ArdiaShell.utilityReady",
    "ArdiaShell.privateWindows",
    "ArdiaShell.windowDecorations",
    "ArdiaShell.watchLeftEdge",
};

constexpr std::string_view kDialogCalls[] = {"ArdiaShell.beginDialog", "ArdiaShell.cancelDialog"};
constexpr std::string_view kKeyboardCalls[] = {"ArdiaShell.setShortcutRecording", "ArdiaShell.setSwitcherCapture",
                                               "ArdiaShell.restoreShortcutFocus"};
constexpr std::string_view kWindowCalls[] = {
    "ArdiaShell.windowState",       "ArdiaShell.windowDecorations",   "ArdiaShell.toggleFullScreen",
    "ArdiaShell.setWindowTitle",    "ArdiaShell.minimizeWindow",      "ArdiaShell.toggleMaximizeWindow",
    "ArdiaShell.setWindowFrame",    "ArdiaShell.closeWindow",         "ArdiaShell.requestWindowClose",
    "ArdiaShell.utilityReady",
};

template <std::size_t N>
bool Listed(const std::string_view (&names)[N], std::string_view method) {
  return std::ranges::find(names, method) != std::end(names);
}

window_policy::QuitBarrier& Quit() {
  static base::NoDestructor<window_policy::QuitBarrier> barrier;
  return *barrier;
}

base::OneShotTimer& QuitDeadline() {
  static base::NoDestructor<base::OneShotTimer> timer;
  return *timer;
}

bool UnloadHandlersPending() {
  bool pending = false;
  ForEachCurrentBrowserWindowInterfaceOrderedByActivation([&pending](BrowserWindowInterface* browser) {
    UnloadController* unload = UnloadController::From(browser);
    pending = unload && unload->TabsNeedBeforeUnloadFired();
    return !pending;
  });
  return pending;
}

void ForEachActiveDownload(base::FunctionRef<void(DownloadCoreService*, download::DownloadItem*)> visit) {
  for (Profile* loaded : g_browser_process->profile_manager()->GetLoadedProfiles()) {
    std::vector<Profile*> profiles = loaded->GetAllOffTheRecordProfiles();
    profiles.insert(profiles.begin(), loaded);
    for (Profile* profile : profiles) {
      DownloadCoreService* service = DownloadCoreServiceFactory::GetForBrowserContext(profile);
      if (!service || !service->HasCreatedDownloadManager()) {
        continue;
      }
      content::DownloadManager::DownloadVector downloads;
      profile->GetDownloadManager()->GetAllDownloads(&downloads);
      for (download::DownloadItem* item : downloads) {
        if (item && window_policy::BlocksShutdown(item->IsTransient(),
                                                  item->GetState() == download::DownloadItem::IN_PROGRESS,
                                                  item->IsDangerous(), item->IsInsecure())) {
          visit(service, item);
        }
      }
    }
  }
}

std::set<std::string> ActiveDownloadIds() {
  std::set<std::string> ids;
  ForEachActiveDownload([&ids](DownloadCoreService*, download::DownloadItem* item) { ids.insert(item->GetGuid()); });
  return ids;
}

window_policy::DownloadPermission& ShownDownloads() {
  static base::NoDestructor<window_policy::DownloadPermission> shown;
  return *shown;
}

void NoteDialogAnswer(const base::Value& envelope) {
  const base::DictValue* event = envelope.GetIfDict();
  const base::DictValue* data = event ? event->FindDict("data") : nullptr;
  const base::DictValue* result = data ? data->FindDict("result") : nullptr;
  const std::string* window = data ? data->FindString("windowId") : nullptr;
  const std::string* renderer = data ? data->FindString("rendererGeneration") : nullptr;
  const std::string* dialog = data ? data->FindString("dialogId") : nullptr;
  if (!result || !window || !renderer || !dialog || result->FindBool("confirmed").value_or(false)) {
    return;
  }
  ShownDownloads().Declined(window_policy::DownloadAsker{*window, *renderer}, *dialog);
}

void NoteDialogOpened(const window_policy::DownloadAsker& asker, const base::DictValue& request) {
  const std::string* kind = request.FindString("kind");
  const std::string* dialog = request.FindString("dialogId");
  if (kind && *kind == "confirm" && dialog) {
    ShownDownloads().Opened(asker, *dialog);
  }
}

window_policy::DownloadAuthorization& QuitDownloadAuthorization() {
  static base::NoDestructor<window_policy::DownloadAuthorization> authorized;
  return *authorized;
}

void FinishShellQuit(window_policy::DownloadAuthorization authorized) {
  const std::set<std::string> cancel =
      window_policy::DownloadsToCancel(true, UnloadHandlersPending(), authorized, ActiveDownloadIds());
  if (!cancel.empty()) {
    ForEachActiveDownload([&cancel](DownloadCoreService* service, download::DownloadItem* item) {
      if (!cancel.contains(item->GetGuid())) {
        return;
      }
      item->Cancel(false);
      if (ChromeDownloadManagerDelegate* delegate = service->GetDownloadManagerDelegate()) {
        delegate->OnDownloadCanceledAtShutdown(item);
      }
    });
  }
  chrome::AttemptExit();
}

void ExitSoon(bool shell_confirmed) {
  QuitDeadline().Stop();
  window_policy::DownloadAuthorization authorized = std::exchange(QuitDownloadAuthorization(), {});
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, shell_confirmed ? base::BindOnce(&FinishShellQuit, std::move(authorized))
                                 : base::BindOnce(&chrome::AttemptExit));
}

std::string StringAt(const base::ListValue* values, std::size_t index) {
  return values && values->size() > index && (*values)[index].is_string() ? (*values)[index].GetString()
                                                                           : std::string();
}

std::optional<window_policy::CloseIdentity> CloseIdentityFrom(const base::DictValue& request,
                                                              std::string_view window) {
  const std::string* id = request.FindString("windowId");
  const std::string* renderer = request.FindString("rendererGeneration");
  const std::string* close = request.FindString("closeGeneration");
  if (!id || *id != window || !renderer || !close || !window_policy::ValidGeneration(*renderer) ||
      !window_policy::ValidGeneration(*close)) {
    return std::nullopt;
  }
  return window_policy::CloseIdentity{*renderer, *close};
}

base::DictValue CloseRequestValue(const std::string& window, const window_policy::CloseIdentity& identity) {
  return base::DictValue()
      .Set("windowId", window)
      .Set("rendererGeneration", identity.renderer)
      .Set("closeGeneration", identity.close);
}

base::Value Stale(std::string_view message) {
  return Failure("ERR_WINDOW_CLOSE_STALE", message);
}

ShellHostView* HostNamed(std::string_view window) {
  for (ShellHostView* host : Hosts()) {
    if (host->window_id() == window) {
      return host;
    }
  }
  return nullptr;
}

void StartQuit(const window_policy::DownloadAsker& asker) {
  window_policy::DownloadAuthorization authorized = ShownDownloads().Take(asker);
  if (Quit().running()) {
    return;
  }
  QuitDownloadAuthorization() = std::move(authorized);
  std::vector<std::string> windows;
  for (ShellHostView* host : Hosts()) {
    if (host->RendererLive()) {
      windows.push_back(host->window_id());
    }
  }
  if (windows.empty()) {
    return ExitSoon(true);
  }
  const std::uint64_t generation = Quit().Begin(windows);
  if (!generation) {
    return;
  }
  QuitDeadline().Start(FROM_HERE, base::Seconds(window_policy::kQuitDeadlineSeconds),
                       base::BindOnce(
                           [](std::uint64_t generation) {
                             if (Quit().Expired(generation) == window_policy::QuitStep::kExit) {
                               Trace("quit went ahead after the windows missed the flush deadline");
                               FinishShellQuit(std::exchange(QuitDownloadAuthorization(), {}));
                             }
                           },
                           generation));
  std::vector<base::WeakPtr<ShellHostView>> hosts;
  for (ShellHostView* host : Hosts()) {
    hosts.push_back(host->GetWeakPtr());
  }
  for (const auto& host : hosts) {
    if (!host || !Quit().Waits(host->window_id())) {
      continue;
    }
    if (host->RequestWindowClose(generation).empty() &&
        Quit().Acknowledged(host->window_id(), generation) == window_policy::QuitStep::kExit) {
      return ExitSoon(true);
    }
  }
}

}

void QuitWithoutShell() {
  ExitSoon(false);
}

std::vector<std::string_view> LifecycleCapabilities() {
  return std::vector<std::string_view>(std::begin(kAdvertised), std::end(kAdvertised));
}

bool ShellHostView::HandlesLifecycleCall(const std::string& method) const {
  return Listed(kAdvertised, method) || Listed(kServed, method);
}

bool ShellHostView::RendererLive() const {
  return browser_ && !closing_ && handler_ && OwnsHandler(handler_, handler_->generation());
}

void ShellHostView::StartLifecycle() {
  views::Widget* widget = browser_view_ ? browser_view_->GetWidget() : nullptr;
  dialogs_ = std::make_unique<DialogSheets>(
      widget, window_id_, BackgroundInstance(),
      base::BindRepeating(
          [](base::WeakPtr<ShellHostView> host, base::Value envelope) {
            NoteDialogAnswer(envelope);
            if (host) {
              host->Emit("ArdiaShell", "shell", std::move(envelope));
            }
          },
          GetWeakPtr()));
  window_events_ = std::make_unique<WindowEvents>(
      widget, base::BindRepeating(&ShellHostView::OnWindowChanged, GetWeakPtr()),
      base::BindRepeating(&ShellHostView::OnPointerMoved, GetWeakPtr()));
  scroll_gestures_ = std::make_unique<ScrollGestures>(this, widget);
  KeepMinimumSize(widget);
}

void ShellHostView::StopLifecycle() {
  edge_.Stop();
  scroll_gestures_.reset();
  window_events_.reset();
  dialogs_.reset();
  close_dialogs_.clear();
  if (quit_generation_ && Quit().Waits(window_id_) &&
      Quit().Acknowledged(window_id_, quit_generation_) == window_policy::QuitStep::kExit) {
    ExitSoon(true);
  }
  quit_generation_ = 0;
}

void ShellHostView::RetireLifecycle() {
  if (dialogs_) {
    for (const auto& [close, token] : close_dialogs_) {
      dialogs_->Resume(token);
    }
    dialogs_->CancelAll();
  }
  close_dialogs_.clear();
  close_.Retire();
  quit_generation_ = 0;
  if (shortcut_recording_ && focus_manager_) {
    focus_manager_->set_shortcut_handling_suspended(false);
  }
  shortcut_recording_ = false;
  SetMenuKeysSuppressed(window_id_, false);
  switcher_capture_ = false;
  switcher_source_.reset();
  edge_.Stop();
  edge_id_.clear();
  if (window_events_) {
    window_events_->WatchPointer(false);
  }
  reported_state_.reset();
}

void ShellHostView::LifecycleCall(const std::string& method, const base::DictValue& args, Done done) {
  const base::ListValue* values = Arguments(args);
  if (Listed(kDialogCalls, method)) {
    return DialogCall(method, values, std::move(done));
  }
  if (Listed(kKeyboardCalls, method)) {
    return KeyboardCall(method, values, std::move(done));
  }
  if (Listed(kWindowCalls, method)) {
    return WindowCall(method, values, std::move(done));
  }
  if (method == "ArdiaShell.watchSidebarEdge" || method == "ArdiaShell.watchLeftEdge") {
    return SidebarEdgeCall(values, method == "ArdiaShell.watchLeftEdge", std::move(done));
  }
  const auto only_dict = [values]() -> const base::DictValue* {
    return values && values->size() == 1 ? (*values)[0].GetIfDict() : nullptr;
  };
  if (method == "ArdiaShell.beginWindowCloseDrain") {
    const base::DictValue* request = only_dict();
    return request ? BeginWindowCloseDrain(*request, std::move(done))
                   : std::move(done).Run(false, Stale("Close identity required"));
  }
  if (method == "ArdiaShell.acknowledgeWindowClose") {
    const base::DictValue* request = only_dict();
    return request ? AcknowledgeWindowClose(*request, std::move(done))
                   : std::move(done).Run(false, Stale("Close identity required"));
  }
  if (method == "ArdiaShell.rejectWindowClose") {
    const base::DictValue* request = only_dict();
    return request ? RejectWindowClose(*request, std::move(done))
                   : std::move(done).Run(false, Stale("Close identity required"));
  }
  if (method == "ArdiaShell.quit" || method == "ArdiaShell.downloadsInProgress") {
    if (values && !values->empty()) {
      return std::move(done).Run(false, base::Value(method + " takes no arguments"));
    }
    if (method == "ArdiaShell.downloadsInProgress") {
      std::set<std::string> shown = ActiveDownloadIds();
      const int count = static_cast<int>(shown.size());
      ShownDownloads().Shown(window_policy::DownloadAsker{window_id_, base::NumberToString(renderer_generation_)},
                             std::move(shown));
      return std::move(done).Run(true, base::Value(count));
    }
    std::move(done).Run(true, base::Value());
    return StartQuit(window_policy::DownloadAsker{window_id_, base::NumberToString(renderer_generation_)});
  }
  if (method == "ArdiaShell.privateWindows") {
    return std::move(done).Run(true, base::Value(base::ListValue()));
  }
  if (method == "ArdiaShell.restoreFullScreen") {
    if (!values || values->empty() || values->size() > 2 || !(*values)[0].is_list() ||
        (values->size() == 2 && !(*values)[1].is_string() && !(*values)[1].is_none())) {
      return std::move(done).Run(false, base::Value("Invalid fullscreen restore"));
    }
    for (const base::Value& id : (*values)[0].GetList()) {
      ShellHostView* host = id.is_string() ? HostNamed(id.GetString()) : nullptr;
      if (!host || host->full_screen_restored_ || !host->window_events_) {
        continue;
      }
      host->full_screen_restored_ = true;
      if (BackgroundInstance()) {
        host->Note("full screen restore for " + host->window_id_ + " skipped (background)");
        continue;
      }
      host->window_events_->EnterFullScreen();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.setAppearance") {
    const std::optional<window_policy::Appearance> appearance = window_policy::AppearanceNamed(StringAt(values, 0));
    if (!appearance || values->size() != 1) {
      return std::move(done).Run(false, base::Value("Appearance is auto, light or dark"));
    }
    SetAppAppearance(*appearance);
    return std::move(done).Run(true, base::Value());
  }
  NoteUnhandled(method);
  std::move(done).Run(true, base::Value());
}

void ShellHostView::DialogCall(const std::string& method, const base::ListValue* values, Done done) {
  if (!values || values->size() != 1) {
    return std::move(done).Run(false, Failure("ERR_DIALOG", "Invalid dialog request"));
  }
  if (!dialogs_ || !RendererLive()) {
    return std::move(done).Run(false, Failure("ERR_DIALOG", "Dialog requester is not current"));
  }
  if (method == "ArdiaShell.cancelDialog") {
    if (!(*values)[0].is_string() || !dialogs_->Cancel((*values)[0].GetString())) {
      return std::move(done).Run(false, Failure("ERR_DIALOG", "Invalid dialog cancellation"));
    }
    return std::move(done).Run(true, base::Value());
  }
  const base::DictValue* request = (*values)[0].GetIfDict();
  if (!request) {
    return std::move(done).Run(false, Failure("ERR_DIALOG", "Invalid dialog request"));
  }
  const std::string live = base::NumberToString(renderer_generation_);
  const dialog_policy::Refusal refusal = dialogs_->Begin(*request, live, live);
  if (refusal != dialog_policy::Refusal::kNone) {
    return std::move(done).Run(false, Failure("ERR_DIALOG", dialog_policy::RefusalMessage(refusal)));
  }
  NoteDialogOpened(window_policy::DownloadAsker{window_id_, live}, *request);
  std::move(done).Run(true, base::Value(base::DictValue().Set("accepted", true)));
}

base::DictValue ShellHostView::RequestWindowClose(std::uint64_t quit_generation) {
  if (!RendererLive()) {
    return {};
  }
  switch (window_policy::PlanCloseRequest(close_.Open(), close_.phase(), quit_generation_, quit_generation)) {
    case window_policy::CloseRequestPlan::kRequest:
      break;
    case window_policy::CloseRequestPlan::kAlreadyLeaving:
      return {};
    case window_policy::CloseRequestPlan::kReissue:
      CancelWindowClose(close_.identity(), "a newer quit replaced it");
      break;
  }
  const bool fresh = !close_.Open();
  const std::optional<window_policy::CloseIdentity> identity = close_.Request(renderer_generation_);
  if (!identity) {
    return {};
  }
  if (fresh || quit_generation) {
    quit_generation_ = quit_generation;
  }
  base::DictValue request = CloseRequestValue(window_id_, *identity);
  if (close_.Deciding()) {
    Emit("ArdiaShell", "shell",
         base::Value(base::DictValue()
                         .Set("name", "shell.closeRequested")
                         .Set("data", request.Clone())
                         .Set("quitting", quit_generation_ != 0)));
  }
  return request;
}

bool ShellHostView::ClosingEndsSession() const {
  if (quit_generation_ || Quit().running()) {
    return true;
  }
  if (is_utility()) {
    return false;
  }
  for (const ShellHostView* host : Hosts()) {
    if (host == this || !host->browser_ || host->closing_ || host->is_utility()) {
      continue;
    }
    const window_policy::ClosePhase phase = host->close_.phase();
    if (phase == window_policy::ClosePhase::kIdle || phase == window_policy::ClosePhase::kRequested ||
        phase == window_policy::ClosePhase::kCancelled) {
      return false;
    }
  }
  return true;
}

void ShellHostView::BeginWindowCloseDrain(const base::DictValue& request, Done done) {
  const std::optional<window_policy::CloseIdentity> identity = CloseIdentityFrom(request, window_id_);
  const bool deciding = close_.Deciding();
  if (request.size() != 3 || !identity || !RendererLive() || !close_.BeginDrain(*identity, renderer_generation_)) {
    return std::move(done).Run(false, Stale("Invalid close drain"));
  }
  if (deciding) {
    if (dialogs_ && !close_dialogs_.contains(identity->close)) {
      close_dialogs_[identity->close] = dialogs_->Suspend();
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<ShellHostView> host, window_policy::CloseIdentity identity) {
              if (host && host->close_.phase() == window_policy::ClosePhase::kDraining &&
                  host->close_.identity() == identity) {
                host->CancelWindowClose(identity, "the drain missed its deadline");
              }
            },
            GetWeakPtr(), *identity),
        base::Seconds(window_policy::kDrainDeadlineSeconds));
  }
  std::move(done).Run(true, base::Value(base::DictValue()
                                            .Set("accepted", true)
                                            .Set("endsSession", ClosingEndsSession())));
}

void ShellHostView::AcknowledgeWindowClose(const base::DictValue& request, Done done) {
  const std::optional<window_policy::CloseIdentity> identity = CloseIdentityFrom(request, window_id_);
  const base::Value* departure_value = request.Find("departure");
  const base::DictValue* departure = departure_value ? departure_value->GetIfDict() : nullptr;
  const bool departure_valid = window_policy::ValidDeparture(
      departure_value != nullptr, departure != nullptr, departure ? departure->size() : 0,
      departure && departure->FindDict("base"), departure && departure->FindDict("session"));
  const base::Value* watermark_value = request.Find("watermark");
  const std::optional<double> watermark =
      watermark_value && (watermark_value->is_int() || watermark_value->is_double())
          ? std::optional<double>(watermark_value->GetDouble())
          : std::nullopt;
  if (!identity || !departure_valid ||
      !window_policy::ValidAcknowledgeShape(request.size(), departure_value != nullptr) || !RendererLive() ||
      !close_.Acknowledge(*identity, renderer_generation_, watermark)) {
    return std::move(done).Run(false, Stale("Invalid close acknowledgment"));
  }
  if (quit_generation_) {
    const window_policy::QuitStep step = Quit().Acknowledged(window_id_, quit_generation_);
    if (step == window_policy::QuitStep::kStale) {
      CancelWindowClose(*identity, "its quit already ended");
      return std::move(done).Run(
          false, Failure("ERR_WINDOW_CLOSE_CANCELLED", "The quit this close belonged to already ended"));
    }
    std::move(done).Run(true, base::Value());
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&ShellHostView::SettleClose, GetWeakPtr(), *identity),
        base::Seconds(window_policy::kQuitDeadlineSeconds + window_policy::kCloseSettleSeconds));
    if (step == window_policy::QuitStep::kExit) {
      ExitSoon(true);
    }
    return;
  }
  if (!departure) {
    std::move(done).Run(true, base::Value());
    return CloseAcknowledgedWindow(*identity);
  }
  if (!ardia::ValidLinuxSession(*departure->FindDict("base")) ||
      !ardia::ValidLinuxSession(*departure->FindDict("session"))) {
    std::move(done).Run(false, Failure("ERR_DOCUMENT_STORAGE", "The window's departure could not be saved"));
    return CancelWindowClose(*identity, "the departure was not a mergeable session");
  }
  held_departure_ = HeldDeparture{*identity, departure->FindDict("base")->Clone(),
                                  departure->FindDict("session")->Clone()};
  std::move(done).Run(true, base::Value());
  CloseAcknowledgedWindow(*identity);
}

void ShellHostView::CloseAcknowledgedWindow(window_policy::CloseIdentity identity) {
  if (!close_.BeginClosing(identity)) {
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<ShellHostView> host, window_policy::CloseIdentity identity) {
                       if (!host || !host->browser_ || host->close_.phase() != window_policy::ClosePhase::kClosing ||
                           host->close_.identity() != identity) {
                         return;
                       }
                       host->browser_->GetWindow()->Close();
                     },
                     GetWeakPtr(), identity));
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&ShellHostView::SettleClose, GetWeakPtr(), identity),
      base::Seconds(window_policy::kCloseSettleSeconds));
}

void ShellHostView::SettleClose(window_policy::CloseIdentity identity) {
  const window_policy::ClosePhase phase = close_.phase();
  if (close_.identity() != identity ||
      (phase != window_policy::ClosePhase::kClosing && phase != window_policy::ClosePhase::kAcknowledged)) {
    return;
  }
  CancelWindowClose(identity, "the window stayed open");
}

void ShellHostView::RejectWindowClose(const base::DictValue& request, Done done) {
  const std::optional<window_policy::CloseIdentity> identity = CloseIdentityFrom(request, window_id_);
  if (request.size() != 3 || !identity || !close_.Open() || close_.identity() != *identity) {
    return std::move(done).Run(false, Stale("Invalid close rejection"));
  }
  const std::uint64_t quit_generation = quit_generation_;
  CancelWindowClose(*identity, "the shell kept the window");
  std::move(done).Run(true, base::Value());
  if (quit_generation && Quit().Rejected(window_id_, quit_generation) == window_policy::QuitStep::kAbort) {
    QuitDeadline().Stop();
    QuitDownloadAuthorization() = {};
    Note("quit cancelled by window " + window_id_);
    std::vector<base::WeakPtr<ShellHostView>> hosts;
    for (ShellHostView* host : Hosts()) {
      hosts.push_back(host->GetWeakPtr());
    }
    for (const auto& host : hosts) {
      if (host && host.get() != this && host->quit_generation_ == quit_generation && host->close_.Open()) {
        host->CancelWindowClose(host->close_.identity(), "another window kept the app open");
      }
    }
  }
}

void ShellHostView::CommitHeldDeparture() {
  const bool held = held_departure_.has_value();
  switch (shell_policy::DepartureStepFor(held, close_.phase() == window_policy::ClosePhase::kClosing,
                                         held && close_.identity() == held_departure_->identity)) {
    case shell_policy::DepartureStep::kNone:
      return;
    case shell_policy::DepartureStep::kDiscard:
      held_departure_.reset();
      return;
    case shell_policy::DepartureStep::kCommit:
      break;
  }
  HeldDeparture departure = std::move(*held_departure_);
  held_departure_.reset();
  SessionFiles()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&MergeAndWriteSession, std::move(departure.base), std::move(departure.session)),
      base::BindOnce(
          [](std::string window, MergedSession merged) {
            if (!merged.ok) {
              LOG(WARNING) << "Ardia Mac WebUI: window " << window
                           << " closed but its departure could not be saved";
              return;
            }
            BroadcastSession(merged, window, nullptr);
          },
          window_id_));
}

void ShellHostView::CancelWindowClose(const window_policy::CloseIdentity& identity, std::string_view reason) {
  if (held_departure_ && held_departure_->identity == identity) {
    held_departure_.reset();
  }
  if (!close_.Cancel(identity)) {
    return;
  }
  const window_policy::CloseIdentity cancelled = identity;
  if (const auto found = close_dialogs_.find(cancelled.close); found != close_dialogs_.end()) {
    const std::uint64_t token = found->second;
    close_dialogs_.erase(found);
    if (dialogs_) {
      dialogs_->Resume(token);
    }
  }
  quit_generation_ = 0;
  Note("window " + window_id_ + " close cancelled: " + std::string(reason));
  EmitShellEvent("shell.closeCancelled", base::Value(CloseRequestValue(window_id_, cancelled)));
}

base::DictValue ShellHostView::WindowStateValue() const {
  const window_policy::WindowState state = window_events_ ? window_events_->State() : window_policy::WindowState();
  return base::DictValue()
      .Set("windowId", window_id_)
      .Set("maximized", state.maximized)
      .Set("tiled", state.tiled)
      .Set("fullScreen", state.full_screen);
}

base::DictValue ShellHostView::WindowGeometryValue() const {
  const gfx::Rect bounds = browser_ ? browser_->GetWindow()->GetBounds() : gfx::Rect();
  const window_policy::WindowState state = window_events_ ? window_events_->State() : window_policy::WindowState();
  return base::DictValue()
      .Set("frame", base::ListValue()
                        .Append(bounds.x())
                        .Append(bounds.y())
                        .Append(bounds.width())
                        .Append(bounds.height()))
      .Set("zoomed", state.maximized)
      .Set("fullScreen", state.full_screen)
      .Set("miniaturized", browser_ && browser_->GetWindow()->IsMinimized())
      .Set("visible", browser_ && browser_->GetWindow()->IsVisible())
      .Set("display", base::Value());
}

void ShellHostView::WindowCall(const std::string& method, const base::ListValue* values, Done done) {
  ShellHostView* target = HostNamed(StringAt(values, 0));
  if (!target || !target->browser_ || !target->window_events_) {
    return std::move(done).Run(false, base::Value("No such native window"));
  }
  WindowEvents& window = *target->window_events_;
  if (method == "ArdiaShell.windowState") {
    return std::move(done).Run(true, base::Value(target->WindowStateValue()));
  }
  if (method == "ArdiaShell.windowDecorations") {
    return std::move(done).Run(true, base::Value(base::DictValue()
                                                     .Set("decoratedBy", "compositor")
                                                     .Set("answer", "server")
                                                     .Set("corners", base::DictValue()
                                                                         .Set("upperLeft", 0)
                                                                         .Set("upperRight", 0)
                                                                         .Set("lowerRight", 0)
                                                                         .Set("lowerLeft", 0))));
  }
  if (method == "ArdiaShell.utilityReady") {
    if (target != this || !is_utility()) {
      return std::move(done).Run(false, base::Value("No such utility renderer"));
    }
    utility_ready_ = true;
    return std::move(done).Run(true, base::Value(utility_.Clone()));
  }
  if (method == "ArdiaShell.closeWindow" || method == "ArdiaShell.requestWindowClose") {
    base::DictValue request = target->RequestWindowClose(0);
    if (request.empty()) {
      return std::move(done).Run(false, Failure("ERR_WINDOW_CLOSE_UNAVAILABLE", "Target renderer unavailable"));
    }
    return std::move(done).Run(true, base::Value(std::move(request)));
  }
  if (method == "ArdiaShell.toggleFullScreen") {
    if (BackgroundInstance()) {
      target->Note("full screen toggle skipped (background)");
      return std::move(done).Run(true, base::Value(window.FullScreen()));
    }
    return std::move(done).Run(true, base::Value(window.ToggleFullScreen()));
  }
  if (method == "ArdiaShell.setWindowTitle") {
    const std::optional<std::string> title =
        values->size() == 2 && (*values)[1].is_string() ? window_policy::WindowTitle((*values)[1].GetString())
                                                        : std::nullopt;
    if (!title) {
      return std::move(done).Run(false, base::Value("A window title is text of at most 1024 bytes"));
    }
    window.SetTitle(*title);
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.minimizeWindow") {
    if (BackgroundInstance()) {
      target->Note("minimize skipped (background)");
    } else {
      window.Minimize();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.toggleMaximizeWindow") {
    window.ToggleZoom();
    return std::move(done).Run(true, base::Value());
  }
  const base::ListValue* frame = values->size() == 2 ? (*values)[1].GetIfList() : nullptr;
  const auto number = [frame](std::size_t index) -> std::optional<double> {
    if (!frame || frame->size() != 4 || !((*frame)[index].is_int() || (*frame)[index].is_double())) {
      return std::nullopt;
    }
    return (*frame)[index].GetDouble();
  };
  const std::optional<window_policy::Frame> wanted = window_policy::FrameFrom(number(0), number(1), number(2), number(3));
  base::DictValue geometry = target->WindowGeometryValue();
  if (!wanted) {
    geometry.Set("refused", "invalid");
    return std::move(done).Run(true, base::Value(std::move(geometry)));
  }
  if (!window_policy::OnAnyScreen(*wanted, window.Screens())) {
    geometry.Set("refused", "offscreen");
    return std::move(done).Run(true, base::Value(std::move(geometry)));
  }
  if (!window.FullScreen()) {
    target->browser_->GetWindow()->SetBounds(gfx::Rect(static_cast<int>(wanted->x), static_cast<int>(wanted->y),
                                                       static_cast<int>(wanted->width),
                                                       static_cast<int>(wanted->height)));
  }
  std::move(done).Run(true, base::Value(target->WindowGeometryValue()));
}

void ShellHostView::KeyboardCall(const std::string& method, const base::ListValue* values, Done done) {
  if (method == "ArdiaShell.restoreShortcutFocus") {
    RestoreSwitcherSource();
    return std::move(done).Run(true, base::Value());
  }
  if (!focus_manager_ || !values || values->size() != 1 || !(*values)[0].is_bool()) {
    return std::move(done).Run(false, base::Value("A keyboard capture flag is required"));
  }
  const bool on = (*values)[0].GetBool();
  if (method == "ArdiaShell.setShortcutRecording") {
    shortcut_recording_ = on;
    focus_manager_->set_shortcut_handling_suspended(on);
    SetMenuKeysSuppressed(window_id_, on);
    WatchRecordedKeys(on);
    return std::move(done).Run(true, base::Value());
  }
  switcher_capture_ = on;
  if (on) {
    FocusShell();
  } else {
    RestoreSwitcherSource();
  }
  std::move(done).Run(true, base::Value());
}

void ShellHostView::NoteSwitcherSource() {
  for (const auto& [id, binding] : bindings_) {
    if (binding->viewport && binding->viewport->HasFocus() && binding->contents()) {
      switcher_source_ = binding->contents()->GetWeakPtr();
      return;
    }
  }
  switcher_source_.reset();
}

void ShellHostView::RestoreSwitcherSource() {
  content::WebContents* contents = switcher_source_.get();
  switcher_source_.reset();
  BrowserWindowInterface* owner = contents ? OwnerOf(contents) : nullptr;
  if (!owner || owner->GetTabStripModel()->GetActiveWebContents() != contents) {
    return;
  }
  if (PageBinding* binding = BindingForContents(contents); binding && binding->viewport) {
    binding->viewport->RequestFocus();
  }
  contents->Focus();
}

void ShellHostView::SidebarEdgeCall(const base::ListValue* values, bool left_only, Done done) {
  const std::size_t most = left_only ? 3 : 5;
  const auto number = [](const base::Value& value) { return value.is_int() || value.is_double(); };
  if (!values || values->size() < 2 || values->size() > most || !(*values)[0].is_string() ||
      (*values)[0].GetString().empty() || !window_policy::ValidWindowId((*values)[0].GetString()) ||
      !(*values)[1].is_bool() || (values->size() > 2 && !number((*values)[2])) ||
      (values->size() > 3 && !(*values)[3].is_bool()) || (values->size() > 4 && !(*values)[4].is_bool())) {
    return std::move(done).Run(false, base::Value("A window id and a watch flag are required"));
  }
  if (!window_events_) {
    return std::move(done).Run(true, base::Value());
  }
  if (!(*values)[1].GetBool()) {
    edge_.Stop();
    window_events_->WatchPointer(false);
    return std::move(done).Run(true, base::Value());
  }
  edge_id_ = (*values)[0].GetString();
  const double hold = values->size() > 2 ? (*values)[2].GetDouble() : 0;
  const window_policy::Side side =
      values->size() > 3 && (*values)[3].GetBool() ? window_policy::Side::kRight : window_policy::Side::kLeft;
  const bool while_pressed = values->size() > 4 && (*values)[4].GetBool();
  window_events_->WatchPointer(true);
  const std::optional<WindowEvents::Pointer> live = window_events_->LivePointer();
  const double zoom = ShellZoom();
  if (live && !live->covered) {
    edge_.Place(live->x / zoom, live->y / zoom, live->width / zoom, live->height / zoom, live->pressed);
  } else {
    edge_.Forget();
  }
  ReportSidebarEdge(edge_.Watch(hold, side, while_pressed));
  ReconcilePointerPoll(live);
  std::move(done).Run(true, base::Value());
}

void ShellHostView::ReconcilePointerPoll(const std::optional<WindowEvents::Pointer>& pointer) {
  if (!window_events_) {
    return;
  }
  window_events_->PollPointer(
      pointer && !pointer->covered &&
      window_policy::PollsOutside(edge_.over(), pointer->x, pointer->y, pointer->width, pointer->height));
}

void ShellHostView::OnPointerMoved(const WindowEvents::Pointer& pointer) {
  if (!edge_.watching()) {
    return;
  }
  if (pointer.covered) {
    ReportSidebarEdge(edge_.Covered());
  } else {
    const double zoom = ShellZoom();
    ReportSidebarEdge(
        edge_.Moved(pointer.x / zoom, pointer.y / zoom, pointer.width / zoom, pointer.height / zoom, pointer.pressed));
  }
  ReconcilePointerPoll(pointer);
}

void ShellHostView::ReportSidebarEdge(std::optional<window_policy::EdgeReport> report) {
  if (!report || edge_id_.empty()) {
    return;
  }
  Emit("ArdiaShell", "onWindowEvent",
       base::Value(base::DictValue()
                       .Set("type", "sidebarEdge")
                       .Set("id", edge_id_)
                       .Set("over", report->over)
                       .Set("point", base::ListValue().Append(report->x).Append(report->y))));
}

void ShellHostView::EmitWindowEvent(base::DictValue event) {
  for (ShellHostView* host : Hosts()) {
    host->Emit("ArdiaShell", "onWindowEvent", base::Value(event.Clone()));
  }
}

void ShellHostView::ReportWindowState() {
  if (!window_events_) {
    return;
  }
  const window_policy::WindowState state = window_events_->State();
  if (reported_state_ == state) {
    return;
  }
  const bool maximized_changed = !reported_state_ || reported_state_->maximized != state.maximized;
  reported_state_ = state;
  Emit("ArdiaShell", "windowState", base::Value(WindowStateValue()));
  if (maximized_changed) {
    EmitWindowEvent(base::DictValue().Set("type", "maximized").Set("id", window_id_).Set("on", state.maximized));
  }
}

void ShellHostView::OnWindowChanged(WindowEvents::Kind kind) {
  if (!window_events_ || !browser_) {
    return;
  }
  views::Widget* widget = browser_view_ ? browser_view_->GetWidget() : nullptr;
  switch (kind) {
    case WindowEvents::Kind::kFocus:
      EmitWindowEvent(base::DictValue().Set("type", "focus").Set("id", window_id_));
      return;
    case WindowEvents::Kind::kBlur:
      ReportSidebarEdge(edge_.Resigned());
      window_events_->PollPointer(false);
      EmitWindowEvent(base::DictValue().Set("type", "blur").Set("id", window_id_));
      return;
    case WindowEvents::Kind::kFrame: {
      KeepMinimumSize(widget);
      ReportWindowState();
      if (window_events_->FullScreen() || browser_->GetWindow()->IsMinimized()) {
        return;
      }
      const gfx::Rect bounds = browser_->GetWindow()->GetBounds();
      EmitWindowEvent(base::DictValue()
                          .Set("type", "frame")
                          .Set("id", window_id_)
                          .Set("frame", base::ListValue()
                                            .Append(bounds.x())
                                            .Append(bounds.y())
                                            .Append(bounds.width())
                                            .Append(bounds.height())));
      return;
    }
    case WindowEvents::Kind::kFullScreen:
      window_events_->RouteCloseButton();
      KeepMinimumSize(widget);
      EmitWindowEvent(
          base::DictValue().Set("type", "fullScreen").Set("id", window_id_).Set("on", window_events_->FullScreen()));
      ReportWindowState();
      return;
    case WindowEvents::Kind::kMiniaturize:
    case WindowEvents::Kind::kDeminiaturize:
      ReportWindowState();
      return;
    case WindowEvents::Kind::kClose: {
      const std::string closed = window_id_;
      for (ShellHostView* host : Hosts()) {
        if (host != this) {
          host->Emit("ArdiaShell", "onWindowEvent",
                     base::Value(base::DictValue().Set("type", "close").Set("id", closed)));
        }
      }
      return;
    }
    case WindowEvents::Kind::kCloseButton:
      if (RequestWindowClose(0).empty()) {
        window_events_->PerformClose();
      }
      return;
  }
}

}
