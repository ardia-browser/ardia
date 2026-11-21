#ifndef ARDIA_LINUX_AC_LINUX_WINDOW_CORNERS_H_
#define ARDIA_LINUX_AC_LINUX_WINDOW_CORNERS_H_

#include <cstddef>
#include <string_view>

namespace ardia::linux_window_corners {

inline constexpr float kPageCardRadius = 12.0f;
inline constexpr std::string_view kTilingDesktops[] = {
    "hyprland", "sway", "niri", "i3", "river", "dwl", "bspwm", "awesome", "qtile", "xmonad", "dwm", "herbstluftwm",
    "regolith"};

enum class DecorationAnswer { kNone, kClientSide, kServerSide };

constexpr DecorationAnswer DecorationAnswerOf(int xdg_decoration_mode) {
  switch (xdg_decoration_mode) {
    case 1:
      return DecorationAnswer::kClientSide;
    case 2:
      return DecorationAnswer::kServerSide;
    default:
      return DecorationAnswer::kNone;
  }
}

constexpr char Lower(char c) {
  return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
}

constexpr bool SameName(std::string_view name, std::string_view known) {
  while (!name.empty() && (name.front() == ' ' || name.front() == '\t')) name.remove_prefix(1);
  while (!name.empty() && (name.back() == ' ' || name.back() == '\t')) name.remove_suffix(1);
  if (name.size() != known.size()) return false;
  for (size_t i = 0; i < name.size(); ++i) {
    if (Lower(name[i]) != known[i]) return false;
  }
  return true;
}

constexpr bool IsTilingDesktop(std::string_view desktop) {
  while (true) {
    const size_t colon = desktop.find(':');
    const std::string_view name = desktop.substr(0, colon);
    for (std::string_view known : kTilingDesktops) {
      if (SameName(name, known)) return true;
    }
    if (colon == std::string_view::npos) return false;
    desktop.remove_prefix(colon + 1);
  }
}

constexpr bool CompositorDecorates(DecorationAnswer answer, std::string_view desktop) {
  return answer == DecorationAnswer::kServerSide || IsTilingDesktop(desktop);
}

struct Corners {
  float upper_left = 0;
  float upper_right = 0;
  float lower_right = 0;
  float lower_left = 0;

  friend constexpr bool operator==(const Corners&, const Corners&) = default;
};

struct Box {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
};

constexpr Corners ClipToWindow(Box view, int window_width, int window_height, Corners window, float own_radius) {
  const bool left = view.x <= 0;
  const bool top = view.y <= 0;
  const bool right = view.x + view.width >= window_width;
  const bool bottom = view.y + view.height >= window_height;
  return Corners{
      .upper_left = top && left ? window.upper_left : own_radius,
      .upper_right = top && right ? window.upper_right : own_radius,
      .lower_right = bottom && right ? window.lower_right : own_radius,
      .lower_left = bottom && left ? window.lower_left : own_radius,
  };
}

}

#endif
