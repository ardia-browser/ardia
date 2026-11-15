// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_EDGE_POINTER_H_
#define ARDIA_LINUX_MODULES_EDGE_POINTER_H_

#include <optional>

#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"

namespace ardia_linux {

class ModuleRegistry;

std::optional<gfx::Point> PointerInWindow(const gfx::Point& cursor,
                                          const gfx::Rect& bounds);

void RegisterEdgePointerModule(ModuleRegistry& registry);

}

#endif
