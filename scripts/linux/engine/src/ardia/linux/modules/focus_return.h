// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_FOCUS_RETURN_H_
#define ARDIA_LINUX_MODULES_FOCUS_RETURN_H_

#include <cstdint>
#include <optional>
#include <set>
#include <string_view>

namespace ardia_linux {

void ReturnFocusSoon(std::string_view preferred_window_id = {});

struct XFocusState {
  uint32_t root = 0;
  uint32_t focus = 0;
  std::optional<uint32_t> active;
};

bool NothingElseFocused(const XFocusState& state,
                        const std::set<uint32_t>& ours);

}

#endif
