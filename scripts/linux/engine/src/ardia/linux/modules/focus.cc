// Copyright 2026 Ardia. Apache-2.0.

#include <cstdlib>
#include <optional>

#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/ui_host/modules.h"
#include "ui/display/screen.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/x/connection.h"
#include "ui/gfx/x/xproto.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaFocus";
constexpr int kSwitcherPointerSlop = 4;
constexpr int kControl = 1;
constexpr int kOption = 2;
constexpr int kShift = 4;

std::optional<gfx::Point>& SwitcherPointerStart() {
  static std::optional<gfx::Point> start;
  return start;
}

gfx::Point CursorNow() {
  display::Screen* screen = display::Screen::Get();
  return screen ? screen->GetCursorScreenPoint() : gfx::Point();
}

int HeldModifiers() {
  x11::Connection* connection = x11::Connection::Get();
  if (!connection || !connection->Ready()) {
    return 0;
  }
  auto reply = connection->QueryPointer({connection->default_root()}).Sync();
  if (!reply) {
    return 0;
  }
  const auto mask = static_cast<uint32_t>(reply->mask);
  int held = 0;
  if (mask & static_cast<uint32_t>(x11::KeyButMask::Control)) {
    held |= kControl;
  }
  if (mask & static_cast<uint32_t>(x11::KeyButMask::Mod1)) {
    held |= kOption;
  }
  if (mask & static_cast<uint32_t>(x11::KeyButMask::Shift)) {
    held |= kShift;
  }
  return held;
}

bool SwitcherPointerMoved() {
  const std::optional<gfx::Point>& start = SwitcherPointerStart();
  if (!start) {
    return false;
  }
  const gfx::Point now = CursorNow();
  return std::abs(now.x() - start->x()) > kSwitcherPointerSlop ||
         std::abs(now.y() - start->y()) > kSwitcherPointerSlop;
}

}

void RegisterFocusModule(ModuleRegistry& registry) {
  registry.Define(kModule)
      .Sync("heldModifiers", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(HeldModifiers()));
            }))
      .Sync("switcherPointerMoved", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(SwitcherPointerMoved()));
            }))
      .Sync("pressesWithoutRelease", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(0));
            }))
      .Async("markSwitcherPointer", AnswerOf([](const base::ListValue& args) {
               if (BoolArg(args, 0)) {
                 SwitcherPointerStart() = CursorNow();
               } else {
                 SwitcherPointerStart().reset();
               }
               return ModuleResult(base::Value());
             }));
}

}
