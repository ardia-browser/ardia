#ifndef ARDIA_MAC_AC_MAC_PIP_POLICY_H_
#define ARDIA_MAC_AC_MAC_PIP_POLICY_H_

#include <algorithm>
#include <initializer_list>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string_view>

namespace ardia_mac::pip_policy {

inline constexpr std::string_view kPipMethods[] = {"pip.attach", "pip.viewport", "pip.command"};
inline constexpr std::string_view kAutoPipCall = "webView.setAutoPictureInPicture";
inline constexpr double kMaxSeekSeconds = 1e7;
inline constexpr double kMaxCoordinate = 1e6;
inline constexpr double kCloseFadeMs = 100;
inline constexpr double kBackToTabFadeMs = 70;
inline constexpr double kHandoffDeadlineMs = 1000;

enum class Action { kTogglePlayPause, kSeekTo, kSeekBy, kBackToTab, kClose, kPopOut };

inline std::optional<Action> ParseAction(std::string_view action) {
  if (action == "togglePlayPause") return Action::kTogglePlayPause;
  if (action == "seekTo") return Action::kSeekTo;
  if (action == "seekBy") return Action::kSeekBy;
  if (action == "backToTab") return Action::kBackToTab;
  if (action == "close") return Action::kClose;
  if (action == "popOut") return Action::kPopOut;
  return std::nullopt;
}

inline bool ValidSeekSeconds(double seconds) {
  return std::isfinite(seconds) && std::abs(seconds) <= kMaxSeekSeconds;
}

inline double ClampSeek(double target, std::optional<double> duration) {
  double clamped = std::max(0.0, target);
  if (duration && std::isfinite(*duration) && *duration > 0) clamped = std::min(clamped, *duration);
  return clamped;
}

inline bool PlayerMatches(std::optional<double> requested, uint64_t presented) {
  if (!requested || !std::isfinite(*requested) || *requested < 1 || *requested > 9007199254740991.0 ||
      std::floor(*requested) != *requested || presented == 0) {
    return false;
  }
  return static_cast<uint64_t>(*requested) == presented;
}

struct Box {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  bool empty() const { return width <= 0 || height <= 0; }
  bool operator==(const Box&) const = default;
};

inline bool Bounded(double value) {
  return std::isfinite(value) && std::abs(value) <= kMaxCoordinate;
}

inline std::optional<Box> PlayerBox(double x, double y, double width, double height, double scale,
                                    int room_width, int room_height) {
  if (!Bounded(x) || !Bounded(y) || !Bounded(width) || !Bounded(height) || width < 0 || height < 0 ||
      !std::isfinite(scale) || scale < 0.1 || scale > 10) {
    return std::nullopt;
  }
  const double left = std::floor(x * scale);
  const double top = std::floor(y * scale);
  const double right = std::ceil((x + width) * scale);
  const double bottom = std::ceil((y + height) * scale);
  const double clip_left = std::clamp(left, 0.0, static_cast<double>(std::max(0, room_width)));
  const double clip_top = std::clamp(top, 0.0, static_cast<double>(std::max(0, room_height)));
  const double clip_right = std::clamp(right, clip_left, static_cast<double>(std::max(0, room_width)));
  const double clip_bottom = std::clamp(bottom, clip_top, static_cast<double>(std::max(0, room_height)));
  return Box{static_cast<int>(clip_left), static_cast<int>(clip_top), static_cast<int>(clip_right - clip_left),
             static_cast<int>(clip_bottom - clip_top)};
}

inline constexpr int kMinPopOutWidth = 284;
inline constexpr int kMinPopOutHeight = 160;

inline std::optional<int> PopOutCoordinate(double screen_point, double grab_css, double zoom) {
  if (!Bounded(screen_point) || !Bounded(grab_css) || !std::isfinite(zoom) || zoom < 0.1 || zoom > 10) {
    return std::nullopt;
  }
  return static_cast<int>(std::round(screen_point - grab_css * zoom));
}

inline Box DefaultPlayerBox(int room_width, int room_height, int natural_width, int natural_height) {
  const int player_width = std::clamp(static_cast<int>(std::max(0, room_width) * 0.28), 240, 480);
  const double aspect = natural_width > 0 && natural_height > 0
                            ? static_cast<double>(natural_width) / natural_height
                            : 16.0 / 9.0;
  const int player_height = std::max(1, static_cast<int>(player_width / std::clamp(aspect, 0.1, 10.0)));
  return Box{std::max(0, room_width - player_width - 10), std::max(0, room_height - player_height - 10),
             player_width, player_height};
}

inline Box FitInWorkArea(Box rect, Box area) {
  if (area.empty()) return rect;
  Box fitted = rect;
  fitted.width = std::clamp(rect.width, 1, area.width);
  fitted.height = std::clamp(rect.height, 1, area.height);
  fitted.x = std::clamp(rect.x, area.x, area.x + area.width - fitted.width);
  fitted.y = std::clamp(rect.y, area.y, area.y + area.height - fitted.height);
  return fitted;
}

inline Box PopOutBox(Box rect, Box area, int min_width = kMinPopOutWidth, int min_height = kMinPopOutHeight) {
  rect.width = std::max({rect.width, min_width, kMinPopOutWidth});
  rect.height = std::max({rect.height, min_height, kMinPopOutHeight});
  return FitInWorkArea(rect, area);
}

enum class Intent { kExplicit, kAutomatic };

enum class Presentation { kInWindow, kWindow, kDeclined };

enum class AutoPipPermission { kAllow, kAsk, kBlock };

inline AutoPipPermission PermissionFor(bool switched_off, bool allowed, bool asks, bool embargoed) {
  if (switched_off) return AutoPipPermission::kBlock;
  if (allowed) return AutoPipPermission::kAllow;
  if (asks && !embargoed) return AutoPipPermission::kAsk;
  return AutoPipPermission::kBlock;
}

inline bool KeepsVisibleWindow(Intent intent, bool window_visible, AutoPipPermission permission) {
  return intent == Intent::kAutomatic && window_visible && permission == AutoPipPermission::kAllow;
}

inline Presentation PresentationFor(Intent intent, bool presenter_found, AutoPipPermission permission) {
  if (intent == Intent::kExplicit) return Presentation::kWindow;
  switch (permission) {
    case AutoPipPermission::kAsk:
      return Presentation::kWindow;
    case AutoPipPermission::kBlock:
      return Presentation::kDeclined;
    case AutoPipPermission::kAllow:
      break;
  }
  return presenter_found ? Presentation::kInWindow : Presentation::kDeclined;
}

inline bool Presents(bool attached, uint64_t attached_generation, uint64_t renderer_generation, bool binds_source) {
  return attached && attached_generation == renderer_generation && binds_source;
}

}

#endif
