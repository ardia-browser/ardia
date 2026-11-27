#include "ardia/mac/ac_mac_page_commands.h"

#include <algorithm>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_page_events.h"
#include "ardia/mac/ac_mac_page_policy.h"
#include "ardia/mac/ac_mac_shell_host.h"
#include "ardia/mac/generated/ac_desktop_favicon_policy.h"
#include "ardia/mac/generated/ac_desktop_window_commands.h"
#include "ardia/mac/generated/ac_linux_page_operations.h"
#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/metrics/user_metrics.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/devtools/devtools_toggle_action.h"
#include "chrome/browser/devtools/devtools_window.h"
#include "chrome/browser/media/webrtc/media_capture_devices_dispatcher.h"
#include "chrome/browser/media/webrtc/media_stream_capture_indicator.h"
#include "chrome/browser/performance_manager/policies/cannot_discard_reason.h"
#include "chrome/browser/performance_manager/policies/discard_eligibility_policy.h"
#include "chrome/browser/performance_manager/policies/page_discarding_helper.h"
#include "chrome/browser/picture_in_picture/picture_in_picture_window_manager.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/resource_coordinator/tab_lifecycle_unit_external.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tab_contents/core_tab_helper.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "chrome/common/content_restriction.h"
#include "chrome/common/pref_names.h"
#include "components/find_in_page/find_tab_helper.h"
#include "components/find_in_page/find_types.h"
#include "components/zoom/page_zoom.h"
#include "components/performance_manager/public/graph/graph.h"
#include "components/performance_manager/public/graph/page_node.h"
#include "components/performance_manager/public/performance_manager.h"
#include "components/permissions/permission_request_manager.h"
#include "components/policy/core/common/policy_pref_names.h"
#include "components/prefs/pref_service.h"
#include "components/web_modal/web_contents_modal_dialog_manager.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/picture_in_picture_window_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/url_constants.h"
#include "content/public/common/url_utils.h"
#include "crypto/sha2.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "printing/buildflags/buildflags.h"
#include "skia/ext/image_operations.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "third_party/blink/public/mojom/frame/sudden_termination_disabler_type.mojom-shared.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"

#if BUILDFLAG(ENABLE_PRINTING)
#include "chrome/browser/printing/print_view_manager_common.h"
#endif
#if BUILDFLAG(ENABLE_PRINT_PREVIEW)
#include "chrome/browser/printing/print_preview_dialog_controller.h"
#endif

namespace ardia_mac {

namespace {

namespace favicons = ardiacore::desktop_favicons;

base::Value Error(std::string_view code, std::string_view message) {
  return base::Value(base::DictValue().Set("code", code).Set("message", message));
}

constexpr page_policy::Arguments ArgumentsFor(ardiacore::LinuxPageOperationArgs args) {
  switch (args) {
    case ardiacore::LinuxPageOperationArgs::kNone:
      return page_policy::Arguments::kNone;
    case ardiacore::LinuxPageOperationArgs::kReplace:
      return page_policy::Arguments::kReplace;
    case ardiacore::LinuxPageOperationArgs::kLook:
      return page_policy::Arguments::kLook;
    case ardiacore::LinuxPageOperationArgs::kPoint:
      return page_policy::Arguments::kPoint;
    case ardiacore::LinuxPageOperationArgs::kSelectors:
      return page_policy::Arguments::kSelectors;
  }
  return page_policy::Arguments::kNone;
}

const std::vector<page_policy::Operation>& Operations() {
  static const base::NoDestructor<std::vector<page_policy::Operation>> operations([] {
    std::vector<page_policy::Operation> converted;
    for (const ardiacore::LinuxPageOperation& operation :
         ardiacore::kLinuxPageOperations) {
      converted.push_back(page_policy::Operation{
          operation.name, operation.length, operation.sha256,
          ArgumentsFor(operation.args), operation.suffix});
    }
    return converted;
  }());
  return *operations;
}

std::string Sha256(std::string_view text) {
  return base::HexEncodeLower(crypto::SHA256HashString(text));
}

std::optional<std::string> EncodedArguments(page_policy::Arguments kind,
                                            const base::ListValue& list) {
  switch (kind) {
    case page_policy::Arguments::kNone:
      return std::nullopt;
    case page_policy::Arguments::kReplace:
      if (list.size() != 3 || !list[0].is_string() || !list[1].is_string() ||
          !list[2].is_bool()) {
        return std::nullopt;
      }
      return page_policy::ReplaceArguments(list[0].GetString(),
                                           list[1].GetString(), list[2].GetBool());
    case page_policy::Arguments::kLook: {
      const base::DictValue* look = list.size() == 1 ? list[0].GetIfDict() : nullptr;
      const std::optional<bool> dark = look ? look->FindBool("dark") : std::nullopt;
      const std::optional<int> size = look ? look->FindInt("size") : std::nullopt;
      const std::string* font = look ? look->FindString("font") : nullptr;
      if (!look || look->size() != 3 || !dark || !size || !font) {
        return std::nullopt;
      }
      return page_policy::LookArgument(*dark, *size, *font,
                                       ardiacore::kLinuxReaderLookSizes,
                                       ardiacore::kLinuxReaderLookFonts);
    }
    case page_policy::Arguments::kPoint: {
      if (list.size() != 1) {
        return std::nullopt;
      }
      if (list[0].is_none()) {
        return page_policy::PickerPoint(std::nullopt, std::nullopt);
      }
      const base::ListValue* point = list[0].GetIfList();
      const auto number = [](const base::Value& value) {
        return value.is_double() || value.is_int();
      };
      if (!point || point->size() != 2 || !number((*point)[0]) ||
          !number((*point)[1])) {
        return std::nullopt;
      }
      return page_policy::PickerPoint((*point)[0].GetDouble(),
                                      (*point)[1].GetDouble());
    }
    case page_policy::Arguments::kSelectors: {
      const base::ListValue* selectors =
          list.size() == 1 ? list[0].GetIfList() : nullptr;
      if (!selectors) {
        return std::nullopt;
      }
      std::vector<std::string_view> texts;
      for (const base::Value& selector : *selectors) {
        if (!selector.is_string()) {
          return std::nullopt;
        }
        texts.push_back(selector.GetString());
      }
      return page_policy::PickerSelectors(texts);
    }
  }
  return std::nullopt;
}

struct Evaluation {
  std::string script;
  std::optional<uint64_t> token;
};

uint64_t NextEvaluationToken() {
  static uint64_t token = 0;
  return ++token;
}

std::optional<Evaluation> EvaluationScript(std::string_view code) {
  const std::optional<page_policy::OperationMatch> match =
      page_policy::MatchOperation(code, &Sha256, Operations());
  if (!match) {
    return std::nullopt;
  }
  if (match->operation->args == page_policy::Arguments::kNone) {
    return Evaluation{page_policy::WrapEvaluation(code), std::nullopt};
  }
  std::optional<base::Value> parsed = base::JSONReader::Read(
      "[" + std::string(match->arguments) + "]", base::JSON_PARSE_RFC, 4);
  const std::optional<std::string> arguments =
      parsed && parsed->is_list()
          ? EncodedArguments(match->operation->args, parsed->GetList())
          : std::nullopt;
  if (!arguments) {
    return std::nullopt;
  }
  const std::string body = std::string(code.substr(0, match->operation->length)) +
                           *arguments + std::string(match->operation->suffix);
  if (!page_policy::AwaitsResult(*match->operation)) {
    return Evaluation{page_policy::WrapEvaluation(body), std::nullopt};
  }
  const uint64_t token = NextEvaluationToken();
  return Evaluation{page_policy::WrapAwaitedEvaluation(body, token), token};
}

base::Value ImageReply(const SkBitmap& source, int pixels) {
  if (source.drawsNothing()) {
    return base::Value();
  }
  const auto [width, height] = favicons::Fit(source.width(), source.height(), pixels);
  if (width <= 0 || height <= 0) {
    return base::Value();
  }
  const SkBitmap scaled =
      width == source.width() && height == source.height()
          ? source
          : skia::ImageOperations::Resize(
                source, skia::ImageOperations::RESIZE_BEST, width, height);
  const std::optional<std::vector<uint8_t>> png =
      scaled.drawsNothing() ? std::nullopt
                            : gfx::PNGCodec::EncodeBGRASkBitmap(scaled, false);
  if (!png || png->empty()) {
    return base::Value();
  }
  return base::Value(base::DictValue()
                         .Set("uri", "data:image/png;base64," + base::Base64Encode(*png))
                         .Set("width", scaled.width())
                         .Set("height", scaled.height()));
}

std::optional<bool> UnsavedInputOf(content::WebContents* contents) {
  bool before_unload = false;
  contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&before_unload](content::RenderFrameHost* frame) {
        before_unload |= frame->GetSuddenTerminationDisablerState(
            blink::mojom::SuddenTerminationDisablerType::kBeforeUnloadHandler);
      });
  if (!performance_manager::PerformanceManager::IsAvailable()) {
    return page_policy::UnsavedInput(before_unload, std::nullopt, std::nullopt);
  }
  const base::WeakPtr<performance_manager::PageNode> page =
      performance_manager::PerformanceManager::GetPrimaryPageNodeForWebContents(contents);
  if (!page) {
    return page_policy::UnsavedInput(before_unload, std::nullopt, std::nullopt);
  }
  return page_policy::UnsavedInput(before_unload, page->HadFormInteraction(),
                                   page->HadUserEdits());
}

base::ListValue SleepUnavailable() {
  return base::ListValue().Append(page_policy::kSleepUnavailable);
}

base::ListValue SleepIfHidden(content::WebContents* contents, double seconds) {
  namespace policies = performance_manager::policies;
  using performance_manager::PerformanceManager;
  if (!contents) {
    return SleepUnavailable();
  }
  if (contents->WasDiscarded()) {
    return base::ListValue();
  }
  if (!PerformanceManager::IsAvailable()) {
    return SleepUnavailable();
  }
  base::WeakPtr<performance_manager::PageNode> page =
      PerformanceManager::GetPrimaryPageNodeForWebContents(contents);
  if (!page) {
    return SleepUnavailable();
  }
  performance_manager::Graph* graph = page->GetGraph();
  auto* eligibility = policies::DiscardEligibilityPolicy::GetFromGraph(graph);
  auto* discarding = policies::PageDiscardingHelper::GetFromGraph(graph);
  if (!eligibility || !discarding) {
    return SleepUnavailable();
  }
  const auto reason = policies::DiscardEligibilityPolicy::DiscardReason::PROACTIVE;
  std::vector<policies::CannotDiscardReason> kept_by;
  if (eligibility->CanDiscardWithCustomRecentVisibilityWindow(
          page.get(), reason, base::Seconds(seconds), &kept_by) !=
      policies::CanDiscardResult::kEligible) {
    if (kept_by.empty()) {
      return SleepUnavailable();
    }
    base::ListValue codes;
    for (policies::CannotDiscardReason kept : kept_by) {
      codes.Append(static_cast<int>(kept));
    }
    return codes;
  }
  if (!discarding->ImmediatelyDiscardMultiplePages({page.get()}, reason)) {
    return SleepUnavailable();
  }
  return base::ListValue();
}

std::optional<std::string> ZoomHost(std::string_view host) {
  if (!page_policy::ZoomHostShape(host)) {
    return std::nullopt;
  }
  const GURL url("https://" + std::string(host) + "/");
  if (!url.is_valid() || url.host().empty() || url.has_port() ||
      url.host().size() > 253) {
    return std::nullopt;
  }
  return std::string(url.host());
}

}

PageCommands::PageCommands(PageBinding* binding) : binding_(binding) {}

PageCommands::~PageCommands() {
  Reset();
}

bool PageCommands::Handles(std::string_view command) {
  return page_policy::Handles(command);
}

void PageCommands::Reset() {
  weak_factory_.InvalidateWeakPtrs();
  CancelEvaluations();
  if (observed_) {
    find_in_page::FindTabHelper* helper = observed_;
    observed_ = nullptr;
    helper->RemoveObserver(this);
    helper->StopFinding(find_in_page::SelectionAction::kClear);
  }
}

content::WebContents* PageCommands::Live() const {
  content::WebContents* contents = binding_ ? binding_->contents() : nullptr;
  ShellHostView* host = binding_ ? binding_->host() : nullptr;
  return contents && host && host->OwnerOf(contents) ? contents : nullptr;
}

void PageCommands::Run(const std::string& command,
                       const base::ListValue& args,
                       Done done) {
  content::WebContents* contents = Live();
  if (!contents) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_STALE_TARGET", "Page claim is no longer current"));
  }
  if (command == "find") {
    return Find(args, std::move(done));
  }
  if (command == "stopFinding") {
    return StopFinding(args, std::move(done));
  }
  if (command == "print") {
    if (!args.empty()) {
      return std::move(done).Run(
          false, Error("ERR_PAGE_ARGUMENT", "print takes no arguments"));
    }
    base::Value failure = Print(false);
    return std::move(done).Run(failure.is_none(), std::move(failure));
  }
  if (command == "runPageCommand") {
    return PageAction(args, std::move(done));
  }
  if (command == "showDevTools") {
    return DevTools(args, std::move(done));
  }
  if (command == "zoomStep") {
    const std::optional<int> step =
        args.size() == 1 && (args[0].is_int() || args[0].is_double())
            ? page_policy::ZoomStep(args[0].GetDouble())
            : std::nullopt;
    if (!step) {
      return std::move(done).Run(
          false, base::Value("zoomStep requires -1, 0 or 1 on a live page"));
    }
    zoom::PageZoom::Zoom(contents, static_cast<content::PageZoom>(*step));
    return std::move(done).Run(true, base::Value());
  }
  if (command == "goToOffset") {
    const std::optional<int> offset =
        args.size() == 1 && (args[0].is_int() || args[0].is_double())
            ? page_policy::WholeNumber(args[0].GetDouble())
            : std::nullopt;
    if (!offset) {
      return std::move(done).Run(
          false,
          base::Value("goToOffset requires one integer offset on a live page"));
    }
    content::NavigationController& controller = contents->GetController();
    if (page_policy::HistoryTarget(controller.GetCurrentEntryIndex(),
                                   controller.GetEntryCount(), *offset) &&
        controller.CanGoToOffset(*offset)) {
      controller.GoToOffset(*offset);
    }
    return std::move(done).Run(true, base::Value());
  }
  if (command == "evaluate") {
    return Evaluate(args, std::move(done));
  }
  if (command == ardia::desktop_commands::kEditCommand) {
    return Edit(args, std::move(done));
  }
  if (command == "getSecurityInfo") {
    if (!args.empty()) {
      return std::move(done).Run(false,
                                 base::Value("getSecurityInfo takes no arguments"));
    }
    return std::move(done).Run(true, base::Value(SecuritySnapshot(contents)));
  }
  if (command == "discard") {
    return Discard(args, std::move(done));
  }
  if (command == "sleepIfHidden") {
    const std::optional<double> seconds =
        args.size() == 1 && (args[0].is_int() || args[0].is_double())
            ? page_policy::SleepSeconds(args[0].GetDouble())
            : std::nullopt;
    if (!seconds) {
      return std::move(done).Run(
          false, base::Value("sleepIfHidden requires a hidden time in seconds"));
    }
    return std::move(done).Run(true, base::Value(SleepIfHidden(contents, *seconds)));
  }
  if (command == "setFrozen") {
    return SetFrozen(args, std::move(done));
  }
  if (command == "downloadFavicon") {
    return DownloadFavicon(args, std::move(done));
  }
  if (command == "downloadImage") {
    return DownloadImage(args, std::move(done));
  }
  if (command == "openBlockedPopup") {
    return OpenBlockedPopup(args, std::move(done));
  }
  if (command == "resolveUnresponsive") {
    return ResolveUnresponsive(args, std::move(done));
  }
  std::move(done).Run(false, base::Value("Unsupported tab command: " + command));
}

void PageCommands::Find(const base::ListValue& args, Done done) {
  if (args.size() != 3 || !args[0].is_string() || !args[1].is_bool() ||
      !args[2].is_bool() || !page_policy::FindTextFits(args[0].GetString().size())) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_ARGUMENT", "find requires text, forward and findNext"));
  }
  find_in_page::FindTabHelper* helper =
      find_in_page::FindTabHelper::FromWebContents(Live());
  if (!helper) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_UNAVAILABLE", "Find helper is unavailable"));
  }
  const std::u16string text = base::UTF8ToUTF16(args[0].GetString());
  if (text.empty()) {
    if (observed_) {
      std::exchange(observed_, nullptr)->RemoveObserver(this);
    }
    helper->StopFinding(find_in_page::SelectionAction::kClear);
    SendFind(0, 0, true);
    return std::move(done).Run(true, base::Value());
  }
  if (!observed_) {
    helper->StopFinding(find_in_page::SelectionAction::kClear);
    observed_ = helper;
    helper->AddObserver(this);
  }
  helper->StartFinding(text, args[1].GetBool(), false, true);
  std::move(done).Run(true, base::Value());
}

void PageCommands::StopFinding(const base::ListValue& args, Done done) {
  if (args.size() != 1 || !args[0].is_bool()) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_ARGUMENT", "stopFinding requires clearSelection"));
  }
  find_in_page::FindTabHelper* helper =
      find_in_page::FindTabHelper::FromWebContents(Live());
  if (!helper) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_UNAVAILABLE", "Find helper is unavailable"));
  }
  if (observed_) {
    std::exchange(observed_, nullptr)->RemoveObserver(this);
  }
  helper->StopFinding(args[0].GetBool() ? find_in_page::SelectionAction::kClear
                                        : find_in_page::SelectionAction::kKeep);
  std::move(done).Run(true, base::Value());
}

void PageCommands::SendFind(int count, int active, bool final) {
  if (binding_) {
    binding_->Report("find", base::Value(base::DictValue()
                                             .Set("count", std::max(0, count))
                                             .Set("active", std::max(0, active))
                                             .Set("final", final)));
  }
}

void PageCommands::OnFindResultAvailable(content::WebContents* contents) {
  if (!observed_ || !binding_ || contents != binding_->contents()) {
    return;
  }
  const find_in_page::FindNotificationDetails& result = observed_->find_result();
  SendFind(result.number_of_matches(), result.active_match_ordinal(),
           result.final_update());
}

void PageCommands::OnFindEmptyText(content::WebContents* contents) {
  if (observed_ && binding_ && contents == binding_->contents()) {
    SendFind(0, 0, true);
  }
}

void PageCommands::OnFindTabHelperDestroyed(find_in_page::FindTabHelper* helper) {
  if (observed_ == helper) {
    observed_ = nullptr;
    helper->RemoveObserver(this);
  }
}

void PageCommands::PageAction(const base::ListValue& args, Done done) {
  if (args.size() != 1 || !args[0].is_string()) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_ARGUMENT", "runPageCommand requires a command"));
  }
  base::Value failure;
  switch (page_policy::PageActionFor(args[0].GetString())) {
    case page_policy::PageAction::kSavePage:
      failure = Save();
      break;
    case page_policy::PageAction::kSystemPrint:
      failure = Print(true);
      break;
    case page_policy::PageAction::kViewSource:
      failure = ViewSource();
      break;
    case page_policy::PageAction::kUnsupported:
      failure = Error("ERR_PAGE_UNSUPPORTED", "Unsupported page command");
      break;
  }
  std::move(done).Run(failure.is_none(), std::move(failure));
}

base::Value PageCommands::Print(bool system) {
#if BUILDFLAG(ENABLE_PRINTING)
  content::WebContents* contents = Live();
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  PrefService* prefs = profile ? profile->GetPrefs() : nullptr;
  CoreTabHelper* core = CoreTabHelper::FromWebContents(contents);
  if (!prefs || !core) {
    return Error("ERR_PAGE_UNAVAILABLE", "Print helpers are unavailable");
  }
  if (!prefs->GetBoolean(prefs::kPrintingEnabled)) {
    return Error("ERR_PAGE_POLICY", "Printing is disabled");
  }
  bool preview = false;
#if BUILDFLAG(ENABLE_PRINT_PREVIEW)
  printing::PrintPreviewDialogController* previews =
      printing::PrintPreviewDialogController::GetInstance();
  preview = previews && previews->GetPrintPreviewForContents(contents);
#endif
  web_modal::WebContentsModalDialogManager* dialogs =
      web_modal::WebContentsModalDialogManager::FromWebContents(contents);
  if ((contents->IsCrashed() || (dialogs && dialogs->IsDialogActive()) ||
       (core->content_restrictions() & CONTENT_RESTRICTION_PRINT)) &&
      !(system && preview)) {
    return Error("ERR_PAGE_POLICY", "Printing is not allowed for this page");
  }
  if (BackgroundInstance()) {
    Trace("print dialog (background run, not shown)");
    return Error("ERR_PAGE_UNAVAILABLE", "Native print UI is disabled");
  }
  if (system) {
    printing::StartBasicPrint(contents);
  } else if (!printing::StartPrint(contents,
                                   prefs->GetBoolean(prefs::kPrintPreviewDisabled),
                                   false)) {
    return Error("ERR_PAGE_DISPATCH", "Print dispatch was refused");
  }
  return base::Value();
#else
  return Error("ERR_PAGE_UNAVAILABLE", "Printing is not built");
#endif
}

base::Value PageCommands::Save() {
  content::WebContents* contents = Live();
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  PrefService* prefs = profile ? profile->GetPrefs() : nullptr;
  CoreTabHelper* core = CoreTabHelper::FromWebContents(contents);
  PrefService* local_state =
      g_browser_process ? g_browser_process->local_state() : nullptr;
  content::NavigationEntry* entry =
      contents->GetController().GetLastCommittedEntry();
  if (!prefs || !core || !local_state || !entry || contents->IsCrashed()) {
    return Error("ERR_PAGE_UNAVAILABLE",
                 "Save helpers or committed page are unavailable");
  }
  if (!local_state->GetBoolean(prefs::kAllowFileSelectionDialogs) ||
      static_cast<policy::DownloadRestriction>(
          prefs->GetInteger(policy::policy_prefs::kDownloadRestrictions)) ==
          policy::DownloadRestriction::ALL_FILES ||
      (core->content_restrictions() & CONTENT_RESTRICTION_SAVE) ||
      !content::IsSavableURL(entry->GetURL())) {
    return Error("ERR_PAGE_POLICY", "Saving is not allowed for this page");
  }
  if (BackgroundInstance()) {
    Trace("save page dialog (background run, not shown)");
    return Error("ERR_PAGE_UNAVAILABLE", "Native save UI is disabled");
  }
  base::RecordAction(base::UserMetricsAction("SavePage"));
  contents->OnSavePage();
  return base::Value();
}

base::Value PageCommands::ViewSource() {
  content::WebContents* contents = Live();
  ShellHostView* host = binding_->host();
  BrowserWindowInterface* owner = host ? host->OwnerOf(contents) : nullptr;
  content::NavigationEntry* entry =
      contents->GetController().GetLastCommittedEntry();
  if (!owner || !entry || !contents->GetController().CanViewSource()) {
    return Error("ERR_PAGE_UNAVAILABLE", "This page has no source to show");
  }
  const GURL url(std::string(content::kViewSourceScheme) + ":" +
                 entry->GetURL().spec());
  if (!url.is_valid()) {
    return Error("ERR_PAGE_UNAVAILABLE", "This page has no source to show");
  }
  NavigateParams params(owner, url, ui::PAGE_TRANSITION_LINK);
  params.disposition = WindowOpenDisposition::kNewForegroundTab;
  params.window_action = NavigateParams::WindowAction::kNoAction;
  params.source_contents = contents;
  Navigate(&params);
  if (!params.navigated_or_inserted_contents) {
    return Error("ERR_PAGE_DISPATCH", "The source tab did not open");
  }
  return base::Value();
}

void PageCommands::DevTools(const base::ListValue& args, Done done) {
  if (args.size() > 1 || (!args.empty() && !args[0].is_string())) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_ARGUMENT", "showDevTools takes an optional panel"));
  }
  const std::optional<page_policy::DevToolsPanel> panel = page_policy::DevToolsPanelFor(
      args.empty() ? std::nullopt
                   : std::optional<std::string_view>(args[0].GetString()));
  if (!panel) {
    return std::move(done).Run(false,
                               Error("ERR_PAGE_ARGUMENT", "Unknown DevTools panel"));
  }
  content::WebContents* contents = Live();
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  if (!DevToolsWindow::AllowDevToolsFor(profile, contents)) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_POLICY", "DevTools is disabled for this page"));
  }
  if (BackgroundInstance()) {
    Trace("DevTools window (background run, not shown)");
    return std::move(done).Run(
        false, Error("ERR_PAGE_UNAVAILABLE", "DevTools presentation is unavailable"));
  }
  switch (*panel) {
    case page_policy::DevToolsPanel::kShow:
      DevToolsWindow::OpenDevToolsWindow(contents, DevToolsToggleAction::Show(),
                                         DevToolsOpenedByAction::kMainMenuOrMainShortcut);
      break;
    case page_policy::DevToolsPanel::kInspect:
      DevToolsWindow::OpenDevToolsWindow(contents, DevToolsToggleAction::Inspect(),
                                         DevToolsOpenedByAction::kMainMenuOrMainShortcut);
      break;
    case page_policy::DevToolsPanel::kConsole:
      DevToolsWindow::OpenDevToolsWindow(contents,
                                         DevToolsToggleAction::ShowConsolePanel(),
                                         DevToolsOpenedByAction::kMainMenuOrMainShortcut);
      break;
    case page_policy::DevToolsPanel::kToggle: {
      DevToolsWindow* tools = DevToolsWindow::GetInstanceForInspectedWebContents(contents);
      content::WebContents* docked =
          tools && tools->IsDocked() ? DevToolsWindow::GetInTabWebContents(contents, nullptr)
                                     : nullptr;
      if (docked) {
        docked->DispatchBeforeUnload(false);
      } else {
        DevToolsWindow::OpenDevToolsWindow(contents, DevToolsToggleAction::Toggle(),
                                           DevToolsOpenedByAction::kMainMenuOrMainShortcut);
      }
      break;
    }
  }
  std::move(done).Run(true, base::Value());
}

void PageCommands::Evaluate(const base::ListValue& args, Done done) {
  if (args.size() != 1 || !args[0].is_string()) {
    return std::move(done).Run(false, base::Value("evaluate requires one script"));
  }
  std::optional<Evaluation> evaluation = EvaluationScript(args[0].GetString());
  if (!evaluation) {
    return std::move(done).Run(
        false, Error("ERR_PAGE_EVALUATION_REFUSED",
                     "Ardia runs only its own page operations"));
  }
  content::WebContents* contents = Live();
  content::RenderFrameHost* frame = contents->GetPrimaryMainFrame();
  if (!frame || !frame->IsRenderFrameLive() || !frame->IsActive() ||
      !page_policy::ScriptableScheme(frame->GetLastCommittedURL().scheme())) {
    return std::move(done).Run(true, base::Value());
  }
  const uint64_t id = evaluation->token.value_or(NextEvaluationToken());
  auto pending = std::make_unique<PendingEvaluation>();
  pending->awaited = evaluation->token.has_value();
  pending->contents = contents->GetWeakPtr();
  pending->document = frame->GetWeakDocumentPtr();
  pending->done = std::move(done);
  pending->deadline.Start(
      FROM_HERE, base::Milliseconds(page_policy::kEvaluationDeadlineMilliseconds),
      base::BindOnce(&PageCommands::SettleEvaluation, base::Unretained(this), id,
                     base::Value()));
  evaluations_[id] = std::move(pending);
  SendEvaluation(id, std::move(evaluation->script));
}

content::RenderFrameHost* PageCommands::EvaluationDocument(
    const PendingEvaluation& pending) const {
  content::RenderFrameHost* frame = pending.document.AsRenderFrameHostIfValid();
  return pending.contents && frame && frame == pending.contents->GetPrimaryMainFrame() &&
                 frame->IsRenderFrameLive()
             ? frame
             : nullptr;
}

content::RenderFrameHost* PageCommands::EvaluationFrame(
    const PendingEvaluation& pending) const {
  content::RenderFrameHost* frame = EvaluationDocument(pending);
  return frame && frame->IsActive() && Live() && Live() == pending.contents.get()
             ? frame
             : nullptr;
}

void PageCommands::SendEvaluation(uint64_t id, std::string script) {
  const auto found = evaluations_.find(id);
  if (found == evaluations_.end()) {
    return;
  }
  content::RenderFrameHost* frame = EvaluationFrame(*found->second);
  if (!frame) {
    return SettleEvaluation(id, base::Value());
  }
  frame->ExecuteJavaScriptInIsolatedWorld(
      base::UTF8ToUTF16(script),
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(&PageCommands::EvaluationAnswered, weak_factory_.GetWeakPtr(),
                         id),
          base::Value()),
      ISOLATED_WORLD_ID_CHROME_INTERNAL);
}

void PageCommands::EvaluationAnswered(uint64_t id, base::Value value) {
  const auto found = evaluations_.find(id);
  if (found == evaluations_.end()) {
    return;
  }
  PendingEvaluation& pending = *found->second;
  const bool has_result = value.is_string();
  switch (page_policy::NextEvaluationStep(
      false, EvaluationFrame(pending) != nullptr, has_result,
      has_result && page_policy::EvaluationResultFits(value.GetString().size()),
      pending.awaited)) {
    case page_policy::EvaluationStep::kReply:
      return SettleEvaluation(id, std::move(value));
    case page_policy::EvaluationStep::kReplyNull:
      return SettleEvaluation(id, base::Value());
    case page_policy::EvaluationStep::kPoll:
      pending.poll.Start(
          FROM_HERE, base::Milliseconds(page_policy::kEvaluationPollMilliseconds),
          base::BindOnce(&PageCommands::PollEvaluation, base::Unretained(this), id));
      return;
  }
}

void PageCommands::PollEvaluation(uint64_t id) {
  SendEvaluation(id, page_policy::TakeEvaluation(id));
}

void PageCommands::SettleEvaluation(uint64_t id, base::Value value) {
  const auto found = evaluations_.find(id);
  if (found == evaluations_.end()) {
    return;
  }
  std::unique_ptr<PendingEvaluation> pending = std::move(found->second);
  evaluations_.erase(found);
  if (pending->awaited && value.is_none()) {
    if (content::RenderFrameHost* frame = EvaluationDocument(*pending)) {
      frame->ExecuteJavaScriptInIsolatedWorld(
          base::UTF8ToUTF16(page_policy::ForgetEvaluation(id)),
          content::RenderFrameHost::JavaScriptResultCallback(),
          ISOLATED_WORLD_ID_CHROME_INTERNAL);
    }
  }
  std::move(pending->done).Run(true, std::move(value));
}

void PageCommands::CancelEvaluations() {
  std::map<uint64_t, std::unique_ptr<PendingEvaluation>> cancelled =
      std::move(evaluations_);
  evaluations_.clear();
  for (auto& [id, pending] : cancelled) {
    pending->deadline.Stop();
    pending->poll.Stop();
    if (pending->awaited) {
      if (content::RenderFrameHost* frame = EvaluationDocument(*pending)) {
        frame->ExecuteJavaScriptInIsolatedWorld(
            base::UTF8ToUTF16(page_policy::ForgetEvaluation(id)),
            content::RenderFrameHost::JavaScriptResultCallback(),
            ISOLATED_WORLD_ID_CHROME_INTERNAL);
      }
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(pending->done), true, base::Value()));
  }
}

void PageCommands::Edit(const base::ListValue& args, Done done) {
  using ardia::desktop_commands::EditAction;
  const std::optional<EditAction> action =
      args.size() == 1 && args[0].is_string()
          ? ardia::desktop_commands::ParseEditAction(args[0].GetString())
          : std::nullopt;
  if (!action) {
    return std::move(done).Run(
        false, base::Value("edit requires one known editing action"));
  }
  content::WebContents* contents = Live();
  switch (*action) {
    case EditAction::kUndo:
      contents->Undo();
      break;
    case EditAction::kRedo:
      contents->Redo();
      break;
    case EditAction::kCut:
      contents->Cut();
      break;
    case EditAction::kCopy:
      contents->Copy();
      break;
    case EditAction::kPaste:
      contents->Paste();
      break;
    case EditAction::kPasteAndMatchStyle:
      contents->PasteAndMatchStyle();
      break;
    case EditAction::kSelectAll:
      contents->SelectAll();
      break;
  }
  std::move(done).Run(true, base::Value());
}

page_policy::Protection PageCommands::CurrentProtection() const {
  content::WebContents* contents = binding_->contents();
  page_policy::Protection protection;
  if (!contents) {
    return protection;
  }
  protection.visible = binding_->presented || binding_->visible ||
                       contents->GetVisibility() == content::Visibility::VISIBLE;
  protection.audible = contents->IsCurrentlyAudible();
  protection.playing = binding_->events() && binding_->events()->playing();
  scoped_refptr<MediaStreamCaptureIndicator> indicator =
      MediaCaptureDevicesDispatcher::GetInstance()->GetMediaStreamCaptureIndicator();
  protection.capturing =
      contents->IsBeingCaptured() ||
      (indicator && (indicator->IsCapturingUserMedia(contents) ||
                     indicator->IsBeingMirrored(contents) ||
                     indicator->IsCapturingTab(contents) ||
                     indicator->IsCapturingWindow(contents) ||
                     indicator->IsCapturingDisplay(contents)));
  protection.picture_in_picture =
      contents->HasPictureInPictureVideo() || contents->HasPictureInPictureDocument() ||
      PictureInPictureWindowManager::GetInstance()->GetWebContents() == contents;
  web_modal::WebContentsModalDialogManager* dialogs =
      web_modal::WebContentsModalDialogManager::FromWebContents(contents);
  permissions::PermissionRequestManager* requests =
      permissions::PermissionRequestManager::FromWebContents(contents);
  if (dialogs && requests) {
    protection.pending_prompt = dialogs->IsDialogActive() ||
                                requests->IsRequestInProgress() ||
                                requests->has_pending_requests();
  }
  protection.dirty_input = UnsavedInputOf(contents);
  return protection;
}

void PageCommands::Discard(const base::ListValue& args, Done done) {
  bool unload = false;
  if (args.size() > 1) {
    return std::move(done).Run(
        false, base::Value("discard takes an optional {unload} object"));
  }
  if (args.size() == 1 && !args[0].is_none()) {
    const base::DictValue* options = args[0].GetIfDict();
    if (!options) {
      return std::move(done).Run(
          false, base::Value("discard takes an optional {unload} object"));
    }
    for (const auto [key, value] : *options) {
      if (key != "unload" || !(value.is_bool() || value.is_none())) {
        return std::move(done).Run(
            false, base::Value("discard takes an optional {unload} object"));
      }
      unload = value.is_bool() && value.GetBool();
    }
  }
  content::WebContents* contents = Live();
  const page_policy::DiscardDecision decision = page_policy::DecideDiscard(
      true, contents->WasDiscarded(), unload, CurrentProtection());
  bool discarded = false;
  if (decision == page_policy::DiscardDecision::kDiscard) {
    base::WeakPtr<PageCommands> alive = alive_factory_.GetWeakPtr();
    resource_coordinator::TabLifecycleUnitExternal* unit =
        resource_coordinator::TabLifecycleUnitExternal::FromWebContents(contents);
    const bool accepted =
        unit && unit->DiscardTab(::mojom::LifecycleUnitDiscardReason::EXTERNAL);
    content::WebContents* bound =
        alive && alive->binding_ ? alive->binding_->contents() : nullptr;
    discarded = page_policy::DiscardSucceeded(accepted, bound != nullptr,
                                              bound && bound->WasDiscarded());
  }
  std::move(done).Run(true, base::Value(page_policy::DiscardOutcome(decision, discarded)));
}

void PageCommands::SetFrozen(const base::ListValue& args, Done done) {
  if (args.size() != 1 || !args[0].is_bool()) {
    return std::move(done).Run(false, base::Value("setFrozen requires a boolean"));
  }
  const bool value = args[0].GetBool();
  content::WebContents* contents = Live();
  if (value && !page_policy::MayFreeze(CurrentProtection())) {
    return std::move(done).Run(true, base::Value(false));
  }
  frozen_ = value;
  if (value || contents->GetVisibility() != content::Visibility::VISIBLE) {
    contents->SetPageFrozen(value);
  }
  std::move(done).Run(true, base::Value(true));
}

void PageCommands::DownloadFavicon(const base::ListValue& args, Done done) {
  if (args.empty() || !args[0].is_string()) {
    return std::move(done).Run(false,
                               base::Value("downloadFavicon requires an icon URL"));
  }
  const GURL url(args[0].GetString());
  content::WebContents* contents = Live();
  if (!url.is_valid() || !favicons::Allowed(url.spec(), favicons::Source::kPage)) {
    return std::move(done).Run(true, base::Value());
  }
  content::RenderFrameHost* frame = contents->GetPrimaryMainFrame();
  contents->DownloadImage(
      url, true, gfx::Size(favicons::kPixels, favicons::kPixels),
      static_cast<uint32_t>(favicons::kPixels), false,
      base::BindOnce(
          [](base::WeakPtr<content::WebContents> contents,
             content::WeakDocumentPtr document, Done done, int, int, const GURL&,
             const std::vector<SkBitmap>& bitmaps, const std::vector<gfx::Size>&) {
            content::RenderFrameHost* frame = document.AsRenderFrameHostIfValid();
            if (!contents || !frame || frame != contents->GetPrimaryMainFrame()) {
              return std::move(done).Run(true, base::Value());
            }
            std::vector<std::pair<int, int>> sizes;
            for (const SkBitmap& bitmap : bitmaps) {
              sizes.emplace_back(bitmap.width(), bitmap.height());
            }
            const int best = favicons::Pick(sizes);
            std::move(done).Run(
                true, best < 0 ? base::Value()
                               : ImageReply(bitmaps[static_cast<size_t>(best)],
                                            favicons::kPixels));
          },
          contents->GetWeakPtr(),
          frame ? frame->GetWeakDocumentPtr() : content::WeakDocumentPtr(),
          mojo::WrapCallbackWithDefaultInvokeIfNotRun(std::move(done), true,
                                                      base::Value())));
}

void PageCommands::DownloadImage(const base::ListValue& args, Done done) {
  const GURL url(args.size() == 2 && args[0].is_string() ? args[0].GetString()
                                                         : std::string());
  const std::optional<int> pixels =
      args.size() == 2 && args[1].is_int() ? page_policy::ImagePixels(args[1].GetInt())
                                           : std::nullopt;
  if (!pixels || !url.is_valid() || !page_policy::ImageScheme(url.scheme())) {
    return std::move(done).Run(
        false, base::Value(
                   "downloadImage requires an http(s) or data URL and a pixel limit"));
  }
  Live()->DownloadImage(
      url, false, gfx::Size(*pixels, *pixels), static_cast<uint32_t>(*pixels), false,
      base::BindOnce(
          [](Done done, int, int, const GURL&, const std::vector<SkBitmap>& bitmaps,
             const std::vector<gfx::Size>&) {
            for (const SkBitmap& bitmap : bitmaps) {
              if (bitmap.drawsNothing()) {
                continue;
              }
              const std::optional<std::vector<uint8_t>> png =
                  gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, false);
              if (!png) {
                continue;
              }
              return std::move(done).Run(
                  true,
                  base::Value(base::DictValue()
                                  .Set("uri", "data:image/png;base64," +
                                                  base::Base64Encode(*png))
                                  .Set("width", bitmap.width())
                                  .Set("height", bitmap.height())));
            }
            std::move(done).Run(true, base::Value());
          },
          mojo::WrapCallbackWithDefaultInvokeIfNotRun(std::move(done), true,
                                                      base::Value())));
}

void PageCommands::OpenBlockedPopup(const base::ListValue& args, Done done) {
  const std::optional<int32_t> id =
      !args.empty() && args.size() <= 2 && args[0].is_string() &&
              (args.size() == 1 || args[1].is_bool())
          ? page_policy::PopupId(args[0].GetString())
          : std::nullopt;
  PageEvents* events = binding_->events();
  if (!id || !events) {
    return std::move(done).Run(false,
                               base::Value("No live page document"));
  }
  const bool always = args.size() == 2 && args[1].GetBool();
  if (!events->OpenBlockedPopup(*id, always)) {
    return std::move(done).Run(
        false, base::Value("The blocked pop-up is no longer available"));
  }
  std::move(done).Run(true, base::Value());
}

void PageCommands::ResolveUnresponsive(const base::ListValue& args, Done done) {
  PageEvents* events = binding_->events();
  if (args.size() != 1 || !args[0].is_bool() || !events ||
      !events->ResolveUnresponsive(args[0].GetBool())) {
    return std::move(done).Run(
        false,
        base::Value("resolveUnresponsive requires one boolean on a live page"));
  }
  std::move(done).Run(true, base::Value());
}

void SiteZoomCall(const std::string& name,
                  Profile* profile,
                  const base::Value* args,
                  base::OnceCallback<void(bool, base::Value)> done) {
  if (!profile || profile->IsOffTheRecord()) {
    return std::move(done).Run(
        false, Error("ERR_PROFILE", "Site zoom needs a loaded, saved profile"));
  }
  std::optional<base::Value> parsed =
      args && args->is_string()
          ? base::JSONReader::Read(args->GetString(), base::JSON_PARSE_RFC, 4)
          : std::nullopt;
  const base::DictValue* input = parsed ? parsed->GetIfDict() : nullptr;
  content::HostZoomMap* zoom = content::HostZoomMap::GetDefaultForBrowserContext(profile);
  if (!input || input->Find("tab") || !zoom) {
    return std::move(done).Run(false, Error("ERR_ENGINE", "Invalid site zoom request"));
  }
  if (name == "sites.zoomLevels") {
    if (!input->empty()) {
      return std::move(done).Run(false,
                                 Error("ERR_ENGINE", "Invalid site zoom request"));
    }
    base::DictValue factors;
    for (const content::HostZoomMap::ZoomLevelChange& change :
         zoom->GetAllZoomLevels()) {
      if (change.mode != content::HostZoomMap::ZOOM_CHANGED_FOR_HOST) {
        continue;
      }
      const std::optional<std::string> host = ZoomHost(change.host);
      const std::optional<double> factor =
          std::isfinite(change.zoom_level)
              ? page_policy::ReportedZoomFactor(
                    blink::ZoomLevelToZoomFactor(change.zoom_level))
              : std::nullopt;
      if (host && factor) {
        factors.Set(*host, *factor);
      }
    }
    return std::move(done).Run(
        true, base::Value(base::WriteJson(factors).value_or("{}")));
  }
  const std::string* host_text = input->FindString("host");
  const std::optional<double> factor = input->FindDouble("zoom");
  const std::optional<std::string> host = host_text ? ZoomHost(*host_text) : std::nullopt;
  if (!host || !factor || input->size() != 2 ||
      !page_policy::ZoomFactorAllowed(*factor)) {
    return std::move(done).Run(false, Error("ERR_ENGINE", "Invalid site zoom request"));
  }
  const double level = blink::ZoomFactorToZoomLevel(*factor);
  if (!std::isfinite(level)) {
    return std::move(done).Run(false, Error("ERR_ENGINE", "Invalid site zoom request"));
  }
  zoom->SetZoomLevelForHost(*host, level);
  std::move(done).Run(true, base::Value("null"));
}

}
