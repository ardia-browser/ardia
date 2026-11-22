#ifndef ARDIA_LINUX_AC_LINUX_WINDOW_CORNERS_H_
#define ARDIA_LINUX_AC_LINUX_WINDOW_CORNERS_H_

#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <string_view>

namespace ardia::linux_window_corners {

inline constexpr float kPageCardRadius = 12.0f;
inline constexpr char kWindowDecorationsCall[] = "ArdiaShell.windowDecorations";
inline constexpr char kWindowDecorationsEvent[] = "windowDecorations";
inline constexpr const char* kWindowCornersCapabilities[] = {"ArdiaShell.windowDecorations"};
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
  switch (answer) {
    case DecorationAnswer::kServerSide:
      return true;
    case DecorationAnswer::kClientSide:
      return false;
    case DecorationAnswer::kNone:
      return IsTilingDesktop(desktop);
  }
  return false;
}

constexpr std::string_view DecoratedByName(bool compositor) {
  return compositor ? "compositor" : "app";
}

constexpr std::string_view AnswerName(DecorationAnswer answer) {
  switch (answer) {
    case DecorationAnswer::kClientSide:
      return "client";
    case DecorationAnswer::kServerSide:
      return "server";
    case DecorationAnswer::kNone:
      return "none";
  }
  return "none";
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

inline int ClampedFloor(double value) {
  const double floored = std::floor(value);
  if (!(floored > std::numeric_limits<int>::min())) return std::numeric_limits<int>::min();
  if (floored >= std::numeric_limits<int>::max()) return std::numeric_limits<int>::max();
  return static_cast<int>(floored);
}

inline int ClampedCeil(double value) {
  const double ceiled = std::ceil(value);
  if (!(ceiled > std::numeric_limits<int>::min())) return std::numeric_limits<int>::min();
  if (ceiled >= std::numeric_limits<int>::max()) return std::numeric_limits<int>::max();
  return static_cast<int>(ceiled);
}

inline int ClampedSpan(int from, int to) {
  const long long span = static_cast<long long>(to) - static_cast<long long>(from);
  if (span <= 0) return 0;
  return span >= std::numeric_limits<int>::max() ? std::numeric_limits<int>::max() : static_cast<int>(span);
}

inline Box EnclosingBox(double left, double top, double right, double bottom) {
  const int x = ClampedFloor(left);
  const int y = ClampedFloor(top);
  return Box{.x = x,
             .y = y,
             .width = right > left ? ClampedSpan(x, ClampedCeil(right)) : 0,
             .height = bottom > top ? ClampedSpan(y, ClampedCeil(bottom)) : 0};
}

struct FrameInsets {
  int left = 0;
  int top = 0;
  int right = 0;
  int bottom = 0;
};

constexpr std::optional<Box> DefaultBoundsWithoutFrame(Box bounds, int default_width, int default_height,
                                                       FrameInsets framed, bool restored) {
  if (!restored || bounds.width != default_width || bounds.height != default_height) return std::nullopt;
  const int left = framed.left > 0 ? framed.left : 0;
  const int top = framed.top > 0 ? framed.top : 0;
  const int right = framed.right > 0 ? framed.right : 0;
  const int bottom = framed.bottom > 0 ? framed.bottom : 0;
  const long long width = static_cast<long long>(bounds.width) - left - right;
  const long long height = static_cast<long long>(bounds.height) - top - bottom;
  const long long x = static_cast<long long>(bounds.x) + left;
  const long long y = static_cast<long long>(bounds.y) + top;
  if ((left | top | right | bottom) == 0 || width < 1 || height < 1 || x > std::numeric_limits<int>::max() ||
      y > std::numeric_limits<int>::max()) {
    return std::nullopt;
  }
  return Box{.x = static_cast<int>(x), .y = static_cast<int>(y), .width = static_cast<int>(width),
             .height = static_cast<int>(height)};
}

constexpr float NearCornerRadius(int inset_x, int inset_y, float window_radius, float own_radius) {
  if (inset_x < 1 && inset_y < 1) return window_radius;
  if (inset_x < window_radius && inset_y < window_radius) {
    const float concentric = window_radius - static_cast<float>(inset_x < inset_y ? inset_x : inset_y);
    return concentric > own_radius ? concentric : own_radius;
  }
  return own_radius;
}

constexpr Corners ClipToWindow(Box view, int window_width, int window_height, Corners window, float own_radius) {
  const int left = view.x;
  const int top = view.y;
  const int right = window_width - (view.x + view.width);
  const int bottom = window_height - (view.y + view.height);
  return Corners{
      .upper_left = NearCornerRadius(left, top, window.upper_left, own_radius),
      .upper_right = NearCornerRadius(right, top, window.upper_right, own_radius),
      .lower_right = NearCornerRadius(right, bottom, window.lower_right, own_radius),
      .lower_left = NearCornerRadius(left, bottom, window.lower_left, own_radius),
  };
}

}

#endif
