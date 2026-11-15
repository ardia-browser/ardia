// Copyright 2026 Ardia. Apache-2.0.

#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/ui_host/ui_host_parts.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/base64.h"
#include "base/files/file_util.h"
#include "base/immediate_crash.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/events/event.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/keycodes/dom/dom_key.h"
#include "ui/events/keycodes/dom/keycode_converter.h"
#include "ui/events/keycodes/keyboard_code_conversion.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/vector2d.h"
#include "ui/views/widget/widget.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaDev";
constexpr char kPngDataPrefix[] = "data:image/png;base64,";

std::optional<ModuleResult> RefuseOutsideTests() {
  if (CurrentLaunchConfig().test_instance) {
    return std::nullopt;
  }
  return ModuleFailure("dev calls are for test instances",
                       "ERR_NOT_TEST_INSTANCE");
}

void SnapshotWindow(base::ListValue args, ModuleReply reply) {
  if (auto refused = RefuseOutsideTests()) {
    std::move(reply).Run(std::move(*refused));
    return;
  }
  AppWindow* window = AppWindows::Get().Find(StringArg(args, 0));
  const base::FilePath path(StringArg(args, 1));
  if (!window || path.empty() || !path.IsAbsolute()) {
    std::move(reply).Run(base::Value(false));
    return;
  }
  window->Snapshot(base::BindOnce(
      [](base::FilePath path, ModuleReply reply, base::Value picture) {
        const std::string* url =
            picture.is_dict() ? picture.GetDict().FindString("url") : nullptr;
        std::string png;
        if (!url || !base::StartsWith(*url, kPngDataPrefix) ||
            !base::Base64Decode(
                std::string_view(*url).substr(sizeof(kPngDataPrefix) - 1),
                &png)) {
          std::move(reply).Run(base::Value(false));
          return;
        }
        base::ThreadPool::PostTaskAndReplyWithResult(
            FROM_HERE, {base::MayBlock()},
            base::BindOnce(
                [](base::FilePath path, std::string png) {
                  return base::WriteFile(path, png);
                },
                path, std::move(png)),
            base::BindOnce(
                [](ModuleReply reply, bool written) {
                  std::move(reply).Run(base::Value(written));
                },
                std::move(reply)));
      },
      path, std::move(reply)));
}

aura::WindowTreeHost* HostOf(const base::ListValue& args) {
  AppWindow* window = AppWindows::Get().Find(StringArg(args, 0));
  views::Widget* widget = window ? window->widget() : nullptr;
  return widget && widget->GetNativeWindow()
             ? widget->GetNativeWindow()->GetHost()
             : nullptr;
}

int ModifierFlags(const base::DictValue& press) {
  int flags = 0;
  if (const base::ListValue* modifiers = press.FindList("modifiers")) {
    for (const base::Value& modifier : *modifiers) {
      const std::string* name = modifier.GetIfString();
      if (!name) {
        continue;
      }
      if (*name == "control" || *name == "ctrl" || *name == "command") {
        flags |= ui::EF_CONTROL_DOWN;
      } else if (*name == "shift") {
        flags |= ui::EF_SHIFT_DOWN;
      } else if (*name == "option" || *name == "alt") {
        flags |= ui::EF_ALT_DOWN;
      }
    }
  }
  return flags;
}

ModuleResult InjectKey(const base::ListValue& args) {
  aura::WindowTreeHost* host = HostOf(args);
  const base::DictValue* press = DictArg(args, 1);
  const std::string* code = press ? press->FindString("code") : nullptr;
  if (!host || !code) {
    return ModuleFailure("devKey takes a window id and { code, modifiers }");
  }
  const ui::DomCode dom_code = ui::KeycodeConverter::CodeStringToDomCode(*code);
  if (dom_code == ui::DomCode::NONE) {
    return ModuleFailure("unknown DOM code " + *code);
  }
  const int flags = ModifierFlags(*press);
  ui::DomKey dom_key;
  ui::KeyboardCode key_code;
  if (!ui::DomCodeToUsLayoutDomKey(dom_code, flags, &dom_key, &key_code)) {
    return ModuleFailure("no US layout key for " + *code);
  }
  const std::string* type = press->FindString("type");
  const bool down = !type || *type != "up";
  const bool up = !type || *type != "down";
  if (down) {
    ui::KeyEvent pressed(ui::EventType::kKeyPressed, key_code, dom_code, flags,
                         dom_key, base::TimeTicks::Now());
    host->SendEventToSink(&pressed);
  }
  if (up) {
    ui::KeyEvent released(ui::EventType::kKeyReleased, key_code, dom_code,
                          flags, dom_key, base::TimeTicks::Now());
    host->SendEventToSink(&released);
  }
  return base::Value(true);
}

int ButtonFlag(const std::string* button) {
  if (button && *button == "right") {
    return ui::EF_RIGHT_MOUSE_BUTTON;
  }
  if (button && *button == "middle") {
    return ui::EF_MIDDLE_MOUSE_BUTTON;
  }
  return ui::EF_LEFT_MOUSE_BUTTON;
}

ModuleResult InjectPointer(const base::ListValue& args) {
  aura::WindowTreeHost* host = HostOf(args);
  const base::DictValue* pointer = DictArg(args, 1);
  const std::string* type = pointer ? pointer->FindString("type") : nullptr;
  if (!host || !type) {
    return ModuleFailure(
        "devPointer takes a window id and { type, x, y, button }");
  }
  gfx::Point at(static_cast<int>(pointer->FindDouble("x").value_or(0)),
                static_cast<int>(pointer->FindDouble("y").value_or(0)));
  host->ConvertDIPToPixels(&at);
  const int button = ButtonFlag(pointer->FindString("button"));
  const int flags = ModifierFlags(*pointer);
  auto send = [&](ui::EventType event_type, int held, int changed,
                  int click_count) {
    ui::MouseEvent event(event_type, at, at, base::TimeTicks::Now(),
                         flags | held, changed);
    if (click_count) {
      event.SetClickCount(click_count);
    }
    host->SendEventToSink(&event);
  };
  if (*type == "move") {
    send(ui::EventType::kMouseMoved, 0, 0, 0);
  } else if (*type == "down") {
    send(ui::EventType::kMousePressed, button, button, 1);
  } else if (*type == "up") {
    send(ui::EventType::kMouseReleased, button, button, 1);
  } else if (*type == "click") {
    const int count = pointer->FindInt("clickCount").value_or(1);
    send(ui::EventType::kMouseMoved, 0, 0, 0);
    for (int i = 1; i <= count; ++i) {
      send(ui::EventType::kMousePressed, button, button, i);
      send(ui::EventType::kMouseReleased, button, button, i);
    }
  } else if (*type == "wheel") {
    ui::MouseWheelEvent wheel(
        gfx::Vector2d(
            static_cast<int>(pointer->FindDouble("deltaX").value_or(0)),
            static_cast<int>(pointer->FindDouble("deltaY").value_or(0))),
        at, at, base::TimeTicks::Now(), flags, 0);
    host->SendEventToSink(&wheel);
  } else {
    return ModuleFailure("devPointer type is move, down, up, click or wheel");
  }
  return base::Value(true);
}

}

void RegisterDevModule(ModuleRegistry& registry) {
  registry.Define(kModule)
      .Async("devMenuCommand", AnswerOf([](const base::ListValue& args) {
               if (auto refused = RefuseOutsideTests()) {
                 return std::move(*refused);
               }
               base::DictValue payload;
               payload.Set("command", StringArg(args, 0));
               payload.Set("arg", OrNull(OptionalStringArg(args, 1)));
               payload.Set("windowId", base::Value());
               payload.Set("focusGeneration", base::Value());
               ModuleRegistry::Get().Emit("ArdiaMenus", "onCommand",
                                          base::Value(std::move(payload)));
               return ModuleResult(base::Value());
             }))
      .Async("devSnapshotWindow", base::BindRepeating(&SnapshotWindow))
      .Async("devKey", AnswerOf([](const base::ListValue& args) {
               if (auto refused = RefuseOutsideTests()) {
                 return std::move(*refused);
               }
               return InjectKey(args);
             }))
      .Async("devPointer", AnswerOf([](const base::ListValue& args) {
               if (auto refused = RefuseOutsideTests()) {
                 return std::move(*refused);
               }
               return InjectPointer(args);
             }))
      .Async("reloadUi", AnswerOf([](const base::ListValue&) {
               if (auto refused = RefuseOutsideTests()) {
                 return std::move(*refused);
               }
               Note("dev", "reloading the UI");
               ReloadUiHost();
               return ModuleResult(base::Value());
             }))
      .Async("devCrash", AnswerOf([](const base::ListValue&) {
               if (auto refused = RefuseOutsideTests()) {
                 return std::move(*refused);
               }
               base::ImmediateCrash();
             }));
}

}
