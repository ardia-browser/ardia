#include <cassert>
#include <cstdio>
#include <string>

#include "ardia/linux/ac_linux_window_state.h"

namespace state = ardia::linux_window_state;

int main() {
  constexpr state::TiledEdges kNone{};
  constexpr state::TiledEdges kAll{.left = true, .right = true, .top = true, .bottom = true};
  constexpr state::TiledEdges kLeftHalf{.left = true, .right = false, .top = true, .bottom = true};
  static_assert(state::StateOf(false, false, kNone, true) == state::WindowState{});
  static_assert(state::StateOf(false, false, kAll, true) == state::WindowState{.tiled = true});
  static_assert(state::StateOf(false, false, kLeftHalf, true) == state::WindowState{});
  static_assert(state::StateOf(true, false, kAll, true) == state::WindowState{.maximized = true, .tiled = true});
  static_assert(state::StateOf(true, false, kNone, true) == state::WindowState{.maximized = true});
  static_assert(state::StateOf(false, true, kAll, true) == state::WindowState{.tiled = true, .full_screen = true});
  static_assert(state::StateOf(true, true, kNone, true) == state::WindowState{.full_screen = true});
  static_assert(state::StateOf(true, false, kAll, false) == state::WindowState{.maximized = true});
  static_assert(state::StateOf(false, false, kAll, false) == state::WindowState{});
  for (const bool reported : {false, true}) {
    for (const bool left : {false, true}) {
      for (const bool right : {false, true}) {
        for (const bool top : {false, true}) {
          for (const bool bottom : {false, true}) {
            const state::WindowState tiled = state::StateOf(false, false, {left, right, top, bottom}, reported);
            assert(tiled.tiled == (reported && left && right && top && bottom));
            assert(!tiled.maximized && !tiled.full_screen);
          }
        }
      }
    }
  }
  assert(state::ReportableButtonLayout(":minimize,maximize,close"));
  assert(state::ReportableButtonLayout("appmenu:close"));
  assert(state::ReportableButtonLayout("close:maximize"));
  assert(state::ReportableButtonLayout(""));
  assert(state::ReportableButtonLayout("ubuntu:GNOME"));
  assert(!state::ReportableButtonLayout("close\n:minimize"));
  assert(!state::ReportableButtonLayout(std::string("close\0", 6)));
  assert(!state::ReportableButtonLayout("\xc3\xa9:close"));
  assert(state::ReportableButtonLayout(std::string(state::kButtonLayoutLimit, 'a')));
  assert(!state::ReportableButtonLayout(std::string(state::kButtonLayoutLimit + 1, 'a')));
  std::puts("ok");
  return 0;
}
