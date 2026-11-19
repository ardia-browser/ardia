#include "ardia/win/tab_calls.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string_view>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/ac_calls.h"
#include "ardia/win/autoplay.h"
#include "ardia/win/contents_background.h"
#include "ardia/win/external_apps.h"
#include "ardia/win/kept_pages.h"
#include "ardia/win/now_playing.h"
#include "ardia/win/page_links.h"
#include "ardia/win/tab_events.h"
#include "base/containers/span.h"
#include "base/barrier_callback.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/metrics/user_metrics.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/devtools/devtools_toggle_action.h"
#include "chrome/browser/devtools/devtools_window.h"
#include "chrome/browser/performance_manager/policies/cannot_discard_reason.h"
#include "chrome/browser/performance_manager/policies/discard_eligibility_policy.h"
#include "chrome/browser/performance_manager/policies/page_discarding_helper.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/resource_coordinator/lifecycle_unit_state.mojom.h"
#include "chrome/browser/resource_coordinator/tab_lifecycle_unit_external.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tab_contents/core_tab_helper.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/content_restriction.h"
#include "chrome/common/pref_names.h"
#include "components/blocked_content/popup_blocker_tab_helper.h"
#include "components/performance_manager/public/decorators/page_live_state_decorator.h"
#include "components/performance_manager/public/graph/graph.h"
#include "components/performance_manager/public/graph/page_node.h"
#include "components/performance_manager/public/performance_manager.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/find_in_page/find_tab_helper.h"
#include "components/find_in_page/find_types.h"
#include "components/policy/core/common/policy_pref_names.h"
#include "components/prefs/pref_service.h"
#include "components/web_modal/web_contents_modal_dialog_manager.h"
#include "components/zoom/page_zoom.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "content/public/common/page_zoom.h"
#include "content/public/common/url_utils.h"
#include "pdf/buildflags.h"
#include "printing/buildflags/buildflags.h"
#include "third_party/blink/public/common/web_preferences/web_preferences.h"
#include "third_party/blink/public/mojom/css/preferred_color_scheme.mojom-shared.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/scheme_host_port.h"
#if BUILDFLAG(ENABLE_PDF)
#include "chrome/browser/pdf/pdf_extension_util.h"
#include "pdf/pdf_features.h"
#endif
#if BUILDFLAG(ENABLE_PRINTING)
#include "chrome/browser/printing/print_view_manager_common.h"
#endif
#if BUILDFLAG(ENABLE_PRINT_PREVIEW)
#include "chrome/browser/printing/print_preview_dialog_controller.h"
#endif

namespace ardia_win {

namespace {

constexpr size_t kMaxEvaluationResultBytes = 4 * 1024 * 1024;
constexpr base::TimeDelta kClickAnswerDeadline = base::Seconds(10);

constexpr char kEvaluationStart[] =
    "new Promise((resolve) => {(function(post){'use strict';\n";

constexpr char kEvaluationEnd[] =
    "\n})((kind, json) => {if (kind === 'result') "
    "resolve(typeof json === 'string' ? json : 'null');});})";

constexpr char kWokenPageMediaChoice[] =
    "const all = [];"
    "const collect = (doc) => {"
    "all.push(...doc.querySelectorAll('video,audio'));"
    "for (const frame of doc.querySelectorAll('iframe')) {"
    "try { if (frame.contentDocument) collect(frame.contentDocument); }"
    " catch (e) {}"
    "}"
    "};"
    "collect(document);"
    "const playing = (m) => !m.paused && !m.ended;"
    "const playable = (m) => m.currentSrc || m.srcObject || m.src || "
    "m.querySelector('source[src]');"
    "return all.find(playing) || all.find(playable) || null;";

constexpr char kWokenPagePlaysStart[] =
    "((from) => {"
    "const el = (() => {";

constexpr char kWokenPagePlaysEnd[] =
    "})();"
    "if (!el) return;"
    "if (Number.isFinite(from) && from >= 0) el.currentTime = from;"
    "el.play();"
    "})(";

using DevToolsReply =
    base::OnceCallback<void(std::optional<base::DictValue> result,
                            std::optional<std::string> error)>;

base::DictValue Ok() {
  base::DictValue result;
  result.Set("ok", true);
  return result;
}

std::string Text(const base::DictValue& args, std::string_view key) {
  const std::string* value = args.FindString(key);
  return value ? *value : std::string();
}

int Integer(const base::DictValue& args, std::string_view key) {
  return static_cast<int>(args.FindDouble(key).value_or(0));
}

void Answer(DevToolsReply reply,
            std::optional<base::DictValue> result,
            std::optional<std::string> error) {
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(std::move(reply), std::move(result), std::move(error)));
}

class DevToolsCaller : public content::DevToolsAgentHostClient,
                       public content::WebContentsUserData<DevToolsCaller> {
 public:
  ~DevToolsCaller() override {
    if (host_) {
      host_->DetachClient(this);
    }
    FailAll("the tab is gone");
  }

  void Call(const std::string& method,
            base::DictValue params,
            std::optional<base::TimeDelta> timeout,
            DevToolsReply reply) {
    if (!host_) {
      host_ = content::DevToolsAgentHost::GetOrCreateFor(&GetWebContents());
      if (!host_ || !host_->AttachClient(this)) {
        host_ = nullptr;
        Answer(std::move(reply), std::nullopt, "can't attach to the tab");
        return;
      }
    }
    const int id = next_id_++;
    base::DictValue message;
    message.Set("id", id);
    message.Set("method", method);
    message.Set("params", std::move(params));
    std::optional<std::string> json = base::WriteJson(message);
    if (!json) {
      Answer(std::move(reply), std::nullopt, "params aren't JSON");
      return;
    }
    pending_[id] = std::move(reply);
    ++generation_;
    if (timeout) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&DevToolsCaller::TimedOut, weak_factory_.GetWeakPtr(),
                         id),
          *timeout);
    }
    scoped_refptr<content::DevToolsAgentHost> host = host_;
    host->DispatchProtocolMessage(this, base::as_byte_span(*json));
  }

  void DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                               base::span<const uint8_t> message) override {
    std::optional<base::DictValue> parsed = base::JSONReader::ReadDict(
        base::as_string_view(message), base::JSON_PARSE_CHROMIUM_EXTENSIONS);
    if (!parsed) {
      return;
    }
    std::optional<int> id = parsed->FindInt("id");
    if (!id) {
      return;
    }
    auto it = pending_.find(*id);
    if (it == pending_.end()) {
      return;
    }
    DevToolsReply reply = std::move(it->second);
    pending_.erase(it);
    MaybeDetachSoon();
    if (base::DictValue* error = parsed->FindDict("error")) {
      const std::string* text = error->FindString("message");
      Answer(std::move(reply), std::nullopt, text ? *text : "error");
      return;
    }
    base::DictValue* result = parsed->FindDict("result");
    Answer(std::move(reply), result ? std::move(*result) : base::DictValue(),
           std::nullopt);
  }

  void AgentHostClosed(content::DevToolsAgentHost* agent_host) override {
    host_ = nullptr;
    FailAll("the tab's DevTools target closed");
  }

  bool MayAttachToURL(const GURL& url, bool is_webui) override { return true; }
  bool IsTrusted() override { return true; }
  bool MayReadLocalFiles() override { return false; }
  bool MayWriteLocalFiles() override { return false; }

 private:
  friend class content::WebContentsUserData<DevToolsCaller>;

  explicit DevToolsCaller(content::WebContents* contents)
      : content::WebContentsUserData<DevToolsCaller>(*contents) {}

  void TimedOut(int id) {
    auto it = pending_.find(id);
    if (it == pending_.end()) {
      return;
    }
    DevToolsReply reply = std::move(it->second);
    pending_.erase(it);
    Answer(std::move(reply), std::nullopt, "timed out");
    MaybeDetachSoon();
  }

  void MaybeDetachSoon() {
    if (!pending_.empty()) {
      return;
    }
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&DevToolsCaller::DetachIfIdle,
                                  weak_factory_.GetWeakPtr(), generation_));
  }

  void DetachIfIdle(int generation) {
    if (generation != generation_ || !pending_.empty() || !host_) {
      return;
    }
    scoped_refptr<content::DevToolsAgentHost> host = std::move(host_);
    host->DetachClient(this);
  }

  void FailAll(const std::string& why) {
    std::map<int, DevToolsReply> pending = std::move(pending_);
    pending_.clear();
    for (auto& [id, reply] : pending) {
      Answer(std::move(reply), std::nullopt, why);
    }
  }

  scoped_refptr<content::DevToolsAgentHost> host_;
  int next_id_ = 1;
  std::map<int, DevToolsReply> pending_;
  int generation_ = 0;
  base::WeakPtrFactory<DevToolsCaller> weak_factory_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(DevToolsCaller);

void CallDevTools(content::WebContents* contents,
                  const std::string& method,
                  base::DictValue params,
                  std::optional<base::TimeDelta> timeout,
                  DevToolsReply reply) {
  EndAheadBlank(contents);
  DevToolsCaller::CreateForWebContents(contents);
  DevToolsCaller::FromWebContents(contents)->Call(
      method, std::move(params), timeout, std::move(reply));
}

void Ignore(std::optional<base::DictValue> result,
            std::optional<std::string> error) {}

void RunInPage(content::WebContents* contents, std::string code) {
  base::DictValue params;
  params.Set("expression", std::move(code));
  CallDevTools(contents, "Runtime.evaluate", std::move(params), std::nullopt,
               base::BindOnce(&Ignore));
}

void ThawHiddenPage(content::WebContents* contents) {
  TabEvents* events = TabEvents::FromWebContents(contents);
  if (events && !events->frozen() &&
      contents->GetVisibility() != content::Visibility::VISIBLE) {
    contents->SetPageFrozen(false);
  }
}

std::optional<bool> RunPageCommand(content::WebContents* contents,
                                   int command) {
  Profile* profile =
      Profile::FromBrowserContext(contents->GetBrowserContext());
  PrefService* prefs = profile->GetPrefs();
  CoreTabHelper* core = CoreTabHelper::FromWebContents(contents);
  const int restrictions = core ? core->content_restrictions() : 0;
  switch (command) {
#if BUILDFLAG(ENABLE_PRINTING)
    case IDC_PRINT:
    case IDC_BASIC_PRINT: {
      auto* dialogs =
          web_modal::WebContentsModalDialogManager::FromWebContents(contents);
      const bool can_print = prefs->GetBoolean(prefs::kPrintingEnabled) &&
                             !contents->IsCrashed() &&
                             !(dialogs && dialogs->IsDialogActive()) &&
                             !(restrictions & CONTENT_RESTRICTION_PRINT);
      bool preview = false;
#if BUILDFLAG(ENABLE_PRINT_PREVIEW)
      auto* previews = printing::PrintPreviewDialogController::GetInstance();
      preview = previews &&
                (previews->GetPrintPreviewForContents(contents) ||
                 previews->is_creating_print_preview_dialog());
#endif
      if (!can_print && !(command == IDC_BASIC_PRINT && preview &&
                          prefs->GetBoolean(prefs::kPrintingEnabled))) {
        return false;
      }
      if (command == IDC_PRINT) {
        printing::StartPrint(
            contents, prefs->GetBoolean(prefs::kPrintPreviewDisabled), false);
      } else {
        printing::StartBasicPrint(contents);
      }
      return true;
    }
#endif
    case IDC_SAVE_PAGE: {
      PrefService* local_state = g_browser_process->local_state();
      content::NavigationEntry* entry =
          contents->GetController().GetLastCommittedEntry();
      if ((local_state &&
           !local_state->GetBoolean(prefs::kAllowFileSelectionDialogs)) ||
          static_cast<policy::DownloadRestriction>(prefs->GetInteger(
              policy::policy_prefs::kDownloadRestrictions)) ==
              policy::DownloadRestriction::ALL_FILES ||
          (restrictions & CONTENT_RESTRICTION_SAVE) ||
          (entry && !content::IsSavableURL(entry->GetURL()))) {
        return false;
      }
      base::RecordAction(base::UserMetricsAction("SavePage"));
#if BUILDFLAG(ENABLE_PDF)
      if (contents->GetContentsMimeType() == "application/pdf" &&
          chrome_pdf::features::IsOopifPdfEnabled() &&
          pdf_extension_util::MaybeDispatchSaveEvent(
              contents->GetPrimaryMainFrame())) {
        return true;
      }
#endif
      contents->OnSavePage();
      return true;
    }
    case IDC_DEV_TOOLS_CONSOLE:
    case IDC_DEV_TOOLS_INSPECT:
      DevToolsWindow::OpenDevToolsWindow(
          contents,
          command == IDC_DEV_TOOLS_CONSOLE
              ? DevToolsToggleAction::ShowConsolePanel()
              : DevToolsToggleAction::Inspect(),
          DevToolsOpenedByAction::kMainMenuOrMainShortcut);
      return true;
    case IDC_DEV_TOOLS_TOGGLE: {
      DevToolsWindow* tools =
          DevToolsWindow::GetInstanceForInspectedWebContents(contents);
      if (tools && tools->IsDocked()) {
        if (content::WebContents* docked =
                DevToolsWindow::GetInTabWebContents(contents, nullptr)) {
          docked->DispatchBeforeUnload(false);
        }
      } else {
        DevToolsWindow::OpenDevToolsWindow(
            contents, DevToolsToggleAction::Show(),
            DevToolsOpenedByAction::kMainMenuOrMainShortcut);
      }
      return true;
    }
    default:
      return std::nullopt;
  }
}

bool ExecuteChromeCommand(content::WebContents* contents, int command) {
  BrowserWindowInterface* browser =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
  if (!browser) {
    return false;
  }
  TabStripModel* model = browser->GetTabStripModel();
  const int index = model->GetIndexOfWebContents(contents);
  const int active = model->active_index();
  if (index == TabStripModel::kNoTab) {
    return false;
  }
  if (index == active) {
    return chrome::ExecuteCommand(browser, command);
  }
  if (std::optional<bool> ran = RunPageCommand(contents, command)) {
    return *ran;
  }
  if (command == IDC_CARET_BROWSING_TOGGLE) {
    return chrome::ExecuteCommand(browser, command);
  }
  return false;
}

int PageCommandNamed(const std::string& name) {
  if (name == "savePage") {
    return IDC_SAVE_PAGE;
  }
#if BUILDFLAG(ENABLE_PRINTING)
  if (name == "systemPrint") {
    return IDC_BASIC_PRINT;
  }
#endif
  if (name == "caretBrowsing") {
    return IDC_CARET_BROWSING_TOGGLE;
  }
  return 0;
}

std::string SiteOrigin(const GURL& url) {
  if (!url.is_valid()) {
    return std::string();
  }
  const url::Origin origin = url::Origin::Create(url);
  const url::SchemeHostPort& tuple =
      origin.GetTupleOrPrecursorTupleIfOpaque();
  return tuple.IsValid() ? tuple.Serialize() : std::string();
}

void Find(content::WebContents* contents,
          const base::DictValue& args,
          Reply reply) {
  if (auto* helper = find_in_page::FindTabHelper::FromWebContents(contents)) {
    helper->StartFinding(base::UTF8ToUTF16(Text(args, "text")),
                         args.FindBool("forward").value_or(true), false, true);
  }
  std::move(reply).Run(Ok());
}

void StopFinding(content::WebContents* contents,
                 const base::DictValue& args,
                 Reply reply) {
  if (auto* helper = find_in_page::FindTabHelper::FromWebContents(contents)) {
    helper->StopFinding(find_in_page::SelectionAction::kKeep);
  }
  std::move(reply).Run(Ok());
}

void ZoomStep(content::WebContents* contents,
              const base::DictValue& args,
              Reply reply) {
  const int direction = Integer(args, "direction");
  const double before = TabEvents::ZoomFactor(contents);
  zoom::PageZoom::Zoom(contents, direction > 0   ? content::PAGE_ZOOM_IN
                                 : direction < 0 ? content::PAGE_ZOOM_OUT
                                                 : content::PAGE_ZOOM_RESET);
  TabEvents* events = TabEvents::FromWebContents(contents);
  if (events && std::fabs(TabEvents::ZoomFactor(contents) - before) > 1e-6) {
    events->SendZoom(true);
  }
  std::move(reply).Run(Ok());
}

void ExecuteJavaScript(content::WebContents* contents,
                       const base::DictValue& args,
                       Reply reply) {
  RunInPage(contents, Text(args, "code"));
  std::move(reply).Run(Ok());
}

void Evaluated(Reply reply,
               std::optional<base::DictValue> result,
               std::optional<std::string> error) {
  const base::DictValue* value =
      result && !result->FindDict("exceptionDetails")
          ? result->FindDict("result")
          : nullptr;
  const std::string* json = value ? value->FindString("value") : nullptr;
  base::DictValue answer;
  if (json && json->size() <= kMaxEvaluationResultBytes) {
    answer.Set("result", *json);
  } else {
    answer.Set("result", base::Value());
  }
  std::move(reply).Run(std::move(answer));
}

void Evaluate(content::WebContents* contents,
              const base::DictValue& args,
              Reply reply) {
  ThawHiddenPage(contents);
  base::DictValue params;
  params.Set("expression",
             kEvaluationStart + Text(args, "code") + kEvaluationEnd);
  params.Set("awaitPromise", true);
  params.Set("returnByValue", true);
  if (args.FindBool("userGesture").value_or(false) &&
      ardiacore::TestInstance()) {
    params.Set("userGesture", true);
  }
  CallDevTools(contents, "Runtime.evaluate", std::move(params), std::nullopt,
               base::BindOnce(&Evaluated, std::move(reply)));
}

void NavigationEntries(content::WebContents* contents,
                       const base::DictValue& args,
                       Reply reply) {
  content::NavigationController& controller = contents->GetController();
  const int current = controller.GetCurrentEntryIndex();
  const int committed = controller.GetLastCommittedEntryIndex();
  base::ListValue entries;
  for (int i = 0; i < controller.GetEntryCount(); ++i) {
    content::NavigationEntry* entry = controller.GetEntryAtIndex(i);
    base::DictValue item;
    item.Set("url", entry->GetURL().spec());
    item.Set("title", base::UTF16ToUTF8(entry->GetTitle()));
    item.Set("current", i == current);
    item.Set("committed", i == committed);
    entries.Append(std::move(item));
  }
  base::DictValue result;
  result.Set("entries", std::move(entries));
  std::move(reply).Run(std::move(result));
}

void ShowDevTools(content::WebContents* contents,
                  const base::DictValue& args,
                  Reply reply) {
  const std::string panel = Text(args, "panel");
  const int command = panel == "console"   ? IDC_DEV_TOOLS_CONSOLE
                      : panel == "inspect" ? IDC_DEV_TOOLS_INSPECT
                      : panel == "toggle"  ? IDC_DEV_TOOLS_TOGGLE
                                           : 0;
  if (command) {
    ExecuteChromeCommand(contents, command);
  } else {
    DevToolsWindow::OpenDevToolsWindow(contents, DevToolsToggleAction::Show(),
                                       DevToolsOpenedByAction::kUnknown);
  }
  std::move(reply).Run(Ok());
}

void Print(content::WebContents* contents,
           const base::DictValue& args,
           Reply reply) {
  ExecuteChromeCommand(contents, IDC_PRINT);
  std::move(reply).Run(Ok());
}

void RunNamedPageCommand(content::WebContents* contents,
                         const base::DictValue& args,
                         Reply reply) {
  if (const int command = PageCommandNamed(Text(args, "name"))) {
    ExecuteChromeCommand(contents, command);
  }
  std::move(reply).Run(Ok());
}

void GetSecurityInfo(content::WebContents* contents,
                     const base::DictValue& args,
                     Reply reply) {
  std::move(reply).Run(TabEvents::SecurityInfo(contents));
}

void MediaCommand(content::WebContents* contents,
                  const base::DictValue& args,
                  Reply reply) {
  const std::optional<MediaCommandArgs> parsed = ParseMediaCommand(args);
  if (!parsed) {
    std::move(reply).Run(
        Error("mediaCommand requires a known action and finite seconds"));
    return;
  }
  ThawHiddenPage(contents);
  base::DictValue answer = Ok();
  const MediaCommandOutcome outcome = NowPlaying::Command(contents, *parsed);
  switch (outcome.result) {
    case MediaCommandResult::kDone:
      answer.Set("done", true);
      std::move(reply).Run(std::move(answer));
      return;
    case MediaCommandResult::kNotDone:
      answer.Set("done", false);
      std::move(reply).Run(std::move(answer));
      return;
    case MediaCommandResult::kRefused:
      std::move(reply).Run(Error("the page's media session does not take that"));
      return;
    case MediaCommandResult::kSeekRecorded:
      answer.Set("done", true);
      answer.Set("recorded", true);
      std::move(reply).Run(std::move(answer));
      return;
    case MediaCommandResult::kPlayByScript:
      RunMediaCommand(
          contents,
          std::string(kWokenPagePlaysStart) + kWokenPageMediaChoice +
              kWokenPagePlaysEnd +
              (outcome.play_from ? base::NumberToString(*outcome.play_from)
                                 : std::string("null")) +
              ")");
      break;
  }
  answer.Set("done", true);
  answer.Set("byScript", true);
  std::move(reply).Run(std::move(answer));
}

void DownloadImage(content::WebContents* contents,
                   const base::DictValue& args,
                   Reply reply) {
  ThawHiddenPage(contents);
  NowPlaying::DownloadArtwork(contents, args, std::move(reply));
}

void SiteDataCleared(void* context, const char* json) {
  std::unique_ptr<Reply> reply(static_cast<Reply*>(context));
  std::optional<base::DictValue> result = base::JSONReader::ReadDict(
      json && *json ? json : "{}", base::JSON_PARSE_RFC);
  std::move(*reply).Run(result ? std::move(*result) : Error("bad reply"));
}

void ClearSiteData(content::WebContents* contents,
                   const base::DictValue& args,
                   Reply reply) {
  const std::string origin = SiteOrigin(contents->GetVisibleURL());
  if (origin.empty()) {
    base::DictValue result;
    result.Set("cookies", false);
    result.Set("storage", false);
    std::move(reply).Run(std::move(result));
    return;
  }
  ac_engine_call_t call = FindEngineCall("ac_site_data_clear");
  if (!call) {
    std::move(reply).Run(Error("unknown call"));
    return;
  }
  Profile* profile =
      Profile::FromBrowserContext(contents->GetBrowserContext());
  base::DictValue call_args;
  call_args.Set("origin", origin);
  if (profile->IsOffTheRecord()) {
    call_args.Set("offTheRecord", true);
  }
  const std::string directory =
      base::WideToUTF8(profile->GetOriginalProfile()->GetPath().value());
  const std::string json = base::WriteJson(call_args).value_or("{}");
  call(directory.c_str(), json.c_str(), &SiteDataCleared,
       new Reply(std::move(reply)));
}

void CookiesRead(Reply reply,
                 std::optional<base::DictValue> result,
                 std::optional<std::string> error) {
  base::ListValue cookies;
  if (result) {
    if (base::ListValue* found = result->FindList("cookies")) {
      cookies = std::move(*found);
    }
  }
  base::DictValue answer;
  answer.Set("cookies", std::move(cookies));
  std::move(reply).Run(std::move(answer));
}

void PageCookies(content::WebContents* contents,
                 const base::DictValue& args,
                 Reply reply) {
  const base::ListValue* urls = args.FindList("urls");
  if (!urls || urls->empty()) {
    CookiesRead(std::move(reply), std::nullopt, std::nullopt);
    return;
  }
  base::DictValue params;
  params.Set("urls", urls->Clone());
  CallDevTools(contents, "Network.getCookies", std::move(params),
               base::Seconds(1),
               base::BindOnce(&CookiesRead, std::move(reply)));
}

void OpenBlockedPopup(content::WebContents* contents,
                      const base::DictValue& args,
                      Reply reply) {
  auto* popups =
      blocked_content::PopupBlockerTabHelper::FromWebContents(contents);
  int id_number = 0;
  if (popups && base::StringToInt(Text(args, "id"), &id_number) &&
      popups->GetBlockedPopupRequests().contains(id_number)) {
    if (args.FindBool("always").value_or(false)) {
      HostContentSettingsMapFactory::GetForProfile(
          contents->GetBrowserContext())
          ->SetContentSettingDefaultScope(contents->GetLastCommittedURL(),
                                          GURL(), ContentSettingsType::POPUPS,
                                          CONTENT_SETTING_ALLOW);
    }
    popups->ShowBlockedPopup(id_number,
                             WindowOpenDisposition::NEW_FOREGROUND_TAB);
  }
  std::move(reply).Run(Ok());
}

void Discard(content::WebContents* contents,
             const base::DictValue& args,
             Reply reply) {
  const char* outcome = "refused";
  NowPlaying::CancelWake(contents);
  if (args.FindBool("unload").value_or(false)) {
    outcome = "unsupported";
  } else if (contents->WasDiscarded()) {
    outcome = "already";
  } else {
    auto* unit =
        resource_coordinator::TabLifecycleUnitExternal::FromWebContents(
            contents);
    if (unit &&
        unit->DiscardTab(::mojom::LifecycleUnitDiscardReason::EXTERNAL) &&
        contents->WasDiscarded()) {
      outcome = "discarded";
    }
  }
  base::DictValue result;
  result.Set("outcome", outcome);
  std::move(reply).Run(std::move(result));
}

void AnswerKeptBy(Reply reply, base::ListValue kept_by) {
  base::DictValue result;
  result.Set("keptBy", std::move(kept_by));
  std::move(reply).Run(std::move(result));
}

void SleepIfHidden(content::WebContents* contents,
                   const base::DictValue& args,
                   Reply reply) {
  namespace policies = performance_manager::policies;
  using performance_manager::PerformanceManager;
  base::ListValue unavailable;
  unavailable.Append(-1);
  if (!PerformanceManager::IsAvailable()) {
    return AnswerKeptBy(std::move(reply), std::move(unavailable));
  }
  base::WeakPtr<performance_manager::PageNode> page =
      PerformanceManager::GetPrimaryPageNodeForWebContents(contents);
  if (!page) {
    return AnswerKeptBy(std::move(reply), std::move(unavailable));
  }
  performance_manager::Graph* graph = page->GetGraph();
  auto* eligibility = policies::DiscardEligibilityPolicy::GetFromGraph(graph);
  auto* discarding = policies::PageDiscardingHelper::GetFromGraph(graph);
  if (!eligibility || !discarding) {
    return AnswerKeptBy(std::move(reply), std::move(unavailable));
  }
  if (std::vector<int> kept = KeptBy(page.get()); !kept.empty()) {
    base::ListValue codes;
    for (int code : kept) {
      codes.Append(code);
    }
    return AnswerKeptBy(std::move(reply), std::move(codes));
  }
  const auto reason =
      policies::DiscardEligibilityPolicy::DiscardReason::PROACTIVE;
  const double seconds = args.FindDouble("seconds").value_or(0);
  std::vector<policies::CannotDiscardReason> kept_by;
  if (eligibility->CanDiscardWithCustomRecentVisibilityWindow(
          page.get(), reason, base::Seconds(seconds), &kept_by) !=
      policies::CanDiscardResult::kEligible) {
    base::ListValue codes;
    for (policies::CannotDiscardReason kept : kept_by) {
      codes.Append(static_cast<int>(kept));
    }
    return AnswerKeptBy(std::move(reply),
                        codes.empty() ? std::move(unavailable)
                                      : std::move(codes));
  }
  if (!discarding->ImmediatelyDiscardMultiplePages({page.get()}, reason)) {
    return AnswerKeptBy(std::move(reply), std::move(unavailable));
  }
  AnswerKeptBy(std::move(reply), base::ListValue());
}

class TestDevToolsClient
    : public content::DevToolsAgentHostClient,
      public content::WebContentsUserData<TestDevToolsClient> {
 public:
  ~TestDevToolsClient() override { Detach(); }

  bool Attach() {
    if (host_) {
      return true;
    }
    host_ = content::DevToolsAgentHost::GetOrCreateFor(&GetWebContents());
    if (!host_ || !host_->AttachClient(this)) {
      host_ = nullptr;
      return false;
    }
    return true;
  }

  void Detach() {
    if (scoped_refptr<content::DevToolsAgentHost> host = std::move(host_)) {
      host->DetachClient(this);
    }
  }

  void DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                               base::span<const uint8_t> message) override {}
  void AgentHostClosed(content::DevToolsAgentHost* agent_host) override {
    host_ = nullptr;
  }

 private:
  friend class content::WebContentsUserData<TestDevToolsClient>;

  explicit TestDevToolsClient(content::WebContents* contents)
      : content::WebContentsUserData<TestDevToolsClient>(*contents) {}

  scoped_refptr<content::DevToolsAgentHost> host_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(TestDevToolsClient);

void PreferDarkForTest(content::WebContents* contents,
                       const base::DictValue& args,
                       Reply reply) {
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(Error("preferDarkForTest is for test instances"));
    return;
  }
  blink::web_pref::WebPreferences prefs = contents->GetOrCreateWebPreferences();
  prefs.preferred_color_scheme =
      args.FindBool("dark").value_or(true)
          ? blink::mojom::PreferredColorScheme::kDark
          : blink::mojom::PreferredColorScheme::kLight;
  contents->SetWebPreferences(prefs);
  std::move(reply).Run(Ok());
}

void TestClientForTest(content::WebContents* contents,
                       const base::DictValue& args,
                       Reply reply) {
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(Error("testClient is for test instances"));
    return;
  }
  TestDevToolsClient::CreateForWebContents(contents);
  TestDevToolsClient* client = TestDevToolsClient::FromWebContents(contents);
  if (args.FindBool("attach").value_or(false)) {
    std::move(reply).Run(client->Attach() ? Ok()
                                          : Error("can't attach to the tab"));
    return;
  }
  client->Detach();
  std::move(reply).Run(Ok());
}

const char* EligibilityName(
    performance_manager::policies::CanDiscardResult result) {
  switch (result) {
    case performance_manager::policies::CanDiscardResult::kEligible:
      return "eligible";
    case performance_manager::policies::CanDiscardResult::kProtected:
      return "protected";
    case performance_manager::policies::CanDiscardResult::kDisallowed:
      return "disallowed";
  }
  return "unknown";
}

void DiscardEligibilityForTest(content::WebContents* contents,
                               const base::DictValue& args,
                               Reply reply) {
  namespace policies = performance_manager::policies;
  using performance_manager::PerformanceManager;
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(
        Error("discardEligibilityForTest is for test instances"));
    return;
  }
  base::WeakPtr<performance_manager::PageNode> page =
      PerformanceManager::IsAvailable()
          ? PerformanceManager::GetPrimaryPageNodeForWebContents(contents)
          : nullptr;
  auto* eligibility =
      page ? policies::DiscardEligibilityPolicy::GetFromGraph(page->GetGraph())
           : nullptr;
  if (!eligibility) {
    std::move(reply).Run(Error("no discard eligibility for the page"));
    return;
  }
  using DiscardReason = policies::DiscardEligibilityPolicy::DiscardReason;
  const std::string reason_name = Text(args, "reason");
  const DiscardReason reason =
      reason_name == "urgent"   ? DiscardReason::URGENT
      : reason_name == "frozen" ? DiscardReason::FROZEN_WITH_GROWING_MEMORY
                                : DiscardReason::PROACTIVE;
  auto* const host = policies::g_ardia_keeps_page;
  if (args.FindBool("withoutHost").value_or(false)) {
    policies::g_ardia_keeps_page = nullptr;
  }
  std::vector<policies::CannotDiscardReason> reasons;
  const policies::CanDiscardResult result =
      eligibility->CanDiscardWithCustomRecentVisibilityWindow(
          page.get(), reason, base::TimeDelta(), &reasons);
  policies::g_ardia_keeps_page = host;
  base::ListValue chromium;
  for (policies::CannotDiscardReason each : reasons) {
    chromium.Append(static_cast<int>(each));
  }
  base::ListValue kept;
  for (int code : KeptBy(page.get())) {
    kept.Append(code);
  }
  base::DictValue answer;
  answer.Set("result", EligibilityName(result));
  answer.Set("reasons", std::move(chromium));
  answer.Set("keptBy", std::move(kept));
  std::move(reply).Run(std::move(answer));
}

void ClickForTest(content::WebContents* contents,
                  const base::DictValue& args,
                  Reply reply) {
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(Error("clickForTest is for test instances"));
    return;
  }
  const double x = args.FindDouble("x").value_or(0);
  const double y = args.FindDouble("y").value_or(0);
  const int modifiers = Integer(args, "modifiers");
  double* dispatched_at = new double(0);
  const auto answered = base::BarrierCallback<std::optional<std::string>>(
      3, base::BindOnce(
             [](Reply reply, const double* dispatched_at,
                std::vector<std::optional<std::string>> errors) {
               for (const std::optional<std::string>& error : errors) {
                 if (error) {
                   std::move(reply).Run(Error(*error));
                   return;
                 }
               }
               base::DictValue answer = Ok();
               answer.Set("dispatchedAt", *dispatched_at);
               std::move(reply).Run(std::move(answer));
             },
             std::move(reply), base::Owned(dispatched_at)));
  for (const char* type : {"mouseMoved", "mousePressed", "mouseReleased"}) {
    if (std::string_view(type) == "mousePressed") {
      *dispatched_at = base::Time::Now().InMillisecondsFSinceUnixEpoch();
    }
    base::DictValue params;
    params.Set("type", type);
    params.Set("x", x);
    params.Set("y", y);
    params.Set("modifiers", modifiers);
    if (std::string_view(type) != "mouseMoved") {
      params.Set("button", "left");
      params.Set("clickCount", 1);
    }
    CallDevTools(contents, "Input.dispatchMouseEvent", std::move(params),
                 kClickAnswerDeadline,
                 base::BindOnce(
                     [](std::string_view type,
                        base::RepeatingCallback<void(std::optional<std::string>)>
                            done,
                        std::optional<base::DictValue> result,
                        std::optional<std::string> error) {
                       done.Run(
                           error ? std::optional<std::string>(
                                       std::string(type) + ": " + *error)
                                 : std::nullopt);
                     },
                     std::string_view(type), answered));
  }
}

void ReattachLinksForTest(content::WebContents* contents,
                          const base::DictValue& args,
                          Reply reply) {
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(Error("reattachLinksForTest is for test instances"));
    return;
  }
  PageLinks* links = PageLinks::FromWebContents(contents);
  if (!links) {
    std::move(reply).Run(Error("the tab has no link script"));
    return;
  }
  links->ReattachForTest();
  std::move(reply).Run(Ok());
}

void TouchForTest(content::WebContents* contents,
                  const base::DictValue& args,
                  Reply reply) {
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(Error("touchForTest is for test instances"));
    return;
  }
  base::DictValue point;
  point.Set("x", args.FindDouble("x").value_or(0));
  point.Set("y", args.FindDouble("y").value_or(0));
  base::ListValue down;
  down.Append(std::move(point));
  base::DictValue start;
  start.Set("type", "touchStart");
  start.Set("touchPoints", std::move(down));
  CallDevTools(contents, "Input.dispatchTouchEvent", std::move(start),
               std::nullopt, base::BindOnce(&Ignore));
  base::DictValue end;
  end.Set("type", "touchEnd");
  end.Set("touchPoints", base::ListValue());
  CallDevTools(contents, "Input.dispatchTouchEvent", std::move(end),
               std::nullopt, base::BindOnce(&Ignore));
  base::DictValue last;
  last.Set("expression", "0");
  CallDevTools(contents, "Runtime.evaluate", std::move(last), std::nullopt,
               base::BindOnce(
                   [](Reply reply, std::optional<base::DictValue> result,
                      std::optional<std::string> error) {
                     std::move(reply).Run(error ? Error(*error) : Ok());
                   },
                   std::move(reply)));
}

void MediaSessionActionForTest(content::WebContents* contents,
                               const base::DictValue& args,
                               Reply reply) {
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(Error("mediaSessionActionForTest is for test instances"));
    return;
  }
  const std::string action = Text(args, "action");
  if (action != "play" && action != "pause") {
    std::move(reply).Run(Error("the action is play or pause"));
    return;
  }
  content::MediaSession::Get(contents)->DidReceiveAction(
      action == "play" ? media_session::mojom::MediaSessionAction::kPlay
                       : media_session::mojom::MediaSessionAction::kPause);
  std::move(reply).Run(Ok());
}

void InsertTextForTest(content::WebContents* contents,
                       const base::DictValue& args,
                       Reply reply) {
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(Error("insertText is for test instances"));
    return;
  }
  base::DictValue params;
  params.Set("text", Text(args, "text"));
  CallDevTools(contents, "Input.insertText", std::move(params), std::nullopt,
               base::BindOnce(
                   [](Reply reply, std::optional<base::DictValue> result,
                      std::optional<std::string> error) {
                     std::move(reply).Run(error ? Error(*error) : Ok());
                   },
                   std::move(reply)));
}

void SetFrozen(content::WebContents* contents,
               const base::DictValue& args,
               Reply reply) {
  const bool frozen = args.FindBool("frozen").value_or(false);
  TabEvents* events = TabEvents::FromWebContents(contents);
  if (events &&
      !(frozen && contents->GetVisibility() == content::Visibility::VISIBLE)) {
    events->set_frozen(frozen);
    contents->SetPageFrozen(frozen);
  }
  std::move(reply).Run(Ok());
}

void ResolveUnresponsive(content::WebContents* contents,
                         const base::DictValue& args,
                         Reply reply) {
  if (TabEvents* events = TabEvents::FromWebContents(contents)) {
    events->ResolveUnresponsive(args.FindBool("terminate").value_or(false));
  }
  std::move(reply).Run(Ok());
}

void ExternalAppAliveCall(content::WebContents* contents,
                          const base::DictValue& args,
                          Reply reply) {
  base::DictValue answer;
  answer.Set("alive", ExternalAppAlive(contents, Text(args, "id")));
  std::move(reply).Run(std::move(answer));
}

void ExternalAppForgetCall(content::WebContents* contents,
                           const base::DictValue& args,
                           Reply reply) {
  ForgetExternalApp(contents, Text(args, "id"));
  std::move(reply).Run(Ok());
}

using Method = void (*)(content::WebContents* contents,
                        const base::DictValue& args,
                        Reply reply);

struct NamedMethod {
  const char* name;
  Method method;
};

constexpr NamedMethod kMethods[] = {
    {"find", &Find},
    {"stopFinding", &StopFinding},
    {"zoomStep", &ZoomStep},
    {"executeJavaScript", &ExecuteJavaScript},
    {"evaluate", &Evaluate},
    {"navigationEntries", &NavigationEntries},
    {"showDevTools", &ShowDevTools},
    {"print", &Print},
    {"runPageCommand", &RunNamedPageCommand},
    {"getSecurityInfo", &GetSecurityInfo},
    {"mediaCommand", &MediaCommand},
    {"downloadImage", &DownloadImage},
    {"clearSiteData", &ClearSiteData},
    {"pageCookies", &PageCookies},
    {"openBlockedPopup", &OpenBlockedPopup},
    {"discard", &Discard},
    {"sleepIfHidden", &SleepIfHidden},
    {"insertText", &InsertTextForTest},
    {"clickForTest", &ClickForTest},
    {"touchForTest", &TouchForTest},
    {"reattachLinksForTest", &ReattachLinksForTest},
    {"mediaSessionActionForTest", &MediaSessionActionForTest},
    {"audioFocusForTest", &NowPlaying::AudioFocusForTest},
    {"activeSessionForTest", &NowPlaying::ActiveSessionForTest},
    {"testClient", &TestClientForTest},
    {"preferDarkForTest", &PreferDarkForTest},
    {"discardEligibilityForTest", &DiscardEligibilityForTest},
    {"setFrozen", &SetFrozen},
    {"resolveUnresponsive", &ResolveUnresponsive},
    {"externalAppAlive", &ExternalAppAliveCall},
    {"externalAppForget", &ExternalAppForgetCall},
};

}

void UnmarkEngineDevTools(content::WebContents* contents) {
  performance_manager::PageLiveStateDecorator::SetIsDevToolsOpen(contents,
                                                                 false);
}

const content::DevToolsAgentHostClient* EngineDevToolsClient(
    content::WebContents* contents) {
  return DevToolsCaller::FromWebContents(contents);
}

bool CallTabMethod(content::WebContents* contents,
                   const std::string& method,
                   const base::DictValue& args,
                   Reply& reply) {
  for (const NamedMethod& known : kMethods) {
    if (method != known.name) {
      continue;
    }
    if (!contents) {
      std::move(reply).Run(Error("no such tab"));
      return true;
    }
    TabEvents::Attach(contents);
    known.method(contents, args, std::move(reply));
    return true;
  }
  return false;
}

}
