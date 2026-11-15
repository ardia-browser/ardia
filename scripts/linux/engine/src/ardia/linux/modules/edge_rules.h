// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_EDGE_RULES_H_
#define ARDIA_LINUX_MODULES_EDGE_RULES_H_

#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"

namespace ardia_linux {

inline constexpr int kSidebarEdgeReach = 24;
inline constexpr int kSidebarEdgeLeastBand = kSidebarEdgeReach / 2;

struct SidebarEdgeWatch {
  int hold = 0;
  bool right = false;
  bool while_pressed = false;
};

enum class SidebarEdgeZone { kAway, kBand, kBeyond };

struct SidebarEdgeProbe {
  SidebarEdgeZone zone = SidebarEdgeZone::kAway;
  gfx::Point inside;
  bool cursor_in_window = false;
  bool needs_active_app = false;
};

struct SidebarEdgeStack {
  bool window_on_top_inside = true;
  bool cursor_over_other = false;
  bool app_active = true;
};

SidebarEdgeProbe ProbeSidebarEdge(const gfx::Point& cursor,
                                  const gfx::Rect& window,
                                  const gfx::Rect& work_area,
                                  const SidebarEdgeWatch& watch,
                                  bool holding);

bool BesideWorkAreaEdge(const gfx::Rect& window,
                        const gfx::Rect& work_area,
                        bool right);

bool SidebarEdgeOver(const SidebarEdgeProbe& probe,
                     const SidebarEdgeStack& stack,
                     const SidebarEdgeWatch& watch,
                     bool pressed);

}

#endif
