#include "ardia/mac/ac_mac_shell_policy.h"

#include <string>

#include "check.h"

namespace policy = ardia_mac::shell_policy;

TEST(session_json_is_reserved_in_every_ascii_case) {
  for (const char* name : {"session.json", "Session.json", "SESSION.JSON", "sEsSiOn.JsOn", "session.JSON"}) {
    CHECK(!policy::ValidDocumentName(name));
  }
  CHECK(policy::ValidDocumentName("sessions.json"));
  CHECK(policy::ValidDocumentName("session.json.bak"));
  CHECK(policy::ValidDocumentName("notes.json"));
}

TEST(document_names_keep_their_charset) {
  CHECK(!policy::ValidDocumentName(""));
  CHECK(!policy::ValidDocumentName(".hidden"));
  CHECK(!policy::ValidDocumentName("a/b.json"));
  CHECK(!policy::ValidDocumentName("..json/x"));
  CHECK(!policy::ValidDocumentName(std::string(201, 'a')));
  CHECK(policy::ValidDocumentName(std::string(200, 'a')));
}

TEST(oversized_sessions_are_refused_before_writing) {
  CHECK(policy::SessionFitsOnDisk(0));
  CHECK(policy::SessionFitsOnDisk(policy::kMergeableSessionBytes));
  CHECK(!policy::SessionFitsOnDisk(policy::kMergeableSessionBytes + 1));
  CHECK(policy::kMergeableSessionBytes == 8u * 1024u * 1024u);
  CHECK(policy::SessionFileFor(true, policy::kMergeableSessionBytes, true, true) == policy::SessionFile::kUse);
  CHECK(policy::SessionFileFor(true, policy::kMergeableSessionBytes + 2, true, true) == policy::SessionFile::kSetAside);
}

TEST(default_profile_offers_use_the_empty_engine_name) {
  CHECK(policy::OfferedProfile("default").empty());
  CHECK(policy::OfferedProfile("work") == "work");
  CHECK(policy::OfferedProfile("").empty());
}

TEST(adopt_field_shapes) {
  using policy::AdoptField;
  CHECK(policy::ClassifyAdoptField(false, false, "") == AdoptField::kAbsent);
  CHECK(policy::ClassifyAdoptField(true, false, "") == AdoptField::kInvalid);
  CHECK(policy::ClassifyAdoptField(true, true, "") == AdoptField::kInvalid);
  CHECK(policy::ClassifyAdoptField(true, true, "tab:x") == AdoptField::kInvalid);
  CHECK(policy::ClassifyAdoptField(true, true, "tab:7") == AdoptField::kId);
}

TEST(create_plans_check_the_adopt_id_before_reclaim_or_create) {
  using policy::AdoptField;
  using policy::AdoptRefusal;
  using policy::CreatePlan;
  policy::CreateRequest fresh;
  CHECK(policy::PlanCreate(fresh) == CreatePlan::kCreate);
  policy::CreateRequest non_string = fresh;
  non_string.adopt = AdoptField::kInvalid;
  CHECK(policy::PlanCreate(non_string) == CreatePlan::kRefuse);
  policy::CreateRequest reclaim{AdoptField::kAbsent, 0, true, true, 9, AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(reclaim) == CreatePlan::kReclaim);
  policy::CreateRequest invalid_on_existing = reclaim;
  invalid_on_existing.adopt = AdoptField::kInvalid;
  CHECK(policy::PlanCreate(invalid_on_existing) == CreatePlan::kRefuse);
  policy::CreateRequest mismatched = reclaim;
  mismatched.adopt = AdoptField::kId;
  mismatched.adopt_id = 4;
  CHECK(policy::PlanCreate(mismatched) == CreatePlan::kRefuse);
  policy::CreateRequest matching = mismatched;
  matching.adopt_id = 9;
  CHECK(policy::PlanCreate(matching) == CreatePlan::kReclaim);
  policy::CreateRequest adopt{AdoptField::kId, 4, false, false, 0, AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(adopt) == CreatePlan::kAdopt);
  adopt.adoption = AdoptRefusal::kNotOffered;
  CHECK(policy::PlanCreate(adopt) == CreatePlan::kRefuse);
  policy::CreateRequest move{AdoptField::kAbsent, 0, true, false, 9, AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(move) == CreatePlan::kReplace);
  policy::CreateRequest adopt_move{AdoptField::kId, 4, true, false, 9, AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(adopt_move) == CreatePlan::kAdoptReplacing);
}

TEST(a_cross_profile_move_is_always_replaced) {
  policy::CreateRequest move{policy::AdoptField::kAbsent, 0, true, false, 9, policy::AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(move) == policy::CreatePlan::kReplace);
}

TEST(offers_keep_their_active_disposition_and_leave_with_their_tab) {
  policy::OfferBook<int> book;
  book.Add(3, 30, true);
  book.Add(4, 40, false);
  CHECK(book.Find(3) && book.Find(3)->active && book.Find(3)->handle == 30);
  CHECK(book.Find(4) && !book.Find(4)->active);
  book.Forget(3);
  CHECK(!book.Find(3) && book.size() == 1);
  book.Add(5, 0, true);
  book.Prune([](int, const auto& offer) { return offer.handle != 0; });
  CHECK(book.size() == 1 && book.Find(4));
  for (int id = 0; id < 1000; ++id) {
    book.Add(100 + id, id + 1, id % 2 == 0);
    book.Forget(100 + id);
  }
  CHECK(book.size() == 1);
}

TEST(suppressed_shortcuts_are_consumed_without_a_command) {
  CHECK(policy::ShortcutActionFor(true) == policy::ShortcutAction::kConsume);
  CHECK(policy::ShortcutActionFor(false) == policy::ShortcutAction::kDispatch);
  CHECK(policy::ShortcutAccepted(84, 0, false, true));
  CHECK(policy::ShortcutAccepted(84, 4, true, false));
  CHECK(!policy::ShortcutAccepted(84, 0, false, false));
  CHECK(!policy::ShortcutAccepted(0, 0, true, false));
  CHECK(!policy::ShortcutAccepted(300, 0, true, true));
  CHECK(!policy::ShortcutAccepted(84, -1, true, true));
}

TEST(adopt_ids_are_tab_and_a_positive_int) {
  CHECK(policy::ParseAdoptId("tab:1") == 1);
  CHECK(policy::ParseAdoptId("tab:2147483647") == 2147483647);
  for (const char* bad : {"", "tab:", "tab:0", "tab:-1", "tab:2147483648", "tab:12a", "tab: 1", "ardiacore:1",
                          "TAB:1", "tab:99999999999", "tab:1\n"}) {
    CHECK(!policy::ParseAdoptId(bad));
  }
}

TEST(unclaimed_tabs_are_offered_once_the_shell_listens) {
  using policy::UnclaimedStep;
  CHECK(policy::NextUnclaimedStep(true, true, true, false, 0) == UnclaimedStep::kDrop);
  CHECK(policy::NextUnclaimedStep(false, false, true, false, 0) == UnclaimedStep::kWait);
  CHECK(policy::NextUnclaimedStep(false, false, true, false, policy::kUnclaimedTries) == UnclaimedStep::kDrop);
  CHECK(policy::NextUnclaimedStep(true, false, false, false, 0) == UnclaimedStep::kPark);
  CHECK(policy::NextUnclaimedStep(true, false, true, true, 0) == UnclaimedStep::kWait);
  CHECK(policy::NextUnclaimedStep(true, false, true, true, policy::kUnclaimedTries) == UnclaimedStep::kReport);
  CHECK(policy::NextUnclaimedStep(true, false, true, false, 0) == UnclaimedStep::kReport);
}

TEST(only_an_offered_unbound_tab_of_the_same_profile_is_adopted) {
  using policy::AdoptRefusal;
  CHECK(policy::CheckAdoption(true, true, true, true, false) == AdoptRefusal::kNone);
  CHECK(policy::CheckAdoption(false, true, true, true, false) == AdoptRefusal::kMalformed);
  CHECK(policy::CheckAdoption(true, false, true, true, false) == AdoptRefusal::kNotOffered);
  CHECK(policy::CheckAdoption(true, true, false, true, false) == AdoptRefusal::kOtherProfile);
  CHECK(policy::CheckAdoption(true, true, true, false, false) == AdoptRefusal::kGone);
  CHECK(policy::CheckAdoption(true, true, true, true, true) == AdoptRefusal::kAlreadyClaimed);
}

TEST(quit_waits_for_the_shell_that_painted_in_this_renderer) {
  CHECK(policy::ShellTakesQuit(true, 3, 3));
  CHECK(!policy::ShellTakesQuit(true, 0, 0));
  CHECK(!policy::ShellTakesQuit(true, 2, 3));
  CHECK(!policy::ShellTakesQuit(false, 3, 3));
}

TEST(shortcuts_take_only_chromium_key_modifiers) {
  CHECK(policy::kCommandDown == 16 && policy::kControlDown == 4 && policy::kAltDown == 8 && policy::kShiftDown == 2);
  CHECK(policy::ShortcutAccepted(84, policy::kCommandDown, true, false));
  CHECK(policy::ShortcutAccepted(9, policy::kControlDown | policy::kShiftDown, true, false));
  CHECK(policy::ShortcutAccepted(83, policy::kCommandDown | policy::kAltDown | policy::kControlDown | policy::kShiftDown, true, false));
  CHECK(!policy::ShortcutAccepted(84, 1 << 5, true, false));
  CHECK(!policy::ShortcutAccepted(84, policy::kCommandDown | 1, true, false));
  CHECK(!policy::ShortcutAccepted(84, -1, true, false));
  CHECK(!policy::ShortcutAccepted(0, policy::kCommandDown, true, false));
  CHECK(!policy::ShortcutAccepted(256, policy::kCommandDown, true, false));
  CHECK(!policy::ShortcutAccepted(84, policy::kCommandDown, false, false));
  CHECK(policy::ShortcutAccepted(84, policy::kCommandDown, false, true));
}

TEST(shortcuts_run_before_the_page_unless_a_text_field_may_take_them) {
  CHECK(policy::ShortcutTimingFor(false) == policy::ShortcutTiming::kBeforePage);
  CHECK(policy::ShortcutTimingFor(true) == policy::ShortcutTiming::kAfterPage);
}

TEST(window_requests_keep_utility_ids_to_their_kind) {
  using policy::WindowRefusal;
  CHECK(policy::CheckWindowRequest({"settings", "settings", "", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"import", "import", "", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"w-1f2e", "", "", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"w-1f2e", "small", "work", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"w-1f2e", "browser", "default", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"other", "settings", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({"settings", "browser", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({"import", "", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({"", "", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({std::string(257, 'a'), "", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({std::string(256, 'a'), "", "", false, false}) == WindowRefusal::kNone);
  for (const char* hostile : {"../main", "a b", "w\n", "w/1", "<script>", "w%"}) {
    CHECK(policy::CheckWindowRequest({hostile, "", "", false, false}) == WindowRefusal::kInvalid);
  }
}

TEST(private_windows_and_bad_profiles_are_refused_before_a_window_opens) {
  using policy::WindowRefusal;
  CHECK(policy::CheckWindowRequest({"p-1", "", "", true, false}) == WindowRefusal::kPrivateUnavailable);
  CHECK(policy::CheckWindowRequest({"p-1", "", "", false, true}) == WindowRefusal::kPrivateUnavailable);
  CHECK(policy::CheckWindowRequest({"w-1", "", "../Default", false, false}) == WindowRefusal::kProfile);
  CHECK(policy::CheckWindowRequest({"w-1", "", "1work", false, false}) == WindowRefusal::kProfile);
  CHECK(policy::CheckWindowRequest({"w-1", "", "incognito:w@default", false, false}) == WindowRefusal::kProfile);
  CHECK(policy::ValidProfileId("work_2-b"));
  CHECK(!policy::ValidProfileId(""));
  CHECK(!policy::ValidProfileId(std::string(129, 'a')));
}

TEST(windows_open_as_their_kind_with_the_page_profile_they_name) {
  CHECK(policy::WindowKindFor("settings") == "settings");
  CHECK(policy::WindowKindFor("import") == "import");
  CHECK(policy::WindowKindFor("small") == "small");
  CHECK(policy::WindowKindFor("") == "browser");
  CHECK(policy::WindowKindFor("popup") == "browser");
  CHECK(policy::PageProfileFor("browser", "work") == "work");
  CHECK(policy::PageProfileFor("browser", "default").empty());
  CHECK(policy::PageProfileFor("settings", "work").empty());
  CHECK(policy::PageProfileFor("", "").empty());
}

TEST(recording_a_shortcut_lets_every_key_reach_the_recorder) {
  CHECK(policy::AcceleratorsLive(true, true, false));
  CHECK(!policy::AcceleratorsLive(true, true, true));
  CHECK(!policy::AcceleratorsLive(false, true, false));
  CHECK(!policy::AcceleratorsLive(true, false, false));
}

TEST(recording_sends_this_windows_key_equivalents_to_the_shell) {
  using policy::RecordingRoute;
  CHECK(policy::RecordingRouteFor(true, true, true) == RecordingRoute::kToShell);
  CHECK(policy::RecordingRouteFor(false, true, true) == RecordingRoute::kNormal);
  CHECK(policy::RecordingRouteFor(true, false, true) == RecordingRoute::kNormal);
  CHECK(policy::RecordingRouteFor(true, true, false) == RecordingRoute::kNormal);
}

TEST(a_session_on_disk_the_merge_cannot_take_is_set_aside_not_wedged) {
  using policy::SessionFile;
  CHECK(policy::SessionFileFor(false, 0, false, false) == SessionFile::kAbsent);
  CHECK(policy::SessionFileFor(true, 1024, true, true) == SessionFile::kUse);
  CHECK(policy::SessionFileFor(true, policy::kMergeableSessionBytes, true, true) == SessionFile::kUse);
  CHECK(policy::SessionFileFor(true, policy::kMergeableSessionBytes + 1, false, false) == SessionFile::kSetAside);
  CHECK(policy::SessionFileFor(true, 64u * 1024u * 1024u + 1, false, false) == SessionFile::kSetAside);
  CHECK(policy::SessionFileFor(true, 4096, true, false) == SessionFile::kSetAside);
  CHECK(policy::SessionFileFor(true, 4096, false, false) == SessionFile::kSetAside);
}

TEST(set_aside_sessions_never_overwrite_an_earlier_backup) {
  CHECK(policy::SetAsideSessionName(1795642159057u, 0) == "session-backup-oversized-1795642159057-0.json");
  CHECK(policy::SetAsideSessionName(1795642159057u, 1) != policy::SetAsideSessionName(1795642159057u, 0));
  CHECK(policy::SetAsideSessionName(1795642159058u, 0) != policy::SetAsideSessionName(1795642159057u, 0));
  for (int attempt = 0; attempt < policy::kSetAsideAttempts; ++attempt) {
    const std::string name = policy::SetAsideSessionName(1u, attempt);
    CHECK(policy::ValidDocumentName(name) && name.starts_with("session-backup"));
    for (int other = 0; other < attempt; ++other) {
      CHECK(name != policy::SetAsideSessionName(1u, other));
    }
  }
}

TEST(a_backup_that_cannot_be_moved_blocks_saves_instead_of_looking_absent) {
  using policy::SessionFile;
  using policy::SessionLoad;
  CHECK(policy::SessionLoadFor(SessionFile::kSetAside, false) == SessionLoad::kBlocked);
  CHECK(!policy::SessionWritable(SessionLoad::kBlocked));
  CHECK(policy::SessionLoadFor(SessionFile::kSetAside, true) == SessionLoad::kQuarantined);
  CHECK(policy::SessionWritable(SessionLoad::kQuarantined));
  CHECK(policy::SessionLoadFor(SessionFile::kAbsent, false) == SessionLoad::kAbsent);
  CHECK(policy::SessionLoadFor(SessionFile::kUse, false) == SessionLoad::kUse);
  CHECK(policy::SessionWritable(SessionLoad::kAbsent) && policy::SessionWritable(SessionLoad::kUse));
}

TEST(a_departure_is_saved_only_once_the_window_really_closes) {
  using policy::DepartureStep;
  CHECK(policy::DepartureStepFor(false, true, true) == DepartureStep::kNone);
  CHECK(policy::DepartureStepFor(true, true, true) == DepartureStep::kCommit);
  CHECK(policy::DepartureStepFor(true, false, true) == DepartureStep::kDiscard);
  CHECK(policy::DepartureStepFor(true, true, false) == DepartureStep::kDiscard);
  CHECK(policy::DepartureStepFor(true, false, false) == DepartureStep::kDiscard);
}

TEST(live_documents_are_reserved_in_any_case) {
  for (const char* name : {"live.json", "LIVE.JSON", "Live.Json", "live.canonical.json", "LIVE.Canonical.JSON"}) {
    CHECK(policy::ReservedLiveDocument(name));
  }
  for (const char* name : {"", "live", "live.json.bak", "notes.json", "xlive.json", "live.canonical.json "}) {
    CHECK(!policy::ReservedLiveDocument(name));
  }
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
