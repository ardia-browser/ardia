// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_WINDOWS_APP_WINDOWS_H_
#define ARDIA_LINUX_WINDOWS_APP_WINDOWS_H_

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace content {
class WebContents;
}

namespace ardia_linux {

class AppWindow;
class ModuleRegistry;

enum class WindowKind { kBrowser, kSmall, kSettings, kImport, kPopup };

struct WindowShape {
  WindowKind kind = WindowKind::kBrowser;
  gfx::Rect bounds;
  gfx::Size minimum_size;
  std::string title = "Ardia";
  bool focus = true;
  bool animated = false;
  bool resizable = true;
  bool maximizable = true;
  bool fullscreenable = true;
};

class AppWindows {
 public:
  AppWindows(const AppWindows&) = delete;
  AppWindows& operator=(const AppWindows&) = delete;

  static AppWindows& Get();
  static base::ListValue FrameOf(const gfx::Rect& bounds);
  static std::optional<gfx::Rect> BoundsOf(const base::ListValue* frame);

  void Register(ModuleRegistry& registry);

  bool IsShaped(std::string_view id) const;
  bool Adopt(const std::string& id,
             std::unique_ptr<content::WebContents> contents);

  AppWindow* Find(std::string_view id) const;
  AppWindow* ForUiContents(const content::WebContents* contents) const;
  AppWindow* LastActive() const;
  bool AnotherJustAppearedActive(const AppWindow* window) const;
  void NoteAppearedActive(const AppWindow* window);
  std::vector<std::string> Ids() const;
  void CloseAll();

  void Emit(std::string_view event, base::DictValue payload);
  void WindowEvent(std::string_view type,
                   const std::string& id,
                   base::DictValue extra = base::DictValue());

  void WindowActivated(AppWindow* window);
  void WindowClosed(AppWindow* window);

 private:
  friend class base::NoDestructor<AppWindows>;

  AppWindows();
  ~AppWindows();

  WindowShape ShapeFor(const std::string& id, const base::DictValue& options);
  gfx::Rect Placement(const std::string& id,
                      WindowKind kind,
                      const base::DictValue& options) const;
  void QuitWhenNoWindowsAreLeft();

  std::map<std::string, WindowShape, std::less<>> shaped_;
  std::map<std::string, std::unique_ptr<AppWindow>, std::less<>> windows_;
  std::string last_browser_;
  std::string last_active_;
  std::string appeared_active_;
  base::TimeTicks appeared_active_at_;
  base::OneShotTimer last_window_timer_;
  base::WeakPtrFactory<AppWindows> weak_factory_{this};
};

}

#endif
