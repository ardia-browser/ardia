#include <cassert>
#include <cstdio>
#include <string>

#include "ardia/linux/ac_linux_window_state.h"

namespace state = ardia::linux_window_state;

namespace {

constexpr state::TiledEdges kNone{};
constexpr state::TiledEdges kAll{.left = true, .right = true, .top = true, .bottom = true};
constexpr state::TiledEdges kLeftHalf{.left = true, .right = false, .top = true, .bottom = true};

constexpr state::NativeWindow Wayland(bool maximized, state::TiledEdges edges) {
  return {.maximized = maximized, .edges = edges, .compositor_reports_edges = true};
}

constexpr state::NativeWindow WindowFullScreen(state::TiledEdges edges) {
  return {.widget_full_screen = true, .window_full_screen = true, .edges = edges, .compositor_reports_edges = true};
}

constexpr state::NativeWindow PageFullScreen(state::TiledEdges edges) {
  return {.widget_full_screen = true, .window_full_screen = false, .edges = edges, .compositor_reports_edges = true};
}

constexpr state::WindowState kMaximizedTiled{.maximized = true, .tiled = true};

}

int main() {
  constexpr state::WindowState kNothing{};
  static_assert(state::StateOf(Wayland(false, kNone), kNothing) == state::WindowState{});
  static_assert(state::StateOf(Wayland(false, kAll), kNothing) == state::WindowState{.tiled = true});
  static_assert(state::StateOf(Wayland(false, kLeftHalf), kNothing) == state::WindowState{});
  static_assert(state::StateOf(Wayland(true, kAll), kNothing) == kMaximizedTiled);
  static_assert(state::StateOf(Wayland(true, kNone), kNothing) == state::WindowState{.maximized = true});
  static_assert(state::StateOf(state::NativeWindow{.maximized = true, .edges = kAll}, kNothing) ==
                state::WindowState{.maximized = true});
  static_assert(state::StateOf(state::NativeWindow{.edges = kAll}, kNothing) == state::WindowState{});
  static_assert(state::StateOf(WindowFullScreen(kNone), kMaximizedTiled) == state::WindowState{.full_screen = true});
  static_assert(state::StateOf(WindowFullScreen(kAll), kNothing) == state::WindowState{.tiled = true, .full_screen = true});
  static_assert(!state::PageFullScreen(Wayland(true, kAll)));
  static_assert(!state::PageFullScreen(WindowFullScreen(kAll)));
  static_assert(state::PageFullScreen(PageFullScreen(kNone)));
  static_assert(state::StateOf(PageFullScreen(kNone), kMaximizedTiled) == kMaximizedTiled);
  static_assert(state::StateOf(PageFullScreen(kAll), kNothing) == kNothing);
  {
    state::SettledWindowState fresh;
    assert(fresh.Settle(PageFullScreen(kNone)) == kNothing);
  }
  {
    state::SettledWindowState attached;
    assert(attached.Peek(PageFullScreen(kNone)) == kNothing);
    assert(attached.Settle(Wayland(true, kAll)) == kMaximizedTiled);
    assert(attached.Peek(PageFullScreen(kNone)) == kMaximizedTiled);
    assert(attached.Settle(PageFullScreen(kNone)) == kMaximizedTiled);
    assert(attached.Settle(WindowFullScreen(kNone)) == state::WindowState{.full_screen = true});
    assert(attached.Settle(Wayland(false, kNone)) == kNothing);
    assert(attached.Peek(PageFullScreen(kAll)) == kNothing);
  }
  for (const bool reported : {false, true}) {
    for (const bool left : {false, true}) {
      for (const bool right : {false, true}) {
        for (const bool top : {false, true}) {
          for (const bool bottom : {false, true}) {
            const state::NativeWindow window{.edges = {left, right, top, bottom}, .compositor_reports_edges = reported};
            const state::WindowState tiled = state::StateOf(window, kMaximizedTiled);
            assert(tiled.tiled == (reported && left && right && top && bottom));
            assert(!tiled.maximized && !tiled.full_screen);
          }
        }
      }
    }
  }
  assert(state::ReportableToolkitString(":minimize,maximize,close"));
  assert(state::ReportableToolkitString("appmenu:close"));
  assert(state::ReportableToolkitString("close:maximize"));
  assert(state::ReportableToolkitString(""));
  assert(state::ReportableToolkitString("ubuntu:GNOME"));
  assert(!state::ReportableToolkitString("close\n:minimize"));
  assert(!state::ReportableToolkitString(std::string("close\0", 6)));
  assert(!state::ReportableToolkitString("\xc3\xa9:close"));
  assert(state::ReportableToolkitString(std::string(state::kToolkitStringLimit, 'a')));
  assert(!state::ReportableToolkitString(std::string(state::kToolkitStringLimit + 1, 'a')));
  std::puts("ok");
  return 0;
}
