#include "ardia/mac/ac_mac_page_policy.h"

#include <array>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <string>
#include <string_view>
#include <vector>

#include "check.h"

namespace policy = ardia_mac::page_policy;

namespace {

std::string Identity(std::string_view text) {
  return std::string(text);
}

constexpr std::array<std::string_view, 2> kFonts = {{"serif", "sans"}};

}

TEST(page_commands_are_the_shared_webview_handle_names) {
  for (std::string_view command :
       {"find", "stopFinding", "print", "runPageCommand", "showDevTools", "zoomStep",
        "goToOffset", "evaluate", "edit", "getSecurityInfo", "discard", "sleepIfHidden",
        "setFrozen", "downloadFavicon", "downloadImage", "openBlockedPopup",
        "resolveUnresponsive"}) {
    CHECK(policy::Handles(command));
  }
  for (std::string_view other : {"loadUrl", "goBack", "reload", "close", "stopFind", "findNext",
                                 "openDevTools", "inspectElement", "viewSource", "", "FIND"}) {
    CHECK(!policy::Handles(other));
  }
  CHECK(policy::IsZoomRoute("sites.zoomLevels") && policy::IsZoomRoute("sites.setZoom"));
  CHECK(!policy::IsZoomRoute("sites.settings") && !policy::IsZoomRoute("sites.setzoom"));
}

TEST(page_actions_and_devtools_panels) {
  CHECK(policy::PageActionFor("savePage") == policy::PageAction::kSavePage);
  CHECK(policy::PageActionFor("systemPrint") == policy::PageAction::kSystemPrint);
  CHECK(policy::PageActionFor("viewSource") == policy::PageAction::kViewSource);
  CHECK(policy::PageActionFor("caretBrowsing") == policy::PageAction::kUnsupported);
  CHECK(policy::PageActionFor("SavePage") == policy::PageAction::kUnsupported);
  CHECK(policy::DevToolsPanelFor(std::nullopt) == policy::DevToolsPanel::kShow);
  CHECK(policy::DevToolsPanelFor("toggle") == policy::DevToolsPanel::kToggle);
  CHECK(policy::DevToolsPanelFor("inspect") == policy::DevToolsPanel::kInspect);
  CHECK(policy::DevToolsPanelFor("console") == policy::DevToolsPanel::kConsole);
  CHECK(!policy::DevToolsPanelFor("show").has_value());
  CHECK(!policy::DevToolsPanelFor("").has_value());
}

TEST(whole_numbers_zoom_steps_and_offsets) {
  CHECK(policy::WholeNumber(3) == 3);
  CHECK(policy::WholeNumber(-2) == -2);
  CHECK(!policy::WholeNumber(1.5).has_value());
  CHECK(!policy::WholeNumber(std::numeric_limits<double>::quiet_NaN()).has_value());
  CHECK(!policy::WholeNumber(std::numeric_limits<double>::infinity()).has_value());
  CHECK(!policy::WholeNumber(1e20).has_value());
  CHECK(policy::ZoomStep(-1) == -1 && policy::ZoomStep(0) == 0 && policy::ZoomStep(1) == 1);
  CHECK(!policy::ZoomStep(2).has_value() && !policy::ZoomStep(0.5).has_value());
}

TEST(sleep_image_and_popup_arguments) {
  CHECK(policy::SleepSeconds(0) == 0.0);
  CHECK(policy::SleepSeconds(policy::kSleepLongestHiddenSeconds).has_value());
  CHECK(!policy::SleepSeconds(policy::kSleepLongestHiddenSeconds + 1).has_value());
  CHECK(!policy::SleepSeconds(-1).has_value());
  CHECK(!policy::SleepSeconds(std::numeric_limits<double>::quiet_NaN()).has_value());
  CHECK(policy::ImagePixels(1) == 1 && policy::ImagePixels(512) == 512);
  CHECK(!policy::ImagePixels(0).has_value() && !policy::ImagePixels(513).has_value());
  CHECK(policy::ImageScheme("https") && policy::ImageScheme("http") && policy::ImageScheme("data"));
  CHECK(!policy::ImageScheme("file") && !policy::ImageScheme("javascript") && !policy::ImageScheme("chrome"));
  CHECK(policy::PopupId("0") == 0 && policy::PopupId("2147483647") == 2147483647);
  CHECK(!policy::PopupId("2147483648").has_value());
  CHECK(!policy::PopupId("-1").has_value() && !policy::PopupId("").has_value());
  CHECK(!policy::PopupId("1e3").has_value() && !policy::PopupId("12345678901").has_value());
}

TEST(discard_and_freeze_follow_the_linux_protection_order) {
  const policy::Protection clear{false, false, false, false, false, false, false};
  CHECK(!policy::ProtectionReason(clear).has_value());
  CHECK(policy::MayFreeze(clear));
  policy::Protection visible = clear;
  visible.visible = true;
  CHECK(policy::ProtectionReason(visible) == "visible");
  policy::Protection unknown = clear;
  unknown.dirty_input.reset();
  CHECK(policy::ProtectionReason(unknown) == "unknown unsaved input");
  CHECK(!policy::MayFreeze(unknown));
  CHECK(policy::DecideDiscard(true, false, false, clear) == policy::DiscardDecision::kDiscard);
  CHECK(policy::DecideDiscard(true, false, true, clear) == policy::DiscardDecision::kUnsupported);
  CHECK(policy::DecideDiscard(false, false, false, clear) == policy::DiscardDecision::kRefused);
  CHECK(policy::DecideDiscard(true, true, false, visible) == policy::DiscardDecision::kAlready);
  CHECK(policy::DecideDiscard(true, false, false, visible) == policy::DiscardDecision::kRefused);
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kDiscard, true) == "discarded");
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kDiscard, false) == "refused");
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kAlready, false) == "already");
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kUnsupported, false) == "unsupported");
}

TEST(crashes_load_errors_and_theme_colors) {
  CHECK(!policy::RendererGone(policy::Termination::kNormal));
  CHECK(!policy::RendererGone(policy::Termination::kStillRunning));
  CHECK(policy::RendererGone(policy::Termination::kCrashed));
  CHECK(policy::CrashReason(policy::Termination::kAbnormal) == "abnormal");
  CHECK(policy::CrashReason(policy::Termination::kKilled) == "killed");
  CHECK(policy::CrashReason(policy::Termination::kCrashed) == "crashed");
  CHECK(policy::CrashReason(policy::Termination::kOom) == "oom");
  CHECK(policy::CrashReason(policy::Termination::kLaunchFailed) == "launchFailed");
  CHECK(policy::CrashReason(policy::Termination::kOther) == "unknown");
  CHECK(!policy::NavigationLoadError(0) && !policy::NavigationLoadError(-3));
  CHECK(policy::NavigationLoadError(-105) && policy::NavigationLoadError(-2));
  CHECK(policy::ThemeColorText(0, 0, 0) == "#000000");
  CHECK(policy::ThemeColorText(255, 16, 171) == "#ff10ab");
}

TEST(site_zoom_hosts_and_factors) {
  CHECK(policy::ZoomHostShape("example.com"));
  CHECK(policy::ZoomHostShape("[::1]"));
  CHECK(!policy::ZoomHostShape(""));
  CHECK(!policy::ZoomHostShape("example.com:8080"));
  CHECK(!policy::ZoomHostShape("a/b") && !policy::ZoomHostShape("a b") && !policy::ZoomHostShape("u@h"));
  CHECK(!policy::ZoomHostShape(std::string(254, 'a')));
  CHECK(policy::ZoomFactorAllowed(1) && policy::ZoomFactorAllowed(0.25) && policy::ZoomFactorAllowed(5));
  CHECK(!policy::ZoomFactorAllowed(0.2) && !policy::ZoomFactorAllowed(5.01));
  CHECK(!policy::ZoomFactorAllowed(std::numeric_limits<double>::quiet_NaN()));
  CHECK_NEAR(*policy::ReportedZoomFactor(1.10000001), 1.1);
  CHECK(!policy::ReportedZoomFactor(0.001).has_value());
}

TEST(evaluation_runs_only_known_operations) {
  const std::array<policy::Operation, 3> operations = {{
      {"plain", 9, "plainBody", policy::Arguments::kNone, ""},
      {"replace", 6, "swap((", policy::Arguments::kReplace, ")"},
      {"look", 5, "look(", policy::Arguments::kLook, ");"},
  }};
  const auto plain = policy::MatchOperation("plainBody", &Identity, operations);
  CHECK(plain && plain->operation->name == "plain" && plain->arguments.empty());
  CHECK(!policy::MatchOperation("plainBody;alert(1)", &Identity, operations).has_value());
  CHECK(!policy::MatchOperation("plainbody", &Identity, operations).has_value());
  const auto swap = policy::MatchOperation("swap((\"a\", \"b\", true)", &Identity, operations);
  CHECK(swap && swap->operation->name == "replace" && swap->arguments == "\"a\", \"b\", true");
  CHECK(!policy::MatchOperation("swap((", &Identity, operations).has_value());
  const auto loose = policy::MatchOperation("swap((x)alert(1)", &Identity, operations);
  CHECK(loose && loose->arguments == "x)alert(1");
  const auto look = policy::MatchOperation("look({});", &Identity, operations);
  CHECK(look && look->arguments == "{}");
  CHECK(!policy::MatchOperation("", &Identity, operations).has_value());
  CHECK(!policy::MatchOperation(std::string(policy::kEvaluationCodeMax + 1, 'p'), &Identity,
                                operations)
             .has_value());
}

TEST(evaluation_arguments_are_rebuilt_not_forwarded) {
  CHECK(policy::JavaScriptString("a\"b\\c") == "\"a\\\"b\\\\c\"");
  CHECK(policy::JavaScriptString("</script>") == "\"\\u003c/script\\u003e\"");
  CHECK(policy::JavaScriptString(std::string("\n\x7f", 2)) == "\"\\u000a\\u007f\"");
  CHECK(policy::JavaScriptString("\xe2\x80\xa8\xe2\x80\xa9") == "\"\\u2028\\u2029\"");
  CHECK(policy::ReplaceArguments("a", "b", true) == "\"a\", \"b\", true");
  CHECK(!policy::ReplaceArguments(std::string(policy::kReplaceTextMax + 1, 'a'), "b", false).has_value());
  CHECK(!policy::ReplaceArguments(std::string("a\0b", 3), "b", false).has_value());
  CHECK(policy::LookArgument(true, 2, "serif", 5, kFonts) ==
        "{\"dark\":true,\"size\":2,\"font\":\"serif\"}");
  CHECK(!policy::LookArgument(false, 5, "serif", 5, kFonts).has_value());
  CHECK(!policy::LookArgument(false, -1, "serif", 5, kFonts).has_value());
  CHECK(!policy::LookArgument(false, 1, "\"};alert(1)", 5, kFonts).has_value());
  CHECK(policy::PickerPoint(std::nullopt, std::nullopt) == "null");
  CHECK(policy::PickerPoint(1.5, -2) == "[1.5,-2]");
  CHECK(!policy::PickerPoint(1, std::nullopt).has_value());
  CHECK(!policy::PickerPoint(2e6, 0).has_value());
  CHECK(!policy::PickerPoint(std::numeric_limits<double>::quiet_NaN(), 0).has_value());
  const std::vector<std::string_view> selectors = {"a.b", "#c"};
  CHECK(policy::PickerSelectors(selectors) == "[\"a.b\",\"#c\"]");
  const std::vector<std::string_view> empty_selector = {""};
  CHECK(!policy::PickerSelectors(empty_selector).has_value());
  const std::vector<std::string_view> too_many(policy::kPickerSelectorsMax + 1, "a");
  CHECK(!policy::PickerSelectors(too_many).has_value());
  const std::string wrapped = policy::WrapEvaluation("post(\"result\", \"1\")");
  CHECK(wrapped.starts_with("(() => {\nlet ardiaResult = null;\n"));
  CHECK(wrapped.find("try {\npost(\"result\", \"1\")\n;\n} catch (ardiaError) {}") != std::string::npos);
  CHECK(wrapped.ends_with("return ardiaResult;\n})()"));
  CHECK(policy::EvaluationResultFits(policy::kEvaluationResultMax));
  CHECK(!policy::EvaluationResultFits(policy::kEvaluationResultMax + 1));
  CHECK(policy::ScriptableScheme("https") && policy::ScriptableScheme("file"));
  CHECK(!policy::ScriptableScheme("chrome") && !policy::ScriptableScheme("devtools"));
  CHECK(policy::FindTextFits(policy::kFindTextMax) && !policy::FindTextFits(policy::kFindTextMax + 1));
}

TEST(history_offsets_never_overflow) {
  constexpr int kMax = std::numeric_limits<int>::max();
  constexpr int kMin = std::numeric_limits<int>::min();
  CHECK(policy::HistoryTarget(2, 5, 1) == 3);
  CHECK(policy::HistoryTarget(2, 5, -2) == 0);
  CHECK(!policy::HistoryTarget(2, 5, 0).has_value());
  CHECK(!policy::HistoryTarget(2, 5, 3).has_value());
  CHECK(!policy::HistoryTarget(2, 5, -3).has_value());
  CHECK(!policy::HistoryTarget(2, 5, kMax).has_value());
  CHECK(!policy::HistoryTarget(2, 5, kMin).has_value());
  CHECK(!policy::HistoryTarget(kMax, kMax, kMax).has_value());
  CHECK(!policy::HistoryTarget(-1, 5, 1).has_value());
  CHECK(policy::HistoryTarget(kMax - 1, kMax, 0 - (kMax - 1)) == 0);
}

TEST(unsaved_input_and_pending_prompts_keep_a_tab_awake) {
  CHECK(policy::UnsavedInput(false, false, false) == false);
  CHECK(policy::UnsavedInput(false, true, false) == true);
  CHECK(policy::UnsavedInput(false, false, true) == true);
  CHECK(policy::UnsavedInput(true, std::nullopt, std::nullopt) == true);
  CHECK(!policy::UnsavedInput(false, std::nullopt, std::nullopt).has_value());
  policy::Protection edited{false, false, false, false, false, false, std::nullopt};
  edited.dirty_input = policy::UnsavedInput(false, true, false);
  CHECK(policy::DecideDiscard(true, false, false, edited) == policy::DiscardDecision::kRefused);
  CHECK(!policy::MayFreeze(edited));
  policy::Protection prompting{false, false, false, false, false, true, false};
  CHECK(policy::ProtectionReason(prompting) == "pending prompt");
  policy::Protection unknown_prompt{false, false, false, false, false, std::nullopt, false};
  CHECK(policy::DecideDiscard(true, false, false, unknown_prompt) ==
        policy::DiscardDecision::kRefused);
}

TEST(background_permission_prompts_are_dismissed_only_for_bound_tabs) {
  CHECK(policy::PromptHandlingFor(true, true) == policy::PromptHandling::kDismissWithoutUi);
  CHECK(policy::PromptHandlingFor(true, false) == policy::PromptHandling::kChrome);
  CHECK(policy::PromptHandlingFor(false, true) == policy::PromptHandling::kChrome);
  CHECK(policy::PromptHandlingFor(false, false) == policy::PromptHandling::kChrome);
}

TEST(bindings_follow_replaced_and_detached_tabs) {
  CHECK(policy::StripExitFor(true, true) == policy::StripExit::kDestroyed);
  CHECK(policy::StripExitFor(false, true) == policy::StripExit::kKeep);
  CHECK(policy::StripExitFor(false, false) == policy::StripExit::kDrop);
  CHECK(policy::RebindAllowed(4, 4, true));
  CHECK(policy::RebindAllowed(4, 9, false));
  CHECK(!policy::RebindAllowed(4, 9, true));
  CHECK(!policy::RebindAllowed(0, 9, false));
  CHECK(!policy::RebindAllowed(4, 0, false));
  CHECK(policy::NextBindingGeneration(1) == 2u);
  CHECK(!policy::NextBindingGeneration(0).has_value());
  CHECK(!policy::NextBindingGeneration(std::numeric_limits<uint64_t>::max()).has_value());
}

TEST(blocked_popups_clear_on_cross_document_commits) {
  CHECK(policy::ClearsBlockedPopups(true, true, false));
  CHECK(!policy::ClearsBlockedPopups(true, true, true));
  CHECK(!policy::ClearsBlockedPopups(true, false, false));
  CHECK(!policy::ClearsBlockedPopups(false, true, false));
  CHECK(policy::kSnapshotEventsMax == 128u);
}

TEST(promise_operations_are_awaited_by_token) {
  const policy::Operation apply{
      "elementPickerApply", 4, "x", policy::Arguments::kSelectors,
      "])).then((v) => post(\"result\", JSON.stringify(v)), () => post(\"result\", \"null\"));"};
  const policy::Operation start{
      "elementPickerStart", 4, "x", policy::Arguments::kPoint,
      "])).then((v) => { window.stash = v; }, () => { window.stash = null; });"};
  const policy::Operation look{"readerOpen", 4, "x", policy::Arguments::kLook, ")));"};
  const policy::Operation take{"elementPickerTake", 4, "x", policy::Arguments::kNone, ""};
  CHECK(policy::AwaitsResult(apply));
  CHECK(!policy::AwaitsResult(start));
  CHECK(!policy::AwaitsResult(look));
  CHECK(!policy::AwaitsResult(take));
  const std::string awaited = policy::WrapAwaitedEvaluation("post(\"result\", \"1\")", 7);
  CHECK(awaited.find("ardiaSlots.set(7, ardiaSlot)") != std::string::npos);
  CHECK(awaited.find("ardiaSlots.set(7, ardiaSlot)") < awaited.find("try {"));
  CHECK(awaited.find("ardiaSlots.get(7) !== ardiaSlot) return;") != std::string::npos);
  CHECK(awaited.find("ardiaSlots.delete(7)") != std::string::npos);
  CHECK(policy::TakeEvaluation(7).find("ardiaSlots.get(7)") != std::string::npos);
  CHECK(policy::kEvaluationDeadlineMilliseconds == 5000);
  CHECK(policy::kEvaluationSlotTtlMilliseconds > policy::kEvaluationDeadlineMilliseconds);
  CHECK(awaited.find("setTimeout(() => { if (ardiaSlots.get(7) === ardiaSlot) ardiaSlots.delete(7); }, 6000)") != std::string::npos);
  CHECK(policy::TakeEvaluation(7).find("ardiaSlot.pending") != std::string::npos);
  CHECK(policy::ForgetEvaluation(7).find(".delete(7)") != std::string::npos);
  if (const char* out = std::getenv("ARDIA_EVALUATION_SCRIPTS")) {
    std::ofstream file(out);
    file << policy::WrapAwaitedEvaluation(
                "Promise.resolve([\"a\"]).then((v) => post(\"result\", JSON.stringify(v)), () => post(\"result\", \"null\"));",
                41)
         << "\n--ardia-split--\n"
         << policy::WrapAwaitedEvaluation("post(\"result\", \"now\"); post(\"result\", \"later\");", 42)
         << "\n--ardia-split--\n"
         << policy::TakeEvaluation(41) << "\n--ardia-split--\n"
         << policy::TakeEvaluation(42) << "\n--ardia-split--\n"
         << policy::WrapEvaluation("post(\"result\", \"sync\")") << "\n--ardia-split--\n"
         << policy::WrapAwaitedEvaluation(
                "Promise.resolve(1).then((v) => post(\"result\", JSON.stringify(v)), () => post(\"result\", \"null\"));",
                43)
         << "\n--ardia-split--\n"
         << policy::TakeEvaluation(43) << "\n--ardia-split--\n"
         << policy::ForgetEvaluation(43) << "\n--ardia-split--\n"
         << policy::WrapAwaitedEvaluation(
                "new Promise((resolve) => setImmediate(() => resolve(2))).then((v) => post(\"result\", JSON.stringify(v)), () => post(\"result\", \"null\"));",
                44)
         << "\n--ardia-split--\n"
         << policy::TakeEvaluation(44) << "\n--ardia-split--\n"
         << policy::ForgetEvaluation(44);
  }
}

TEST(evaluations_settle_once_and_follow_the_document) {
  using Step = policy::EvaluationStep;
  CHECK(policy::NextEvaluationStep(false, true, true, true, false) == Step::kReply);
  CHECK(policy::NextEvaluationStep(false, true, true, true, true) == Step::kReply);
  CHECK(policy::NextEvaluationStep(false, true, true, false, true) == Step::kReplyNull);
  CHECK(policy::NextEvaluationStep(false, true, false, false, true) == Step::kPoll);
  CHECK(policy::NextEvaluationStep(false, true, false, false, false) == Step::kReplyNull);
  CHECK(policy::NextEvaluationStep(false, false, true, true, true) == Step::kReplyNull);
  CHECK(policy::NextEvaluationStep(true, true, false, false, true) == Step::kReplyNull);
}

TEST(discard_succeeds_through_the_surviving_binding) {
  CHECK(policy::DiscardSucceeded(true, true, true));
  CHECK(!policy::DiscardSucceeded(true, false, false));
  CHECK(!policy::DiscardSucceeded(true, true, false));
  CHECK(!policy::DiscardSucceeded(false, true, true));
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kDiscard,
                               policy::DiscardSucceeded(true, true, true)) == "discarded");
}

TEST(media_sessions_that_play_protect_the_tab) {
  CHECK(policy::SessionPlaying(true, true));
  CHECK(!policy::SessionPlaying(false, true));
  CHECK(!policy::SessionPlaying(true, false));
  policy::Protection playing{false, false, policy::SessionPlaying(true, true), false, false, false, false};
  CHECK(policy::ProtectionReason(playing) == "playing media");
  CHECK(!policy::MayFreeze(playing));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
