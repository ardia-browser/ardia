#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>
#include <utility>

#include "ardia/linux/ac_linux_window_corners.h"

namespace corners = ardia::linux_window_corners;

namespace {

constexpr corners::Corners kFrame{.upper_left = 8, .upper_right = 8};
constexpr corners::Corners kSquare{};
constexpr float kCard = corners::kPageCardRadius;

}

int main() {
  using corners::DecorationAnswer;
  static_assert(corners::DecorationAnswerOf(0) == DecorationAnswer::kNone);
  static_assert(corners::DecorationAnswerOf(1) == DecorationAnswer::kClientSide);
  static_assert(corners::DecorationAnswerOf(2) == DecorationAnswer::kServerSide);
  static_assert(corners::DecorationAnswerOf(3) == DecorationAnswer::kNone);

  for (const char* tiling : {"Hyprland", "hyprland", "sway", "SWAY", "niri", "i3", "river", "dwl", "bspwm", "awesome",
                             "qtile", "xmonad", "dwm", "herbstluftwm", "Regolith:GNOME", "regolith",
                             "Hyprland:Omarchy", "wlroots:sway", " niri "}) {
    assert(corners::IsTilingDesktop(tiling));
  }
  for (const char* floating : {"GNOME", "ubuntu:GNOME", "KDE", "X-Cinnamon", "XFCE", "MATE", "LXQt", "Budgie:GNOME",
                               "Pantheon", "COSMIC", "Unity", "", "i3wm", "swayfx-like", "hyprlandish", ":", "::"}) {
    assert(!corners::IsTilingDesktop(floating));
  }

  static_assert(corners::CompositorDecorates(DecorationAnswer::kServerSide, "ubuntu:GNOME"));
  static_assert(corners::CompositorDecorates(DecorationAnswer::kServerSide, ""));
  static_assert(corners::CompositorDecorates(DecorationAnswer::kNone, "Hyprland"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kClientSide, "sway"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kClientSide, "Hyprland"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kNone, "ubuntu:GNOME"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kClientSide, "KDE"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kNone, ""));
  for (const char* desktop : {"KDE", "sway", "", "ubuntu:GNOME", "Hyprland"}) {
    const bool main_window = corners::CompositorDecorates(DecorationAnswer::kClientSide, desktop);
    const bool task_manager = corners::CompositorDecorates(DecorationAnswer::kServerSide, desktop);
    assert(!main_window && task_manager);
  }
  static_assert(corners::DecoratedByName(true) == "compositor" && corners::DecoratedByName(false) == "app");
  static_assert(corners::AnswerName(DecorationAnswer::kNone) == "none");
  static_assert(corners::AnswerName(DecorationAnswer::kClientSide) == "client");
  static_assert(corners::AnswerName(DecorationAnswer::kServerSide) == "server");

  static_assert(corners::ClipToWindow({.width = 900, .height = 700}, 900, 700, kFrame, 0) == kFrame);
  static_assert(corners::ClipToWindow({.width = 900, .height = 700}, 900, 700, kSquare, kCard) == kSquare);
  static_assert(corners::ClipToWindow({.x = -2, .y = -2, .width = 904, .height = 704}, 900, 700, kFrame, 0) == kFrame);
  static_assert(corners::ClipToWindow({.x = 8, .y = 8, .width = 884, .height = 684}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = kCard, .lower_right = kCard, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 240, .y = 0, .width = 660, .height = 700}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = 8, .lower_right = 0, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 0, .y = 0, .width = 240, .height = 700}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = 8, .upper_right = kCard, .lower_right = kCard, .lower_left = 0});
  static_assert(corners::ClipToWindow({.x = 240, .y = 40, .width = 660, .height = 660}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = kCard, .lower_right = 0, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 0, .y = 0, .width = 899, .height = 699}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = 8, .upper_right = kCard, .lower_right = kCard, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 1, .y = 0, .width = 899, .height = 700}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = 8, .lower_right = 0, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 240, .y = 0, .width = 660, .height = 700}, 900, 700, kSquare, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = 0, .lower_right = 0, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 240, .y = 0, .width = 660, .height = 700}, 1000, 700, kSquare, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = kCard, .lower_right = kCard, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 240, .y = 0, .width = 660, .height = 700}, 900, 800, kSquare, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = 0, .lower_right = kCard, .lower_left = kCard});
  for (const float window_radius : {12.0f, 19.0f, 24.0f}) {
    const corners::Corners window{window_radius, window_radius, window_radius, window_radius};
    for (const int inset : {0, 1, 2, 3, 8}) {
      const corners::Corners page = corners::ClipToWindow(
          {.x = inset, .y = inset, .width = 900 - 2 * inset, .height = 700 - 2 * inset}, 900, 700, window, kCard);
      const float expected = inset == 0 ? window_radius
                             : inset < window_radius ? std::fmax(kCard, window_radius - static_cast<float>(inset))
                                                     : kCard;
      assert(page.upper_left == expected && page.upper_right == expected && page.lower_right == expected &&
             page.lower_left == expected);
      for (int y = inset; y < inset + 30; ++y) {
        for (int x = inset; x < inset + 30; ++x) {
          const float px = x + 0.5f;
          const float py = y + 0.5f;
          const float page_cx = static_cast<float>(inset) + page.upper_left;
          const float page_cy = static_cast<float>(inset) + page.upper_left;
          const bool in_page = !(px < page_cx && py < page_cy) || std::hypot(px - page_cx, py - page_cy) <= page.upper_left;
          const bool in_window = !(px < window_radius && py < window_radius) ||
                                 std::hypot(px - window_radius, py - window_radius) <= window_radius;
          assert(!in_page || in_window || inset == 0);
        }
      }
    }
    const corners::Corners lopsided = corners::ClipToWindow({.x = 0, .y = 5, .width = 900, .height = 695}, 900, 700, window, kCard);
    assert(lopsided.upper_left == std::fmax(kCard, window_radius));
  }
  for (const float window_radius : {8.0f, 12.0f, 15.0f, 19.0f, 24.0f}) {
    const corners::Corners window{window_radius, window_radius, window_radius, window_radius};
    for (const auto& [inset_x, inset_y] : {std::pair{0, 3}, std::pair{1, 5}, std::pair{2, 9}, std::pair{4, 1}, std::pair{7, 2},
                                           std::pair{3, 14}, std::pair{11, 6}}) {
      const corners::Corners page = corners::ClipToWindow(
          {.x = inset_x, .y = inset_y, .width = 900 - 2 * inset_x, .height = 700 - 2 * inset_y}, 900, 700, window, kCard);
      const float radius = page.upper_left;
      for (int y = inset_y; y < inset_y + 40; ++y) {
        for (int x = inset_x; x < inset_x + 40; ++x) {
          const float px = x + 0.5f;
          const float py = y + 0.5f;
          const float page_cx = static_cast<float>(inset_x) + radius;
          const float page_cy = static_cast<float>(inset_y) + radius;
          const bool in_page = !(px < page_cx && py < page_cy) || std::hypot(px - page_cx, py - page_cy) <= radius;
          const bool in_window = !(px < window_radius && py < window_radius) ||
                                 std::hypot(px - window_radius, py - window_radius) <= window_radius;
          assert(!in_page || in_window || (inset_x == 0 && inset_y == 0));
        }
      }
    }
  }
  {
    const corners::Box box = corners::EnclosingBox(0.75, 0.2, 998.25, 699.5);
    assert(box.x == 0 && box.y == 0 && box.width == 999 && box.height == 700);
    const corners::Box near_one = corners::EnclosingBox(0.99999999999, 0.0, 1000.00000000001, 700.0);
    assert(near_one.x == 0 && near_one.width == 1001);
    const corners::Box exact = corners::EnclosingBox(1.0, 2.0, 999.0, 698.0);
    assert(exact.x == 1 && exact.y == 2 && exact.width == 998 && exact.height == 696);
    const corners::Box empty = corners::EnclosingBox(10.5, 20.25, 10.5, 20.25);
    assert(empty.x == 10 && empty.y == 20 && empty.width == 0 && empty.height == 0);
    const corners::Box huge = corners::EnclosingBox(-1e300, 0.0, 1e300, std::nan(""));
    assert(huge.x == std::numeric_limits<int>::min() && huge.width == std::numeric_limits<int>::max() && huge.height == 0);
  }
  {
    constexpr corners::FrameInsets kShadow{.left = 10, .top = 10, .right = 10, .bottom = 10};
    constexpr corners::Box kDefault{.x = 0, .y = 0, .width = 945, .height = 1060};
    constexpr auto kept = corners::DefaultBoundsWithoutFrame(kDefault, 945, 1060, kShadow, true, true);
    static_assert(kept && kept->x == 10 && kept->y == 10 && kept->width == 925 && kept->height == 1040);
    static_assert(!corners::DefaultBoundsWithoutFrame(kDefault, 945, 1060, kShadow, false, true));
    static_assert(!corners::DefaultBoundsWithoutFrame(kDefault, 945, 1060, kShadow, true, false));
    static_assert(!corners::DefaultBoundsWithoutFrame({.width = 925, .height = 1040}, 945, 1060, kShadow, true, true));
    static_assert(!corners::DefaultBoundsWithoutFrame({.width = 945, .height = 1040}, 945, 1060, kShadow, true, true));
    static_assert(!corners::DefaultBoundsWithoutFrame(kDefault, 945, 1060, {}, true, true));
    static_assert(!corners::DefaultBoundsWithoutFrame({.width = 20, .height = 20}, 20, 20, kShadow, true, true));
    constexpr auto lopsided =
        corners::DefaultBoundsWithoutFrame({.x = 100, .y = 50, .width = 800, .height = 600}, 800, 600,
                                           {.left = 3, .top = 40, .right = 5, .bottom = -2}, true, true);
    static_assert(lopsided && lopsided->x == 103 && lopsided->y == 90 && lopsided->width == 792 &&
                  lopsided->height == 560);
    const auto far = corners::DefaultBoundsWithoutFrame(
        {.x = std::numeric_limits<int>::max() - 5, .y = 0, .width = 945, .height = 1060}, 945, 1060, kShadow, true, true);
    assert(!far);
    constexpr corners::Box kSavedAtDefaultSize{.x = 30, .y = 40, .width = 945, .height = 1060};
    static_assert(!corners::DefaultBoundsWithoutFrame(kSavedAtDefaultSize, 945, 1060, kShadow, true, false));
    corners::Box saved = *kept;
    for (int launch = 0; launch < 3; ++launch) {
      if (const auto next = corners::DefaultBoundsWithoutFrame(saved, 945, 1060, kShadow, true, false)) saved = *next;
    }
    assert(saved.width == 925 && saved.height == 1040);
  }
  std::puts("ok");
  return 0;
}
