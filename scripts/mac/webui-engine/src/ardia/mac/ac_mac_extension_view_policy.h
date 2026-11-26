#ifndef ARDIA_MAC_AC_MAC_EXTENSION_VIEW_POLICY_H_
#define ARDIA_MAC_AC_MAC_EXTENSION_VIEW_POLICY_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_system_policy.h"

namespace ardia_mac::extension_policy {

inline constexpr std::size_t kMaxSurfacesPerWindow = 4;
inline constexpr std::size_t kMaxActionIds = 64;
inline constexpr std::size_t kMaxPendingPrompts = 8;
inline constexpr std::size_t kMaxTabKey = 256;
inline constexpr std::size_t kMaxRequestId = 64;
inline constexpr std::size_t kMaxSurfaceUrl = 2048;
inline constexpr std::size_t kMaxIconBytes = 512 * 1024;
inline constexpr std::size_t kMaxCallJson = 1024 * 1024;
inline constexpr int kMaxFadeMs = 1000;
inline constexpr double kMaxCornerRadius = 64;
inline constexpr double kMaxCoordinate = 1e6;

inline constexpr int kPopupMinWidth = 25;
inline constexpr int kPopupMinHeight = 25;
inline constexpr int kPopupMaxWidth = 800;
inline constexpr int kPopupMaxHeight = 600;

inline constexpr std::string_view kSurfaceMethods[] = {"extensionView.create", "extensionView.viewport",
                                                       "extensionView.place", "extensionView.command",
                                                       "extensionView.release"};

inline constexpr std::string_view kExtensionCalls[] = {"extensions.actionStates", "extensions.sidePanelUrl",
                                                       "extensions.chooseFolder", "extensions.inspectUnpacked",
                                                       "extensions.resolveInstallPrompt"};

inline constexpr std::string_view kExecuteAction = "executeExtensionAction";

inline bool ValidExtensionId(std::string_view id) {
  return id.size() == 32 && std::all_of(id.begin(), id.end(), [](char c) { return c >= 'a' && c <= 'p'; });
}

inline bool ValidFolderPath(std::string_view path) {
  return path != "/" && system_policy::ValidLocalPath(path);
}

inline bool ValidTabKey(std::string_view key) {
  return !key.empty() && key.size() <= kMaxTabKey && !system_policy::Controls(key);
}

inline bool ValidRequestId(std::string_view id) {
  return !id.empty() && id.size() <= kMaxRequestId && !system_policy::Controls(id);
}

inline std::optional<std::string> ExtensionUrlHost(std::string_view url) {
  constexpr std::string_view kScheme = "chrome-extension://";
  if (!url.starts_with(kScheme) || url.size() > kMaxSurfaceUrl || system_policy::Controls(url) ||
      url.find(' ') != std::string_view::npos) {
    return std::nullopt;
  }
  const std::string_view rest = url.substr(kScheme.size());
  const std::string_view host = rest.substr(0, rest.find_first_of("/?#"));
  if (!ValidExtensionId(host) || (host.size() < rest.size() && rest[host.size()] != '/')) return std::nullopt;
  return std::string(host);
}

enum class SurfaceKind { kPopup, kSidePanel };

inline std::optional<SurfaceKind> SurfaceKindFor(std::string_view kind) {
  if (kind == "popup") return SurfaceKind::kPopup;
  if (kind == "sidePanel") return SurfaceKind::kSidePanel;
  return std::nullopt;
}

struct SurfaceEntry {
  SurfaceKind kind = SurfaceKind::kPopup;
  std::string extension_id;
  uint64_t generation = 0;
};

class SurfaceBook {
 public:
  std::optional<int> Open(SurfaceKind kind, std::string extension_id, uint64_t generation) {
    if (entries_.size() >= kMaxSurfacesPerWindow || !ValidExtensionId(extension_id) || next_ == INT32_MAX) {
      return std::nullopt;
    }
    const int id = ++next_;
    entries_.emplace(id, SurfaceEntry{kind, std::move(extension_id), generation});
    return id;
  }

  bool Close(int id) { return entries_.erase(id) != 0; }

  std::vector<int> CloseOlderThan(uint64_t generation) {
    std::vector<int> closed;
    for (auto it = entries_.begin(); it != entries_.end();) {
      if (it->second.generation < generation) {
        closed.push_back(it->first);
        it = entries_.erase(it);
      } else {
        ++it;
      }
    }
    return closed;
  }

  std::vector<int> CloseAll() {
    std::vector<int> closed;
    for (const auto& [id, entry] : entries_) closed.push_back(id);
    entries_.clear();
    return closed;
  }

  const SurfaceEntry* Find(int id) const {
    const auto found = entries_.find(id);
    return found == entries_.end() ? nullptr : &found->second;
  }

  bool Owns(int id, uint64_t generation) const {
    const SurfaceEntry* entry = Find(id);
    return entry && entry->generation == generation;
  }

  std::size_t size() const { return entries_.size(); }

 private:
  std::map<int, SurfaceEntry> entries_;
  int next_ = 0;
};

inline std::optional<int> SurfaceIdFrom(bool is_int, int value) {
  return is_int && value > 0 ? std::optional<int>(value) : std::nullopt;
}

struct PopupPlacement {
  double anchor_right = 0;
  double anchor_top = 0;
  double room_left = 0;
  double room_right = 0;
  double room_bottom = 0;

  bool operator==(const PopupPlacement&) const = default;
};

struct PopupLimits {
  int min_width = kPopupMinWidth;
  int min_height = kPopupMinHeight;
  int max_width = kPopupMaxWidth;
  int max_height = kPopupMaxHeight;

  bool operator==(const PopupLimits&) const = default;
};

struct Box {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  bool operator==(const Box&) const = default;
};

inline constexpr double kEdgeSlack = 1e-6;

inline bool Bounded(double value) {
  return std::isfinite(value) && std::abs(value) <= kMaxCoordinate;
}

inline int FloorDip(double value) {
  return static_cast<int>(std::floor(value + kEdgeSlack));
}

inline int CeilDip(double value) {
  return static_cast<int>(std::ceil(value - kEdgeSlack));
}

inline bool PlacementIsFinite(const PopupPlacement& p) {
  return Bounded(p.anchor_right) && Bounded(p.anchor_top) && Bounded(p.room_left) && Bounded(p.room_right) &&
         Bounded(p.room_bottom);
}

inline bool ValidZoom(double zoom) {
  return std::isfinite(zoom) && zoom >= 0.1 && zoom <= 10;
}

inline int PopupTop(const PopupPlacement& p, double zoom) {
  return static_cast<int>(std::lround(p.anchor_top * zoom));
}

inline std::optional<PopupLimits> PopupLimitsFor(const PopupPlacement& p, double zoom) {
  if (!PlacementIsFinite(p) || !ValidZoom(zoom)) return std::nullopt;
  const int span_width = FloorDip(p.room_right * zoom) - CeilDip(p.room_left * zoom);
  const int span_height = FloorDip(p.room_bottom * zoom) - PopupTop(p, zoom);
  if (span_width < 1 || span_height < 1) return std::nullopt;
  PopupLimits limits;
  limits.max_width = std::min(kPopupMaxWidth, span_width);
  limits.max_height = std::min(kPopupMaxHeight, span_height);
  limits.min_width = std::min(kPopupMinWidth, limits.max_width);
  limits.min_height = std::min(kPopupMinHeight, limits.max_height);
  return limits;
}

inline double PixelError(double base_px, int dip, double scale) {
  const double px = base_px + dip * scale;
  return std::abs(px - std::round(px));
}

inline int PixelAligned(int want, int low, int high, double base_px, double scale) {
  if (low > high) return want;
  want = std::clamp(want, low, high);
  if (PixelError(base_px, want, scale) < 0.01) return want;
  for (int step = 1; step <= 3; ++step) {
    for (const int candidate : {want - step, want + step}) {
      if (candidate >= low && candidate <= high && PixelError(base_px, candidate, scale) < 0.01) return candidate;
    }
  }
  return want;
}

inline std::optional<Box> PopupBoxFor(const PopupPlacement& p, double zoom, int preferred_width,
                                      int preferred_height, double origin_x_px, double origin_y_px,
                                      double device_scale) {
  const std::optional<PopupLimits> limits = PopupLimitsFor(p, zoom);
  if (!limits) return std::nullopt;
  const double scale = std::isfinite(device_scale) && device_scale > 0 && device_scale <= 8 ? device_scale : 1;
  const double base_x = std::isfinite(origin_x_px) ? origin_x_px : 0;
  const double base_y = std::isfinite(origin_y_px) ? origin_y_px : 0;
  Box box;
  box.width = std::clamp(preferred_width > 0 ? preferred_width : limits->min_width, limits->min_width,
                         limits->max_width);
  box.height = std::clamp(preferred_height > 0 ? preferred_height : limits->min_height, limits->min_height,
                          limits->max_height);
  const int low = CeilDip(p.room_left * zoom);
  const int high = FloorDip(p.room_right * zoom) - box.width;
  box.x = PixelAligned(static_cast<int>(std::lround(p.anchor_right * zoom)) - box.width, low, high, base_x, scale);
  const int top = PopupTop(p, zoom);
  box.y = PixelAligned(top, top, FloorDip(p.room_bottom * zoom) - box.height, base_y, scale);
  return box;
}

inline std::optional<Box> ViewportBox(double x, double y, double width, double height, double scale,
                                      double room_width, double room_height) {
  if (!Bounded(x) || !Bounded(y) || !Bounded(width) || !Bounded(height) || width < 0 || height < 0 ||
      !ValidZoom(scale) || !std::isfinite(room_width) || !std::isfinite(room_height) || room_width < 0 ||
      room_height < 0) {
    return std::nullopt;
  }
  const double left = std::clamp(x * scale, 0.0, room_width);
  const double top = std::clamp(y * scale, 0.0, room_height);
  const double right = std::clamp((x + width) * scale, left, room_width);
  const double bottom = std::clamp((y + height) * scale, top, room_height);
  const int box_left = static_cast<int>(std::ceil(left));
  const int box_top = static_cast<int>(std::ceil(top));
  const int box_right = static_cast<int>(std::floor(right));
  const int box_bottom = static_cast<int>(std::floor(bottom));
  return Box{box_left, box_top, std::max(0, box_right - box_left), std::max(0, box_bottom - box_top)};
}

inline double CornerRadius(double requested, double zoom) {
  if (!std::isfinite(requested) || requested <= 0 || !ValidZoom(zoom)) return 0;
  return std::min(requested, kMaxCornerRadius) * zoom;
}

inline bool ValidFade(int fade_ms) {
  return fade_ms >= 0 && fade_ms <= kMaxFadeMs;
}

inline bool ValidPopupRadius(double radius) {
  return std::isfinite(radius) && radius >= 0;
}

enum class SurfaceFocus { kNone, kStored, kTaken };

constexpr SurfaceFocus SurfaceFocusFor(bool shown, bool window_active) {
  if (!shown) return SurfaceFocus::kNone;
  return window_active ? SurfaceFocus::kTaken : SurfaceFocus::kStored;
}

inline std::optional<std::string> HexColor(uint32_t argb) {
  if (!(argb >> 24)) return std::nullopt;
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out = "#";
  for (const int shift : {20, 16, 12, 8, 4, 0}) out += kHex[(argb >> shift) & 15];
  return out;
}

inline std::string DisplayBadge(std::string_view text) {
  return text.starts_with("<<") ? std::string() : std::string(text);
}

inline constexpr int kPromptInstall = 0;
inline constexpr int kPromptReEnable = 3;
inline constexpr int kPromptPermissions = 4;
inline constexpr int kPromptExternal = 5;
inline constexpr int kPromptRemote = 8;
inline constexpr int kPromptRepair = 9;

inline std::string_view PromptTypeName(int type) {
  switch (type) {
    case kPromptInstall:
      return "install";
    case kPromptReEnable:
      return "re-enable";
    case kPromptPermissions:
      return "permissions";
    case kPromptExternal:
      return "external";
    case kPromptRemote:
      return "remote";
    case kPromptRepair:
      return "repair";
    default:
      return "other";
  }
}

inline std::optional<std::string> ResourcePath(std::string_view relative) {
  while (relative.starts_with("/")) relative.remove_prefix(1);
  if (relative.empty() || relative.size() > system_policy::kMaxPathBytes || system_policy::Controls(relative) ||
      relative.find('\\') != std::string_view::npos) {
    return std::nullopt;
  }
  std::size_t start = 0;
  while (start <= relative.size()) {
    const std::size_t end = std::min(relative.find('/', start), relative.size());
    const std::string_view part = relative.substr(start, end - start);
    if (part.empty() || part == "." || part == "..") return std::nullopt;
    start = end + 1;
  }
  return std::string(relative);
}

inline std::string_view ImageMimeType(std::string_view path) {
  std::string lower;
  for (const char c : path.substr(path.rfind('.') == std::string_view::npos ? path.size() : path.rfind('.'))) {
    lower.push_back(system_policy::Lower(c));
  }
  if (lower == ".png") return "image/png";
  if (lower == ".jpg" || lower == ".jpeg") return "image/jpeg";
  if (lower == ".gif") return "image/gif";
  if (lower == ".webp") return "image/webp";
  if (lower == ".svg") return "image/svg+xml";
  if (lower == ".bmp") return "image/bmp";
  if (lower == ".ico") return "image/x-icon";
  return "";
}

enum class PromptResolve { kResolved, kUnknown, kWrongWindow, kWrongProfile };

template <typename Pending>
class PromptLedger {
 public:
  struct Entry {
    std::string profile;
    std::string window;
    Pending pending;
  };

  bool full() const { return entries_.size() >= kMaxPendingPrompts; }

  std::optional<std::string> Add(std::string profile, std::string window, Pending pending) {
    if (full()) return std::nullopt;
    std::string id = "install" + std::to_string(++next_);
    entries_.emplace(id, Entry{std::move(profile), std::move(window), std::move(pending)});
    return id;
  }

  PromptResolve Check(std::string_view id, std::string_view window, std::string_view profile) const {
    const auto found = entries_.find(std::string(id));
    if (found == entries_.end()) return PromptResolve::kUnknown;
    if (found->second.profile != profile) return PromptResolve::kWrongProfile;
    if (found->second.window != window) return PromptResolve::kWrongWindow;
    return PromptResolve::kResolved;
  }

  std::optional<Pending> Take(std::string_view id) {
    const auto found = entries_.find(std::string(id));
    if (found == entries_.end()) return std::nullopt;
    std::optional<Pending> pending(std::move(found->second.pending));
    entries_.erase(found);
    return pending;
  }

  std::vector<std::string> OfWindow(std::string_view window) const {
    std::vector<std::string> ids;
    for (const auto& [id, entry] : entries_) {
      if (entry.window == window) ids.push_back(id);
    }
    return ids;
  }

  std::size_t size() const { return entries_.size(); }

 private:
  std::map<std::string, Entry> entries_;
  uint64_t next_ = 0;
};

}

#endif
