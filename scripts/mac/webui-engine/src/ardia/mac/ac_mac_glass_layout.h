#ifndef ARDIA_MAC_AC_MAC_GLASS_LAYOUT_H_
#define ARDIA_MAC_AC_MAC_GLASS_LAYOUT_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

namespace ardia_mac::glass {

inline constexpr std::size_t kMaxRegions = 64;
inline constexpr std::size_t kMaxIdLength = 128;
inline constexpr double kMaxCoordinate = 1e6;
inline constexpr double kMaxBlur = 200;

struct Rect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;

  double right() const { return x + width; }
  double bottom() const { return y + height; }
  bool empty() const { return !(width > 0) || !(height > 0); }
  bool operator==(const Rect&) const = default;
};

struct Point {
  double x = 0;
  double y = 0;
};

struct Radii {
  double upper_left = 0;
  double upper_right = 0;
  double lower_right = 0;
  double lower_left = 0;
  bool operator==(const Radii&) const = default;
};

enum class Layer { kAuto, kBehind, kOverPage };

enum class Material {
  kLiquid,
  kLiquidClear,
  kSidebar,
  kHeader,
  kMenu,
  kPopover,
  kHud,
  kWindow,
  kUnderWindow,
  kWindowTreatment,
};

enum class Plane { kBehindWindow, kOverPage };

enum class Effect { kLiquidGlass, kVibrancy };

enum class Source { kGlass, kBackdrop };

enum class Appearance { kAuto, kLight, kDark };

struct Color {
  double red = 0;
  double green = 0;
  double blue = 0;
  double alpha = 1;
  bool operator==(const Color&) const = default;
};

struct Region {
  std::string id;
  Rect rect;
  Radii radii;
  double opacity = 1;
  double blur = 24;
  Layer layer = Layer::kAuto;
  Material material = Material::kLiquid;
  Source source = Source::kGlass;
  std::optional<Color> tint;
  std::string group;
  Appearance appearance = Appearance::kAuto;
};

struct Page {
  int id = 0;
  Rect rect;
};

struct Placement {
  std::string id;
  Plane plane = Plane::kBehindWindow;
  int page = 0;
  Rect frame;
  Rect visible;
  double radius = 0;
  std::uint8_t corners = 0;
  double opacity = 1;
  Material material = Material::kLiquid;
  std::size_t order = 0;
  Source source = Source::kGlass;
  Radii radii;
  std::optional<Color> tint;
  std::string group;
  Appearance appearance = Appearance::kAuto;
  int slice = 0;
  Rect outline;
  bool seamed = false;
  bool operator==(const Placement&) const = default;
};

struct Rejection {
  std::string id;
  std::string reason;
};

struct Layout {
  std::vector<Placement> placements;
  std::vector<std::string> accepted;
  std::vector<Rejection> rejected;
  std::set<std::string> partial;
};

struct SlotKey {
  Plane plane = Plane::kBehindWindow;
  int page = 0;
  Source source = Source::kGlass;
  std::string id;
  int slice = 0;
  auto operator<=>(const SlotKey&) const = default;
};

inline SlotKey KeyOf(const Placement& placement) {
  return SlotKey{placement.plane, placement.page, placement.source, placement.id, placement.slice};
}

struct Diff {
  std::vector<Placement> create;
  std::vector<Placement> update;
  std::vector<SlotKey> remove;
};

inline constexpr std::uint8_t kUpperLeft = 1;
inline constexpr std::uint8_t kUpperRight = 2;
inline constexpr std::uint8_t kLowerRight = 4;
inline constexpr std::uint8_t kLowerLeft = 8;
inline constexpr std::uint8_t kAllCorners = 15;

inline bool Finite(double value) {
  return std::isfinite(value);
}

inline std::optional<Layer> LayerNamed(std::string_view name) {
  if (name.empty() || name == "auto") return Layer::kAuto;
  if (name == "behind" || name == "window" || name == "sidebar") return Layer::kBehind;
  if (name == "over_page" || name == "overPage" || name == "page") return Layer::kOverPage;
  return std::nullopt;
}

inline std::optional<Material> MaterialNamed(std::string_view name) {
  if (name.empty() || name == "liquid" || name == "regular") return Material::kLiquid;
  if (name == "clear") return Material::kLiquidClear;
  if (name == "sidebar") return Material::kSidebar;
  if (name == "header") return Material::kHeader;
  if (name == "menu") return Material::kMenu;
  if (name == "popover") return Material::kPopover;
  if (name == "hud") return Material::kHud;
  if (name == "window") return Material::kWindow;
  if (name == "under" || name == "underWindow") return Material::kUnderWindow;
  if (name == "windowTreatment") return Material::kWindowTreatment;
  return std::nullopt;
}

inline std::optional<Appearance> AppearanceNamed(std::string_view name) {
  if (name.empty() || name == "auto") return Appearance::kAuto;
  if (name == "light") return Appearance::kLight;
  if (name == "dark") return Appearance::kDark;
  return std::nullopt;
}

inline std::optional<double> ColorNumber(std::string_view text) {
  while (!text.empty() && text.front() == ' ') text.remove_prefix(1);
  while (!text.empty() && text.back() == ' ') text.remove_suffix(1);
  if (text.empty() || text.size() > 16) return std::nullopt;
  double whole = 0;
  double fraction = 0;
  double scale = 1;
  bool dot = false;
  bool digits = false;
  for (const char c : text) {
    if (c == '.' && !dot) {
      dot = true;
      continue;
    }
    if (c < '0' || c > '9') return std::nullopt;
    digits = true;
    if (dot) {
      scale /= 10;
      fraction += (c - '0') * scale;
    } else {
      whole = whole * 10 + (c - '0');
    }
  }
  if (!digits) return std::nullopt;
  return whole + fraction;
}

inline std::optional<int> HexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return std::nullopt;
}

inline std::optional<Color> ColorFrom(std::string_view text) {
  if (text.empty() || text.size() > 64) return std::nullopt;
  if (text.front() == '#') {
    const std::string_view hex = text.substr(1);
    if (hex.size() != 3 && hex.size() != 6 && hex.size() != 8) return std::nullopt;
    double channels[4] = {0, 0, 0, 1};
    const bool short_form = hex.size() == 3;
    const std::size_t count = short_form ? 3 : hex.size() / 2;
    for (std::size_t index = 0; index < count; ++index) {
      const std::optional<int> high = HexDigit(hex[short_form ? index : index * 2]);
      const std::optional<int> low = HexDigit(hex[short_form ? index : index * 2 + 1]);
      if (!high || !low) return std::nullopt;
      channels[index] = (*high * 16 + *low) / 255.0;
    }
    return Color{channels[0], channels[1], channels[2], channels[3]};
  }
  const bool alpha = text.starts_with("rgba(");
  if ((!alpha && !text.starts_with("rgb(")) || text.back() != ')') return std::nullopt;
  std::string_view inner = text.substr(alpha ? 5 : 4);
  inner.remove_suffix(1);
  double channels[4] = {0, 0, 0, 1};
  std::size_t count = 0;
  while (true) {
    const std::size_t comma = inner.find(',');
    if (count >= 4) return std::nullopt;
    const std::optional<double> value = ColorNumber(inner.substr(0, comma));
    if (!value) return std::nullopt;
    channels[count++] = *value;
    if (comma == std::string_view::npos) break;
    inner.remove_prefix(comma + 1);
  }
  if (count != (alpha ? 4u : 3u)) return std::nullopt;
  for (std::size_t index = 0; index < 3; ++index) {
    if (channels[index] > 255) return std::nullopt;
    channels[index] /= 255.0;
  }
  if (channels[3] > 1) return std::nullopt;
  return Color{channels[0], channels[1], channels[2], channels[3]};
}

constexpr int kTreatmentMaterialDark = 29;
constexpr int kTreatmentMaterialLight = 13;

inline int TreatmentMaterial(bool dark) {
  return dark ? kTreatmentMaterialDark : kTreatmentMaterialLight;
}

inline Effect EffectFor(Material material, bool liquid_glass_available) {
  const bool liquid = material == Material::kLiquid || material == Material::kLiquidClear;
  return liquid && liquid_glass_available ? Effect::kLiquidGlass : Effect::kVibrancy;
}

inline bool ValidId(std::string_view id) {
  if (id.empty() || id.size() > kMaxIdLength) return false;
  return std::all_of(id.begin(), id.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' ||
           c == '_' || c == ':' || c == '.';
  });
}

inline bool ValidGroup(std::string_view group) {
  return group.empty() || ValidId(group);
}

inline bool ValidRect(const Rect& rect) {
  return Finite(rect.x) && Finite(rect.y) && Finite(rect.width) && Finite(rect.height) && rect.width >= 0 &&
         rect.height >= 0 && std::abs(rect.x) <= kMaxCoordinate && std::abs(rect.y) <= kMaxCoordinate &&
         rect.width <= kMaxCoordinate && rect.height <= kMaxCoordinate;
}

inline Rect Intersect(const Rect& a, const Rect& b) {
  const double left = std::max(a.x, b.x);
  const double top = std::max(a.y, b.y);
  const double right = std::min(a.right(), b.right());
  const double bottom = std::min(a.bottom(), b.bottom());
  if (!(right > left) || !(bottom > top)) return Rect{};
  return Rect{left, top, right - left, bottom - top};
}

inline Rect Offset(const Rect& rect, double dx, double dy) {
  return Rect{rect.x - dx, rect.y - dy, rect.width, rect.height};
}

inline Rect Scaled(const Rect& rect, double scale) {
  return Rect{rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale};
}

inline bool Contains(const Rect& rect, Point point) {
  return point.x >= rect.x && point.x < rect.right() && point.y >= rect.y && point.y < rect.bottom();
}

inline std::optional<Radii> SanitizedRadii(const Radii& radii, double width, double height, double scale) {
  const double raw[4] = {radii.upper_left, radii.upper_right, radii.lower_right, radii.lower_left};
  double scaled[4] = {};
  for (int corner = 0; corner < 4; ++corner) {
    if (!Finite(raw[corner])) return std::nullopt;
    scaled[corner] = std::max(0.0, raw[corner]) * scale;
  }
  double factor = 1;
  const auto fit = [&factor](double side, double first, double second) {
    const double sum = first + second;
    if (sum > side && sum > 0) factor = std::min(factor, side / sum);
  };
  fit(width, scaled[0], scaled[1]);
  fit(height, scaled[1], scaled[2]);
  fit(width, scaled[3], scaled[2]);
  fit(height, scaled[0], scaled[3]);
  return Radii{scaled[0] * factor, scaled[1] * factor, scaled[2] * factor, scaled[3] * factor};
}

inline double UniformRadius(const Radii& radii) {
  return std::max({radii.upper_left, radii.upper_right, radii.lower_right, radii.lower_left});
}

inline std::uint8_t CornerMask(const Radii& radii) {
  std::uint8_t mask = 0;
  if (radii.upper_left > 0) mask |= kUpperLeft;
  if (radii.upper_right > 0) mask |= kUpperRight;
  if (radii.lower_right > 0) mask |= kLowerRight;
  if (radii.lower_left > 0) mask |= kLowerLeft;
  return mask;
}

struct CornerShape {
  bool uniform = true;
  Radii radii;
};

inline CornerShape ShapeFor(const Radii& radii) {
  const auto clean = [](double value) { return Finite(value) && value > 0 ? value : 0.0; };
  const Radii safe{clean(radii.upper_left), clean(radii.upper_right), clean(radii.lower_right), clean(radii.lower_left)};
  const bool uniform = safe.upper_left == safe.upper_right && safe.upper_right == safe.lower_right &&
                       safe.lower_right == safe.lower_left;
  return CornerShape{uniform, safe};
}

inline double NativeCornerRadius(const CornerShape& shape) {
  return shape.uniform ? shape.radii.upper_left : 0;
}

inline constexpr float kUnderShellFill = 0.01f;

inline bool MountsUnderShell(Plane plane) {
  return plane == Plane::kOverPage;
}

inline double UnderShellBlur(double css_blur, double shell_scale) {
  const double scale = Finite(shell_scale) && shell_scale > 0.05 && shell_scale < 20 ? shell_scale : 1;
  const double blur = Finite(css_blur) ? std::clamp(css_blur, 0.0, kMaxBlur) : 0;
  return blur * scale;
}

inline int GlassStyle(Material material) {
  return material == Material::kLiquidClear ? 1 : 0;
}

inline double SanitizedScale(double scale) {
  return Finite(scale) && scale > 0.05 && scale < 20 ? scale : 1;
}

inline void Subtract(std::vector<Rect>& region, const Rect& cut) {
  if (cut.empty()) return;
  std::vector<Rect> remaining;
  for (const Rect& piece : region) {
    const Rect overlap = Intersect(piece, cut);
    if (overlap.empty()) {
      remaining.push_back(piece);
      continue;
    }
    if (overlap.y > piece.y) remaining.push_back(Rect{piece.x, piece.y, piece.width, overlap.y - piece.y});
    if (overlap.bottom() < piece.bottom())
      remaining.push_back(Rect{piece.x, overlap.bottom(), piece.width, piece.bottom() - overlap.bottom()});
    if (overlap.x > piece.x) remaining.push_back(Rect{piece.x, overlap.y, overlap.x - piece.x, overlap.height});
    if (overlap.right() < piece.right())
      remaining.push_back(Rect{overlap.right(), overlap.y, piece.right() - overlap.right(), overlap.height});
  }
  region = std::move(remaining);
}

struct SliceMask {
  bool active = false;
  Rect outline;
  Radii radii;
};

inline SliceMask MaskFor(const Placement& placement) {
  if (placement.slice <= 0 && !placement.seamed) return SliceMask{};
  return SliceMask{true, Offset(placement.outline, placement.frame.x, placement.frame.y), placement.radii};
}

inline Layout Lay(const std::vector<Region>& regions,
                  const std::vector<Page>& pages,
                  const Rect& window,
                  double shell_scale) {
  Layout layout;
  const double scale = SanitizedScale(shell_scale);
  std::set<std::pair<Source, std::string>> seen;
  std::size_t behind_order = 0;
  std::vector<std::size_t> page_order(pages.size(), 0);
  for (const Region& region : regions) {
    const auto reject = [&](std::string reason) { layout.rejected.push_back({region.id, std::move(reason)}); };
    if (!ValidId(region.id)) {
      reject("id");
      continue;
    }
    if (seen.contains({region.source, region.id})) {
      reject("duplicate");
      continue;
    }
    if (layout.accepted.size() >= kMaxRegions) {
      reject("limit");
      continue;
    }
    if (!ValidRect(region.rect) || region.rect.empty()) {
      reject("rect");
      continue;
    }
    if (!Finite(region.opacity) || !Finite(region.blur) || region.blur < 0 || region.blur > kMaxBlur) {
      reject("style");
      continue;
    }
    if (!ValidGroup(region.group)) {
      reject("group");
      continue;
    }
    const Rect rect = Scaled(region.rect, scale);
    const std::optional<Radii> radii = SanitizedRadii(region.radii, rect.width, rect.height, scale);
    if (!radii) {
      reject("radii");
      continue;
    }
    seen.insert({region.source, region.id});
    layout.accepted.push_back(region.id);
    const double opacity = std::clamp(region.opacity, 0.0, 1.0);
    if (opacity <= 0) continue;
    const auto place = [&](Plane plane, int page, const Rect& origin, const Rect& clip, std::size_t order) {
      const Rect visible = Intersect(rect, clip);
      if (visible.empty()) return false;
      layout.placements.push_back(Placement{region.id, plane, page, Offset(rect, origin.x, origin.y),
                                            Offset(visible, origin.x, origin.y), UniformRadius(*radii),
                                            CornerMask(*radii), opacity, region.material, order,
                                            region.source, *radii, region.tint, region.group,
                                            region.appearance, 0, Rect{}});
      return true;
    };
    bool on_page = false;
    const std::size_t first_placement = layout.placements.size();
    std::vector<Rect> uncovered;
    if (ValidRect(window)) {
      const Rect shown = Intersect(rect, window);
      if (!shown.empty()) uncovered.push_back(shown);
    }
    if (region.layer != Layer::kBehind) {
      for (std::size_t index = 0; index < pages.size(); ++index) {
        const Page& page = pages[index];
        if (!ValidRect(page.rect) || page.rect.empty() || page.id <= 0) continue;
        if (place(Plane::kOverPage, page.id, page.rect, page.rect, page_order[index])) {
          ++page_order[index];
          on_page = true;
          Subtract(uncovered, page.rect);
        }
      }
    }
    if (!on_page && ValidRect(window) && place(Plane::kBehindWindow, 0, Rect{}, window, behind_order)) {
      ++behind_order;
    } else if (on_page) {
      int slice = 0;
      for (const Rect& piece : uncovered) {
        if (piece.empty()) continue;
        layout.placements.push_back(Placement{region.id, Plane::kBehindWindow, 0, piece, piece, UniformRadius(*radii),
                                              CornerMask(*radii), opacity, region.material, behind_order++,
                                              region.source, *radii, region.tint, region.group, region.appearance,
                                              ++slice, rect});
      }
      for (std::size_t index = first_placement; slice > 0 && index < layout.placements.size(); ++index) {
        Placement& placement = layout.placements[index];
        if (placement.plane != Plane::kOverPage) continue;
        placement.seamed = true;
        placement.outline = placement.frame;
      }
    }
  }
  return layout;
}

inline std::optional<int> PresentableGeneration(double raw) {
  if (!Finite(raw) || raw < 0 || raw > 2147483647.0 || std::floor(raw) != raw) return std::nullopt;
  return static_cast<int>(raw);
}

inline int ClampToInt(double value, double limit = kMaxCoordinate) {
  if (!Finite(value)) return 0;
  return static_cast<int>(std::lround(std::clamp(value, -limit, limit)));
}

inline std::vector<Region> Mounted(const std::vector<Region>& backdrops, const std::vector<Region>& glass) {
  std::vector<Region> all;
  all.reserve(backdrops.size() + glass.size());
  for (Region backdrop : backdrops) {
    backdrop.source = Source::kBackdrop;
    all.push_back(std::move(backdrop));
  }
  for (Region region : glass) {
    region.source = Source::kGlass;
    all.push_back(std::move(region));
  }
  return all;
}

inline std::vector<Page> MountablePages(const std::vector<Page>& pages, const std::set<int>& with_native_view) {
  std::vector<Page> mountable;
  for (const Page& page : pages) {
    if (with_native_view.contains(page.id)) mountable.push_back(page);
  }
  return mountable;
}

inline Layout KeepAttached(Layout layout, const std::set<SlotKey>& attached) {
  std::erase_if(layout.placements, [&attached, &layout](const Placement& placement) {
    const bool kept = attached.contains(KeyOf(placement));
    if (!kept) layout.partial.insert(placement.id);
    return !kept;
  });
  return layout;
}

inline std::vector<std::string> MountedGlass(const std::vector<Placement>& placements) {
  std::vector<std::string> mounted;
  std::set<std::string> seen;
  for (const Placement& placement : placements) {
    if (placement.source == Source::kGlass && seen.insert(placement.id).second) mounted.push_back(placement.id);
  }
  return mounted;
}

inline std::vector<std::string> MountedGlass(const Layout& mounted) {
  std::vector<std::string> whole = MountedGlass(mounted.placements);
  std::erase_if(whole, [&mounted](const std::string& id) { return mounted.partial.contains(id); });
  return whole;
}

class PresentedGate {
 public:
  struct Ticket {
    std::uint64_t epoch = 0;
    int generation = 0;
  };

  Ticket Issue(int generation) const { return Ticket{epoch_, generation}; }
  void Invalidate() { ++epoch_; }
  bool Live(const Ticket& ticket) const { return ticket.epoch == epoch_; }

 private:
  std::uint64_t epoch_ = 0;
};

struct GroupKey {
  Plane plane = Plane::kBehindWindow;
  int page = 0;
  std::string group;
  auto operator<=>(const GroupKey&) const = default;
};

inline bool Grouped(const Placement& placement, bool groups_glass) {
  return groups_glass && !placement.group.empty() && placement.source == Source::kGlass &&
         EffectFor(placement.material, true) == Effect::kLiquidGlass;
}

inline GroupKey GroupOf(const Placement& placement) {
  return GroupKey{placement.plane, placement.page, placement.group};
}

inline std::set<GroupKey> LiveGroups(const std::vector<Placement>& placements, bool groups_glass) {
  std::set<GroupKey> live;
  for (const Placement& placement : placements) {
    if (Grouped(placement, groups_glass)) live.insert(GroupOf(placement));
  }
  return live;
}


inline Diff DiffPlacements(const std::vector<Placement>& before,
                           const std::vector<Placement>& after,
                           bool liquid_glass_available) {
  Diff diff;
  std::vector<std::pair<SlotKey, const Placement*>> old;
  old.reserve(before.size());
  for (const Placement& placement : before) old.emplace_back(KeyOf(placement), &placement);
  std::sort(old.begin(), old.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  std::set<SlotKey> kept;
  for (const Placement& placement : after) {
    const SlotKey key = KeyOf(placement);
    const auto found = std::lower_bound(old.begin(), old.end(), key,
                                        [](const auto& entry, const SlotKey& wanted) { return entry.first < wanted; });
    if (found == old.end() || !(found->first == key)) {
      diff.create.push_back(placement);
      continue;
    }
    const Placement& previous = *found->second;
    if (EffectFor(previous.material, liquid_glass_available) != EffectFor(placement.material, liquid_glass_available)) {
      diff.remove.push_back(key);
      diff.create.push_back(placement);
      continue;
    }
    kept.insert(key);
    if (!(previous == placement)) diff.update.push_back(placement);
  }
  for (const auto& [key, placement] : old) {
    const bool still = std::any_of(after.begin(), after.end(), [&key](const Placement& p) { return KeyOf(p) == key; });
    if (!still) diff.remove.push_back(key);
  }
  return diff;
}

inline std::vector<Rect> PassThrough(const std::vector<Rect>& pages, const std::vector<Rect>& overlays) {
  std::vector<Rect> pass;
  for (const Rect& page : pages) {
    if (!ValidRect(page) || page.empty()) continue;
    std::vector<Rect> open{page};
    for (const Rect& overlay : overlays) {
      if (ValidRect(overlay)) Subtract(open, overlay);
    }
    pass.insert(pass.end(), open.begin(), open.end());
  }
  return pass;
}

inline bool Passes(const std::vector<Rect>& pass, Point point) {
  if (!Finite(point.x) || !Finite(point.y)) return false;
  return std::any_of(pass.begin(), pass.end(), [point](const Rect& rect) { return Contains(rect, point); });
}

}

#endif
