// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <array>
#include <cstring>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/edge_pointer.h"
#include "ardia/linux/modules/edge_rules.h"
#include "ardia/linux/modules/focus_return.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/compiler_specific.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/timer/timer.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/display/display.h"
#include "ui/display/screen.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/x/atom_cache.h"
#include "ui/gfx/x/connection.h"
#include "ui/gfx/x/xproto.h"
#include "ui/views/widget/widget.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaLinuxEdgePointer";
constexpr base::TimeDelta kPoll = base::Milliseconds(30);
constexpr int kAnyButton =
    static_cast<int>(x11::KeyButMask::Button1) |
    static_cast<int>(x11::KeyButMask::Button2) |
    static_cast<int>(x11::KeyButMask::Button3);

views::Widget* ShownWidget(AppWindow* window) {
  views::Widget* widget = window ? window->widget() : nullptr;
  if (!widget || widget->IsClosed() || !widget->IsVisible() ||
      widget->IsMinimized() || widget->IsFullscreen() ||
      !widget->GetNativeWindow() || !widget->GetNativeWindow()->GetHost()) {
    return nullptr;
  }
  return widget;
}

uint32_t XWindowOf(views::Widget* widget) {
  return static_cast<uint32_t>(
      widget->GetNativeWindow()->GetHost()->GetAcceleratedWidget());
}

bool AnyOfOursActive() {
  for (const std::string& id : AppWindows::Get().Ids()) {
    AppWindow* window = AppWindows::Get().Find(id);
    if (window && window->widget() && window->widget()->IsActive()) {
      return true;
    }
  }
  return false;
}

std::set<uint32_t> OurXWindows() {
  std::set<uint32_t> ours;
  for (const std::string& id : AppWindows::Get().Ids()) {
    AppWindow* window = AppWindows::Get().Find(id);
    views::Widget* widget = window ? window->widget() : nullptr;
    if (widget && widget->GetNativeWindow() &&
        widget->GetNativeWindow()->GetHost()) {
      ours.insert(XWindowOf(widget));
    }
  }
  return ours;
}

class XStacking {
 public:
  explicit XStacking(x11::Connection* x) : x_(x) {
    std::vector<x11::Window> bottom_up;
    if (!x_->GetArrayProperty(x_->default_root(),
                              x11::GetAtom("_NET_CLIENT_LIST_STACKING"),
                              &bottom_up)) {
      return;
    }
    top_down_.assign(bottom_up.rbegin(), bottom_up.rend());
    known_ = true;
  }

  bool known() const { return known_; }

  std::optional<size_t> IndexOf(uint32_t window) const {
    auto found = std::ranges::find(top_down_, static_cast<x11::Window>(window));
    if (found == top_down_.end()) {
      return std::nullopt;
    }
    return static_cast<size_t>(found - top_down_.begin());
  }

  size_t size() const { return top_down_.size(); }
  uint32_t At(size_t index) const {
    return static_cast<uint32_t>(top_down_[index]);
  }

  const std::optional<gfx::Rect>& Frame(size_t index) {
    LoadFrames(index + 1);
    return frames_[index];
  }

 private:
  void LoadFrames(size_t count) {
    count = std::min(count, top_down_.size());
    if (frames_.size() >= count) {
      return;
    }
    struct Pending {
      x11::Future<x11::GetWindowAttributesReply> attributes;
      x11::Future<x11::GetGeometryReply> geometry;
      x11::Future<x11::TranslateCoordinatesReply> origin;
      x11::Future<x11::GetPropertyReply> extents;
    };
    const size_t from = frames_.size();
    std::vector<Pending> pending;
    for (size_t i = from; i < count; ++i) {
      const x11::Window window = top_down_[i];
      pending.push_back(
          {x_->GetWindowAttributes(window),
           x_->GetGeometry(x11::Drawable(window)),
           x_->TranslateCoordinates(window, x_->default_root(), 0, 0),
           x_->GetProperty(x11::GetPropertyRequest{
               .window = window,
               .property = x11::GetAtom("_NET_FRAME_EXTENTS"),
               .long_length = 4})});
    }
    for (Pending& request : pending) {
      auto attributes = request.attributes.Sync();
      auto geometry = request.geometry.Sync();
      auto origin = request.origin.Sync();
      auto extents = request.extents.Sync();
      if (!attributes || attributes->map_state != x11::MapState::Viewable ||
          !geometry || !origin) {
        frames_.push_back(std::nullopt);
        continue;
      }
      std::array<uint32_t, 4> insets{};
      if (extents && extents->format == 32 && extents->value_len == 4 &&
          extents->value) {
        UNSAFE_BUFFERS(
            std::memcpy(insets.data(), extents->value->bytes(), sizeof(insets)));
      }
      const auto [left, right, top, bottom] = insets;
      frames_.push_back(gfx::Rect(
          origin->dst_x - static_cast<int>(left),
          origin->dst_y - static_cast<int>(top),
          geometry->width + static_cast<int>(left + right),
          geometry->height + static_cast<int>(top + bottom)));
    }
  }

  raw_ptr<x11::Connection> x_;
  std::vector<x11::Window> top_down_;
  std::vector<std::optional<gfx::Rect>> frames_;
  bool known_ = false;
};

class EdgePointer {
 public:
  static EdgePointer& Get() {
    static base::NoDestructor<EdgePointer> pointer;
    return *pointer;
  }

  void Watch(const std::string& id, bool on, const SidebarEdgeWatch& watch) {
    if (on) {
      watched_[id] = watch;
      unreported_.insert(id);
    } else {
      watched_.erase(id);
      over_.erase(id);
      unreported_.erase(id);
    }
    if (watched_.empty()) {
      timer_.Stop();
      return;
    }
    if (!timer_.IsRunning()) {
      timer_.Start(FROM_HERE, kPoll,
                   base::BindRepeating(&EdgePointer::Poll,
                                       base::Unretained(this)));
    }
    Poll();
  }

 private:
  friend class base::NoDestructor<EdgePointer>;
  EdgePointer() = default;

  struct PollState {
    gfx::Point cursor;
    std::optional<bool> pressed;
    std::optional<XStacking> stacking;
    std::optional<std::set<uint32_t>> ours;
    std::optional<bool> app_active;
  };

  x11::Connection* X() const {
    if (!OnX11()) {
      return nullptr;
    }
    x11::Connection* x = x11::Connection::Get();
    return x && x->Ready() ? x : nullptr;
  }

  bool Pressed(PollState& state) const {
    if (!state.pressed) {
      state.pressed = false;
      if (x11::Connection* x = X()) {
        if (auto reply = x->QueryPointer(x->default_root()).Sync()) {
          state.pressed = (static_cast<int>(reply->mask) & kAnyButton) != 0;
        }
      }
    }
    return *state.pressed;
  }

  bool AppActive(PollState& state) const {
    if (!state.app_active) {
      std::set<uint32_t> ours;
      std::optional<XFocusState> focus =
          X() ? QueryXFocus(&ours) : std::nullopt;
      state.app_active = focus ? OursFocused(*focus, ours) : AnyOfOursActive();
    }
    return *state.app_active;
  }

  SidebarEdgeStack StackAt(PollState& state,
                           views::Widget* widget,
                           const SidebarEdgeProbe& probe) const {
    SidebarEdgeStack stack;
    if (probe.needs_active_app) {
      stack.app_active = AppActive(state);
    }
    x11::Connection* x = X();
    if (!x) {
      return stack;
    }
    if (!state.stacking) {
      state.stacking.emplace(x);
      state.ours = OurXWindows();
    }
    XStacking& stacking = *state.stacking;
    if (!stacking.known()) {
      return stack;
    }
    const uint32_t own = XWindowOf(widget);
    const std::optional<size_t> own_index = stacking.IndexOf(own);
    if (!own_index) {
      return stack;
    }
    aura::WindowTreeHost* host = widget->GetNativeWindow()->GetHost();
    const gfx::Vector2d origin =
        widget->GetWindowBoundsInScreen().OffsetFromOrigin();
    auto to_pixels = [&](gfx::Point point) {
      point -= origin;
      host->ConvertDIPToScreenInPixels(&point);
      return point;
    };
    const gfx::Point inside = to_pixels(probe.inside);
    for (size_t i = 0; i < *own_index; ++i) {
      const std::optional<gfx::Rect>& frame = stacking.Frame(i);
      if (frame && frame->Contains(inside)) {
        stack.window_on_top_inside = false;
        return stack;
      }
    }
    if (probe.cursor_in_window) {
      return stack;
    }
    const gfx::Point cursor = to_pixels(state.cursor);
    for (size_t i = 0; i < stacking.size(); ++i) {
      if (i == *own_index) {
        continue;
      }
      const std::optional<gfx::Rect>& frame = stacking.Frame(i);
      if (frame && frame->Contains(cursor)) {
        stack.cursor_over_other =
            i < *own_index || state.ours->contains(stacking.At(i));
        break;
      }
    }
    return stack;
  }

  void Poll() {
    display::Screen* screen = display::Screen::Get();
    if (!screen) {
      return;
    }
    PollState state;
    state.cursor = screen->GetCursorScreenPoint();
    std::vector<std::string> ids;
    for (const auto& [id, watch] : watched_) {
      ids.push_back(id);
    }
    for (const std::string& id : ids) {
      auto watched = watched_.find(id);
      if (watched == watched_.end()) {
        continue;
      }
      const SidebarEdgeWatch watch = watched->second;
      AppWindow* window = AppWindows::Get().Find(id);
      if (!window || window->closing() || !window->widget() ||
          window->widget()->IsClosed()) {
        watched_.erase(watched);
        over_.erase(id);
        unreported_.erase(id);
        continue;
      }
      const bool holding = over_.contains(id);
      const gfx::Rect bounds = window->widget()->GetClientAreaBoundsInScreen();
      bool now = false;
      bool overshoot = false;
      if (views::Widget* widget = ShownWidget(window)) {
        const gfx::Rect work_area =
            screen->GetDisplayMatching(bounds).work_area();
        const SidebarEdgeProbe probe =
            ProbeSidebarEdge(state.cursor, bounds, work_area, watch, holding);
        if (probe.zone != SidebarEdgeZone::kAway) {
          const bool pressed = !watch.while_pressed && Pressed(state);
          now = SidebarEdgeOver(
              probe,
              pressed ? SidebarEdgeStack() : StackAt(state, widget, probe),
              watch, pressed);
          overshoot = probe.zone == SidebarEdgeZone::kBeyond;
        }
      }
      const bool fresh = unreported_.erase(id) > 0;
      if (!fresh && now == holding) {
        continue;
      }
      if (now) {
        if (!fresh && !holding && overshoot) {
          CountLinux("sidebar_edge_overshoot_peeks");
        }
        over_.insert(id);
      } else {
        over_.erase(id);
      }
      AppWindows::Get().WindowEvent(
          "sidebarEdge", id,
          base::DictValue().Set("over", now).Set(
              "point", base::ListValue()
                           .Append(state.cursor.x() - bounds.x())
                           .Append(state.cursor.y() - bounds.y())));
    }
    if (watched_.empty()) {
      timer_.Stop();
    }
  }

  std::map<std::string, SidebarEdgeWatch> watched_;
  std::set<std::string> over_;
  std::set<std::string> unreported_;
  base::RepeatingTimer timer_;
};

}

void RegisterEdgePointerModule(ModuleRegistry& registry) {
  registry.Define(kModule).Async(
      "watchSidebarEdge", AnswerOf([](const base::ListValue& args) {
        const std::string id = StringArg(args, 0);
        if (!id.empty()) {
          EdgePointer::Get().Watch(
              id, BoolArg(args, 1),
              SidebarEdgeWatch{
                  .hold = std::max(0, static_cast<int>(NumberArg(args, 2))),
                  .right = BoolArg(args, 3),
                  .while_pressed = BoolArg(args, 4)});
        }
        return ModuleResult(base::Value(true));
      }));
}

}
