// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/edge_rules.h"

#include <algorithm>

namespace ardia_linux {

namespace {

bool InBand(const gfx::Point& cursor,
            const gfx::Rect& window,
            const SidebarEdgeWatch& watch) {
  const int band = std::max(watch.hold, kSidebarEdgeLeastBand);
  return watch.right ? cursor.x() < window.right() &&
                           cursor.x() >= window.right() - band
                     : cursor.x() >= window.x() &&
                           cursor.x() < window.x() + band;
}

bool BeyondEdge(const gfx::Point& cursor,
                const gfx::Rect& window,
                const gfx::Rect& work_area,
                bool right) {
  return right ? cursor.x() >= window.right() &&
                     cursor.x() < std::min(work_area.right(),
                                           window.right() + kSidebarEdgeReach)
               : cursor.x() < window.x() &&
                     cursor.x() >= std::max(work_area.x(),
                                            window.x() - kSidebarEdgeReach);
}

}

bool BesideWorkAreaEdge(const gfx::Rect& window,
                        const gfx::Rect& work_area,
                        bool right) {
  return (right ? work_area.right() - window.right()
                : window.x() - work_area.x()) <= kSidebarEdgeReach;
}

SidebarEdgeProbe ProbeSidebarEdge(const gfx::Point& cursor,
                                  const gfx::Rect& window,
                                  const gfx::Rect& work_area,
                                  const SidebarEdgeWatch& watch,
                                  bool holding) {
  SidebarEdgeProbe probe;
  if (window.IsEmpty()) {
    return probe;
  }
  const int slack = holding ? kSidebarEdgeReach : 0;
  if (cursor.y() < window.y() - slack || cursor.y() >= window.bottom() + slack) {
    return probe;
  }
  const int inside_y =
      std::clamp(cursor.y(), window.y(), window.bottom() - 1);
  if (InBand(cursor, window, watch)) {
    probe.zone = SidebarEdgeZone::kBand;
    probe.inside = gfx::Point(cursor.x(), inside_y);
    probe.cursor_in_window = inside_y == cursor.y();
    return probe;
  }
  if (!BeyondEdge(cursor, window, work_area, watch.right)) {
    return probe;
  }
  probe.zone = SidebarEdgeZone::kBeyond;
  probe.inside = gfx::Point(watch.right ? window.right() - 1 : window.x() + 1,
                            inside_y);
  probe.needs_active_app =
      !BesideWorkAreaEdge(window, work_area, watch.right);
  return probe;
}

bool SidebarEdgeOver(const SidebarEdgeProbe& probe,
                     const SidebarEdgeStack& stack,
                     const SidebarEdgeWatch& watch,
                     bool pressed) {
  if (pressed && !watch.while_pressed) {
    return false;
  }
  switch (probe.zone) {
    case SidebarEdgeZone::kAway:
      return false;
    case SidebarEdgeZone::kBand:
      return stack.window_on_top_inside &&
             (probe.cursor_in_window || !stack.cursor_over_other);
    case SidebarEdgeZone::kBeyond:
      return stack.window_on_top_inside && !stack.cursor_over_other &&
             (!probe.needs_active_app || stack.app_active);
  }
  return false;
}

}
