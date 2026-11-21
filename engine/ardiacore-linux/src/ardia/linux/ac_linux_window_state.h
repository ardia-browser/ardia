#ifndef ARDIA_LINUX_AC_LINUX_WINDOW_STATE_H_
#define ARDIA_LINUX_AC_LINUX_WINDOW_STATE_H_

#include <cstddef>
#include <string_view>

namespace ardia::linux_window_state {

inline constexpr char kWindowButtonLayoutCall[] = "ArdiaShell.windowButtonLayout";
inline constexpr char kWindowStateCall[] = "ArdiaShell.windowState";
inline constexpr char kWindowButtonLayoutEvent[] = "windowButtonLayout";
inline constexpr char kWindowStateEvent[] = "windowState";
inline constexpr const char* kWindowStateCapabilities[] = {"ArdiaShell.windowButtonLayout",
                                                           "ArdiaShell.windowState"};
inline constexpr size_t kButtonLayoutLimit = 256;

struct TiledEdges {
  bool left = false;
  bool right = false;
  bool top = false;
  bool bottom = false;
};

struct WindowState {
  bool maximized = false;
  bool tiled = false;
  bool full_screen = false;

  friend constexpr bool operator==(const WindowState&, const WindowState&) = default;
};

constexpr WindowState StateOf(bool maximized, bool full_screen, TiledEdges edges, bool compositor_reports_edges) {
  return WindowState{
      .maximized = maximized && !full_screen,
      .tiled = compositor_reports_edges && edges.left && edges.right && edges.top && edges.bottom,
      .full_screen = full_screen,
  };
}

constexpr bool ReportableButtonLayout(std::string_view layout) {
  if (layout.size() > kButtonLayoutLimit) return false;
  for (const char c : layout) {
    if (static_cast<unsigned char>(c) < 0x20 || static_cast<unsigned char>(c) > 0x7e) return false;
  }
  return true;
}

}

#endif
