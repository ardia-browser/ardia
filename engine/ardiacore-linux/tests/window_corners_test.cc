#include <cassert>
#include <cstdio>

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
  static_assert(corners::CompositorDecorates(DecorationAnswer::kClientSide, "sway"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kNone, "ubuntu:GNOME"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kClientSide, "KDE"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kNone, ""));

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
  std::puts("ok");
  return 0;
}
