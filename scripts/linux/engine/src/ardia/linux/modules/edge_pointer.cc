// Copyright 2026 Ardia. Apache-2.0.

#include <map>
#include <optional>
#include <string>

#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/edge_pointer.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/no_destructor.h"
#include "base/timer/timer.h"
#include "ui/display/screen.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/widget/widget.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaLinuxEdgePointer";
constexpr base::TimeDelta kPoll = base::Milliseconds(30);

class EdgePointer {
 public:
  static EdgePointer& Get() {
    static base::NoDestructor<EdgePointer> pointer;
    return *pointer;
  }

  void Watch(const std::string& id, bool on) {
    if (on) {
      watched_.try_emplace(id, std::nullopt);
    } else {
      watched_.erase(id);
    }
    if (!watched_.empty() && !timer_.IsRunning()) {
      timer_.Start(FROM_HERE, kPoll,
                   base::BindRepeating(&EdgePointer::Poll,
                                       base::Unretained(this)));
    } else if (watched_.empty()) {
      timer_.Stop();
    }
  }

 private:
  friend class base::NoDestructor<EdgePointer>;
  EdgePointer() = default;

  std::optional<gfx::Point> PointIn(const std::string& id) const {
    AppWindow* window = AppWindows::Get().Find(id);
    views::Widget* widget = window ? window->widget() : nullptr;
    display::Screen* screen = display::Screen::Get();
    if (!widget || widget->IsClosed() || !widget->IsVisible() ||
        widget->IsMinimized() || !screen) {
      return std::nullopt;
    }
    return PointerInWindow(screen->GetCursorScreenPoint(),
                           widget->GetClientAreaBoundsInScreen());
  }

  void Poll() {
    for (auto& [id, last] : watched_) {
      std::optional<gfx::Point> now = PointIn(id);
      if (now == last) {
        continue;
      }
      last = now;
      base::Value point;
      if (now) {
        point = base::Value(base::ListValue().Append(now->x()).Append(now->y()));
      }
      ModuleRegistry::Get().Emit(
          kModule, "point",
          base::Value(
              base::DictValue().Set("id", id).Set("point", std::move(point))));
    }
  }

  std::map<std::string, std::optional<gfx::Point>> watched_;
  base::RepeatingTimer timer_;
};

}

std::optional<gfx::Point> PointerInWindow(const gfx::Point& cursor,
                                          const gfx::Rect& bounds) {
  const int x = cursor.x() - bounds.x();
  const int y = cursor.y() - bounds.y();
  if (x < 0 || y < 0 || x >= bounds.width() || y >= bounds.height()) {
    return std::nullopt;
  }
  return gfx::Point(x, y);
}

void RegisterEdgePointerModule(ModuleRegistry& registry) {
  registry.Define(kModule).Async(
      "watch", AnswerOf([](const base::ListValue& args) {
        const std::string id = StringArg(args, 0);
        if (!id.empty()) {
          EdgePointer::Get().Watch(id, BoolArg(args, 1));
        }
        return ModuleResult(base::Value());
      }));
}

}
