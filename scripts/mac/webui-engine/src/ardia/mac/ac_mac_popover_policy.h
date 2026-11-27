#ifndef ARDIA_MAC_AC_MAC_POPOVER_POLICY_H_
#define ARDIA_MAC_AC_MAC_POPOVER_POLICY_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <string_view>
#include <vector>

namespace ardia_mac::popover {

inline constexpr double kMaxExtent = 1e5;
inline constexpr double kMinSide = 1;
inline constexpr std::size_t kMaxOpen = 8;
inline constexpr bool kPopoverRendererShipped = true;
inline constexpr std::size_t kMaxMessageBytes = 64 * 1024;
inline constexpr std::size_t kMaxPropsBytes = 256 * 1024;

struct Rect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;

  double right() const { return x + width; }
  double bottom() const { return y + height; }
  double center_x() const { return x + width / 2; }
  double center_y() const { return y + height / 2; }
  bool operator==(const Rect&) const = default;
};

struct Size {
  double width = 0;
  double height = 0;
};

enum class Edge { kBelow, kAbove, kTrailing, kLeading };

enum class Align { kCenter, kStart, kEnd };

struct Request {
  Rect anchor;
  Size size;
  Edge edge = Edge::kBelow;
  Align align = Align::kCenter;
  double gap = 6;
  double margin = 8;
};

struct Placed {
  Rect frame;
  Edge edge = Edge::kBelow;
  std::size_t screen = 0;
  bool flipped = false;
  bool shrunk = false;
};

inline bool Finite(double value) {
  return std::isfinite(value);
}

inline bool ValidRect(const Rect& rect) {
  return Finite(rect.x) && Finite(rect.y) && Finite(rect.width) && Finite(rect.height) && rect.width >= 0 &&
         rect.height >= 0 && std::abs(rect.x) <= kMaxExtent && std::abs(rect.y) <= kMaxExtent &&
         rect.width <= kMaxExtent && rect.height <= kMaxExtent;
}

inline std::optional<Edge> EdgeNamed(std::string_view name) {
  if (name.empty() || name == "bottom") return Edge::kBelow;
  if (name == "top") return Edge::kAbove;
  if (name == "right") return Edge::kTrailing;
  if (name == "left") return Edge::kLeading;
  return std::nullopt;
}

inline std::optional<Align> AlignNamed(std::string_view name) {
  if (name.empty() || name == "center") return Align::kCenter;
  if (name == "start") return Align::kStart;
  if (name == "end") return Align::kEnd;
  return std::nullopt;
}

inline std::string_view EdgeName(Edge edge) {
  switch (edge) {
    case Edge::kBelow:
      return "bottom";
    case Edge::kAbove:
      return "top";
    case Edge::kTrailing:
      return "right";
    case Edge::kLeading:
      return "left";
  }
  return "bottom";
}

inline double Overlap(const Rect& a, const Rect& b) {
  const double width = std::min(a.right(), b.right()) - std::max(a.x, b.x);
  const double height = std::min(a.bottom(), b.bottom()) - std::max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

inline double DistanceSquared(const Rect& rect, double x, double y) {
  const double dx = x < rect.x ? rect.x - x : (x > rect.right() ? x - rect.right() : 0);
  const double dy = y < rect.y ? rect.y - y : (y > rect.bottom() ? y - rect.bottom() : 0);
  return dx * dx + dy * dy;
}

inline std::optional<std::size_t> ScreenFor(const Rect& anchor, const std::vector<Rect>& screens) {
  std::optional<std::size_t> best;
  double best_overlap = 0;
  for (std::size_t index = 0; index < screens.size(); ++index) {
    if (!ValidRect(screens[index]) || screens[index].width <= 0 || screens[index].height <= 0) continue;
    const double overlap = Overlap(anchor, screens[index]);
    if (overlap > best_overlap) {
      best_overlap = overlap;
      best = index;
    }
  }
  if (best) return best;
  double nearest = std::numeric_limits<double>::infinity();
  for (std::size_t index = 0; index < screens.size(); ++index) {
    if (!ValidRect(screens[index]) || screens[index].width <= 0 || screens[index].height <= 0) continue;
    const double distance = DistanceSquared(screens[index], anchor.center_x(), anchor.center_y());
    if (distance < nearest) {
      nearest = distance;
      best = index;
    }
  }
  return best;
}

inline Edge Opposite(Edge edge) {
  switch (edge) {
    case Edge::kBelow:
      return Edge::kAbove;
    case Edge::kAbove:
      return Edge::kBelow;
    case Edge::kTrailing:
      return Edge::kLeading;
    case Edge::kLeading:
      return Edge::kTrailing;
  }
  return Edge::kAbove;
}

inline bool Vertical(Edge edge) {
  return edge == Edge::kBelow || edge == Edge::kAbove;
}

inline double Room(Edge edge, const Rect& anchor, const Rect& area, double gap) {
  switch (edge) {
    case Edge::kBelow:
      return area.bottom() - anchor.bottom() - gap;
    case Edge::kAbove:
      return anchor.y - area.y - gap;
    case Edge::kTrailing:
      return area.right() - anchor.right() - gap;
    case Edge::kLeading:
      return anchor.x - area.x - gap;
  }
  return 0;
}

inline double Clamp(double value, double low, double high) {
  return high < low ? low : std::clamp(value, low, high);
}

inline double Aligned(Align align, double anchor_start, double anchor_length, double length) {
  switch (align) {
    case Align::kStart:
      return anchor_start;
    case Align::kEnd:
      return anchor_start + anchor_length - length;
    case Align::kCenter:
      return anchor_start + (anchor_length - length) / 2;
  }
  return anchor_start;
}

inline std::optional<Placed> Place(const Request& request, const std::vector<Rect>& screens) {
  if (!ValidRect(request.anchor) || !Finite(request.size.width) || !Finite(request.size.height) ||
      !(request.size.width >= kMinSide) || !(request.size.height >= kMinSide) ||
      request.size.width > kMaxExtent || request.size.height > kMaxExtent || !Finite(request.gap) ||
      !Finite(request.margin)) {
    return std::nullopt;
  }
  const std::optional<std::size_t> screen = ScreenFor(request.anchor, screens);
  if (!screen) return std::nullopt;
  const double gap = std::clamp(request.gap, 0.0, 64.0);
  const double margin = std::clamp(request.margin, 0.0, 64.0);
  const Rect& visible = screens[*screen];
  const Rect area{visible.x + margin, visible.y + margin, std::max(kMinSide, visible.width - 2 * margin),
                  std::max(kMinSide, visible.height - 2 * margin)};
  Placed placed;
  placed.screen = *screen;
  Edge edge = request.edge;
  const double wanted = Vertical(edge) ? request.size.height : request.size.width;
  const double room = Room(edge, request.anchor, area, gap);
  const double other = Room(Opposite(edge), request.anchor, area, gap);
  if (room < wanted && other > room) {
    edge = Opposite(edge);
    placed.flipped = true;
  }
  placed.edge = edge;
  const double main_room = std::max(kMinSide, Room(edge, request.anchor, area, gap));
  double width = std::min(request.size.width, area.width);
  double height = std::min(request.size.height, area.height);
  if (Vertical(edge)) {
    height = std::min(height, main_room);
  } else {
    width = std::min(width, main_room);
  }
  placed.shrunk = width < request.size.width || height < request.size.height;
  Rect frame{0, 0, width, height};
  switch (edge) {
    case Edge::kBelow:
      frame.y = request.anchor.bottom() + gap;
      break;
    case Edge::kAbove:
      frame.y = request.anchor.y - gap - height;
      break;
    case Edge::kTrailing:
      frame.x = request.anchor.right() + gap;
      break;
    case Edge::kLeading:
      frame.x = request.anchor.x - gap - width;
      break;
  }
  if (Vertical(edge)) {
    frame.x = Clamp(Aligned(request.align, request.anchor.x, request.anchor.width, width), area.x,
                    area.right() - width);
    frame.y = Clamp(frame.y, area.y, area.bottom() - height);
  } else {
    frame.y = Clamp(Aligned(request.align, request.anchor.y, request.anchor.height, height), area.y,
                    area.bottom() - height);
    frame.x = Clamp(frame.x, area.x, area.right() - width);
  }
  frame.x = std::round(frame.x);
  frame.y = std::round(frame.y);
  frame.width = std::round(frame.width);
  frame.height = std::round(frame.height);
  placed.frame = frame;
  return placed;
}

inline Rect FlipVertical(const Rect& rect, double primary_screen_height) {
  return Rect{rect.x, primary_screen_height - rect.bottom(), rect.width, rect.height};
}

inline std::optional<Rect> WindowToScreen(const Rect& rect, const Rect& content_on_screen, double zoom) {
  const double scale = Finite(zoom) && zoom > 0.05 && zoom < 20 ? zoom : 1;
  if (!ValidRect(rect) || !ValidRect(content_on_screen) || !(rect.width >= kMinSide) || !(rect.height >= kMinSide)) {
    return std::nullopt;
  }
  return Rect{content_on_screen.x + rect.x * scale, content_on_screen.y + rect.y * scale, rect.width * scale,
              rect.height * scale};
}

inline bool ResolveBeyondWindow(std::optional<bool> requested, std::optional<bool> stored) {
  return requested.value_or(stored.value_or(true));
}

struct Clamped {
  Rect frame;
  std::size_t screen = 0;
  bool moved = false;
  bool shrunk = false;
};

inline std::optional<Clamped> ClampToScreen(const Rect& frame,
                                            const Rect& anchor,
                                            const std::vector<Rect>& screens,
                                            bool beyond_window,
                                            const Rect& content_on_screen) {
  if (!ValidRect(frame) || !(frame.width >= kMinSide) || !(frame.height >= kMinSide)) return std::nullopt;
  const std::optional<std::size_t> screen = ScreenFor(ValidRect(anchor) && anchor.width > 0 ? anchor : frame, screens);
  if (!screen) return std::nullopt;
  Rect area = screens[*screen];
  if (!beyond_window && ValidRect(content_on_screen)) {
    const double left = std::max(area.x, content_on_screen.x);
    const double top = std::max(area.y, content_on_screen.y);
    const double right = std::min(area.right(), content_on_screen.right());
    const double bottom = std::min(area.bottom(), content_on_screen.bottom());
    if (right - left >= kMinSide && bottom - top >= kMinSide) area = Rect{left, top, right - left, bottom - top};
  }
  Clamped clamped;
  clamped.screen = *screen;
  Rect out = frame;
  if (out.width > area.width) {
    out.width = area.width;
    clamped.shrunk = true;
  }
  if (out.height > area.height) {
    out.height = area.height;
    clamped.shrunk = true;
  }
  const double x = Clamp(out.x, area.x, area.right() - out.width);
  const double y = Clamp(out.y, area.y, area.bottom() - out.height);
  clamped.moved = x != out.x || y != out.y;
  out.x = std::round(x);
  out.y = std::round(y);
  out.width = std::round(out.width);
  out.height = std::round(out.height);
  clamped.frame = out;
  return clamped;
}

enum class State { kClosed, kOpen };

enum class Event {
  kOpen,
  kUpdate,
  kClose,
  kReplaced,
  kEscape,
  kOutsideClick,
  kInsideClick,
  kResignedKey,
  kParentResized,
  kParentMoved,
  kParentClosed,
  kParentMinimized,
  kAppDeactivated,
  kShellReloaded,
  kContentFailed,
};

enum class Reason { kNone, kEscape, kOutside, kBlur, kResize, kReplaced, kClosed, kHost, kFailed };

struct Options {
  bool takes_focus = true;
  bool dismiss_on_parent_resize = true;
};

struct Transition {
  State next = State::kClosed;
  bool show = false;
  bool hide = false;
  bool reposition = false;
  bool notify = false;
  Reason reason = Reason::kNone;
};

inline std::string_view ReasonName(Reason reason) {
  switch (reason) {
    case Reason::kNone:
      return "";
    case Reason::kEscape:
      return "escape";
    case Reason::kOutside:
      return "outside";
    case Reason::kBlur:
      return "blur";
    case Reason::kResize:
      return "resize";
    case Reason::kReplaced:
      return "replaced";
    case Reason::kClosed:
      return "closed";
    case Reason::kHost:
      return "host";
    case Reason::kFailed:
      return "failed";
  }
  return "host";
}

inline std::optional<Reason> ReasonNamed(std::string_view name) {
  if (name.empty() || name == "closed") return Reason::kClosed;
  if (name == "escape") return Reason::kEscape;
  if (name == "outside") return Reason::kOutside;
  if (name == "blur") return Reason::kBlur;
  if (name == "resize") return Reason::kResize;
  if (name == "replaced") return Reason::kReplaced;
  if (name == "host") return Reason::kHost;
  if (name == "failed") return Reason::kFailed;
  return std::nullopt;
}

inline Transition Step(State state, Event event, const Options& options = {}) {
  const auto dismiss = [](Reason reason, bool notify) {
    return Transition{State::kClosed, false, true, false, notify, reason};
  };
  const auto stay = [state]() { return Transition{state, false, false, false, false, Reason::kNone}; };
  if (state == State::kClosed) {
    if (event == Event::kOpen) return Transition{State::kOpen, true, false, true, false, Reason::kNone};
    return stay();
  }
  switch (event) {
    case Event::kOpen:
    case Event::kUpdate:
    case Event::kParentMoved:
      return Transition{State::kOpen, false, false, true, false, Reason::kNone};
    case Event::kInsideClick:
      return stay();
    case Event::kClose:
      return dismiss(Reason::kClosed, false);
    case Event::kReplaced:
      return dismiss(Reason::kReplaced, false);
    case Event::kEscape:
      return dismiss(Reason::kEscape, true);
    case Event::kOutsideClick:
      return dismiss(Reason::kOutside, true);
    case Event::kResignedKey:
      return options.takes_focus ? dismiss(Reason::kBlur, true) : stay();
    case Event::kAppDeactivated:
      return dismiss(Reason::kBlur, true);
    case Event::kParentResized:
      return options.dismiss_on_parent_resize ? dismiss(Reason::kResize, true)
                                              : Transition{State::kOpen, false, false, true, false, Reason::kNone};
    case Event::kParentClosed:
    case Event::kParentMinimized:
    case Event::kShellReloaded:
      return dismiss(Reason::kHost, true);
    case Event::kContentFailed:
      return dismiss(Reason::kFailed, true);
  }
  return stay();
}

struct Point {
  double x = 0;
  double y = 0;
};

inline bool Inside(const Rect& rect, Point point) {
  return point.x >= rect.x && point.x < rect.right() && point.y >= rect.y && point.y < rect.bottom();
}

inline Event ClassifyClick(Point point, const Rect& panel) {
  if (Finite(point.x) && Finite(point.y) && Inside(panel, point)) return Event::kInsideClick;
  return Event::kOutsideClick;
}

struct Focus {
  bool becomes_key = false;
  bool activates_app = false;
  bool shown = false;
  bool logged = false;
};

inline Focus FocusFor(bool background_instance, bool takes_focus, bool app_active, bool parent_is_key) {
  if (background_instance) return Focus{false, false, false, true};
  return Focus{takes_focus && app_active && parent_is_key, false, true, false};
}

inline bool ValidId(std::string_view id) {
  if (id.empty() || id.size() > 128) return false;
  return std::all_of(id.begin(), id.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
  });
}

inline bool MessageFits(std::optional<std::size_t> serialized_bytes) {
  return serialized_bytes && *serialized_bytes <= kMaxMessageBytes;
}

inline bool PropsFit(std::optional<std::size_t> serialized_bytes) {
  return serialized_bytes && *serialized_bytes <= kMaxPropsBytes;
}

inline bool ValidRoute(std::string_view route) {
  if (route.empty() || route.size() > 128 || route.front() == '/' || route.back() == '/' ||
      route.find("..") != std::string_view::npos || route.find("//") != std::string_view::npos) {
    return false;
  }
  return std::all_of(route.begin(), route.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
           c == '/' || c == '.';
  });
}

}

#endif
