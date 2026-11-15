// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/host/input_region.h"

#include <algorithm>
#include <utility>

namespace ardia_linux {

namespace {

float At(const base::ListValue& list, size_t index) {
  return index < list.size()
             ? static_cast<float>(list[index].GetIfDouble().value_or(0))
             : 0;
}

}

bool RoundedArea::Contains(const gfx::PointF& point) const {
  if (rect.IsEmpty() || point.x() < rect.x() || point.y() < rect.y() ||
      point.x() >= rect.right() || point.y() >= rect.bottom()) {
    return false;
  }
  const float r = std::min({radius, rect.width() / 2, rect.height() / 2});
  if (r <= 0) {
    return true;
  }
  const float left = rect.x() + r;
  const float right = rect.right() - r;
  const float top = rect.y() + r;
  const float bottom = rect.bottom() - r;
  const float cx = std::clamp(point.x(), left, right);
  const float cy = std::clamp(point.y(), top, bottom);
  const float dx = point.x() - cx;
  const float dy = point.y() - cy;
  return dx * dx + dy * dy <= r * r;
}

InputRegion::InputRegion() = default;

InputRegion::~InputRegion() = default;

std::vector<RoundedArea> InputRegion::HolesFrom(const base::ListValue* holes) {
  std::vector<RoundedArea> areas;
  if (!holes) {
    return areas;
  }
  for (const base::Value& entry : *holes) {
    const base::ListValue* hole = entry.GetIfList();
    if (!hole || hole->size() < 4) {
      continue;
    }
    RoundedArea area;
    area.rect = gfx::RectF(At(*hole, 0), At(*hole, 1), At(*hole, 2),
                           At(*hole, 3));
    area.radius = At(*hole, 4);
    areas.push_back(area);
  }
  return areas;
}

void InputRegion::SetPage(const std::string& key,
                          const RoundedArea& page,
                          std::vector<RoundedArea> holes) {
  Entry& entry = pages_[key];
  const bool fresh = entry.order == 0;
  entry.page = page;
  entry.holes = std::move(holes);
  if (fresh) {
    entry.order = ++next_order_;
  }
}

void InputRegion::RemovePage(const std::string& key) {
  pages_.erase(key);
}

void InputRegion::RaisePage(const std::string& key) {
  auto found = pages_.find(key);
  if (found != pages_.end()) {
    found->second.order = ++next_order_;
  }
}

bool InputRegion::Has(const std::string& key) const {
  return pages_.contains(key);
}

std::string InputRegion::PageAt(const gfx::PointF& point) const {
  const std::string* best = nullptr;
  const Entry* top = nullptr;
  for (const auto& [key, entry] : pages_) {
    if ((top && entry.order <= top->order) || !entry.page.Contains(point)) {
      continue;
    }
    best = &key;
    top = &entry;
  }
  if (!top || std::any_of(top->holes.begin(), top->holes.end(),
                          [&](const RoundedArea& hole) {
                            return hole.Contains(point);
                          })) {
    return std::string();
  }
  return *best;
}

}
