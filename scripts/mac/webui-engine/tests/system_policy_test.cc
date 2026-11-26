#include "ardia/mac/ac_mac_system_policy.h"

#include <functional>
#include <limits>
#include <string>
#include <vector>

#include "check.h"

namespace policy = ardia_mac::system_policy;

TEST(download_ids_are_lowercase_or_uppercase_guids_only) {
  CHECK(policy::ValidDownloadId("0b6a3f2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b"));
  CHECK(policy::ValidDownloadId("0B6A3F2E-1C4D-4E5F-8A9B-0C1D2E3F4A5B"));
  CHECK(!policy::ValidDownloadId(""));
  CHECK(!policy::ValidDownloadId("0b6a3f2e1c4d4e5f8a9b0c1d2e3f4a5b"));
  CHECK(!policy::ValidDownloadId("0b6a3f2e-1c4d-4e5f-8a9b-0c1d2e3f4a5g"));
  CHECK(!policy::ValidDownloadId("0b6a3f2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b "));
  CHECK(!policy::ValidDownloadId(std::string("0b6a3f2e-1c4d-4e5f-8a9b-0c1d2e3f4a5\0", 36)));
}

TEST(local_paths_are_absolute_and_normalized) {
  CHECK(policy::ValidLocalPath("/Users/me/Downloads/file.zip"));
  CHECK(policy::ValidLocalPath("/"));
  CHECK(!policy::ValidLocalPath(""));
  CHECK(!policy::ValidLocalPath("relative/file"));
  CHECK(!policy::ValidLocalPath("/Users/me/../etc/passwd"));
  CHECK(!policy::ValidLocalPath("/Users/./me"));
  CHECK(!policy::ValidLocalPath("/Users//me"));
  CHECK(!policy::ValidLocalPath("/Users/me/"));
  CHECK(!policy::ValidLocalPath(std::string("/Users/me\0/x", 12)));
  CHECK(!policy::ValidLocalPath("/" + std::string(policy::kMaxPathBytes, 'a')));
}

TEST(file_actions_reach_only_listed_downloads) {
  const std::vector<std::string> known = {"/Users/me/Downloads/a.zip", "/Users/me/Downloads/b.pdf"};
  CHECK(policy::PathListed("/Users/me/Downloads/a.zip", known));
  CHECK(!policy::PathListed("/Users/me/Downloads/c.zip", known));
  CHECK(!policy::PathListed("/Users/me/Downloads/../Downloads/a.zip", known));
  CHECK(!policy::PathListed("/Users/me/Downloads/a.zip", {}));
  CHECK(policy::IconPathAllowed("report.pdf", {}));
  CHECK(!policy::IconPathAllowed("/etc/passwd", known));
  CHECK(policy::IconPathAllowed("/Users/me/Downloads/b.pdf", known));
  CHECK(!policy::IconPathAllowed("", known));
  CHECK(!policy::IconPathAllowed("bad\nname.pdf", known));
}

TEST(icon_sizes_and_process_ids_are_bounded) {
  CHECK(policy::IconPoints(std::numeric_limits<double>::quiet_NaN()) == policy::kDefaultIconPoints);
  CHECK(policy::IconPoints(1e20) == policy::kMaxIconPoints);
  CHECK(policy::IconPoints(-5) == policy::kMinIconPoints);
  CHECK(policy::IconPoints(32) == 32);
  CHECK(policy::IconPixels(32) == 64);
  CHECK(policy::IconPixels(1e300) == 1024);
  CHECK(policy::ProcessId(42) == 42);
  CHECK(!policy::ProcessId(0));
  CHECK(!policy::ProcessId(-1));
  CHECK(!policy::ProcessId(1.5));
  CHECK(!policy::ProcessId(1e20));
  CHECK(!policy::ProcessId(std::numeric_limits<double>::infinity()));
}

TEST(external_urls_refuse_local_and_script_schemes) {
  for (const char* scheme : {"https", "http", "mailto", "zoommtg", "slack", "x-callback-url"}) {
    CHECK(policy::ExternalSchemeAllowed(scheme));
  }
  for (const char* scheme : {"", "file", "FILE", "javascript", "JavaScript", "data", "chrome", "chrome-extension",
                             "about", "blob", "view-source", "devtools", "filesystem", "x-apple.systempreferences",
                             "1http", "ht tp", "ht\ntp"}) {
    CHECK(!policy::ExternalSchemeAllowed(scheme));
  }
  CHECK(!policy::ExternalSchemeAllowed(std::string(65, 'a')));
  CHECK(policy::ExternalTextAllowed("mailto:me@example.com"));
  CHECK(!policy::ExternalTextAllowed("https://example.com/a b"));
  CHECK(!policy::ExternalTextAllowed("https://example.com/\"x"));
  CHECK(!policy::ExternalTextAllowed("https://example.com\\x"));
  CHECK(!policy::ExternalTextAllowed(std::string(policy::kExternalUrlLimit + 1, 'a')));
}

TEST(links_from_other_apps_reach_the_shell_only_as_web_or_file_urls) {
  CHECK(policy::SchemeGoesToShell("https://example.com"));
  CHECK(policy::SchemeGoesToShell("HTTP://example.com"));
  CHECK(policy::SchemeGoesToShell("file:///Users/me/a.html"));
  CHECK(!policy::SchemeGoesToShell("https:example.com"));
  CHECK(!policy::SchemeGoesToShell("javascript://alert(1)"));
  CHECK(!policy::SchemeGoesToShell("ardia://open"));
  CHECK(!policy::SchemeGoesToShell("https://exa mple.com"));
  CHECK(!policy::SchemeGoesToShell(""));
  CHECK(!policy::SchemeGoesToShell("https://" + std::string(policy::kOpenUrlBytes, 'a')));
}

TEST(open_url_inbox_is_bounded_and_drains_in_batches) {
  policy::OpenUrlInbox inbox;
  std::vector<std::string> urls(policy::kPendingOpenUrls + 10, "https://example.com");
  urls.push_back("javascript://x");
  CHECK(inbox.Add(urls) == policy::kPendingOpenUrls);
  CHECK(inbox.pending() == policy::kPendingOpenUrls);
  CHECK(inbox.Add({"https://late.example"}) == 0);
  const auto first = inbox.Take();
  CHECK(first.size() == policy::kOpenUrlBatch);
  size_t drained = first.size();
  while (!inbox.empty()) drained += inbox.Take().size();
  CHECK(drained == policy::kPendingOpenUrls);
  CHECK(inbox.Take().empty());
}

TEST(picker_prompts_and_admission) {
  CHECK(policy::PickerPromptUsable("Choose"));
  CHECK(!policy::PickerPromptUsable(""));
  CHECK(!policy::PickerPromptUsable("bad\tprompt"));
  CHECK(!policy::PickerPromptUsable(std::string(policy::kPickerPromptLimit + 1, 'a')));
  CHECK(policy::AdmitPicker(false) == policy::PickerAdmission::kOpen);
  CHECK(policy::AdmitPicker(true) == policy::PickerAdmission::kAlreadyOpen);
}

TEST(login_item_status_names_match_the_native_module) {
  CHECK(policy::LoginStatusName(policy::LoginStatusFor(0)) == "notRegistered");
  CHECK(policy::LoginStatusName(policy::LoginStatusFor(1)) == "enabled");
  CHECK(policy::LoginStatusName(policy::LoginStatusFor(2)) == "requiresApproval");
  CHECK(policy::LoginStatusName(policy::LoginStatusFor(3)) == "notFound");
  CHECK(policy::LoginStatusName(policy::LoginStatusFor(-7)) == "notRegistered");
}

TEST(clearing_keeps_running_kept_and_newer_downloads) {
  CHECK(policy::ClearsDownload(false, false, 100, 200));
  CHECK(!policy::ClearsDownload(true, false, 100, 200));
  CHECK(!policy::ClearsDownload(false, true, 100, 200));
  CHECK(!policy::ClearsDownload(false, false, 300, 200));
  CHECK(!policy::ClearsDownload(false, false, std::numeric_limits<double>::quiet_NaN(), 200));
  CHECK(policy::ValidClearCutoff(0));
  CHECK(!policy::ValidClearCutoff(-1));
  CHECK(!policy::ValidClearCutoff(std::numeric_limits<double>::infinity()));
  CHECK(policy::Removable(false));
  CHECK(!policy::Removable(true));
}

TEST(download_progress_is_throttled_but_state_changes_are_not) {
  policy::ProgressMark mark;
  CHECK(!policy::EmitsChange(mark, false, false, false, 0));
  CHECK(policy::EmitsChange(mark, true, false, false, 0));
  CHECK(!policy::EmitsChange(mark, true, false, false, 50));
  CHECK(policy::EmitsChange(mark, true, true, false, 60));
  CHECK(policy::EmitsChange(mark, true, true, false, 200));
  CHECK(policy::EmitsChange(mark, false, false, false, 210));
}

TEST(a_running_download_seen_first_in_the_snapshot_still_reports_its_end) {
  policy::ProgressMark unseeded;
  CHECK(!policy::EmitsChange(unseeded, false, false, false, 10));
  policy::ProgressMark seeded = policy::SeededMark(true, false, false, 0);
  CHECK(policy::EmitsChange(seeded, false, false, false, 10));
  policy::ProgressMark finished = policy::SeededMark(false, false, false, 0);
  CHECK(!policy::EmitsChange(finished, false, false, false, 10));
  policy::ProgressMark throttled = policy::SeededMark(true, false, false, 0);
  CHECK(!policy::EmitsChange(throttled, true, false, false, 50));
}

namespace {

struct InitializedManagerWatch {
  struct Notifier {
    explicit Notifier(InitializedManagerWatch* watch) {
      for (auto& ready : watch->ready.Release()) ready();
      watch->initialized_in_constructor = true;
    }
  };
  int ran = 0;
  policy::ReadyQueue<std::function<void()>> ready;
  bool initialized_in_constructor = false;
  Notifier notifier{this};
};

}

TEST(a_manager_initialized_during_construction_opens_the_queue_safely) {
  InitializedManagerWatch watch;
  CHECK(watch.initialized_in_constructor);
  CHECK(watch.ready.ready());
  auto now = watch.ready.Hold(false, [&watch] { ++watch.ran; });
  CHECK(now.has_value());
  (*now)();
  CHECK(watch.ran == 1);
  CHECK(watch.ready.waiting() == 0);
}

TEST(waiters_run_once_when_the_manager_initializes_later) {
  policy::ReadyQueue<std::function<void()>> queue;
  int ran = 0;
  CHECK(!queue.Hold(false, [&ran] { ++ran; }).has_value());
  CHECK(!queue.Hold(false, [&ran] { ++ran; }).has_value());
  CHECK(queue.waiting() == 2);
  for (auto& ready : queue.Release()) ready();
  CHECK(ran == 2);
  CHECK(queue.Release().empty());
  CHECK(queue.Hold(false, [] {}).has_value());
}

TEST(a_dropped_watch_settles_every_queued_request_as_refused) {
  policy::ReadyQueue<std::function<void(bool)>> queue;
  int refused = 0;
  int served = 0;
  for (int index = 0; index < 3; ++index) {
    CHECK(!queue.Hold(false, [&](bool ready) { ready ? ++served : ++refused; }).has_value());
  }
  for (auto& waiting : queue.Drop()) waiting(false);
  CHECK(refused == 3 && served == 0);
  CHECK(queue.waiting() == 0);
  CHECK(!queue.ready());
  CHECK(queue.Drop().empty());
  CHECK(queue.Release().empty());
}

TEST(a_manager_going_down_refuses_queued_and_later_requests) {
  policy::ReadyQueue<std::function<void(bool)>> queue;
  int refused = 0;
  CHECK(!queue.Hold(false, [&](bool ready) { refused += ready ? 0 : 1; }).has_value());
  CHECK(!queue.Hold(false, [&](bool ready) { refused += ready ? 0 : 1; }).has_value());
  for (auto& waiting : queue.Close()) waiting(false);
  CHECK(refused == 2);
  CHECK(queue.closed() && !queue.ready() && queue.waiting() == 0);
  CHECK(queue.Release().empty());
}

TEST(list_and_clear_are_refused_alike_when_a_profile_cannot_serve_them) {
  using policy::DownloadRoute;
  for (const char* name : {"downloads.list", "downloads.clear"}) {
    CHECK(policy::RouteDownloadRequest(name, false, false, false) == DownloadRoute::kRefuseQueued);
    CHECK(policy::RouteDownloadRequest(name, true, false, false) == DownloadRoute::kRefuseQueued);
    CHECK(policy::RouteDownloadRequest(name, true, true, false) == DownloadRoute::kRefuseQueued);
    CHECK(policy::RouteDownloadRequest(name, true, true, true) == DownloadRoute::kServe);
  }
  CHECK(policy::RouteDownloadRequest("downloads.remove", true, true, false) == DownloadRoute::kUnavailable);
  CHECK(policy::RouteDownloadRequest("downloads.remove", true, true, true) == DownloadRoute::kServe);
}

TEST(links_are_captured_before_the_first_window_and_while_windows_live) {
  CHECK(policy::CapturesOpenUrls(true, false, false));
  CHECK(policy::CapturesOpenUrls(true, true, true));
  CHECK(!policy::CapturesOpenUrls(true, false, true));
  CHECK(!policy::CapturesOpenUrls(false, true, true));
}

TEST(companion_profiles_count_for_downloads_only_while_they_hold_tabs) {
  CHECK(policy::DownloadMember(true, 0));
  CHECK(policy::DownloadMember(true, 3));
  CHECK(!policy::DownloadMember(false, 0));
  CHECK(policy::DownloadMember(false, 1));
  CHECK(!policy::DownloadMember(false, -1));
}

TEST(queued_links_go_back_to_chrome_once_no_window_is_left) {
  CHECK(policy::HandsLinksToChrome(false, 2, false));
  CHECK(!policy::HandsLinksToChrome(true, 2, false));
  CHECK(!policy::HandsLinksToChrome(false, 0, false));
  CHECK(!policy::HandsLinksToChrome(false, 2, true));
}

TEST(every_method_is_advertised_once) {
  for (std::string_view method : policy::kSystemMethods) {
    size_t count = 0;
    for (std::string_view other : policy::kSystemMethods) count += other == method ? 1u : 0u;
    CHECK(count == 1);
  }
  CHECK(policy::kOpenUrlsEvent == "ArdiaShell.onOpenURLs");
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
