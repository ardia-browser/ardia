#ifndef ARDIA_MAC_AC_MAC_WINDOW_LAYOUT_H_
#define ARDIA_MAC_AC_MAC_WINDOW_LAYOUT_H_

#include <algorithm>
#include <cmath>
#include <optional>
#include <string_view>
#include <vector>

namespace ardia_mac::window {

inline constexpr double kTrafficLightInsetX = 18;
inline constexpr double kTrafficLightCenterY = 20;
inline constexpr double kTrafficLightSpacing = 6;
inline constexpr double kButtonSide = 14;

struct Point {
  double x = 0;
  double y = 0;
  bool operator==(const Point&) const = default;
};

struct Size {
  double width = 0;
  double height = 0;
};

struct Lights {
  Point center{kTrafficLightInsetX + kButtonSide / 2, kTrafficLightCenterY};
  bool hidden = false;
};

inline constexpr double kLightsEdgeMargin = 7;
inline constexpr double kMinLightsCenter = kLightsEdgeMargin + kButtonSide / 2;

inline double SafeScale(double scale) {
  return std::isfinite(scale) && scale > 0.05 && scale < 20 ? scale : 1;
}

inline std::optional<Lights> LightsFrom(std::optional<double> x,
                                        std::optional<double> y,
                                        bool hidden,
                                        Size window,
                                        double css_scale = 1) {
  Lights lights;
  lights.hidden = hidden;
  if (!x && !y) return lights;
  const double scale = SafeScale(css_scale);
  const double cx = x ? *x * scale : lights.center.x;
  const double cy = y ? *y * scale : lights.center.y;
  if (!std::isfinite(cx) || !std::isfinite(cy)) return std::nullopt;
  const double max_x = std::max(kMinLightsCenter, window.width - kButtonSide * 2.5 - kTrafficLightSpacing * 2 - kLightsEdgeMargin);
  const double max_y = std::max(kMinLightsCenter, window.height - kMinLightsCenter);
  lights.center = Point{std::clamp(cx, kMinLightsCenter, max_x), std::clamp(cy, kMinLightsCenter, max_y)};
  return lights;
}

inline Point CloseButtonOrigin(const Lights& lights, Size button, double frame_height) {
  const Size size{button.width > 0 ? button.width : kButtonSide, button.height > 0 ? button.height : kButtonSide};
  return Point{std::round(lights.center.x - size.width / 2),
               std::round(frame_height - lights.center.y - size.height / 2)};
}

inline Point ButtonOrigin(const Lights& lights, Size button, double frame_height, int index) {
  const Point close = CloseButtonOrigin(lights, button, frame_height);
  const double width = button.width > 0 ? button.width : kButtonSide;
  return Point{close.x + index * (width + kTrafficLightSpacing), close.y};
}

struct TitlebarMetrics {
  double min_x_inset = 0;
  double height = 0;
  bool operator==(const TitlebarMetrics&) const = default;
};

inline TitlebarMetrics TitlebarFor(const Lights& lights, Size button) {
  const double width = button.width > 0 ? button.width : kButtonSide;
  return TitlebarMetrics{std::max(0.0, std::round(lights.center.x - width / 2)),
                         std::max(1.0, std::round(lights.center.y * 2))};
}

struct TitlebarLayout {
  double container_y = 0;
  double container_height = 0;
  double button_y = 0;
  double button_x[3] = {0, 0, 0};
};

inline TitlebarLayout TitlebarLayoutFor(const TitlebarMetrics& metrics, Size button, double measured_spacing,
                                        double frame_height) {
  const double width = button.width > 0 ? button.width : kButtonSide;
  const double height = button.height > 0 ? button.height : kButtonSide;
  const double spacing = std::isfinite(measured_spacing) && measured_spacing > width ? measured_spacing : width + kTrafficLightSpacing;
  TitlebarLayout layout;
  layout.container_height = std::max(height, metrics.height);
  layout.container_y = std::isfinite(frame_height) ? frame_height - layout.container_height : 0;
  layout.button_y = std::round((layout.container_height - height) / 2);
  for (int index = 0; index < 3; ++index) layout.button_x[index] = metrics.min_x_inset + index * spacing;
  return layout;
}

enum class CaptionAction { kZoom, kMinimize, kNone };

inline CaptionAction CaptionActionFor(std::optional<std::string_view> action,
                                      std::optional<bool> legacy_minimize,
                                      bool background_instance) {
  if (background_instance) return CaptionAction::kNone;
  if (action) {
    if (*action == "Minimize") return CaptionAction::kMinimize;
    if (*action == "None") return CaptionAction::kNone;
    if (*action == "Maximize" || *action == "Fill" || *action == "Zoom") return CaptionAction::kZoom;
  }
  return legacy_minimize.value_or(false) ? CaptionAction::kMinimize : CaptionAction::kZoom;
}

inline std::string_view CaptionActionName(CaptionAction action) {
  switch (action) {
    case CaptionAction::kZoom:
      return "zoom";
    case CaptionAction::kMinimize:
      return "minimize";
    case CaptionAction::kNone:
      return "none";
  }
  return "none";
}

enum class MouseEvent { kLeftDown, kLeftDragged, kOther };

struct DragStart {
  bool start = false;
  bool use_retained_down = false;
  bool operator==(const DragStart&) const = default;
};

inline DragStart WindowDragFor(MouseEvent current,
                               bool current_in_window,
                               bool left_held,
                               bool retained_down_in_window) {
  if (!left_held) return DragStart{};
  if (retained_down_in_window) return DragStart{true, true};
  if (current_in_window && (current == MouseEvent::kLeftDown || current == MouseEvent::kLeftDragged)) {
    return DragStart{true, false};
  }
  return DragStart{};
}

struct Presentation {
  bool show = false;
  bool order_out = false;
  bool lowest_level = false;
};

inline Presentation PresentationFor(bool background_instance) {
  if (background_instance) return Presentation{false, true, true};
  return Presentation{true, false, false};
}

struct Translucency {
  bool opaque = true;
  bool clear_background = false;
  bool full_size_content = false;
  bool transparent_titlebar = false;
  bool hide_title = false;
};

struct Frame {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
  bool operator==(const Frame&) const = default;
};

inline constexpr double kCascadeStep = 22;
inline constexpr double kSettingsWidth = 820;
inline constexpr double kSettingsHeight = 640;
inline constexpr double kImportWidth = 640;
inline constexpr double kImportHeight = 600;

inline Frame CascadedFrom(const Frame& opener) {
  return Frame{opener.x + kCascadeStep, opener.y + kCascadeStep, std::max(1.0, opener.width),
               std::max(1.0, opener.height)};
}

inline Frame UtilityFrameOver(const Frame& opener, std::string_view kind) {
  const bool settings = kind == "settings";
  const double width = settings ? kSettingsWidth : kImportWidth;
  const double height = settings ? kSettingsHeight : kImportHeight;
  return Frame{std::round(opener.x + (opener.width - width) / 2), std::round(opener.y + (opener.height - height) / 2),
               width, height};
}

inline std::optional<Frame> PlacedOnScreens(const Frame& wanted, const std::vector<Frame>& screens) {
  const Frame* best = nullptr;
  double best_overlap = 0;
  for (const Frame& screen : screens) {
    const double overlap_x = std::min(wanted.x + wanted.width, screen.x + screen.width) - std::max(wanted.x, screen.x);
    const double overlap_y = std::min(wanted.y + wanted.height, screen.y + screen.height) - std::max(wanted.y, screen.y);
    const double overlap = overlap_x > 0 && overlap_y > 0 ? overlap_x * overlap_y : 0;
    if (overlap > best_overlap) {
      best_overlap = overlap;
      best = &screen;
    }
  }
  if (!best) return std::nullopt;
  const double width = std::min(wanted.width, best->width);
  const double height = std::min(wanted.height, best->height);
  return Frame{std::clamp(wanted.x, best->x, best->x + best->width - width),
               std::clamp(wanted.y, best->y, best->y + best->height - height), width, height};
}

struct OpenPresentation {
  bool show = false;
  bool activate = false;
  bool order_behind = false;
  bool maximize = false;
  bool operator==(const OpenPresentation&) const = default;
};

inline OpenPresentation PresentationForOpen(bool background_instance, bool focus, bool behind, bool maximized) {
  if (background_instance) return OpenPresentation{};
  return OpenPresentation{true, focus && !behind, behind, maximized};
}

inline Translucency TranslucencyFor(bool webui_shell) {
  if (!webui_shell) return Translucency{};
  return Translucency{false, true, true, true, true};
}

}

#endif
