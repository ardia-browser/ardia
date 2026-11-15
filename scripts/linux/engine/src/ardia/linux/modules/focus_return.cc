// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/focus_return.h"

#include <unistd.h>

#include <string>

#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/timer/timer.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/gfx/x/atom_cache.h"
#include "ui/gfx/x/connection.h"
#include "ui/gfx/x/xproto.h"
#include "ui/ozone/public/ozone_platform.h"
#include "ui/views/widget/widget.h"

namespace ardia_linux {

namespace {

constexpr base::TimeDelta kReturnAfter = base::Milliseconds(100);
constexpr uint32_t kNone = 0;
constexpr uint32_t kPointerRoot = 1;

views::Widget* Focusable(AppWindow* window) {
  views::Widget* widget = window && !window->closing() ? window->widget()
                                                        : nullptr;
  return widget && !widget->IsClosed() && widget->IsVisible() &&
                 !widget->IsMinimized() && widget->CanActivate()
             ? widget
             : nullptr;
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

bool OnX11() {
  return ui::OzonePlatform::GetPlatformNameForTest() == "x11";
}

std::optional<XFocusState> QueryXFocus(std::set<uint32_t>* ours) {
  x11::Connection* x = x11::Connection::Get();
  if (!x || !x->Ready()) {
    return std::nullopt;
  }
  XFocusState state;
  state.root = static_cast<uint32_t>(x->default_root());
  uint32_t active = 0;
  if (x->GetPropertyAs(x->default_root(), x11::GetAtom("_NET_ACTIVE_WINDOW"),
                       &active)) {
    state.active = active;
  } else {
    auto reply = x->GetInputFocus({}).Sync();
    if (!reply) {
      return std::nullopt;
    }
    state.focus = static_cast<uint32_t>(reply->focus);
  }
  const uint32_t candidate = state.active.value_or(state.focus);
  uint32_t pid = 0;
  if (candidate > kPointerRoot && candidate != state.root &&
      x->GetPropertyAs(static_cast<x11::Window>(candidate),
                       x11::GetAtom("_NET_WM_PID"), &pid) &&
      pid == static_cast<uint32_t>(getpid())) {
    ours->insert(candidate);
  }
  for (const std::string& id : AppWindows::Get().Ids()) {
    AppWindow* window = AppWindows::Get().Find(id);
    views::Widget* widget = window ? window->widget() : nullptr;
    if (widget && widget->GetNativeWindow() &&
        widget->GetNativeWindow()->GetHost()) {
      ours->insert(static_cast<uint32_t>(
          widget->GetNativeWindow()->GetHost()->GetAcceleratedWidget()));
    }
  }
  return state;
}

class FocusReturn {
 public:
  static FocusReturn& Get() {
    static base::NoDestructor<FocusReturn> focus_return;
    return *focus_return;
  }

  void Soon(std::string_view preferred) {
    if (!preferred.empty() || !timer_.IsRunning()) {
      preferred_ = std::string(preferred);
    }
    timer_.Start(FROM_HERE, kReturnAfter,
                 base::BindOnce(&FocusReturn::Return, base::Unretained(this)));
  }

 private:
  friend class base::NoDestructor<FocusReturn>;
  FocusReturn() = default;

  void Return() {
    std::string preferred = std::move(preferred_);
    preferred_.clear();
    if (CurrentLaunchConfig().background || AnyOfOursActive()) {
      return;
    }
    views::Widget* target = Focusable(AppWindows::Get().Find(preferred));
    if (!target) {
      target = Focusable(AppWindows::Get().LastActive());
    }
    if (!target) {
      return;
    }
    if (OnX11()) {
      std::set<uint32_t> ours;
      std::optional<XFocusState> state = QueryXFocus(&ours);
      if (!state) {
        CountLinux("focus_return_unverified");
        return;
      }
      if (!NothingElseFocused(*state, ours)) {
        CountLinux("focus_return_skipped");
        return;
      }
    }
    CountLinux("focus_returned");
    target->Activate();
  }

  std::string preferred_;
  base::OneShotTimer timer_;
};

}

bool NothingElseFocused(const XFocusState& state,
                        const std::set<uint32_t>& ours) {
  if (state.active) {
    return *state.active == kNone || ours.contains(*state.active);
  }
  return state.focus == kNone || state.focus == kPointerRoot ||
         state.focus == state.root || ours.contains(state.focus);
}

void ReturnFocusSoon(std::string_view preferred_window_id) {
  FocusReturn::Get().Soon(preferred_window_id);
}

}
