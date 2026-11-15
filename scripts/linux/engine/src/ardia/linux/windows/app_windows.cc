// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/windows/app_windows.h"

#include <algorithm>
#include <utility>

#include "ardia/linux/app_lifetime.h"
#include "ardia/linux/log.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/windows/app_window.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"
#include "content/public/browser/web_contents.h"
#include "ui/display/display.h"
#include "ui/display/screen.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaAppWindows";
constexpr int kCornerRadius = 19;
constexpr int kCascadeStep = 28;
constexpr base::TimeDelta kLastWindowGrace = base::Milliseconds(400);

struct Sizes {
  int width;
  int height;
  int min_width;
  int min_height;
};

Sizes SizesOf(WindowKind kind) {
  switch (kind) {
    case WindowKind::kSmall:
      return {900, 640, 420, 300};
    case WindowKind::kSettings:
      return {820, 640, 720, 480};
    case WindowKind::kImport:
      return {640, 600, 640, 600};
    case WindowKind::kPopup:
      return {600, 500, 200, 150};
    case WindowKind::kBrowser:
      return {1280, 800, 480, 360};
  }
}

WindowKind KindOf(const std::string* name) {
  if (!name) {
    return WindowKind::kBrowser;
  }
  if (*name == "small") {
    return WindowKind::kSmall;
  }
  if (*name == "settings") {
    return WindowKind::kSettings;
  }
  if (*name == "import") {
    return WindowKind::kImport;
  }
  if (*name == "popup") {
    return WindowKind::kPopup;
  }
  return WindowKind::kBrowser;
}

int FlipHeight() {
  return display::Screen::Get()->GetPrimaryDisplay().bounds().height();
}

std::string StringAt(const base::ListValue& args, size_t index) {
  if (index >= args.size()) {
    return std::string();
  }
  const std::string* value = args[index].GetIfString();
  return value ? *value : std::string();
}

ModuleResult Nothing() {
  return base::Value();
}

AppWindow* WindowAt(const base::ListValue& args) {
  return AppWindows::Get().Find(StringAt(args, 0));
}

}

AppWindows& AppWindows::Get() {
  static base::NoDestructor<AppWindows> windows;
  return *windows;
}

AppWindows::AppWindows() = default;

AppWindows::~AppWindows() = default;

base::ListValue AppWindows::FrameOf(const gfx::Rect& bounds) {
  base::ListValue frame;
  frame.Append(bounds.x());
  frame.Append(FlipHeight() - bounds.bottom());
  frame.Append(bounds.width());
  frame.Append(bounds.height());
  return frame;
}

std::optional<gfx::Rect> AppWindows::BoundsOf(const base::ListValue* frame) {
  if (!frame || frame->size() < 4) {
    return std::nullopt;
  }
  const int x = static_cast<int>((*frame)[0].GetIfDouble().value_or(0));
  const int y = static_cast<int>((*frame)[1].GetIfDouble().value_or(0));
  const int width = static_cast<int>((*frame)[2].GetIfDouble().value_or(0));
  const int height = static_cast<int>((*frame)[3].GetIfDouble().value_or(0));
  if (width <= 0 || height <= 0) {
    return std::nullopt;
  }
  return gfx::Rect(x, FlipHeight() - (y + height), width, height);
}

gfx::Rect AppWindows::Placement(const std::string& id,
                                WindowKind kind,
                                const base::DictValue& options) const {
  const Sizes sizes = SizesOf(kind);
  display::Screen* screen = display::Screen::Get();
  if (std::optional<gfx::Rect> asked = BoundsOf(options.FindList("frame"))) {
    const gfx::Rect area = screen->GetDisplayMatching(*asked).work_area();
    const int width =
        std::min(std::max(asked->width(), sizes.min_width), area.width());
    const int height =
        std::min(std::max(asked->height(), sizes.min_height), area.height());
    const int x =
        std::max(area.x(), std::min(asked->x(), area.right() - width));
    const int y =
        std::max(area.y(), std::min(asked->y(), area.bottom() - height));
    return gfx::Rect(x, y, width, height);
  }
  const gfx::Rect area =
      screen->GetDisplayNearestPoint(screen->GetCursorScreenPoint())
          .work_area();
  int wanted_width = sizes.width;
  int wanted_height = sizes.height;
  if (kind == WindowKind::kSmall) {
    if (const base::ListValue* size = options.FindList("size");
        size && size->size() >= 2) {
      wanted_width = static_cast<int>((*size)[0].GetIfDouble().value_or(
          wanted_width));
      wanted_height = static_cast<int>((*size)[1].GetIfDouble().value_or(
          wanted_height));
    }
  }
  const int width = std::min(wanted_width, area.width());
  const int height = std::min(wanted_height, area.height());
  int x = area.x() + (area.width() - width) / 2;
  int y = area.y() + (area.height() - height) / 2;
  if (kind == WindowKind::kBrowser && !last_browser_.empty() &&
      last_browser_ != id) {
    AppWindow* previous = Find(last_browser_);
    if (previous && previous->widget() && previous->widget()->IsVisible()) {
      const gfx::Rect at = previous->Bounds();
      x = std::min(at.x() + kCascadeStep, area.right() - width);
      y = std::min(at.y() + kCascadeStep, area.bottom() - height);
    }
  }
  return gfx::Rect(x, y, width, height);
}

WindowShape AppWindows::ShapeFor(const std::string& id,
                                 const base::DictValue& options) {
  WindowShape shape;
  shape.kind = KindOf(options.FindString("kind"));
  shape.focus = options.FindBool("focus").value_or(true);
  shape.animated = options.FindBool("animated").value_or(false);
  if (const std::string* title = options.FindString("title");
      title && !title->empty()) {
    shape.title = *title;
  }
  shape.bounds = Placement(id, shape.kind, options);
  const Sizes sizes = SizesOf(shape.kind);
  shape.minimum_size =
      gfx::Size(std::min(sizes.min_width, shape.bounds.width()),
                std::min(sizes.min_height, shape.bounds.height()));
  shape.resizable = shape.kind != WindowKind::kImport;
  shape.maximizable = shape.kind != WindowKind::kImport;
  shape.fullscreenable = shape.kind == WindowKind::kBrowser ||
                         shape.kind == WindowKind::kSmall;
  return shape;
}

bool AppWindows::IsShaped(std::string_view id) const {
  return shaped_.contains(id) && !windows_.contains(id);
}

bool AppWindows::Adopt(const std::string& id,
                       std::unique_ptr<content::WebContents> contents) {
  auto shape = shaped_.find(id);
  if (!contents || shape == shaped_.end() || windows_.contains(id)) {
    Note("windows", "a window.open child without a shape was refused");
    return false;
  }
  WindowShape taken = std::move(shape->second);
  shaped_.erase(shape);
  const WindowKind kind = taken.kind;
  last_window_timer_.Stop();
  windows_[id] =
      std::make_unique<AppWindow>(id, std::move(taken), std::move(contents));
  if (kind == WindowKind::kBrowser) {
    last_browser_ = id;
  }
  return true;
}

AppWindow* AppWindows::Find(std::string_view id) const {
  auto found = windows_.find(id);
  return found == windows_.end() || found->second->closing()
             ? nullptr
             : found->second.get();
}

AppWindow* AppWindows::ForUiContents(const content::WebContents* contents) const {
  for (const auto& [id, window] : windows_) {
    if (contents && window->ui_contents() == contents) {
      return window.get();
    }
  }
  return nullptr;
}

AppWindow* AppWindows::LastActive() const {
  if (AppWindow* active = Find(last_active_)) {
    return active;
  }
  for (const auto& [id, window] : windows_) {
    if (!window->closing()) {
      return window.get();
    }
  }
  return nullptr;
}

std::vector<std::string> AppWindows::Ids() const {
  std::vector<std::string> ids;
  for (const auto& [id, window] : windows_) {
    if (!window->closing()) {
      ids.push_back(id);
    }
  }
  return ids;
}

void AppWindows::CloseAll() {
  shaped_.clear();
  for (const std::string& id : Ids()) {
    if (AppWindow* window = Find(id)) {
      window->CloseByApp();
    }
  }
}

void AppWindows::Emit(std::string_view event, base::DictValue payload) {
  if (ModuleRegistry::Exists()) {
    ModuleRegistry::Get().Emit(kModule, event, base::Value(std::move(payload)));
  }
}

void AppWindows::WindowEvent(std::string_view type,
                             const std::string& id,
                             base::DictValue extra) {
  extra.Set("type", type);
  extra.Set("id", id);
  Emit("onWindowEvent", std::move(extra));
}

void AppWindows::WindowActivated(AppWindow* window) {
  last_active_ = window->id();
  if (window->kind() == WindowKind::kBrowser) {
    last_browser_ = window->id();
  }
  WindowEvent("focus", window->id());
}

void AppWindows::WindowClosed(AppWindow* window) {
  const std::string id = window->id();
  if (last_browser_ == id) {
    last_browser_.clear();
  }
  WindowEvent("close", id);
  auto found = windows_.find(id);
  if (found != windows_.end()) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->DeleteSoon(
        FROM_HERE, std::move(found->second));
    windows_.erase(found);
  }
  QuitWhenNoWindowsAreLeft();
}

void AppWindows::QuitWhenNoWindowsAreLeft() {
  if (AppLifetime::Get().quitting() || AppLifetime::Get().finished()) {
    return;
  }
  last_window_timer_.Start(FROM_HERE, kLastWindowGrace, base::BindOnce([] {
                             if (AppWindows::Get().Ids().empty() &&
                                 AppWindows::Get().shaped_.empty()) {
                               AppLifetime::Get().RequestQuit();
                             }
                           }));
}

void AppWindows::Register(ModuleRegistry& registry) {
  auto sync = [](auto run) {
    return base::BindRepeating(
        [](decltype(run) run, const base::ListValue& args) -> ModuleResult {
          return run(args);
        },
        run);
  };
  auto async = [](auto run) {
    return base::BindRepeating(
        [](decltype(run) run, base::ListValue args, ModuleReply reply) {
          std::move(reply).Run(run(args));
        },
        run);
  };
  auto ignore = [](const base::ListValue&) { return Nothing(); };
  registry.Define(kModule)
      .Constant("cornerRadius", base::Value(kCornerRadius))
      .Sync("shapeWindow", sync([](const base::ListValue& args) {
              const std::string id = StringAt(args, 0);
              if (id.empty()) {
                return ModuleFailure("a window needs an id");
              }
              const base::DictValue* options =
                  args.size() > 1 ? args[1].GetIfDict() : nullptr;
              AppWindows& windows = AppWindows::Get();
              windows.shaped_[id] =
                  windows.ShapeFor(id, options ? *options : base::DictValue());
              windows.last_window_timer_.Stop();
              return Nothing();
            }))
      .Sync("showWindow", sync([](const base::ListValue& args) {
              if (AppWindow* window = WindowAt(args)) {
                window->Show();
              }
              return Nothing();
            }))
      .Sync("windowCornerRadius", sync([](const base::ListValue&) {
              return ModuleResult(base::Value(kCornerRadius));
            }))
      .Sync("isMaximized", sync([](const base::ListValue& args) {
              AppWindow* window = WindowAt(args);
              return ModuleResult(base::Value(
                  window && window->widget() && window->widget()->IsMaximized()));
            }))
      .Sync("debugWindowState", sync([](const base::ListValue& args) {
              AppWindow* window = WindowAt(args);
              return window ? ModuleResult(base::Value(window->DebugState()))
                            : Nothing();
            }))
      .Sync("shapeDragPreview", sync(ignore))
      .Sync("moveDragPreview", sync(ignore))
      .Sync("hideDragPreview", sync(ignore))
      .Sync("dragPreviewBounds", sync(ignore))
      .Sync("placeDragPreview", sync(ignore))
      .Sync("dragPreviewTarget", sync(ignore))
      .Async("closeWindow", async([](const base::ListValue& args) {
               if (AppWindow* window = WindowAt(args)) {
                 window->CloseByApp();
               }
               return Nothing();
             }))
      .Async("focusWindow", async([](const base::ListValue& args) {
               if (AppWindow* window = WindowAt(args)) {
                 window->Focus();
               }
               return Nothing();
             }))
      .Async("minimizeWindow", async([](const base::ListValue& args) {
               if (AppWindow* window = WindowAt(args)) {
                 window->Minimize();
               }
               return Nothing();
             }))
      .Async("toggleMaximizeWindow", async([](const base::ListValue& args) {
               if (AppWindow* window = WindowAt(args)) {
                 window->ToggleMaximize();
               }
               return Nothing();
             }))
      .Async("setCaptionRegions", async(ignore))
      .Async("setTrafficLightsCenter", async(ignore))
      .Async("raiseView", async(ignore))
      .Async("endWindowDrag", async(ignore))
      .Async("noteMeadow", async(ignore))
      .Async("windowFrame", async([](const base::ListValue& args) {
               AppWindow* window = WindowAt(args);
               return window ? ModuleResult(base::Value(
                                   AppWindows::FrameOf(window->Bounds())))
                             : Nothing();
             }))
      .Async("frameCornerRadius", async([](const base::ListValue& args) {
               AppWindow* window = WindowAt(args);
               return ModuleResult(
                   base::Value(window ? window->FrameCornerRadius() : 12));
             }))
      .Async("windowIds", async([](const base::ListValue&) {
               base::ListValue ids;
               for (const std::string& id : AppWindows::Get().Ids()) {
                 ids.Append(id);
               }
               return ModuleResult(base::Value(std::move(ids)));
             }))
      .Async("snapshotWindow",
             base::BindRepeating([](base::ListValue args, ModuleReply reply) {
               AppWindow* window = WindowAt(args);
               if (!window) {
                 std::move(reply).Run(Nothing());
                 return;
               }
               window->Snapshot(base::BindOnce(
                   [](ModuleReply reply, base::Value picture) {
                     std::move(reply).Run(std::move(picture));
                   },
                   std::move(reply)));
             }))
      .Async("setWindowTitle", async([](const base::ListValue& args) {
               if (AppWindow* window = WindowAt(args)) {
                 window->SetTitle(StringAt(args, 1));
               }
               return Nothing();
             }))
      .Async("restoreFullScreen", async([](const base::ListValue& args) {
               if (const base::ListValue* ids =
                       args.size() > 0 ? args[0].GetIfList() : nullptr) {
                 for (const base::Value& id : *ids) {
                   if (const std::string* name = id.GetIfString()) {
                     if (AppWindow* window = AppWindows::Get().Find(*name)) {
                       window->SetPageFullscreen(true);
                     }
                   }
                 }
               }
               if (AppWindow* focus = AppWindows::Get().Find(StringAt(args, 1))) {
                 focus->Focus();
               }
               return Nothing();
             }))
      .Async("setPageFullScreen", async([](const base::ListValue& args) {
               if (AppWindow* window = WindowAt(args)) {
                 window->SetPageFullscreen(
                     args.size() > 1 && args[1].GetIfBool().value_or(false));
               }
               return Nothing();
             }))
      .Async("beginWindowDrag", async([](const base::ListValue& args) {
               if (AppWindow* window = WindowAt(args)) {
                 window->BeginDrag();
               }
               return Nothing();
             }))
      .Async("quit", async([](const base::ListValue&) {
               AppLifetime::Get().RequestQuit();
               return Nothing();
             }))
      .Async("replyToTerminate", async([](const base::ListValue& args) {
               AppLifetime::Get().ReplyToTerminate(
                   args.size() > 0 && args[0].GetIfBool().value_or(false));
               return Nothing();
             }));
}

}
