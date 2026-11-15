// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/owner_window.h"

#include <string>

#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "ui/views/widget/widget.h"

namespace ardia_linux {

namespace {

views::Widget* ShownWidget(AppWindow* window) {
  views::Widget* widget = window ? window->widget() : nullptr;
  return widget && !widget->IsClosed() && widget->IsVisible() &&
                 !widget->IsMinimized()
             ? widget
             : nullptr;
}

}

views::Widget* OwnerWidget(std::string_view window_id) {
  AppWindows& windows = AppWindows::Get();
  if (!window_id.empty()) {
    if (views::Widget* chosen = ShownWidget(windows.Find(window_id))) {
      return chosen;
    }
  }
  for (const std::string& id : windows.Ids()) {
    AppWindow* window = windows.Find(id);
    if (window && window->widget() && window->widget()->IsActive()) {
      return window->widget();
    }
  }
  if (views::Widget* last = ShownWidget(windows.LastActive())) {
    return last;
  }
  for (const std::string& id : windows.Ids()) {
    if (views::Widget* shown = ShownWidget(windows.Find(id))) {
      return shown;
    }
  }
  return nullptr;
}

}
