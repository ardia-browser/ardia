#ifndef ARDIA_DESKTOP_AC_DESKTOP_WINDOW_CORNERS_H_
#define ARDIA_DESKTOP_AC_DESKTOP_WINDOW_CORNERS_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <string_view>

namespace ardia::desktop_window_corners {

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

  friend constexpr bool operator==(const Box&, const Box&) = default;
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
                                                       FrameInsets framed, bool restored, bool sized_by_default) {
  if (!sized_by_default || !restored || bounds.width != default_width || bounds.height != default_height) {
    return std::nullopt;
  }
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

constexpr Corners ClipToWindow(Box view, int window_width, int window_height, Corners window, Corners own) {
  const int left = view.x;
  const int top = view.y;
  const int right = window_width - (view.x + view.width);
  const int bottom = window_height - (view.y + view.height);
  return Corners{
      .upper_left = NearCornerRadius(left, top, window.upper_left, own.upper_left),
      .upper_right = NearCornerRadius(right, top, window.upper_right, own.upper_right),
      .lower_right = NearCornerRadius(right, bottom, window.lower_right, own.lower_right),
      .lower_left = NearCornerRadius(left, bottom, window.lower_left, own.lower_left),
  };
}

constexpr Corners ClipToWindow(Box view, int window_width, int window_height, Corners window, float own_radius) {
  return ClipToWindow(view, window_width, window_height, window,
                      Corners{own_radius, own_radius, own_radius, own_radius});
}

inline constexpr Corners kPageCardCorners{kPageCardRadius, kPageCardRadius, kPageCardRadius, kPageCardRadius};

constexpr Corners CornersSharedWithPane(Box view, Box pane, Corners pane_radii) {
  const bool left = view.x == pane.x;
  const bool top = view.y == pane.y;
  const bool right = static_cast<long long>(view.x) + view.width == static_cast<long long>(pane.x) + pane.width;
  const bool bottom = static_cast<long long>(view.y) + view.height == static_cast<long long>(pane.y) + pane.height;
  return Corners{.upper_left = left && top ? pane_radii.upper_left : 0,
                 .upper_right = right && top ? pane_radii.upper_right : 0,
                 .lower_right = right && bottom ? pane_radii.lower_right : 0,
                 .lower_left = left && bottom ? pane_radii.lower_left : 0};
}
inline constexpr double kPageRadiusLimit = 4096.0;
inline constexpr double kMaxViewportExtent = 32768.0;
inline constexpr double kContentSnapEpsilon = 1e-3;

struct BoxF {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

inline std::optional<Box> ContentBoxInDip(BoxF content, BoxF visible, double zoom, Box pane,
                                          std::optional<Box> previous = std::nullopt) {
  if (!std::isfinite(content.x) || !std::isfinite(content.y) || !std::isfinite(content.width) ||
      !std::isfinite(content.height) || !std::isfinite(visible.x) || !std::isfinite(visible.y) ||
      !std::isfinite(visible.width) || !std::isfinite(visible.height) || !std::isfinite(zoom) || zoom <= 0 ||
      content.width < 0 || content.height < 0 || visible.width < 0 || visible.height < 0) {
    return std::nullopt;
  }
  const double scaled_x = content.x * zoom;
  const double scaled_y = content.y * zoom;
  const double scaled_width = content.width * zoom;
  const double scaled_height = content.height * zoom;
  if (!std::isfinite(scaled_x) || !std::isfinite(scaled_y) || !std::isfinite(scaled_width) ||
      !std::isfinite(scaled_height) || std::abs(scaled_x) > kMaxViewportExtent ||
      std::abs(scaled_y) > kMaxViewportExtent || scaled_width > kMaxViewportExtent ||
      scaled_height > kMaxViewportExtent) {
    return std::nullopt;
  }
  const bool clips_x = content.x < visible.x - kContentSnapEpsilon ||
                       content.x + content.width > visible.x + visible.width + kContentSnapEpsilon;
  const bool clips_y = content.y < visible.y - kContentSnapEpsilon ||
                       content.y + content.height > visible.y + visible.height + kContentSnapEpsilon;
  const auto axis = [](bool clips, double scaled_origin, double scaled_size, int pane_origin, int pane_size,
                       std::optional<int> prior) -> std::pair<int, int> {
    if (!clips) return {pane_origin, pane_size};
    const int origin = std::min(ClampedFloor(scaled_origin + kContentSnapEpsilon), pane_origin);
    const int span = ClampedSpan(origin, pane_origin + pane_size);
    const int ceiled = ClampedCeil(std::max(0.0, scaled_size - kContentSnapEpsilon));
    const int needed = std::max(ceiled, span);
    if (prior && *prior >= needed && *prior <= ceiled + 1) return {origin, *prior};
    return {origin, needed};
  };
  const auto [left, width] =
      axis(clips_x, scaled_x, scaled_width, pane.x, pane.width, previous ? std::make_optional(previous->width) : std::nullopt);
  const auto [top, height] =
      axis(clips_y, scaled_y, scaled_height, pane.y, pane.height, previous ? std::make_optional(previous->height) : std::nullopt);
  return Box{.x = left, .y = top, .width = width, .height = height};
}

inline std::optional<Corners> PageRadiiInDip(double upper_left, double upper_right, double lower_right,
                                             double lower_left, double zoom) {
  for (const double radius : {upper_left, upper_right, lower_right, lower_left}) {
    if (!std::isfinite(radius) || radius < 0) return std::nullopt;
  }
  if (!std::isfinite(zoom) || zoom <= 0) return std::nullopt;
  const auto dip = [zoom](double radius) { return static_cast<float>(std::min(radius, kPageRadiusLimit) * zoom); };
  return Corners{.upper_left = dip(upper_left),
                 .upper_right = dip(upper_right),
                 .lower_right = dip(lower_right),
                 .lower_left = dip(lower_left)};
}

}

#endif
