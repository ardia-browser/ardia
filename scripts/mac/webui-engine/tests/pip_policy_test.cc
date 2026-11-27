#include "ardia/mac/ac_mac_pip_policy.h"

#include <limits>

#include "check.h"

namespace pip = ardia_mac::pip_policy;

TEST(only_known_player_actions_are_accepted) {
  CHECK(pip::ParseAction("togglePlayPause") == pip::Action::kTogglePlayPause);
  CHECK(pip::ParseAction("seekTo") == pip::Action::kSeekTo);
  CHECK(pip::ParseAction("seekBy") == pip::Action::kSeekBy);
  CHECK(pip::ParseAction("backToTab") == pip::Action::kBackToTab);
  CHECK(pip::ParseAction("close") == pip::Action::kClose);
  CHECK(pip::ParseAction("popOut") == pip::Action::kPopOut);
  CHECK(!pip::ParseAction(""));
  CHECK(!pip::ParseAction("TogglePlayPause"));
  CHECK(!pip::ParseAction("evaluate"));
}

TEST(seeks_are_finite_and_clamped_to_the_media) {
  CHECK(pip::ValidSeekSeconds(10));
  CHECK(pip::ValidSeekSeconds(-10));
  CHECK(!pip::ValidSeekSeconds(std::numeric_limits<double>::quiet_NaN()));
  CHECK(!pip::ValidSeekSeconds(std::numeric_limits<double>::infinity()));
  CHECK(!pip::ValidSeekSeconds(1e20));
  CHECK(pip::ClampSeek(-5, 100) == 0);
  CHECK(pip::ClampSeek(500, 100) == 100);
  CHECK(pip::ClampSeek(50, std::nullopt) == 50);
  CHECK(pip::ClampSeek(50, std::numeric_limits<double>::infinity()) == 50);
}

TEST(commands_reach_only_the_presented_player) {
  CHECK(pip::PlayerMatches(3.0, 3));
  CHECK(!pip::PlayerMatches(3.0, 4));
  CHECK(!pip::PlayerMatches(std::nullopt, 3));
  CHECK(!pip::PlayerMatches(3.5, 3));
  CHECK(!pip::PlayerMatches(0.0, 0));
  CHECK(!pip::PlayerMatches(-3.0, 3));
  CHECK(!pip::PlayerMatches(std::numeric_limits<double>::quiet_NaN(), 3));
  CHECK(!pip::PlayerMatches(1e300, 3));
}

TEST(player_viewports_stay_inside_the_window) {
  const auto inside = pip::PlayerBox(10, 20, 320, 180, 1, 1000, 800);
  CHECK(inside && *inside == (pip::Box{10, 20, 320, 180}));
  const auto clipped = pip::PlayerBox(900, 700, 320, 180, 1, 1000, 800);
  CHECK(clipped && *clipped == (pip::Box{900, 700, 100, 100}));
  const auto zoomed = pip::PlayerBox(10, 10, 100, 50, 2, 1000, 800);
  CHECK(zoomed && *zoomed == (pip::Box{20, 20, 200, 100}));
  const auto outside = pip::PlayerBox(5000, 5000, 10, 10, 1, 1000, 800);
  CHECK(outside && outside->empty());
  CHECK(!pip::PlayerBox(0, 0, -1, 1, 1, 100, 100));
  CHECK(!pip::PlayerBox(std::numeric_limits<double>::quiet_NaN(), 0, 1, 1, 1, 100, 100));
  CHECK(!pip::PlayerBox(0, 0, 1e20, 1, 1, 100, 100));
  CHECK(!pip::PlayerBox(0, 0, 1, 1, 0, 100, 100));
}

TEST(pop_out_points_scale_only_the_grab_offset) {
  CHECK(pip::PopOutCoordinate(100, 20, 2) == 60);
  CHECK(pip::PopOutCoordinate(1000, 100, 1.25) == 875);
  CHECK(pip::PopOutCoordinate(1000, 100, 1) == 900);
  CHECK(!pip::PopOutCoordinate(std::numeric_limits<double>::quiet_NaN(), 0, 1));
  CHECK(!pip::PopOutCoordinate(0, 1e20, 1));
  CHECK(!pip::PopOutCoordinate(0, 0, 0));
}

TEST(popped_out_players_stay_inside_the_display_work_area) {
  const pip::Box area{0, 25, 1440, 875};
  CHECK(pip::FitInWorkArea({100, 100, 320, 180}, area) == (pip::Box{100, 100, 320, 180}));
  CHECK(pip::FitInWorkArea({1400, 880, 320, 180}, area) == (pip::Box{1120, 720, 320, 180}));
  CHECK(pip::FitInWorkArea({-500, -500, 320, 180}, area) == (pip::Box{0, 25, 320, 180}));
  CHECK(pip::FitInWorkArea({0, 0, 3000, 2000}, area) == area);
  const pip::Box second{1440, -200, 1920, 1080};
  CHECK(pip::FitInWorkArea({3300, 800, 320, 180}, second) == (pip::Box{3040, 700, 320, 180}));
  CHECK(pip::FitInWorkArea({5, 5, 10, 10}, pip::Box{}) == (pip::Box{5, 5, 10, 10}));
}

TEST(popped_out_players_keep_the_window_minimum_inside_the_work_area) {
  const pip::Box area{0, 25, 1440, 875};
  CHECK(pip::PopOutBox({1300, 800, 200, 100}, area) ==
        (pip::Box{1440 - pip::kMinPopOutWidth, 900 - pip::kMinPopOutHeight, pip::kMinPopOutWidth,
                  pip::kMinPopOutHeight}));
  const auto x = pip::PopOutCoordinate(1400, 150, 1.25);
  const auto y = pip::PopOutCoordinate(880, 40, 1.25);
  CHECK(x && y);
  const pip::Box zoomed = pip::PopOutBox({*x, *y, 240, 135}, area);
  CHECK(zoomed.x + zoomed.width <= area.x + area.width && zoomed.y + zoomed.height <= area.y + area.height);
  CHECK(zoomed.width == pip::kMinPopOutWidth && zoomed.height == pip::kMinPopOutHeight);
  CHECK(pip::PopOutBox({100, 100, 480, 270}, area) == (pip::Box{100, 100, 480, 270}));
}

TEST(automatic_pip_keeps_chromiums_ask_prompt) {
  CHECK(pip::PermissionFor(false, true, false, false) == pip::AutoPipPermission::kAllow);
  CHECK(pip::PermissionFor(false, false, true, false) == pip::AutoPipPermission::kAsk);
  CHECK(pip::PermissionFor(false, false, true, true) == pip::AutoPipPermission::kBlock);
  CHECK(pip::PermissionFor(false, false, false, false) == pip::AutoPipPermission::kBlock);
  CHECK(pip::PermissionFor(true, true, false, false) == pip::AutoPipPermission::kBlock);
  CHECK(pip::PresentationFor(pip::Intent::kAutomatic, true, pip::AutoPipPermission::kAsk) ==
        pip::Presentation::kWindow);
  CHECK(pip::PresentationFor(pip::Intent::kAutomatic, true, pip::AutoPipPermission::kBlock) ==
        pip::Presentation::kDeclined);
}

TEST(a_reused_visible_window_still_checks_the_auto_pip_permission) {
  CHECK(pip::KeepsVisibleWindow(pip::Intent::kAutomatic, true, pip::AutoPipPermission::kAllow));
  CHECK(!pip::KeepsVisibleWindow(pip::Intent::kAutomatic, true, pip::AutoPipPermission::kAsk));
  CHECK(pip::PresentationFor(pip::Intent::kAutomatic, false, pip::AutoPipPermission::kAsk) ==
        pip::Presentation::kWindow);
  CHECK(!pip::KeepsVisibleWindow(pip::Intent::kAutomatic, true, pip::AutoPipPermission::kBlock));
  CHECK(!pip::KeepsVisibleWindow(pip::Intent::kAutomatic, false, pip::AutoPipPermission::kAllow));
  CHECK(!pip::KeepsVisibleWindow(pip::Intent::kExplicit, true, pip::AutoPipPermission::kAllow));
  CHECK(pip::PresentationFor(pip::Intent::kAutomatic, false, pip::AutoPipPermission::kBlock) ==
        pip::Presentation::kDeclined);
}

TEST(pop_outs_refit_to_the_shown_windows_effective_minimum) {
  const pip::Box area{0, 25, 1440, 875};
  const pip::Box flush{1440 - 284, 900 - 160, 284, 160};
  CHECK(pip::PopOutBox(flush, area, 360, 240) == (pip::Box{1440 - 360, 900 - 240, 360, 240}));
  CHECK(pip::PopOutBox(flush, area, 100, 100) == flush);
  CHECK(pip::PopOutBox({200, 200, 480, 270}, area, 360, 240) == (pip::Box{200, 200, 480, 270}));
  CHECK(pip::PopOutBox({0, 0, 10, 10}, area, 5000, 5000) == area);
}

TEST(default_player_sits_bottom_right_with_the_video_aspect) {
  const pip::Box wide = pip::DefaultPlayerBox(1600, 1000, 1920, 1080);
  CHECK(wide.width == 448 && wide.height == 252 && wide.x == 1600 - 448 - 10 && wide.y == 1000 - 252 - 10);
  const pip::Box unknown = pip::DefaultPlayerBox(100, 100, 0, 0);
  CHECK(unknown.width == 240 && unknown.height == 135 && unknown.x == 0 && unknown.y == 0);
  const pip::Box extreme = pip::DefaultPlayerBox(1000, 1000, 1, 100000);
  CHECK(extreme.height > 0 && extreme.height <= 2800);
}

TEST(automatic_pip_needs_a_window_that_shows_the_tab) {
  const auto allow = pip::AutoPipPermission::kAllow;
  CHECK(pip::PresentationFor(pip::Intent::kExplicit, true, allow) == pip::Presentation::kWindow);
  CHECK(pip::PresentationFor(pip::Intent::kExplicit, false, pip::AutoPipPermission::kBlock) ==
        pip::Presentation::kWindow);
  CHECK(pip::PresentationFor(pip::Intent::kAutomatic, true, allow) == pip::Presentation::kInWindow);
  CHECK(pip::PresentationFor(pip::Intent::kAutomatic, false, allow) == pip::Presentation::kDeclined);
  CHECK(pip::Presents(true, 4, 4, true));
  CHECK(!pip::Presents(true, 3, 4, true));
  CHECK(!pip::Presents(false, 4, 4, true));
  CHECK(!pip::Presents(true, 4, 4, false));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
