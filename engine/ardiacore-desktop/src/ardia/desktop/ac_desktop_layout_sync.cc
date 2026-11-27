#include "ardia/desktop/ac_desktop_layout_sync.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace ardia::desktop_layout_sync {

namespace {

double RoundHalfUp(double value) { return std::floor(value + 0.5); }

bool Finite(double value) { return std::isfinite(value); }

double NonNegative(double value) { return Finite(value) && value > 0 ? std::min(value, kMaxExtent) : 0; }

double Band(double over) { return kRubberBand * (1 - std::exp(-over / kRubberBandScale)); }

double Unband(double stretch) {
  return -kRubberBandScale * std::log(1 - std::min(stretch, kRubberBand - 0.01) / kRubberBand);
}

double Px(double dip, double scale) { return Finite(dip) ? RoundHalfUp(dip * scale) : 0; }

int64_t SaturatingAdd(int64_t base, int64_t amount) {
  return base > std::numeric_limits<int64_t>::max() - amount ? std::numeric_limits<int64_t>::max() : base + amount;
}

struct Span {
  double start = 0;
  double size = 0;
};

std::vector<Span> Cut(double total, const std::vector<double>& sizes, double gap) {
  const double free = std::max(0.0, total - gap * static_cast<double>(sizes.size() - 1));
  std::vector<Span> spans;
  spans.reserve(sizes.size());
  double at = 0;
  double used = 0;
  for (size_t i = 0; i < sizes.size(); ++i) {
    const double size = i + 1 == sizes.size() ? std::max(0.0, free - used) : RoundHalfUp(free * sizes[i]);
    spans.push_back({at, size});
    at += size + gap;
    used += size;
  }
  return spans;
}

struct Edge {
  double start = 0;
  double end = 0;
};

std::vector<Edge> PixelEdges(double low, double high, const std::vector<double>& sizes, double gap, double scale) {
  const double origin = low / scale;
  const std::vector<Span> spans = Cut((high - low) / scale, sizes, gap);
  std::vector<Edge> edges;
  edges.reserve(spans.size());
  double previous_end = low;
  for (size_t i = 0; i < spans.size(); ++i) {
    double start = i == 0 ? low : gap == 0 ? previous_end : Px(origin + spans[i].start, scale);
    start = std::clamp(start, previous_end, high);
    double end = i + 1 == spans.size() ? high : Px(origin + (spans[i].start + spans[i].size), scale);
    end = std::clamp(end, start, high);
    edges.push_back({start, end});
    previous_end = end;
  }
  return edges;
}

Rect DipRect(double left, double top, double right, double bottom, double scale) {
  return Rect{left / scale, top / scale, (right - left) / scale, (bottom - top) / scale};
}

PixelRect Pixels(double left, double top, double right, double bottom) {
  return PixelRect{static_cast<int>(left), static_cast<int>(top), static_cast<int>(right - left),
                   static_cast<int>(bottom - top)};
}

PaneLayout Pane(size_t slot, size_t stack_index, double left, double top, double right, double bottom,
                double scale) {
  return PaneLayout{slot, stack_index, DipRect(left, top, right, bottom, scale), Pixels(left, top, right, bottom)};
}

DividerLayout Divider(DividerRef ref, bool vertical, double left, double top, double right, double bottom,
                      double scale) {
  return DividerLayout{ref, vertical, DipRect(left, top, right, bottom, scale), Pixels(left, top, right, bottom)};
}

bool ValidRect(const Rect& rect) {
  return Finite(rect.x) && Finite(rect.y) && Finite(rect.width) && Finite(rect.height) && rect.width >= 0 &&
         rect.height >= 0 && std::abs(rect.x) <= kMaxExtent && std::abs(rect.y) <= kMaxExtent &&
         rect.width <= kMaxExtent && rect.height <= kMaxExtent;
}

bool ValidWindow(const WindowFrame& window) {
  return Finite(window.width) && Finite(window.height) && window.width > 0 && window.height > 0 &&
         window.width <= kMaxExtent && window.height <= kMaxExtent;
}

std::array<double, 2> NormalizedPair(const std::array<double, 2>& pair) {
  const double first = Finite(pair[0]) && pair[0] > 0 ? pair[0] : 0;
  const double second = Finite(pair[1]) && pair[1] > 0 ? pair[1] : 0;
  const double sum = first + second;
  if (!(sum > 0) || !Finite(sum)) return {0.5, 0.5};
  return {first / sum, second / sum};
}

double RatioOf(const std::vector<SplitSlot>& slots, DividerRef ref) {
  if (ref.kind == DividerKind::kStack) {
    const double pair = slots[ref.index].stack_sizes[0] + slots[ref.index].stack_sizes[1];
    return pair > 0 ? slots[ref.index].stack_sizes[0] / pair : 0.5;
  }
  const double pair = slots[ref.index].size + slots[ref.index + 1].size;
  return pair > 0 ? slots[ref.index].size / pair : 0.5;
}

std::optional<DividerRef> RatioDivider(const std::vector<SplitSlot>& slots, std::optional<DividerRef> active,
                                       DividerRef preferred) {
  if (active && HasDivider(slots, *active)) return active;
  if (HasDivider(slots, preferred)) return preferred;
  if (HasDivider(slots, DividerRef{DividerKind::kRoot, 0})) return DividerRef{DividerKind::kRoot, 0};
  if (HasDivider(slots, DividerRef{DividerKind::kStack, 0})) return DividerRef{DividerKind::kStack, 0};
  return std::nullopt;
}

double SplitTotal(const LayoutInput& input, const Rect& content, DividerRef ref) {
  const bool horizontal = input.orientation == SplitOrientation::kHorizontal;
  const bool along_width = ref.kind == DividerKind::kRoot ? horizontal : !horizontal;
  return along_width ? content.width : content.height;
}

}

LayoutInput::LayoutInput() = default;
LayoutInput::LayoutInput(const LayoutInput&) = default;
LayoutInput::LayoutInput(LayoutInput&&) = default;
LayoutInput& LayoutInput::operator=(const LayoutInput&) = default;
LayoutInput& LayoutInput::operator=(LayoutInput&&) = default;
LayoutInput::~LayoutInput() = default;

LayoutSnapshot::LayoutSnapshot() = default;
LayoutSnapshot::LayoutSnapshot(const LayoutSnapshot&) = default;
LayoutSnapshot::LayoutSnapshot(LayoutSnapshot&&) = default;
LayoutSnapshot& LayoutSnapshot::operator=(const LayoutSnapshot&) = default;
LayoutSnapshot& LayoutSnapshot::operator=(LayoutSnapshot&&) = default;
LayoutSnapshot::~LayoutSnapshot() = default;

double SidebarWidthLimit(double window_width) {
  if (!Finite(window_width) || window_width <= 0) return kSidebarMaxWidth;
  return std::min(kSidebarMaxWidth, std::max(kSidebarMinWidth, std::floor(window_width - kSidebarPageRoom)));
}

double ShownSidebarWidth(double saved, double window_width) {
  const double width = Finite(saved) && saved > 0 ? saved : kDefaultSidebarWidth;
  return std::min(width, SidebarWidthLimit(window_width));
}

double RubberBand(double width, double min, double max) {
  if (!Finite(width)) return min;
  if (width > max) return max + Band(width - max);
  if (width < min) return min - Band(min - width);
  return width;
}

double Unstretch(double width, double min, double max) {
  if (!Finite(width)) return min;
  if (width > max) return max + Unband(width - max);
  if (width < min) return min - Unband(min - width);
  return width;
}

double ClampWidth(double width, double min, double max) {
  if (!Finite(width)) return min;
  return std::min(max, std::max(min, width));
}

double KeptSidebarWidth(double dragged, double limit, double saved) {
  return dragged >= limit ? std::max(dragged, Finite(saved) ? saved : dragged) : dragged;
}

double SanitizeDeviceScale(double scale) {
  if (!Finite(scale) || scale <= 0) return 1;
  return std::min(kMaxDeviceScale, std::max(kMinDeviceScale, scale));
}

double SnapToDevice(double dip, double device_scale) {
  if (!Finite(dip)) return 0;
  const double scale = SanitizeDeviceScale(device_scale);
  return RoundHalfUp(dip * scale) / scale;
}

PixelRect ToPixels(const Rect& rect, double device_scale) {
  if (!ValidRect(rect)) return {};
  const double scale = SanitizeDeviceScale(device_scale);
  const double left = Px(rect.x, scale);
  const double top = Px(rect.y, scale);
  const double right = std::max(left, Px(rect.x + rect.width, scale));
  const double bottom = std::max(top, Px(rect.y + rect.height, scale));
  return Pixels(left, top, right, bottom);
}

bool HasDivider(size_t count, size_t index) { return count >= 2 && index < count - 1; }

bool HasDivider(const std::vector<SplitSlot>& slots, DividerRef ref) {
  if (ref.kind == DividerKind::kStack) return ref.index < slots.size() && slots[ref.index].stacked;
  return HasDivider(slots.size(), ref.index);
}

std::vector<double> NormalizedSizes(const std::vector<double>& sizes) {
  if (sizes.empty() || sizes.size() > kMaxSlots) return {};
  std::vector<double> out;
  out.reserve(sizes.size());
  double sum = 0;
  for (const double size : sizes) {
    const double kept = Finite(size) && size > 0 ? size : 0;
    out.push_back(kept);
    sum += kept;
  }
  if (!(sum > 0) || !Finite(sum)) return std::vector<double>(sizes.size(), 1.0 / static_cast<double>(sizes.size()));
  for (double& size : out) size /= sum;
  return out;
}

std::vector<SplitSlot> NormalizedSlots(const std::vector<SplitSlot>& slots) {
  if (slots.empty() || slots.size() > kMaxSlots) return {};
  std::vector<double> sizes;
  sizes.reserve(slots.size());
  for (const SplitSlot& slot : slots) sizes.push_back(slot.size);
  sizes = NormalizedSizes(sizes);
  std::vector<SplitSlot> out = slots;
  for (size_t i = 0; i < out.size(); ++i) {
    out[i].size = sizes[i];
    out[i].stack_sizes = NormalizedPair(out[i].stack_sizes);
  }
  return out;
}

std::vector<double> ResizePair(const std::vector<double>& sizes, size_t index, double delta, double total, double gap) {
  if (!HasDivider(sizes.size(), index) || !Finite(delta) || !Finite(total) || !Finite(gap)) return sizes;
  const double free = std::max(1.0, total - gap * static_cast<double>(sizes.size() - 1));
  std::vector<double> px;
  px.reserve(sizes.size());
  for (const double size : sizes) px.push_back(size * free);
  const double pair = px[index] + px[index + 1];
  const double min = std::min({kMinPane, px[index], px[index + 1]});
  const double left = std::min(std::max(px[index] + delta, min), pair - min);
  px[index] = left;
  px[index + 1] = pair - left;
  for (double& size : px) size /= free;
  return px;
}

std::vector<double> EvenPair(const std::vector<double>& sizes, size_t index) {
  if (!HasDivider(sizes.size(), index)) return sizes;
  std::vector<double> out = sizes;
  const double half = (sizes[index] + sizes[index + 1]) / 2;
  out[index] = half;
  out[index + 1] = half;
  return out;
}

std::vector<SplitSlot> ResizeSlots(const std::vector<SplitSlot>& slots, DividerRef ref, double delta, double total,
                                   double gap) {
  if (!HasDivider(slots, ref)) return slots;
  std::vector<SplitSlot> out = slots;
  if (ref.kind == DividerKind::kStack) {
    const std::vector<double> pair = ResizePair({slots[ref.index].stack_sizes[0], slots[ref.index].stack_sizes[1]}, 0,
                                                delta, total, gap);
    out[ref.index].stack_sizes = {pair[0], pair[1]};
    return out;
  }
  std::vector<double> sizes;
  sizes.reserve(slots.size());
  for (const SplitSlot& slot : slots) sizes.push_back(slot.size);
  sizes = ResizePair(sizes, ref.index, delta, total, gap);
  for (size_t i = 0; i < out.size(); ++i) out[i].size = sizes[i];
  return out;
}

std::vector<SplitSlot> EvenSlots(const std::vector<SplitSlot>& slots, DividerRef ref) {
  if (!HasDivider(slots, ref)) return slots;
  std::vector<SplitSlot> out = slots;
  if (ref.kind == DividerKind::kStack) {
    out[ref.index].stack_sizes = {0.5, 0.5};
    return out;
  }
  const double half = (slots[ref.index].size + slots[ref.index + 1].size) / 2;
  out[ref.index].size = half;
  out[ref.index + 1].size = half;
  return out;
}

std::optional<LayoutSnapshot> ComputeLayout(const LayoutInput& input, uint64_t sequence,
                                            std::optional<DividerRef> active_divider) {
  if (!ValidWindow(input.window) || input.split_slots.size() > kMaxSlots) return std::nullopt;
  const double scale = SanitizeDeviceScale(input.window.device_scale);
  const double limit = SidebarWidthLimit(input.window.width);
  const double width = input.sidebar_live
                           ? std::min(limit + kRubberBand,
                                      std::max(kSidebarMinWidth - kRubberBand,
                                               Finite(input.sidebar_width) ? input.sidebar_width : kDefaultSidebarWidth))
                           : ShownSidebarWidth(input.sidebar_width, input.window.width);
  const bool collapsed = !input.sidebar_shown || (input.sidebar_live && Finite(input.collapse_below) &&
                                                  input.collapse_below > 0 && width < input.collapse_below);
  const double window_right = Px(input.window.width, scale);
  const double window_bottom = Px(input.window.height, scale);
  const double sidebar_px = collapsed ? 0 : std::clamp(Px(width, scale), 0.0, window_right);
  const bool left = input.side == SidebarSide::kLeft;
  const double sidebar_left = left ? 0 : window_right - sidebar_px;
  const double region_left = left ? sidebar_px : 0;
  const double region_right = left ? window_right : window_right - sidebar_px;
  const double content_left =
      std::min(region_right, Px(region_left / scale + NonNegative(input.card_insets.left), scale));
  const double content_right =
      std::max(content_left, Px(region_right / scale - NonNegative(input.card_insets.right), scale));
  const double content_top = std::min(window_bottom, Px(NonNegative(input.card_insets.top), scale));
  const double content_bottom =
      std::max(content_top, Px(window_bottom / scale - NonNegative(input.card_insets.bottom), scale));

  LayoutSnapshot out;
  out.sequence = sequence;
  out.device_scale = scale;
  out.sidebar_width = sidebar_px / scale;
  out.sidebar_collapsed = collapsed;
  out.sidebar = DipRect(sidebar_left, 0, sidebar_left + sidebar_px, window_bottom, scale);
  out.sidebar_pixels = Pixels(sidebar_left, 0, sidebar_left + sidebar_px, window_bottom);
  out.content = DipRect(content_left, content_top, content_right, content_bottom, scale);
  out.content_pixels = Pixels(content_left, content_top, content_right, content_bottom);

  out.split_slots = NormalizedSlots(input.split_slots);
  if (out.split_slots.empty()) {
    out.panes.push_back(Pane(0, 0, content_left, content_top, content_right, content_bottom, scale));
    out.css = {out.sidebar_width, 0, sequence};
    return out;
  }
  const bool horizontal = input.orientation == SplitOrientation::kHorizontal;
  const double gap = NonNegative(input.split_gap);
  const double main_low = horizontal ? content_left : content_top;
  const double main_high = horizontal ? content_right : content_bottom;
  const double cross_low = horizontal ? content_top : content_left;
  const double cross_high = horizontal ? content_bottom : content_right;
  std::vector<double> sizes;
  sizes.reserve(out.split_slots.size());
  for (const SplitSlot& slot : out.split_slots) sizes.push_back(slot.size);
  const std::vector<Edge> main = PixelEdges(main_low, main_high, sizes, gap, scale);
  const auto oriented = [&](double main_start, double main_end, double cross_start, double cross_end) {
    return horizontal ? std::array<double, 4>{main_start, cross_start, main_end, cross_end}
                      : std::array<double, 4>{cross_start, main_start, cross_end, main_end};
  };
  for (size_t i = 0; i < main.size(); ++i) {
    const SplitSlot& slot = out.split_slots[i];
    if (slot.stacked) {
      const std::vector<Edge> inner =
          PixelEdges(cross_low, cross_high, {slot.stack_sizes[0], slot.stack_sizes[1]}, gap, scale);
      for (size_t j = 0; j < inner.size(); ++j) {
        const auto box = oriented(main[i].start, main[i].end, inner[j].start, inner[j].end);
        out.panes.push_back(Pane(i, j, box[0], box[1], box[2], box[3], scale));
      }
      const auto bar = oriented(main[i].start, main[i].end, inner[0].end, inner[1].start);
      out.dividers.push_back(
          Divider(DividerRef{DividerKind::kStack, i}, !horizontal, bar[0], bar[1], bar[2], bar[3], scale));
    } else {
      const auto box = oriented(main[i].start, main[i].end, cross_low, cross_high);
      out.panes.push_back(Pane(i, 0, box[0], box[1], box[2], box[3], scale));
    }
    if (i + 1 < main.size()) {
      const auto bar = oriented(main[i].end, main[i + 1].start, cross_low, cross_high);
      out.dividers.push_back(
          Divider(DividerRef{DividerKind::kRoot, i}, horizontal, bar[0], bar[1], bar[2], bar[3], scale));
    }
  }
  if (active_divider && HasDivider(out.split_slots, *active_divider)) out.active_divider = active_divider;
  const std::optional<DividerRef> ratio = RatioDivider(out.split_slots, out.active_divider, input.ratio_divider);
  out.split_ratio = ratio ? RatioOf(out.split_slots, *ratio) : 1;
  out.css = {out.sidebar_width, out.split_ratio, sequence};
  return out;
}

LayoutDragSession::LayoutDragSession(LayoutInput input, uint64_t first_sequence) : sequence_(first_sequence) {
  input.sidebar_live = false;
  input.split_slots = NormalizedSlots(input.split_slots);
  input.window.device_scale = SanitizeDeviceScale(input.window.device_scale);
  input_ = input;
  before_drag_ = input;
  Apply(input, Drag{});
}

LayoutDragSession::~LayoutDragSession() = default;

bool LayoutDragSession::Apply(const LayoutInput& next, const Drag& drag) {
  if (sequence_ == std::numeric_limits<uint64_t>::max()) return false;
  if (drag.kind != DragKind::kNone && sequence_ + 1 == std::numeric_limits<uint64_t>::max()) return false;
  const std::optional<DividerRef> active =
      drag.kind == DragKind::kSplit ? std::optional<DividerRef>(drag.divider) : std::nullopt;
  std::optional<LayoutSnapshot> layout = ComputeLayout(next, sequence_ + 1, active);
  if (!layout) return false;
  layout->settle_target = drag.settle_target;
  input_ = next;
  drag_ = drag;
  ++sequence_;
  snapshot_ = std::move(*layout);
  return true;
}

double LayoutDragSession::SidebarWidthAt(const Drag& drag, double pointer, double max, bool* dragged) const {
  const double dx = pointer - drag.origin;
  *dragged = drag.dragged || dx != 0;
  const double direction = input_.side == SidebarSide::kLeft ? 1 : -1;
  return RubberBand((*dragged ? drag.grabbed : drag.rest) + direction * dx, kSidebarMinWidth, max);
}

std::optional<std::vector<SplitSlot>> LayoutDragSession::SlotsAt(const LayoutInput& next, const Drag& drag,
                                                                 double pointer) const {
  const std::optional<LayoutSnapshot> probe = ComputeLayout(next, 0);
  if (!probe) return std::nullopt;
  return ResizeSlots(split_start_, drag.divider, pointer - drag.origin, SplitTotal(next, probe->content, drag.divider),
                     NonNegative(next.split_gap));
}

bool LayoutDragSession::BeginSidebar(double pointer_x, double pointer_from_edge) {
  if (!Finite(pointer_x) || !Finite(pointer_from_edge) || drag_.kind == DragKind::kSplit) return false;
  const bool regrab = drag_.kind == DragKind::kSidebar;
  const LayoutInput before = regrab ? before_drag_ : input_;
  const double max = SidebarWidthLimit(input_.window.width);
  const double width = regrab ? input_.sidebar_width : ShownSidebarWidth(input_.sidebar_width, input_.window.width);
  const double direction = input_.side == SidebarSide::kLeft ? 1 : -1;
  Drag drag;
  drag.kind = DragKind::kSidebar;
  drag.origin = pointer_x;
  drag.last_pointer = pointer_x;
  drag.rest = Unstretch(width, kSidebarMinWidth, max);
  drag.grabbed = Unstretch(width + direction * pointer_from_edge, kSidebarMinWidth, max);
  drag.dragged = regrab;
  LayoutInput next = input_;
  next.sidebar_shown = true;
  next.sidebar_live = true;
  next.sidebar_width = RubberBand(drag.dragged ? drag.grabbed : drag.rest, kSidebarMinWidth, max);
  if (!Apply(next, drag)) return false;
  before_drag_ = before;
  return true;
}

bool LayoutDragSession::BeginSplit(DividerRef divider, double pointer) {
  if (!Finite(pointer) || drag_.kind != DragKind::kNone || !HasDivider(input_.split_slots, divider)) return false;
  const LayoutInput before = input_;
  std::vector<SplitSlot> start = NormalizedSlots(input_.split_slots);
  Drag drag;
  drag.kind = DragKind::kSplit;
  drag.origin = pointer;
  drag.last_pointer = pointer;
  drag.divider = divider;
  LayoutInput next = input_;
  next.ratio_divider = divider;
  if (!Apply(next, drag)) return false;
  before_drag_ = before;
  split_start_ = std::move(start);
  return true;
}

bool LayoutDragSession::Step(double pointer, LayoutInput& next, Drag& drag) const {
  if (!Finite(pointer)) return false;
  if (drag_.kind == DragKind::kSidebar && !drag_.settle_target) {
    drag.last_pointer = pointer;
    next.sidebar_width = SidebarWidthAt(drag_, pointer, SidebarWidthLimit(next.window.width), &drag.dragged);
    return true;
  }
  if (drag_.kind == DragKind::kSplit) {
    std::optional<std::vector<SplitSlot>> slots = SlotsAt(next, drag_, pointer);
    if (!slots) return false;
    drag.last_pointer = pointer;
    next.split_slots = std::move(*slots);
    return true;
  }
  return false;
}

bool LayoutDragSession::Move(double pointer) {
  LayoutInput next = input_;
  Drag drag = drag_;
  return Step(pointer, next, drag) && Apply(next, drag);
}

bool LayoutDragSession::Reapply(LayoutInput next) {
  Drag drag = drag_;
  const double max = SidebarWidthLimit(next.window.width);
  if (drag_.kind == DragKind::kSidebar && !drag_.settle_target) {
    next.sidebar_width = SidebarWidthAt(drag_, drag_.last_pointer, max, &drag.dragged);
  } else if (drag_.kind == DragKind::kSidebar) {
    drag.settle_target = ClampWidth(*drag_.settle_target, kSidebarMinWidth, max);
  } else if (drag_.kind == DragKind::kSplit) {
    std::optional<std::vector<SplitSlot>> slots = SlotsAt(next, drag_, drag_.last_pointer);
    if (!slots) return false;
    next.split_slots = std::move(*slots);
  }
  if (drag.kind != DragKind::kNone && sequence_ + 1 == std::numeric_limits<uint64_t>::max()) {
    return FinishOnLastSequence(next, drag);
  }
  return Apply(next, drag);
}

bool LayoutDragSession::FinishOnLastSequence(LayoutInput next, const Drag& drag) {
  if (drag.kind == DragKind::kSplit) return FinishSplit(next).has_value();
  if (drag.settle_target) {
    next.sidebar_live = false;
    next.sidebar_width =
        KeptSidebarWidth(*drag.settle_target, SidebarWidthLimit(next.window.width), before_drag_.sidebar_width);
    return Apply(next, Drag{});
  }
  return FinishSidebar(next, drag, false).has_value();
}

bool LayoutDragSession::ResizeWindow(double width, double height) {
  const WindowFrame frame{width, height, input_.window.device_scale};
  if (!ValidWindow(frame) || (frame.width == input_.window.width && frame.height == input_.window.height)) {
    return false;
  }
  LayoutInput next = input_;
  next.window = frame;
  return Reapply(std::move(next));
}

bool LayoutDragSession::SetDeviceScale(double device_scale) {
  const double scale = SanitizeDeviceScale(device_scale);
  if (scale == input_.window.device_scale) return false;
  LayoutInput next = input_;
  next.window.device_scale = scale;
  return Reapply(std::move(next));
}

std::optional<LayoutDragSession::Release> LayoutDragSession::FinishSplit(const LayoutInput& from) {
  LayoutInput next = from;
  next.ratio_divider = drag_.divider;
  if (!Apply(next, Drag{})) return std::nullopt;
  const double ratio = snapshot_.split_ratio;
  return Release{ratio, ratio, ratio, false, false};
}

std::optional<LayoutDragSession::Release> LayoutDragSession::FinishSidebar(const LayoutInput& from, const Drag& drag,
                                                                          bool released) {
  const double raw = from.sidebar_width;
  const double max = SidebarWidthLimit(from.window.width);
  const double collapse_below = Finite(from.collapse_below) ? from.collapse_below : 0;
  LayoutInput next = from;
  next.sidebar_live = false;
  if (released && collapse_below > 0 && raw < collapse_below) {
    next.sidebar_shown = false;
    next.sidebar_width = before_drag_.sidebar_width;
    if (!Apply(next, Drag{})) return std::nullopt;
    return Release{raw, 0, next.sidebar_width, false, true};
  }
  const double target = ClampWidth(raw, kSidebarMinWidth, max);
  const double kept = KeptSidebarWidth(target, max, before_drag_.sidebar_width);
  if (released && raw != target && sequence_ < std::numeric_limits<uint64_t>::max() - 1) {
    Drag settling = drag;
    settling.settle_target = target;
    if (!Apply(from, settling)) return std::nullopt;
    return Release{raw, target, kept, true, false};
  }
  next.sidebar_width = kept;
  if (!Apply(next, Drag{})) return std::nullopt;
  return Release{raw, target, kept, false, false};
}

std::optional<LayoutDragSession::Release> LayoutDragSession::End(double pointer) {
  if (drag_.kind == DragKind::kNone || drag_.settle_target) return std::nullopt;
  LayoutInput next = input_;
  Drag drag = drag_;
  if (!Step(pointer, next, drag)) {
    next = input_;
    drag = drag_;
  }
  if (drag_.kind == DragKind::kSplit) return FinishSplit(next);
  return FinishSidebar(next, drag, true);
}

std::optional<LayoutDragSession::Release> LayoutDragSession::Terminate() {
  if (drag_.kind == DragKind::kSplit) return FinishSplit(input_);
  if (drag_.kind == DragKind::kSidebar && drag_.settle_target) return FinishSettle();
  if (drag_.kind == DragKind::kSidebar) return FinishSidebar(input_, drag_, false);
  return std::nullopt;
}

bool LayoutDragSession::Settle(double width) {
  if (drag_.kind != DragKind::kSidebar || !drag_.settle_target || !Finite(width)) return false;
  if (std::abs(width - *drag_.settle_target) < 1e-6 || sequence_ >= std::numeric_limits<uint64_t>::max() - 1) {
    return FinishSettle().has_value();
  }
  LayoutInput next = input_;
  next.sidebar_width = width;
  return Apply(next, drag_);
}

std::optional<LayoutDragSession::Release> LayoutDragSession::FinishSettle() {
  if (drag_.kind != DragKind::kSidebar || !drag_.settle_target) return std::nullopt;
  const double target = *drag_.settle_target;
  const double kept = KeptSidebarWidth(target, SidebarWidthLimit(input_.window.width), before_drag_.sidebar_width);
  LayoutInput next = input_;
  next.sidebar_live = false;
  next.sidebar_width = kept;
  if (!Apply(next, Drag{})) return std::nullopt;
  return Release{target, target, kept, false, false};
}

bool LayoutDragSession::Cancel() {
  if (drag_.kind == DragKind::kNone) return false;
  LayoutInput next = before_drag_;
  next.window = input_.window;
  next.sidebar_live = false;
  return Apply(next, Drag{});
}

bool LayoutDragSession::ResetSplitPair(DividerRef divider) {
  if (drag_.kind != DragKind::kNone || !HasDivider(input_.split_slots, divider)) return false;
  LayoutInput next = input_;
  next.split_slots = EvenSlots(input_.split_slots, divider);
  next.ratio_divider = divider;
  return Apply(next, Drag{});
}

SurfaceSyncTracker::SurfaceSyncTracker(int64_t vsync_interval_micros) { SetVsyncInterval(vsync_interval_micros); }

SurfaceSyncTracker::~SurfaceSyncTracker() = default;

void SurfaceSyncTracker::SetVsyncInterval(int64_t micros) {
  hold_budget_ = micros <= 0 ? kMaxHoldMicros : std::min(kMaxHoldMicros, std::max(kMinHoldMicros, micros));
}

void SurfaceSyncTracker::SetDeviceScale(double device_scale) {
  const double scale = SanitizeDeviceScale(device_scale);
  if (scale == device_scale_) return;
  device_scale_ = scale;
  shell_.has_rect = false;
  for (Surface& child : children_) child.has_rect = false;
}

void SurfaceSyncTracker::Begin() {
  active_ = true;
  pending_ = false;
}

void SurfaceSyncTracker::End() {
  active_ = false;
  pending_ = false;
  shell_.participating = false;
  for (Surface& child : children_) child.participating = false;
}

SurfaceSyncTracker::Surface* SurfaceSyncTracker::Find(uint64_t child_id) {
  for (Surface& child : children_) {
    if (child.child_id == child_id) return &child;
  }
  return nullptr;
}

const SurfaceSyncTracker::Surface* SurfaceSyncTracker::Find(uint64_t child_id) const {
  for (const Surface& child : children_) {
    if (child.child_id == child_id) return &child;
  }
  return nullptr;
}

bool SurfaceSyncTracker::Caught(const Surface& surface) {
  return surface.expected.surface_generation != 0 &&
         surface.submitted.surface_generation == surface.expected.surface_generation;
}

bool SurfaceSyncTracker::ShellCaught() const {
  return Caught(shell_) && shell_.submitted.frame_sequence == frame_sequence_;
}

bool SurfaceSyncTracker::ClockWentBack(int64_t now_micros) {
  const bool back = has_clock_ && now_micros < last_now_micros_;
  has_clock_ = true;
  last_now_micros_ = now_micros;
  if (back) ++counts_.clock_jumps;
  return back;
}

std::optional<std::vector<SurfaceId>> SurfaceSyncTracker::ExpectLayout(uint64_t frame_sequence, const Rect& shell,
                                                                       const std::vector<ChildGeometry>& children,
                                                                       int64_t now_micros) {
  if (!active_ || frame_sequence <= frame_sequence_ || children.size() > kMaxSurfaces || !ValidRect(shell) ||
      last_generation_ > std::numeric_limits<uint64_t>::max() - (children.size() + 1)) {
    return std::nullopt;
  }
  for (size_t i = 0; i < children.size(); ++i) {
    if (!ValidRect(children[i].rect)) return std::nullopt;
    for (size_t j = 0; j < i; ++j) {
      if (children[j].child_id == children[i].child_id) return std::nullopt;
    }
  }
  if (children_.size() + children.size() > kMaxSurfaces * 2) {
    std::erase_if(children_, [](const Surface& child) { return !child.participating; });
  }
  const bool clock_went_back = ClockWentBack(now_micros);
  frame_sequence_ = frame_sequence;
  if (!shell_.has_rect || !(shell_.rect == shell)) {
    shell_.rect = shell;
    shell_.has_rect = true;
    shell_.expected = {frame_sequence, ++last_generation_};
  }
  shell_.participating = true;
  for (Surface& child : children_) child.participating = false;
  std::vector<SurfaceId> out;
  out.reserve(children.size());
  for (const ChildGeometry& geometry : children) {
    Surface* child = Find(geometry.child_id);
    if (!child) {
      children_.push_back(Surface{});
      child = &children_.back();
      child->child_id = geometry.child_id;
    }
    if (!child->has_rect || !(child->rect == geometry.rect)) {
      child->rect = geometry.rect;
      child->has_rect = true;
      child->expected = {frame_sequence, ++last_generation_};
    }
    child->participating = true;
    out.push_back(child->expected);
  }
  if (!pending_) {
    pending_ = true;
    deadline_micros_ = SaturatingAdd(now_micros, hold_budget_);
  }
  if (clock_went_back) clock_jump_fallback_ = true;
  ++counts_.layouts;
  return out;
}

bool SurfaceSyncTracker::Accept(Surface& surface, SurfaceId id) {
  if (surface.expected.surface_generation == 0 || id.frame_sequence > frame_sequence_ ||
      id.surface_generation > surface.expected.surface_generation) {
    ++counts_.rejected_submissions;
    return false;
  }
  if (id.surface_generation < surface.expected.surface_generation) {
    ++counts_.stale_submissions;
    return false;
  }
  if (id.frame_sequence < surface.expected.frame_sequence) {
    ++counts_.rejected_submissions;
    return false;
  }
  if (surface.submitted.surface_generation == id.surface_generation &&
      id.frame_sequence <= surface.submitted.frame_sequence) {
    ++counts_.stale_submissions;
    return false;
  }
  surface.submitted = id;
  return true;
}

bool SurfaceSyncTracker::ShellSubmitted(SurfaceId id) { return Accept(shell_, id); }

bool SurfaceSyncTracker::ChildSubmitted(uint64_t child_id, SurfaceId id) {
  Surface* child = Find(child_id);
  if (!child) {
    ++counts_.rejected_submissions;
    return false;
  }
  if (!Accept(*child, id)) return false;
  child->misses = 0;
  child->stalled = false;
  return true;
}

bool SurfaceSyncTracker::RemoveChild(uint64_t child_id) {
  return std::erase_if(children_, [child_id](const Surface& child) { return child.child_id == child_id; }) > 0;
}

PresentDecision SurfaceSyncTracker::Decide(int64_t now_micros) {
  PresentDecision decision;
  decision.frame_sequence = frame_sequence_;
  if (!active_ || !pending_) {
    if (ClockWentBack(now_micros)) clock_jump_fallback_ = true;
    return decision;
  }
  const bool clock_jumped = ClockWentBack(now_micros) || clock_jump_fallback_;
  size_t waiting = ShellCaught() ? 0 : 1;
  for (const Surface& child : children_) {
    if (child.participating && !child.stalled && !Caught(child)) ++waiting;
  }
  if (waiting == 0) {
    pending_ = false;
    ++counts_.matched;
    for (Surface& child : children_) {
      if (child.participating) child.misses = 0;
    }
    decision.reason = PresentReason::kMatched;
    return decision;
  }
  if (clock_jumped || now_micros >= deadline_micros_) {
    pending_ = false;
    clock_jump_fallback_ = false;
    ++counts_.deadline_fallbacks;
    if (!clock_jumped) {
      for (Surface& child : children_) {
        if (!child.participating || child.stalled || Caught(child)) continue;
        if (++child.misses >= kMissesBeforeStalled) {
          child.stalled = true;
          ++counts_.stalls;
        }
      }
    }
    decision.reason = PresentReason::kDeadline;
    decision.waiting_on = waiting;
    return decision;
  }
  decision.reason = PresentReason::kHolding;
  decision.present = false;
  decision.waiting_on = waiting;
  decision.deadline_micros = deadline_micros_;
  return decision;
}

std::optional<SurfaceId> SurfaceSyncTracker::Expected(uint64_t child_id) const {
  const Surface* child = Find(child_id);
  if (!child) return std::nullopt;
  return child->expected;
}

bool SurfaceSyncTracker::IsStalled(uint64_t child_id) const {
  const Surface* child = Find(child_id);
  return child && child->stalled;
}

}
