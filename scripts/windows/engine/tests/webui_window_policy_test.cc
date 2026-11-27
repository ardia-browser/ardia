#include "ardia/win/webui/webui_window_policy.h"

#include <cassert>
#include <iostream>
#include <string>

namespace {

using namespace ardia_win::webui_window;

void TestWindowIds() {
  assert(ValidWindowId("main"));
  assert(ValidWindowId("w-1f2e3d"));
  assert(ValidWindowId("private:3"));
  assert(ValidWindowId(std::string(kWindowIdLimit, 'a')));
  assert(!ValidWindowId(""));
  assert(!ValidWindowId(std::string(kWindowIdLimit + 1, 'a')));
  assert(!ValidWindowId("has space"));
  assert(!ValidWindowId("a/b"));
  assert(!ValidWindowId("a\\b"));
  assert(!ValidWindowId("quote\""));
  assert(!ValidWindowId(std::string("nul\0", 4)));
  assert(!ValidWindowId("caf\xc3\xa9"));

  assert(ValidTabKey("tab-1"));
  assert(ValidTabKey("with space is fine"));
  assert(!ValidTabKey(""));
  assert(!ValidTabKey(std::string(kTabKeyLimit + 1, 'k')));
  assert(!ValidTabKey("line\nbreak"));
  assert(!ValidClaim(std::string("a\x7f", 2)));
  assert(ValidClaim("claim-7"));
}

void TestOpenWindowRequests() {
  assert(ClassifyOpenWindow("main", "") == WindowKind::kBrowser);
  assert(ClassifyOpenWindow("w-2", "browser") == WindowKind::kBrowser);
  assert(ClassifyOpenWindow("w-3", "small") == WindowKind::kSmall);
  assert(ClassifyOpenWindow("settings", "settings") == WindowKind::kSettings);
  assert(ClassifyOpenWindow("import", "import") == WindowKind::kImport);
  assert(!ClassifyOpenWindow("w-4", "settings"));
  assert(!ClassifyOpenWindow("settings", ""));
  assert(!ClassifyOpenWindow("import", "small"));
  assert(!ClassifyOpenWindow("w-5", "devtools"));
  assert(!ClassifyOpenWindow("", ""));
  assert(!ClassifyOpenWindow("bad id", ""));

  assert(WindowKindName(WindowKind::kBrowser) == "browser");
  assert(WindowKindName(WindowKind::kSmall) == "small");
  assert(WindowKindName(WindowKind::kSettings) == "settings");
  assert(IsUtility(WindowKind::kImport));
  assert(!IsUtility(WindowKind::kSmall));

  assert(OpenWindowProfileAllowed(WindowKind::kBrowser, {}));
  assert(OpenWindowProfileAllowed(WindowKind::kBrowser,
                                  {.incognito = true, .private_profile = true,
                                   .has_private_seed = true}));
  assert(!OpenWindowProfileAllowed(WindowKind::kBrowser,
                                   {.incognito = false, .private_profile = false,
                                    .has_private_seed = true}));
  assert(!OpenWindowProfileAllowed(WindowKind::kBrowser,
                                   {.incognito = true, .private_profile = false}));
  assert(!OpenWindowProfileAllowed(WindowKind::kBrowser,
                                   {.incognito = false, .private_profile = true}));
  assert(!OpenWindowProfileAllowed(WindowKind::kSettings,
                                   {.incognito = true, .private_profile = true}));
  assert(OpenWindowProfileAllowed(WindowKind::kSmall, {.has_small_seed = true}));
  assert(!OpenWindowProfileAllowed(WindowKind::kBrowser, {.has_small_seed = true}));
  assert(!OpenWindowProfileAllowed(WindowKind::kSmall,
                                   {.incognito = true, .private_profile = true,
                                    .has_small_seed = true}));
}

void TestCompanionRouting() {
  assert(RouteProfile({.requested_is_window_profile = true}) ==
         MemberRoute::kWindowBrowser);
  assert(RouteProfile({.window_private = true, .requested_is_window_profile = true}) ==
         MemberRoute::kWindowBrowser);
  assert(RouteProfile({}) == MemberRoute::kCompanion);
  assert(RouteProfile({.window_private = true}) == MemberRoute::kRefuse);
  assert(RouteProfile({.window_utility = true}) == MemberRoute::kRefuse);
  assert(RouteProfile({.requested_private = true}) == MemberRoute::kRefuse);
  assert(RouteProfile({.window_closing = true}) == MemberRoute::kRefuse);

  assert(KeepsWindowWithoutTabs(true, false, false));
  assert(KeepsWindowWithoutTabs(false, true, false));
  assert(!KeepsWindowWithoutTabs(true, false, true));
  assert(!KeepsWindowWithoutTabs(false, false, false));
}

void TestBindingGenerations() {
  assert(NextBindingGeneration(1) == 2u);
  assert(NextBindingGeneration(41) == 42u);
  assert(!NextBindingGeneration(0));
  assert(!NextBindingGeneration(std::numeric_limits<uint64_t>::max()));
  uint64_t generation = 1;
  for (int replaced = 0; replaced < 5; ++replaced) {
    const std::optional<uint64_t> next = NextBindingGeneration(generation);
    assert(next && *next > generation);
    generation = *next;
  }
  assert(generation == 6);
}

void TestPrivateHandOver() {
  assert(OriginalProfileOf("incognito:abc@default") == "default");
  assert(OriginalProfileOf("incognito:abc@work") == "work");
  assert(OriginalProfileOf("default") == "default");
  assert(OriginalProfileOf("") == "");
  assert(OriginalProfileOf("a@b@c") == "c");
  assert(PrivateLinkProfile(OriginalProfileOf("incognito:abc@default")) ==
         "default");

  assert(NextHandOverStep(true, true, 0) == HandOverStep::kHanded);
  assert(NextHandOverStep(true, false, kPrivateHandOverTries) ==
         HandOverStep::kHanded);
  assert(NextHandOverStep(false, true, 0) == HandOverStep::kRetry);
  assert(NextHandOverStep(false, false, kPrivateHandOverTries - 1) ==
         HandOverStep::kRetry);
  assert(NextHandOverStep(false, true, kPrivateHandOverTries) ==
         HandOverStep::kMove);
  assert(NextHandOverStep(false, false, kPrivateHandOverTries) ==
         HandOverStep::kDrop);

  assert(HidesUntilHandedOver(true, false, true, true));
  assert(!HidesUntilHandedOver(false, false, true, true));
  assert(!HidesUntilHandedOver(true, true, true, true));
  assert(!HidesUntilHandedOver(true, false, false, true));
  assert(!HidesUntilHandedOver(true, false, true, false));
}

void TestSelectionSequence() {
  SelectionSequence sequence;
  assert(sequence.Admit(1, 0));
  assert(sequence.Admit(1, 3));
  assert(!sequence.Admit(1, 2));
  assert(sequence.Current(1, 3));
  assert(sequence.Admit(1, 3));
  assert(sequence.Admit(2, 1));
  assert(!sequence.Current(1, 3));
  assert(sequence.Current(2, 1));
  assert(sequence.Admit(1, 0));
  assert(sequence.Current(1, 0));
}

void TestClaims() {
  assert(CanReclaim("", "anything"));
  assert(CanReclaim("c1", "c1"));
  assert(!CanReclaim("c1", "c2"));
  assert(!CanReclaim("c1", ""));
}

void TestUnclaimedTabs() {
  assert(NextUnclaimedStep(false, false, true, false, 0) == UnclaimedStep::kDrop);
  assert(NextUnclaimedStep(true, true, true, false, 0) == UnclaimedStep::kDrop);
  assert(NextUnclaimedStep(true, false, true, true, 0) == UnclaimedStep::kWait);
  assert(NextUnclaimedStep(true, false, true, true, kUnclaimedBlankTries) ==
         UnclaimedStep::kReport);
  assert(NextUnclaimedStep(true, false, false, false, 0) == UnclaimedStep::kPark);
  assert(NextUnclaimedStep(true, false, true, false, 0) == UnclaimedStep::kReport);

  assert(ParseAdoptId("tab:1") == 1);
  assert(ParseAdoptId("tab:2147483647") == 2147483647);
  assert(!ParseAdoptId("tab:2147483648"));
  assert(!ParseAdoptId("tab:0"));
  assert(!ParseAdoptId("tab:"));
  assert(!ParseAdoptId("tab:-1"));
  assert(!ParseAdoptId("tab:1a"));
  assert(!ParseAdoptId("restore:1"));
  assert(!ParseAdoptId("tab:99999999999"));
}

void TestDocumentVerbs() {
  assert(ParseDocumentVerb("documents.watch") == DocumentVerb::kWatch);
  assert(ParseDocumentVerb("documents.unwatch") == DocumentVerb::kUnwatch);
  assert(ParseDocumentVerb("documents.commit") == DocumentVerb::kCommit);
  assert(ParseDocumentVerb("documents.flush") == DocumentVerb::kFlush);
  assert(!ParseDocumentVerb("documents."));
  assert(!ParseDocumentVerb("documents.seal"));
  assert(!ParseDocumentVerb("document.watch"));
  assert(!ParseDocumentVerb("history.watch"));
  assert(DocumentVerbName(DocumentVerb::kCommit) == "commit");
  assert(DocumentSubscriptionVerb(DocumentVerb::kWatch));
  assert(DocumentSubscriptionVerb(DocumentVerb::kUnwatch));
  assert(!DocumentSubscriptionVerb(DocumentVerb::kCommit));

  DocumentSubscription subscription;
  assert(!subscription.watched());
  const auto first = subscription.Renew(true);
  assert(first && subscription.Delivers(*first));
  const auto second = subscription.Renew(true);
  assert(second && !subscription.Delivers(*first) && subscription.Delivers(*second));
  const auto stopped = subscription.Renew(false);
  assert(stopped && !subscription.Delivers(*stopped));
  const auto again = subscription.Renew(true);
  assert(again && subscription.Delivers(*again));
  subscription.Retire();
  assert(!subscription.Delivers(*again));
  assert(!subscription.watched());
}

void TestRects() {
  assert(ValidRect(0, 0, 0, 0));
  assert(ValidRect(-10, -20, 100, 50));
  assert(!ValidRect(0, 0, -1, 10));
  assert(!ValidRect(0, 0, 10, -1));
  assert(!ValidRect(0.0 / 0.0, 0, 10, 10));
  assert(!ValidRect(0, 0, 1.0 / 0.0, 10));
  assert(!ValidRect(kCoordinateLimit * 2, 0, 10, 10));
}

void TestPlacement() {
  const auto parsed = ParsePlacement("120 80 1280 800 0");
  assert(parsed);
  assert(parsed->frame == (Rect{120, 80, 1280, 800}));
  assert(!parsed->maximized);
  const auto maximized = ParsePlacement("  -8 -8 1936.4 1056.6 1\n");
  assert(maximized);
  assert(maximized->frame == (Rect{-8, -8, 1936, 1057}));
  assert(maximized->maximized);
  assert(ParsePlacement("1.5 2.5 300 200 0")->frame == (Rect{2, 3, 300, 200}));
  assert(!ParsePlacement(""));
  assert(!ParsePlacement("1 2 3 4"));
  assert(!ParsePlacement("1 2 3 4 0 6"));
  assert(!ParsePlacement("1 2 0 4 0"));
  assert(!ParsePlacement("1 2 3 -4 0"));
  assert(!ParsePlacement("1 2 3 4 2"));
  assert(!ParsePlacement("1 2 3 4 yes"));
  assert(!ParsePlacement("1e3 2 3 4 0"));
  assert(!ParsePlacement("nan 2 3 4 0"));
  assert(!ParsePlacement("1 2 3 9999999 0"));
  assert(!ParsePlacement(std::string(kPlacementTextLimit + 1, ' ')));
  assert(!ParsePlacement("1 2 0.2 4 0"));

  const Placement saved{{120, 80, 1280, 800}, true};
  const std::string text = SerializePlacement(saved);
  assert(text == "120 80 1280 800 1\n");
  assert(ParsePlacement(text) == saved);
}

void TestRequestedMaximized() {
  const Rect work{0, 0, 1920, 1040};
  const Rect restored{100, 80, 1200, 800};
  const PlacementChoice maximized =
      ChoosePlacement(restored, std::nullopt, std::nullopt, work, true);
  assert(maximized.source == PlacementSource::kRequested);
  assert(maximized.maximized);
  assert(maximized.frame == restored);
  assert(!ChoosePlacement(restored, std::nullopt, std::nullopt, work).maximized);
  assert(!ChoosePlacement(restored, std::nullopt, std::nullopt, work, false)
              .maximized);
  const Placement saved{{5, 5, 900, 700}, true};
  assert(ChoosePlacement(std::nullopt, std::nullopt, saved, work).maximized);
  assert(!ChoosePlacement(std::nullopt, std::nullopt, saved, work, false)
              .maximized);
  assert(ChoosePlacement(std::nullopt, std::nullopt, std::nullopt, work, true)
             .maximized);
}

void TestMultiMonitorPlacement() {
  const Rect primary{0, 0, 1920, 1040};
  const Rect secondary{1920, -200, 2560, 1400};
  const Placement saved_on_secondary{{2400, 100, 1200, 800}, false};
  const std::optional<Rect> effective =
      EffectivePlacementRect(std::nullopt, std::nullopt, saved_on_secondary);
  assert(effective == saved_on_secondary.frame);
  const PlacementChoice kept = ChoosePlacement(std::nullopt, std::nullopt,
                                               saved_on_secondary, secondary);
  assert(kept.frame == (Rect{2400, 100, 1200, 800}));
  const PlacementChoice clamped = ChoosePlacement(std::nullopt, std::nullopt,
                                                  saved_on_secondary, primary);
  assert(clamped.frame.right() <= primary.right());

  const Placement front_on_secondary{{2000, 0, 1000, 700}, false};
  const std::optional<Rect> cascaded =
      EffectivePlacementRect(std::nullopt, front_on_secondary, saved_on_secondary);
  assert(cascaded == (Rect{2028, 28, 1000, 700}));
  assert(ChoosePlacement(std::nullopt, front_on_secondary, saved_on_secondary,
                         secondary)
             .frame == (Rect{2028, 28, 1000, 700}));

  const Rect requested{3000, 500, 900, 600};
  assert(EffectivePlacementRect(requested, front_on_secondary,
                                saved_on_secondary) == requested);
  assert(EffectivePlacementRect(Rect{0, 0, 0, 0}, std::nullopt, std::nullopt) ==
         std::nullopt);
  assert(EffectivePlacementRect(std::nullopt, std::nullopt, std::nullopt) ==
         std::nullopt);
}

void TestPlacementFit() {
  const Rect work{0, 0, 1920, 1040};
  assert(FitToWorkArea({100, 100, 800, 600}, work) == (Rect{100, 100, 800, 600}));
  assert(FitToWorkArea({1800, 900, 800, 600}, work) == (Rect{1120, 440, 800, 600}));
  assert(FitToWorkArea({-500, -500, 800, 600}, work) == (Rect{0, 0, 800, 600}));
  assert(FitToWorkArea({0, 0, 4000, 3000}, work) == (Rect{0, 0, 1920, 1040}));
  assert(FitToWorkArea({0, 0, 100, 100}, work) ==
         (Rect{0, 0, kMinimumWindowWidth, kMinimumWindowHeight}));
  const Rect tiny{0, 0, 300, 200};
  assert(FitToWorkArea({0, 0, 1000, 1000}, tiny) == (Rect{0, 0, 300, 200}));
  assert(FitToWorkArea({5, 5, 10, 10}, Rect{}) == (Rect{5, 5, 10, 10}));

  assert(CenteredDefault(work) == (Rect{320, 120, 1280, 800}));
  assert(CascadeFrom({100, 100, 800, 600}, work) == (Rect{128, 128, 800, 600}));
  assert(CascadeFrom({1100, 420, 800, 600}, work) == (Rect{0, 0, 800, 600}));

  const auto requested = ChoosePlacement(Rect{10, 20, 900, 700}, std::nullopt,
                                         std::nullopt, work);
  assert(requested.source == PlacementSource::kRequested);
  assert(requested.frame == (Rect{10, 20, 900, 700}));
  const auto front = ChoosePlacement(std::nullopt,
                                     Placement{{100, 100, 800, 600}, true},
                                     Placement{{5, 5, 900, 900}, false}, work);
  assert(front.source == PlacementSource::kFront);
  assert(front.maximized);
  assert(front.frame == (Rect{128, 128, 800, 600}));
  const auto saved = ChoosePlacement(std::nullopt, std::nullopt,
                                     Placement{{5, 5, 900, 900}, false}, work);
  assert(saved.source == PlacementSource::kSaved);
  assert(saved.frame == (Rect{5, 5, 900, 900}));
  const auto fallback =
      ChoosePlacement(Rect{0, 0, 0, 0}, std::nullopt, std::nullopt, work);
  assert(fallback.source == PlacementSource::kDefault);
  assert(fallback.frame == CenteredDefault(work));
}


const std::string kHostileCorpus[] = {
    std::string(),
    std::string("\0", 1),
    std::string("a\0b", 3),
    "\r\n",
    "line\nbreak",
    "\t",
    "\x7f",
    "\xff",
    "\xc0\xaf",
    "\xe0\x80\xaf",
    "\xed\xa0\x80",
    "\xf4\x90\x80\x80",
    "\xf8\x88\x80\x80\x80",
    "\xe2\x80\xae",
    "\xef\xbb\xbf",
    "\xf0\x9f\x98\x80",
    "../../../../etc/passwd",
    "..\\..\\Windows\\System32",
    "%00",
    "%2e%2e%2f",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/Windows/System32/calc.exe",
    "\\\\ardia-fixture.invalid\\share\\x.exe",
    "steam://run/1",
    "ms-msdt:/id PCWDiagnostic",
    "https://user:pass@ardia-fixture.invalid/",
    "__proto__",
    "constructor",
    "default@",
    "@default",
    "Default",
    std::string(kPickerPromptLimit + 1, 'p'),
    std::string(4096, 'x'),
};

void TestHostileSinks() {
  for (const std::string& value : kHostileCorpus) {
    const std::string truncated = TruncateUtf8(value, 3);
    assert(truncated.size() <= 3);
    if (ValidUtf8(value)) {
      assert(ValidUtf8(truncated));
    }
    assert(CopyTextFits(value, 1024 * 1024) == ValidUtf8(value));
    if (PickerPromptUsable(value)) {
      assert(!value.empty() && value.size() <= kPickerPromptLimit &&
             ValidUtf8(value) && value.find('\0') == std::string::npos &&
             value.find('\n') == std::string::npos);
    }
    assert(!RelaunchUrlSchemeAllowed(value));
    const std::string_view link_profile = PrivateLinkProfile(value);
    assert(link_profile.empty() || link_profile == value);
    if (!link_profile.empty()) {
      assert(value.find('@') == std::string::npos &&
             value.find('\n') == std::string::npos &&
             value.size() <= kWindowIdLimit);
    }
    assert(!DocumentEngineRequestAllowed(value, 2));
    assert(!ParseDocumentVerb(value));
    assert(!ParseDocumentVerb("documents." + value));
    assert(!ParseAdoptId(value));
    assert(!ClassifyOpenWindow(value, "") || ValidWindowId(value));
    if (ValidWindowId(value)) {
      assert(value.find_first_of("/\\@%\0 \r\n") == std::string::npos);
    }
  }
  assert(!PickerPromptUsable(std::string(kPickerPromptLimit + 1, 'p')));
  assert(PickerPromptUsable(std::string(kPickerPromptLimit, 'p')));
  assert(PickerPromptUsable("Choose \xf0\x9f\x98\x80"));
  assert(!PickerPromptUsable("bad\xff"));
  assert(!PickerPromptUsable("tab\there"));

  const std::string emoji = "\xf0\x9f\x98\x80";
  std::string four_emoji;
  for (int i = 0; i < 4; ++i) {
    four_emoji += emoji;
  }
  assert(TruncateUtf8(four_emoji, 6) == emoji);
  assert(TruncateUtf8(four_emoji, 8) == emoji + emoji);
  assert(TruncateUtf8(four_emoji, 3).empty());
  assert(TruncateUtf8("abc", 10) == "abc");
  const std::string wide(1024 * 1024 / 3 + 10, 'a');
  std::string cjk;
  for (size_t i = 0; i < 400000; ++i) {
    cjk += "\xe4\xb8\xad";
  }
  const std::string capped = TruncateUtf8(cjk, 1024 * 1024);
  assert(capped.size() <= 1024 * 1024 && capped.size() % 3 == 0 &&
         ValidUtf8(capped));
  assert(!CopyTextFits(cjk, 1024 * 1024));
  assert(CopyTextFits(wide, 1024 * 1024));

  assert(PrivateLinkProfile("default") == "default");
  assert(PrivateLinkProfile("work") == "work");
  assert(PrivateLinkProfile("").empty());
  assert(PrivateLinkProfile("w-1@default").empty());
  assert(PrivateLinkProfile("bad\nname").empty());
  assert(PrivateLinkProfile(std::string(kWindowIdLimit + 1, 'p')).empty());

  assert(RelaunchUrlSchemeAllowed("https"));
  assert(RelaunchUrlSchemeAllowed("http"));
  assert(RelaunchUrlSchemeAllowed("file"));
  assert(!RelaunchUrlSchemeAllowed("javascript"));
  assert(!RelaunchUrlSchemeAllowed("chrome"));
  assert(!RelaunchUrlSchemeAllowed("ms-settings"));
  assert(RelaunchUrlAccepted("https", 20, 0));
  assert(!RelaunchUrlAccepted("https", 0, 0));
  assert(!RelaunchUrlAccepted("https", kRelaunchUrlBytes + 1, 0));
  assert(!RelaunchUrlAccepted("https", 20, kRelaunchUrlLimit));

  assert(DocumentEngineRequestAllowed("default", 0));
  assert(DocumentEngineRequestAllowed("default", kDocumentEngineRequestLimit));
  assert(!DocumentEngineRequestAllowed("default", kDocumentEngineRequestLimit + 1));
  assert(!DocumentEngineRequestAllowed("w-1@default", 10));
  assert(!DocumentEngineRequestAllowed("", 10));
}


void TestStartFocus() {
  assert(NextStartStep(false, false, false, false) == StartStep::kOpenMain);
  assert(NextStartStep(false, true, false, false) == StartStep::kOpenMain);
  assert(NextStartStep(false, false, true, false) == StartStep::kOpenMain);
  assert(NextStartStep(false, false, true, true) == StartStep::kOpenMain);

  assert(NextStartStep(true, true, false, true) == StartStep::kFocusFront);
  assert(NextStartStep(true, true, false, false) == StartStep::kFocusFront);
  assert(NextStartStep(true, true, true, false) == StartStep::kFocusFront);
  assert(NextStartStep(true, true, true, true) == StartStep::kFocusFront);

  assert(NextStartStep(true, false, true, true) == StartStep::kLeaveToLinks);
  assert(NextStartStep(true, false, true, false) == StartStep::kFocusFront);
  assert(NextStartStep(true, false, false, true) == StartStep::kFocusFront);
}
}

int main() {
  TestWindowIds();
  TestOpenWindowRequests();
  TestCompanionRouting();
  TestSelectionSequence();
  TestPrivateHandOver();
  TestBindingGenerations();
  TestClaims();
  TestUnclaimedTabs();
  TestDocumentVerbs();
  TestRects();
  TestPlacement();
  TestPlacementFit();
  TestMultiMonitorPlacement();
  TestRequestedMaximized();
  TestHostileSinks();
  TestStartFocus();
  std::cout << "webui_window_policy_test: all assertions passed\n";
  return 0;
}
