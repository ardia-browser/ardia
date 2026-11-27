#include "ardia/mac/ac_mac_link_policy.h"

#include <limits>
#include <string>

#include "check.h"

namespace lp = ardia_mac::link_policy;

namespace {

constexpr std::uintptr_t kPage = 0x1000;
constexpr std::uintptr_t kOther = 0x2000;

lp::Request RequestFor(std::string key, double now, std::uintptr_t surface = kPage) {
  lp::Request request;
  request.surface = surface;
  request.key = std::move(key);
  request.http = true;
  request.visible = true;
  request.now = now;
  return request;
}

}

TEST(every_page_option_route_is_advertised_once) {
  CHECK(lp::IsRoute("webView.setPeekModifier"));
  CHECK(lp::IsRoute("webView.setSplitLinkModifier"));
  CHECK(lp::IsRoute("webView.setPeekOtherSiteTabs"));
  CHECK(lp::IsRoute("webView.setLittleArdiaOpensNewTabLinks"));
  CHECK(lp::IsRoute("webView.setPopupsOpenAsTabs"));
  CHECK(lp::IsRoute("webView.setCommandScrollZoom"));
  CHECK(!lp::IsRoute("webView.setSelectionPopover"));
  CHECK(!lp::IsRoute(""));
  CHECK(!lp::IsRoute("webView.setpeekmodifier"));
}

TEST(link_keys_round_trip_through_their_flags) {
  for (std::string_view key : {"alt", "shift", "altShift", "altMeta"}) CHECK(lp::KeyFor(lp::KeyFlags(key)) == key);
  CHECK(lp::KeyFlags("off") == 0);
  CHECK(lp::KeyFlags("site") == 0);
  CHECK(lp::KeyFor(lp::kMeta).empty());
  CHECK(lp::KeyFor(lp::kShift | lp::kMeta).empty());
  CHECK(lp::KeyFor(lp::kControl | lp::kShift).empty());
}

TEST(options_pick_peek_and_split_like_the_other_hosts) {
  lp::PageOptions options;
  CHECK(options.ActionFor("shift") == std::optional<std::string>("peek"));
  CHECK(options.ActionFor("altShift") == std::optional<std::string>("split"));
  CHECK(options.ActionFor("altMeta") == std::optional<std::string>("split"));
  CHECK(!options.ActionFor("alt"));
  CHECK(options.SetPeek("alt"));
  CHECK(!options.SetPeek("alt"));
  CHECK(options.ActionFor("alt") == std::optional<std::string>("peek"));
  CHECK(!options.ActionFor("shift"));
  CHECK(options.SetSplit("alt"));
  CHECK(options.EffectiveSplit() == "altShift");
  CHECK(options.SetPeek("bogus"));
  CHECK(options.peek == "off");
  CHECK(options.EffectiveSplit() == "alt");
  CHECK(options.ActionFor("alt") == std::optional<std::string>("split"));
  CHECK(options.SetSplit("anything"));
  CHECK(options.split == "altShift");
}

TEST(a_fresh_shift_release_peeks_once_with_its_point) {
  lp::GestureGate gate;
  lp::PageOptions options;
  gate.NotePress(kPage);
  gate.NoteRelease(kPage, lp::kShift, 1, lp::Point{12, 34});
  const lp::Decision first = gate.Decide(RequestFor("shift", 1.2), options);
  CHECK(first.outcome == lp::Outcome::kPeek);
  CHECK(first.point && first.point->x == 12 && first.point->y == 34);
  CHECK(std::string(lp::DispositionName(first.outcome)) == "peek");
  const lp::Decision second = gate.Decide(RequestFor("shift", 1.3), options);
  CHECK(second.outcome != lp::Outcome::kPeek);
  CHECK(second.refused == "that mouse-up already opened a peek");
}

TEST(option_shift_splits_without_a_point) {
  lp::GestureGate gate;
  lp::PageOptions options;
  gate.NoteRelease(kPage, lp::kAlt | lp::kShift, 1, lp::Point{1, 1});
  const lp::Decision decision = gate.Decide(RequestFor("altShift", 1.1), options);
  CHECK(decision.outcome == lp::Outcome::kSplit);
  CHECK(!decision.point);
}

TEST(stale_pressed_foreign_or_hidden_releases_never_peek) {
  lp::PageOptions options;
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("shift", 1 + lp::GestureGate::kGestureLifetime + 1), options).outcome !=
          lp::Outcome::kPeek);
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    gate.NotePress(kPage);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).refused ==
          "the mouse was pressed again since that mouse-up");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kOther, lp::kShift, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).refused == "the mouse-up wasn't over this page");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    lp::Request hidden = RequestFor("shift", 1.1);
    hidden.visible = false;
    CHECK(gate.Decide(hidden, options).refused == "page not shown");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift | lp::kControl, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).refused ==
          "the mouse-up's keys aren't the page's key alone");
  }
  {
    lp::GestureGate gate;
    CHECK(gate.Decide(RequestFor("shift", 1), options).refused == "no left mouse-up yet");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    lp::Request clock = RequestFor("shift", 0.5);
    CHECK(gate.Decide(clock, options).refused == "the last mouse-up is too old");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    gate.Forget(kPage);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).outcome != lp::Outcome::kPeek);
  }
}

TEST(shift_with_peek_off_opens_a_window_and_alt_falls_back_by_origin) {
  lp::PageOptions options;
  options.SetPeek("off");
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).outcome == lp::Outcome::kWindow);
  }
  options.SetPeek("shift");
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kAlt, 1, std::nullopt);
    lp::Request same = RequestFor("alt", 1.1);
    same.same_origin = true;
    CHECK(gate.Decide(same, options).outcome == lp::Outcome::kDownload);
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kAlt, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("alt", 1.1), options).outcome == lp::Outcome::kBackground);
    CHECK(lp::DispositionName(lp::Outcome::kDownload) == nullptr);
    CHECK(lp::DispositionName(lp::Outcome::kFollow) == nullptr);
  }
}

TEST(other_site_peeks_need_the_tab_listed_and_a_plain_click) {
  lp::PageOptions options;
  lp::GestureGate gate;
  gate.NoteRelease(kPage, 0, 1, lp::Point{5, 6});
  lp::Request unlisted = RequestFor(std::string(lp::kOtherSiteKey), 1.1);
  const lp::Decision follow = gate.Decide(unlisted, options);
  CHECK(follow.outcome == lp::Outcome::kFollow);
  CHECK(follow.site);
  lp::Request listed = unlisted;
  listed.other_sites = true;
  const lp::Decision peek = gate.Decide(listed, options);
  CHECK(peek.outcome == lp::Outcome::kPeek);
  CHECK(peek.site);
  CHECK(peek.point && peek.point->x == 5);
  CHECK(gate.Decide(listed, options).outcome == lp::Outcome::kFollow);
  lp::GestureGate frame_gate;
  frame_gate.NoteRelease(kPage, 0, 1, std::nullopt);
  listed.main = false;
  CHECK(frame_gate.Decide(listed, options).outcome == lp::Outcome::kFollow);
}

TEST(fresh_flags_report_only_an_unused_release_on_that_page) {
  lp::GestureGate gate;
  CHECK(gate.FreshFlags(kPage, 1) == -1);
  gate.NoteRelease(kPage, lp::kShift | 64, 1, std::nullopt);
  CHECK(gate.FreshFlags(kPage, 1.5) == lp::kShift);
  CHECK(gate.FreshSurface(1.5) == kPage);
  CHECK(gate.FreshFlags(kOther, 1.5) == -1);
  CHECK(gate.FreshFlags(kPage, 1 + lp::GestureGate::kGestureLifetime + 0.1) == -1);
  CHECK(gate.FreshFlags(kPage, 0.5) == -1);
  gate.NotePress(kPage);
  CHECK(gate.FreshFlags(kPage, 1.5) == -1);
  CHECK(gate.FreshSurface(1.5) == 0);
}

TEST(chrome_dispositions_map_to_link_keys_only_for_renderer_clicks) {
  using O = lp::Opening;
  CHECK(lp::RouteForOpening(O::kWindow, lp::kShift, true, true, true).key == "shift");
  CHECK(lp::RouteForOpening(O::kWindow, lp::kAlt | lp::kShift, true, true, true).key == "altShift");
  CHECK(lp::RouteForOpening(O::kDownload, lp::kAlt, true, true, true).key == "alt");
  CHECK(lp::RouteForOpening(O::kSplit, lp::kAlt | lp::kMeta, true, true, true).key == "altMeta");
  CHECK(!lp::RouteForOpening(O::kWindow, lp::kShift, false, true, true).ours);
  CHECK(!lp::RouteForOpening(O::kWindow, lp::kShift, true, false, true).ours);
  CHECK(!lp::RouteForOpening(O::kWindow, lp::kShift, true, true, false).ours);
  CHECK(!lp::RouteForOpening(O::kWindow, -1, true, true, true).ours);
  CHECK(!lp::RouteForOpening(O::kBackground, lp::kMeta, true, true, true).ours);
  CHECK(!lp::RouteForOpening(O::kForeground, lp::kMeta | lp::kShift, true, true, true).ours);
  CHECK(!lp::RouteForOpening(O::kWindow, lp::kShift | lp::kControl, true, true, true).ours);
  CHECK(!lp::RouteForOpening(O::kDownload, lp::kAlt | lp::kShift, true, true, true).ours);
  CHECK(!lp::RouteForOpening(O::kPopup, lp::kShift, true, true, true).ours);
}

TEST(unmatched_new_windows_stay_with_chromium_as_tabs) {
  CHECK(lp::WindowOpensAsTab(lp::Opening::kWindow, true));
  CHECK(!lp::WindowOpensAsTab(lp::Opening::kWindow, false));
  CHECK(!lp::WindowOpensAsTab(lp::Opening::kPopup, true));
  CHECK(!lp::WindowOpensAsTab(lp::Opening::kForeground, true));
}

TEST(a_link_matches_only_the_url_released_over) {
  CHECK(lp::TargetMatches("https://a.test/x", "https://a.test/x"));
  CHECK(!lp::TargetMatches("", ""));
  CHECK(!lp::TargetMatches("", "https://a.test/x"));
  CHECK(!lp::TargetMatches("https://a.test/x", "https://a.test/y"));
}

TEST(option_click_downloads_need_that_tab_link_and_a_plain_option_click_request) {
  lp::DownloadClick click;
  click.follows_redirects = true;
  click.user_gesture = true;
  click.target_matches = true;
  click.up_flags = lp::kAlt;
  click.since = 0.6;
  CHECK(lp::OptionClickDownload(click));
  auto without = [&](auto change) {
    lp::DownloadClick copy = click;
    change(copy);
    return lp::OptionClickDownload(copy);
  };
  CHECK(!without([](auto& c) { c.follows_redirects = false; }));
  CHECK(!without([](auto& c) { c.names_file = true; }));
  CHECK(!without([](auto& c) { c.user_gesture = false; }));
  CHECK(!without([](auto& c) { c.target_matches = false; }));
  CHECK(!without([](auto& c) { c.up_flags = lp::kAlt | lp::kShift; }));
  CHECK(!without([](auto& c) { c.up_flags = -1; }));
  CHECK(!without([](auto& c) { c.since = lp::kDownloadLifetime + 0.01; }));
  CHECK(!without([](auto& c) { c.since = -1; }));
}

TEST(an_option_click_in_one_tab_never_claims_another_tabs_download) {
  lp::GestureGate gate;
  gate.NoteRelease(kPage, lp::kAlt, 1, std::nullopt, "https://a.test/report.pdf", 1000000);
  auto click_for = [&](std::uintptr_t source) {
    const auto release = gate.FreshRelease(source, 1.5);
    lp::DownloadClick click;
    click.follows_redirects = true;
    click.user_gesture = true;
    click.target_matches = lp::TargetMatches(release.target, "https://a.test/report.pdf");
    click.up_flags = release.flags;
    click.since = release.since;
    return lp::OptionClickDownload(click);
  };
  CHECK(click_for(kPage));
  CHECK(!click_for(kOther));
}

TEST(a_release_on_one_tab_is_never_fresh_for_another) {
  lp::GestureGate gate;
  gate.NoteRelease(kPage, lp::kAlt, 1, std::nullopt, "https://a.test/file", 1000000);
  const auto mine = gate.FreshRelease(kPage, 1.1);
  CHECK(mine.flags == lp::kAlt && mine.target == "https://a.test/file" && mine.input_us == 1000000);
  CHECK_NEAR(mine.since, 0.1);
  const auto other = gate.FreshRelease(kOther, 1.1);
  CHECK(other.flags == -1 && other.target.empty() && other.input_us == 0);
  gate.NoteRelease(kPage, 0, 2, std::nullopt, std::string(lp::kUrlMax + 1, 'x'), 5);
  CHECK(gate.FreshRelease(kPage, 2).target.empty());
}

TEST(popups_become_tabs_only_outside_little_ardia) {
  CHECK(lp::PopupOpensAsTab(true, false, lp::Opening::kPopup));
  CHECK(!lp::PopupOpensAsTab(true, true, lp::Opening::kPopup));
  CHECK(!lp::PopupOpensAsTab(false, false, lp::Opening::kPopup));
  CHECK(!lp::PopupOpensAsTab(true, false, lp::Opening::kForeground));
}

TEST(little_ardia_keeps_plain_new_tab_links_in_place) {
  lp::InPlaceLink link;
  link.enabled = true;
  link.small_window = true;
  link.opening = lp::Opening::kForeground;
  link.renderer_initiated = true;
  link.user_gesture = true;
  link.http = true;
  link.target_matches = true;
  link.up_flags = 0;
  CHECK(lp::OpensInPlace(link));
  auto without = [&](auto change) {
    lp::InPlaceLink copy = link;
    change(copy);
    return lp::OpensInPlace(copy);
  };
  CHECK(without([](auto& l) { l.opening = lp::Opening::kBackground; }));
  CHECK(!without([](auto& l) { l.enabled = false; }));
  CHECK(!without([](auto& l) { l.small_window = false; }));
  CHECK(!without([](auto& l) { l.renderer_initiated = false; }));
  CHECK(!without([](auto& l) { l.user_gesture = false; }));
  CHECK(!without([](auto& l) { l.http = false; }));
  CHECK(!without([](auto& l) { l.post = true; }));
  CHECK(!without([](auto& l) { l.opener = true; }));
  CHECK(!without([](auto& l) { l.target_matches = false; }));
  CHECK(!without([](auto& l) { l.up_flags = lp::kMeta; }));
  CHECK(!without([](auto& l) { l.up_flags = -1; }));
  CHECK(!without([](auto& l) { l.opening = lp::Opening::kPopup; }));
  CHECK(!without([](auto& l) { l.opening = lp::Opening::kWindow; }));
}

TEST(site_peek_candidates_are_plain_cross_site_link_clicks) {
  lp::SitePeekNavigation navigation;
  navigation.primary_main_frame = true;
  navigation.renderer_initiated = true;
  navigation.user_gesture = true;
  navigation.link = true;
  navigation.link_click = true;
  navigation.main_frame_initiated = true;
  navigation.input_matches = true;
  navigation.http = true;
  navigation.cross_site = true;
  navigation.tab_listed = true;
  navigation.up_flags = 0;
  CHECK(lp::SitePeekCandidate(navigation));
  auto without = [&](auto change) {
    lp::SitePeekNavigation copy = navigation;
    change(copy);
    return lp::SitePeekCandidate(copy);
  };
  CHECK(!without([](auto& n) { n.primary_main_frame = false; }));
  CHECK(!without([](auto& n) { n.renderer_initiated = false; }));
  CHECK(!without([](auto& n) { n.user_gesture = false; }));
  CHECK(!without([](auto& n) { n.link = false; }));
  CHECK(!without([](auto& n) { n.link_click = false; }));
  CHECK(!without([](auto& n) { n.main_frame_initiated = false; }));
  CHECK(!without([](auto& n) { n.input_matches = false; }));
  CHECK(!without([](auto& n) { n.post = true; }));
  CHECK(!without([](auto& n) { n.same_document = true; }));
  CHECK(!without([](auto& n) { n.history = true; }));
  CHECK(!without([](auto& n) { n.http = false; }));
  CHECK(!without([](auto& n) { n.cross_site = false; }));
  CHECK(!without([](auto& n) { n.tab_listed = false; }));
  CHECK(!without([](auto& n) { n.up_flags = -1; }));
  CHECK(!without([](auto& n) { n.up_flags = lp::kShift; }));
}

TEST(other_site_peeks_tell_a_real_anchor_click_from_scripted_navigations) {
  constexpr std::int64_t kReleaseUs = 5000000;
  lp::GestureGate gate;
  gate.NoteRelease(kPage, 0, 5, std::nullopt, "https://other.test/a", kReleaseUs);
  const auto release = gate.FreshRelease(kPage, 5.01);
  auto navigation_for = [&](bool link_click, bool from_main_frame, std::int64_t input_us, std::string_view url) {
    lp::SitePeekNavigation navigation;
    navigation.primary_main_frame = true;
    navigation.renderer_initiated = true;
    navigation.user_gesture = true;
    navigation.link = true;
    navigation.link_click = link_click;
    navigation.main_frame_initiated = from_main_frame;
    navigation.input_matches = lp::SameInput(input_us, release.input_us) && lp::TargetMatches(release.target, url);
    navigation.http = true;
    navigation.cross_site = true;
    navigation.tab_listed = true;
    navigation.up_flags = release.flags;
    return lp::SitePeekCandidate(navigation);
  };
  CHECK(navigation_for(true, true, kReleaseUs, "https://other.test/a"));
  CHECK(!navigation_for(false, true, kReleaseUs, "https://other.test/a"));
  CHECK(!navigation_for(false, true, kReleaseUs, "https://redirect.test/"));
  CHECK(!navigation_for(true, false, kReleaseUs, "https://other.test/a"));
  CHECK(!navigation_for(true, true, kReleaseUs + 1, "https://other.test/a"));
  CHECK(!navigation_for(true, true, kReleaseUs - 1, "https://other.test/a"));
  CHECK(!navigation_for(true, true, kReleaseUs + 250000, "https://other.test/a"));
  CHECK(!navigation_for(true, true, kReleaseUs + 250000, "https://elsewhere.test/"));
  CHECK(!navigation_for(true, true, kReleaseUs, "https://elsewhere.test/"));
  CHECK(!navigation_for(true, true, 0, "https://other.test/a"));
  CHECK(lp::SameInput(kReleaseUs, kReleaseUs));
  CHECK(!lp::SameInput(kReleaseUs, 0));
  CHECK(!lp::SameInput(-1, -1));
}

TEST(a_cancelled_peek_is_announced_only_while_the_source_tab_lives) {
  CHECK(lp::AnnouncesSitePeek(true, false, false));
  CHECK(!lp::AnnouncesSitePeek(true, false, true));
  CHECK(!lp::AnnouncesSitePeek(true, true, false));
  CHECK(!lp::AnnouncesSitePeek(false, false, false));
}

TEST(a_same_process_iframe_anchor_targeting_top_never_peeks) {
  lp::SitePeekNavigation navigation;
  navigation.primary_main_frame = true;
  navigation.renderer_initiated = true;
  navigation.user_gesture = true;
  navigation.link = true;
  navigation.link_click = true;
  navigation.main_frame_initiated = false;
  navigation.input_matches = true;
  navigation.http = true;
  navigation.cross_site = true;
  navigation.tab_listed = true;
  navigation.up_flags = 0;
  CHECK(!lp::SitePeekCandidate(navigation));
}

TEST(a_synthetic_anchor_click_carries_its_own_time_and_never_peeks) {
  constexpr std::int64_t kReleaseUs = 9000000;
  constexpr std::int64_t kSyntheticCreatedUs = kReleaseUs + 400;
  CHECK(!lp::SameInput(kSyntheticCreatedUs, kReleaseUs));
  lp::SitePeekNavigation navigation;
  navigation.primary_main_frame = true;
  navigation.renderer_initiated = true;
  navigation.user_gesture = true;
  navigation.link = true;
  navigation.link_click = true;
  navigation.main_frame_initiated = true;
  navigation.input_matches = lp::SameInput(kSyntheticCreatedUs, kReleaseUs);
  navigation.http = true;
  navigation.cross_site = true;
  navigation.tab_listed = true;
  navigation.up_flags = 0;
  CHECK(!lp::SitePeekCandidate(navigation));
}

TEST(site_tab_lists_are_bounded_and_typed) {
  CHECK(lp::SiteTabKeys({}) && lp::SiteTabKeys({})->empty());
  const auto keys = lp::SiteTabKeys({std::string("a"), std::string("b"), std::string("a")});
  CHECK(keys && keys->size() == 2);
  CHECK(!lp::SiteTabKeys({std::nullopt}));
  CHECK(!lp::SiteTabKeys({std::string()}));
  CHECK(!lp::SiteTabKeys({std::string(lp::kTabKeyMax + 1, 'x')}));
  CHECK(lp::SiteTabKeys({std::string(lp::kTabKeyMax, 'x')}));
  std::vector<std::optional<std::string>> many(lp::kSiteTabsMax + 1, std::string("k"));
  CHECK(!lp::SiteTabKeys(many));
  const auto changed = lp::ChangedKeys({"a", "b"}, {"b", "c"});
  CHECK(changed.size() == 2);
}

TEST(command_wheel_zoom_steps_per_threshold_and_ignores_trackpads) {
  lp::ScrollZoom zoom;
  CHECK(zoom.Add(10, kPage) == 0);
  CHECK(zoom.Add(10, kPage) == 0);
  CHECK(zoom.Add(10, kPage) == 1);
  CHECK(zoom.Add(-31, kPage) == -1);
  CHECK(zoom.Add(std::numeric_limits<double>::quiet_NaN(), kPage) == 0);
  CHECK(zoom.Add(std::numeric_limits<double>::infinity(), kPage) == 0);
  CHECK(zoom.Add(20, kPage) == 0);
  CHECK(zoom.Add(20, kOther) == 0);
  CHECK(zoom.Add(20, kOther) == 1);
  CHECK(zoom.Add(50, 0) == 0);
  CHECK(zoom.Add(20, kOther) == 0);
  zoom.Reset();
  CHECK(zoom.Add(29, kOther) == 0);
  CHECK(lp::CommandScrollZooms(true, true, false, false, false));
  CHECK(!lp::CommandScrollZooms(false, true, false, false, false));
  CHECK(!lp::CommandScrollZooms(true, false, false, false, false));
  CHECK(!lp::CommandScrollZooms(true, true, true, false, false));
  CHECK(!lp::CommandScrollZooms(true, true, false, true, false));
  CHECK(!lp::CommandScrollZooms(true, true, false, false, true));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
