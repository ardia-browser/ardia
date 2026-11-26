#include "ardia/mac/ac_mac_window_policy.h"

#include <limits>
#include <set>
#include <string>

#include "check.h"

namespace policy = ardia_mac::window_policy;

TEST(window_ids_match_the_shell_pattern) {
  CHECK(policy::ValidWindowId("main") && policy::ValidWindowId("w_1-a"));
  CHECK(!policy::ValidWindowId("") && !policy::ValidWindowId("-main") && !policy::ValidWindowId("a b"));
  CHECK(!policy::ValidWindowId(std::string(129, 'a')) && policy::ValidWindowId(std::string(128, 'a')));
}

TEST(a_close_runs_request_drain_acknowledge_and_closing) {
  policy::CloseBook book;
  const auto identity = book.Request(3);
  CHECK(identity && identity->renderer == "3" && identity->close == "1");
  CHECK(book.Deciding());
  CHECK(book.Request(3) == identity);
  CHECK(!book.Request(4));
  CHECK(!book.BeginDrain(*identity, 4));
  CHECK(!book.BeginDrain(policy::CloseIdentity{"3", "2"}, 3));
  CHECK(!book.Acknowledge(*identity, 3, 0));
  CHECK(book.BeginDrain(*identity, 3) && !book.Deciding());
  CHECK(!book.Acknowledge(*identity, 3, std::nullopt));
  CHECK(!book.Acknowledge(*identity, 3, -1));
  CHECK(!book.Acknowledge(*identity, 3, 1.5));
  CHECK(!book.Acknowledge(*identity, 3, std::numeric_limits<double>::infinity()));
  CHECK(book.Acknowledge(*identity, 3, 12));
  CHECK(!book.BeginClosing(policy::CloseIdentity{"3", "9"}));
  CHECK(book.BeginClosing(*identity));
  book.Retire();
  CHECK(book.phase() == policy::ClosePhase::kClosing);
}

TEST(a_cancelled_close_issues_a_fresh_identity) {
  policy::CloseBook book;
  const auto first = book.Request(1);
  CHECK(book.Cancel(*first) && book.Cancel(*first));
  CHECK(!book.Open() && !book.Matches(*first, 1));
  const auto second = book.Request(1);
  CHECK(second && second->close == "2");
  CHECK(!book.Cancel(*first));
  policy::CloseBook idle;
  CHECK(!idle.Request(0));
  CHECK(!idle.Cancel(policy::CloseIdentity{}));
}

TEST(acknowledgments_carry_a_departure_only_with_base_and_session) {
  CHECK(policy::ValidDeparture(false, false, 0, false, false));
  CHECK(policy::ValidDeparture(true, true, 2, true, true));
  CHECK(!policy::ValidDeparture(true, false, 0, false, false));
  CHECK(!policy::ValidDeparture(true, true, 3, true, true));
  CHECK(!policy::ValidDeparture(true, true, 2, true, false));
  CHECK(policy::ValidAcknowledgeShape(4, false) && policy::ValidAcknowledgeShape(5, true));
  CHECK(!policy::ValidAcknowledgeShape(5, false) && !policy::ValidAcknowledgeShape(4, true));
}

TEST(quit_waits_for_every_window_and_a_rejection_aborts_it) {
  policy::QuitBarrier barrier;
  const auto first = barrier.Begin({"main", "second"});
  CHECK(first == 1);
  CHECK(barrier.Begin({"main"}) == 0);
  CHECK(barrier.Waits("main") && !barrier.Waits("other"));
  CHECK(barrier.Acknowledged("main", first) == policy::QuitStep::kWait);
  CHECK(barrier.Rejected("other", first) == policy::QuitStep::kWait);
  CHECK(barrier.Acknowledged("second", first) == policy::QuitStep::kExit && !barrier.running());
  const auto second = barrier.Begin({"main"});
  CHECK(second == 2);
  CHECK(barrier.Rejected("main", second) == policy::QuitStep::kAbort && !barrier.running());
  CHECK(barrier.Expired(second) == policy::QuitStep::kStale);
  const auto third = barrier.Begin({"main"});
  CHECK(barrier.Expired(third) == policy::QuitStep::kExit);
}

TEST(a_late_acknowledgment_after_the_quit_deadline_never_exits_again) {
  policy::QuitBarrier barrier;
  const auto expired = barrier.Begin({"main", "second"});
  CHECK(barrier.Acknowledged("second", expired) == policy::QuitStep::kWait);
  CHECK(barrier.Expired(expired) == policy::QuitStep::kExit);
  CHECK(barrier.Acknowledged("main", expired) == policy::QuitStep::kStale);
  CHECK(barrier.Rejected("main", expired) == policy::QuitStep::kStale);
  CHECK(barrier.Expired(expired) == policy::QuitStep::kStale);
  const auto next = barrier.Begin({"main"});
  CHECK(next != expired && next != 0);
  CHECK(barrier.Acknowledged("main", expired) == policy::QuitStep::kStale && barrier.running());
  CHECK(barrier.Expired(expired) == policy::QuitStep::kStale && barrier.running());
  CHECK(barrier.Acknowledged("main", 0) == policy::QuitStep::kStale);
  CHECK(barrier.Acknowledged("main", next) == policy::QuitStep::kExit);
  CHECK(barrier.Acknowledged("main", next) == policy::QuitStep::kStale);
}

TEST(a_retried_quit_reissues_the_close_so_the_expired_acknowledgment_stays_stale) {
  policy::QuitBarrier barrier;
  policy::CloseBook book;
  std::uint64_t held = 0;
  const auto first_quit = barrier.Begin({"main"});
  CHECK(policy::PlanCloseRequest(book.Open(), book.phase(), held, first_quit) == policy::CloseRequestPlan::kRequest);
  const auto expired = book.Request(4);
  held = first_quit;
  CHECK(expired && book.BeginDrain(*expired, 4));
  CHECK(barrier.Expired(first_quit) == policy::QuitStep::kExit);
  const auto retry = barrier.Begin({"main"});
  CHECK(policy::PlanCloseRequest(book.Open(), book.phase(), held, retry) == policy::CloseRequestPlan::kReissue);
  CHECK(book.Cancel(*expired));
  held = 0;
  const auto fresh = book.Request(4);
  held = retry;
  CHECK(fresh && fresh->close != expired->close);
  CHECK(!book.Acknowledge(*expired, 4, 3));
  CHECK(barrier.Acknowledged("main", first_quit) == policy::QuitStep::kStale && barrier.running());
  CHECK(book.BeginDrain(*fresh, 4) && book.Acknowledge(*fresh, 4, 3));
  CHECK(barrier.Acknowledged("main", held) == policy::QuitStep::kExit);
}

TEST(close_requests_reuse_only_their_own_quit) {
  using policy::ClosePhase;
  CHECK(policy::PlanCloseRequest(false, ClosePhase::kIdle, 0, 5) == policy::CloseRequestPlan::kRequest);
  CHECK(policy::PlanCloseRequest(true, ClosePhase::kDraining, 5, 5) == policy::CloseRequestPlan::kRequest);
  CHECK(policy::PlanCloseRequest(true, ClosePhase::kDraining, 2, 0) == policy::CloseRequestPlan::kRequest);
  CHECK(policy::PlanCloseRequest(true, ClosePhase::kDraining, 2, 5) == policy::CloseRequestPlan::kReissue);
  CHECK(policy::PlanCloseRequest(true, ClosePhase::kRequested, 0, 5) == policy::CloseRequestPlan::kReissue);
  CHECK(policy::PlanCloseRequest(true, ClosePhase::kAcknowledged, 0, 5) == policy::CloseRequestPlan::kAlreadyLeaving);
  CHECK(policy::PlanCloseRequest(true, ClosePhase::kClosing, 0, 5) == policy::CloseRequestPlan::kAlreadyLeaving);
  CHECK(policy::PlanCloseRequest(true, ClosePhase::kAcknowledged, 2, 5) == policy::CloseRequestPlan::kReissue);
}

TEST(downloads_are_cancelled_only_when_no_page_can_still_keep_the_app_open) {
  const policy::DownloadAuthorization shown{true, {"a", "b"}};
  CHECK(policy::DownloadsToCancel(true, false, shown, {"a", "b"}) == (std::set<std::string>{"a", "b"}));
  CHECK(policy::DownloadsToCancel(true, true, shown, {"a", "b"}).empty());
  CHECK(policy::DownloadsToCancel(false, false, shown, {"a", "b"}).empty());
  CHECK(policy::DownloadsToCancel(true, false, policy::DownloadAuthorization{}, {"a"}).empty());
}

TEST(a_download_started_during_the_drain_is_left_for_chromium_to_ask_about) {
  const policy::DownloadAuthorization none_shown{true, {}};
  CHECK(policy::DownloadsToCancel(true, false, none_shown, {"started-mid-drain"}).empty());
  const policy::DownloadAuthorization one_shown{true, {"confirmed"}};
  const auto cancel = policy::DownloadsToCancel(true, false, one_shown, {"confirmed", "started-mid-drain"});
  CHECK(cancel == (std::set<std::string>{"confirmed"}));
  CHECK(!cancel.contains("started-mid-drain"));
  CHECK(policy::DownloadsToCancel(true, false, one_shown, {"finished-and-replaced"}).empty());
}

TEST(only_downloads_chromium_counts_at_shutdown_are_shown_or_cancelled) {
  CHECK(policy::BlocksShutdown(false, true, false, false));
  CHECK(!policy::BlocksShutdown(true, true, false, false));
  CHECK(!policy::BlocksShutdown(false, false, false, false));
  CHECK(!policy::BlocksShutdown(false, true, true, false));
  CHECK(!policy::BlocksShutdown(false, true, false, true));
}

TEST(declining_the_download_prompt_leaves_nothing_for_a_later_quit_to_cancel) {
  const policy::DownloadAsker main{"main", "3"};
  policy::DownloadPermission permission;
  permission.Shown(main, {"a"});
  permission.Opened(main, "dialog:downloads-warning:1");
  permission.Declined(policy::DownloadAsker{"main", "2"}, "dialog:downloads-warning:1");
  CHECK(permission.pending());
  permission.Declined(main, "dialog:downloads-warning:1");
  CHECK(!permission.pending());
  const auto later = permission.Take(main);
  CHECK(!later.present);
  CHECK(policy::DownloadsToCancel(true, false, later, {"a"}).empty());
  permission.Shown(main, {"a"});
  const auto other = permission.Take(policy::DownloadAsker{"second", "3"});
  CHECK(!other.present && !permission.pending());
  CHECK(!permission.Take(main).present);
  permission.Shown(main, {"a"});
  const auto confirmed = permission.Take(main);
  CHECK(confirmed.present && confirmed.ids == (std::set<std::string>{"a"}));
  CHECK(!permission.Take(main).present);
}

TEST(declining_an_unrelated_confirm_keeps_the_download_prompts_snapshot) {
  const policy::DownloadAsker main{"main", "3"};
  policy::DownloadPermission permission;
  permission.Shown(main, {"a"});
  permission.Declined(main, "dialog:already-open-close-tab:1");
  CHECK(permission.pending());
  permission.Opened(main, "dialog:downloads-warning:2");
  permission.Opened(main, "dialog:another-confirm:3");
  permission.Declined(main, "dialog:another-confirm:3");
  permission.Declined(main, "dialog:already-open-close-tab:1");
  CHECK(permission.pending());
  permission.Opened(policy::DownloadAsker{"main", "4"}, "dialog:other-renderer:4");
  const auto confirmed = permission.Take(main);
  CHECK(confirmed.present && confirmed.ids == (std::set<std::string>{"a"}));
  permission.Shown(main, {"b"});
  permission.Declined(main, "dialog:downloads-warning:2");
  CHECK(permission.pending());
  permission.Opened(main, "dialog:downloads-warning:5");
  permission.Declined(main, "dialog:downloads-warning:5");
  CHECK(!permission.pending() && !permission.Take(main).present);
}

TEST(re_registering_the_edge_while_outside_the_content_reports_the_live_pointer_and_polls) {
  policy::EdgeWatch watch;
  watch.Watch(0, policy::Side::kLeft, false);
  CHECK(watch.Moved(-10, 100, 1200, 800, false)->over);
  watch.Stop();
  watch.Place(-10, 100, 1200, 800, false);
  const auto again = watch.Watch(40, policy::Side::kLeft, false);
  CHECK(again && again->over && watch.over());
  CHECK(policy::PollsOutside(watch.over(), -10, 100, 1200, 800));
  watch.Stop();
  watch.Forget();
  const auto covered = watch.Watch(40, policy::Side::kLeft, false);
  CHECK(covered && !covered->over && !watch.over());
  CHECK(!policy::PollsOutside(watch.over(), -10, 100, 1200, 800));
  watch.Stop();
  watch.Place(600, 100, 1200, 800, false);
  const auto inside = watch.Watch(40, policy::Side::kLeft, false);
  CHECK(inside && !inside->over);
  watch.Place(std::numeric_limits<double>::quiet_NaN(), 100, 1200, 800, false);
  CHECK(!watch.Watch(40, policy::Side::kLeft, false)->over);
}

TEST(the_edge_polls_only_while_over_outside_the_content) {
  CHECK(policy::PollsOutside(true, -10, 100, 1200, 800));
  CHECK(policy::PollsOutside(true, 1205, 100, 1200, 800));
  CHECK(!policy::PollsOutside(true, 3, 100, 1200, 800));
  CHECK(!policy::PollsOutside(false, -10, 100, 1200, 800));
  CHECK(!policy::PollsOutside(true, std::numeric_limits<double>::quiet_NaN(), 100, 1200, 800));
  policy::EdgeWatch watch;
  watch.Watch(0, policy::Side::kLeft, false);
  CHECK(watch.Moved(-10, 100, 1200, 800, false)->over && watch.over());
  CHECK(policy::PollsOutside(watch.over(), -10, 100, 1200, 800));
  CHECK(!watch.Covered()->over && !watch.over());
  CHECK(!policy::PollsOutside(watch.over(), -10, 100, 1200, 800));
  CHECK(watch.Moved(-10, 100, 1200, 800, false)->over);
  CHECK(!watch.Moved(-40, 100, 1200, 800, false)->over);
  CHECK(!policy::PollsOutside(watch.over(), -40, 100, 1200, 800));
  watch.Stop();
  CHECK(!watch.over());
}

TEST(window_state_reads_zoom_and_full_screen) {
  CHECK(policy::StateOf(true, false, false) == (policy::WindowState{true, false, false}));
  CHECK(policy::StateOf(true, true, false) == (policy::WindowState{false, false, true}));
  CHECK(policy::StateOf(true, false, true) == (policy::WindowState{false, false, false}));
  CHECK(!policy::StateOf(false, false, false).tiled);
}

TEST(frames_are_finite_bounded_and_at_least_the_minimum_size) {
  CHECK(!policy::FrameFrom(0, 0, 100, std::nullopt));
  CHECK(!policy::FrameFrom(0, 0, 0, 100));
  CHECK(!policy::FrameFrom(0, std::numeric_limits<double>::quiet_NaN(), 900, 600));
  CHECK(!policy::FrameFrom(2e5, 0, 900, 600));
  const auto small = policy::FrameFrom(10.4, 20.6, 100, 100);
  CHECK(small && *small == (policy::Frame{10, 21, policy::kMinWidth, policy::kMinHeight}));
  const auto frame = *policy::FrameFrom(100, 100, 1200, 800);
  CHECK(policy::OnAnyScreen(frame, {{0, 0, 1440, 900}}));
  CHECK(!policy::OnAnyScreen(policy::Frame{5000, 5000, 800, 600}, {{0, 0, 1440, 900}}));
  CHECK(!policy::OnAnyScreen(frame, {}));
}

TEST(titles_and_appearances_are_bounded) {
  CHECK(policy::WindowTitle("Ardia") == std::string("Ardia"));
  CHECK(policy::WindowTitle("a\nb") == std::string("a b"));
  CHECK(!policy::WindowTitle(std::string(policy::kTitleLimit + 1, 'a')));
  CHECK(policy::AppearanceNamed("dark") == policy::Appearance::kDark);
  CHECK(policy::AppearanceNamed("auto") == policy::Appearance::kAuto);
  CHECK(!policy::AppearanceNamed("Dark") && !policy::AppearanceNamed(""));
}

TEST(the_sidebar_edge_reports_only_changes) {
  policy::EdgeWatch watch;
  CHECK(!watch.Moved(600, 100, 1200, 800, false));
  const auto started = watch.Watch(0, policy::Side::kLeft, false);
  CHECK(started && !started->over);
  const auto over = watch.Moved(2, 100, 1200, 800, false);
  CHECK(over && over->over && over->x == 2 && over->y == 100);
  CHECK(!watch.Moved(4, 120, 1200, 800, false));
  const auto pressed = watch.Moved(4, 120, 1200, 800, true);
  CHECK(pressed && !pressed->over);
  CHECK(watch.Moved(-20, 120, 1200, 800, false)->over);
  CHECK(!watch.Moved(-30, 120, 1200, 800, false)->over);
  watch.Watch(300, policy::Side::kLeft, true);
  CHECK(watch.Moved(250, 120, 1200, 800, true)->over);
  watch.Watch(0, policy::Side::kRight, false);
  CHECK(watch.Moved(1197, 120, 1200, 800, false)->over);
  CHECK(watch.Moved(1197, 130, 1200, 800, false) == std::nullopt);
  const auto covered = watch.Covered();
  CHECK(covered && !covered->over && covered->x == -1);
  CHECK(!watch.Covered());
  CHECK(watch.Moved(1197, 130, 1200, 800, false)->over);
  const auto resigned = watch.Resigned();
  CHECK(resigned && !resigned->over && resigned->x == -1);
  CHECK(!watch.Moved(std::numeric_limits<double>::quiet_NaN(), 0, 1200, 800, false));
  watch.Stop();
  CHECK(!watch.Moved(1, 1, 1200, 800, false));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
