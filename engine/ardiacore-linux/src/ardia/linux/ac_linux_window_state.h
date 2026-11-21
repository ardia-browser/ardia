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
inline constexpr size_t kToolkitStringLimit = 256;

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

struct NativeWindow {
  bool maximized = false;
  bool widget_full_screen = false;
  bool window_full_screen = false;
  TiledEdges edges;
  bool compositor_reports_edges = false;
};

constexpr bool PageFullScreen(const NativeWindow& window) {
  return window.widget_full_screen && !window.window_full_screen;
}

constexpr WindowState StateOf(const NativeWindow& window, const WindowState& before_page_full_screen) {
  if (PageFullScreen(window)) {
    return WindowState{
        .maximized = before_page_full_screen.maximized,
        .tiled = before_page_full_screen.tiled,
        .full_screen = window.window_full_screen,
    };
  }
  const TiledEdges& edges = window.edges;
  return WindowState{
      .maximized = window.maximized && !window.window_full_screen,
      .tiled = window.compositor_reports_edges && edges.left && edges.right && edges.top && edges.bottom,
      .full_screen = window.window_full_screen,
  };
}

class SettledWindowState {
 public:
  constexpr WindowState Settle(const NativeWindow& window) {
    settled_ = StateOf(window, settled_);
    return settled_;
  }
  constexpr WindowState Peek(const NativeWindow& window) const { return StateOf(window, settled_); }

 private:
  WindowState settled_;
};

constexpr bool ReportableToolkitString(std::string_view text) {
  if (text.size() > kToolkitStringLimit) return false;
  for (const char c : text) {
    if (static_cast<unsigned char>(c) < 0x20 || static_cast<unsigned char>(c) > 0x7e) return false;
  }
  return true;
}

}

#endif
