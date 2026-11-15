// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/host/key_map.h"

#include <utility>

#include "ardia/linux/app_lifetime.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "components/input/native_web_keyboard_event.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/keycodes/dom/keycode_converter.h"
#include "ui/events/keycodes/keyboard_codes.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaMenus";

constexpr int kModifierMask =
    blink::WebInputEvent::kShiftKey | blink::WebInputEvent::kControlKey |
    blink::WebInputEvent::kAltKey | blink::WebInputEvent::kMetaKey;

bool KeyDown(const input::NativeWebKeyboardEvent& event) {
  return event.GetType() == blink::WebInputEvent::Type::kRawKeyDown &&
         event.windows_key_code != ui::VKEY_PROCESSKEY;
}

std::string CodeOf(const input::NativeWebKeyboardEvent& event) {
  return std::string(ui::KeycodeConverter::DomCodeToCodeString(
      static_cast<ui::DomCode>(event.dom_code)));
}

int ModifiersOf(const base::DictValue& entry) {
  int modifiers = 0;
  if (entry.FindBool("shift").value_or(false)) {
    modifiers |= blink::WebInputEvent::kShiftKey;
  }
  if (entry.FindBool("ctrl").value_or(false)) {
    modifiers |= blink::WebInputEvent::kControlKey;
  }
  if (entry.FindBool("alt").value_or(false)) {
    modifiers |= blink::WebInputEvent::kAltKey;
  }
  if (entry.FindBool("meta").value_or(false)) {
    modifiers |= blink::WebInputEvent::kMetaKey;
  }
  return modifiers;
}

}

KeyMap& KeyMap::Get() {
  static base::NoDestructor<KeyMap> map;
  return *map;
}

KeyMap::KeyMap() = default;

KeyMap::~KeyMap() = default;

std::string KeyMap::KeyOf(const std::string& code, int modifiers) {
  return base::StrCat({code, ":", base::NumberToString(modifiers & kModifierMask)});
}

void KeyMap::Register(ModuleRegistry& registry) {
  registry.Define(kModule).Sync(
      "setKeyMap",
      base::BindRepeating([](const base::ListValue& args) -> ModuleResult {
        const base::ListValue* entries =
            args.size() > 0 ? args[0].GetIfList() : nullptr;
        if (!entries) {
          return ModuleFailure("setKeyMap takes a list of keys");
        }
        return base::Value(KeyMap::Get().Set(*entries));
      }));
}

int KeyMap::Set(const base::ListValue& entries) {
  std::map<std::string, Entry> next;
  for (const base::Value& value : entries) {
    const base::DictValue* entry = value.GetIfDict();
    const std::string* code = entry ? entry->FindString("code") : nullptr;
    const std::string* command = entry ? entry->FindString("command") : nullptr;
    if (!code || code->empty() || !command || command->empty()) {
      continue;
    }
    Entry made;
    made.command = *command;
    if (const std::string* arg = entry->FindString("arg")) {
      made.arg = *arg;
    }
    made.page_first = entry->FindBool("pageFirst").value_or(false);
    next.insert_or_assign(KeyOf(*code, ModifiersOf(*entry)), std::move(made));
  }
  entries_ = std::move(next);
  return static_cast<int>(entries_.size());
}

const KeyMap::Entry* KeyMap::Match(
    const input::NativeWebKeyboardEvent& event) const {
  auto found = entries_.find(KeyOf(CodeOf(event), event.GetModifiers()));
  return found == entries_.end() ? nullptr : &found->second;
}

bool KeyMap::BuiltIn(const input::NativeWebKeyboardEvent& event) const {
  const int modifiers = event.GetModifiers() & kModifierMask;
  return CodeOf(event) == "KeyQ" &&
         (modifiers == blink::WebInputEvent::kControlKey ||
          modifiers == (blink::WebInputEvent::kControlKey |
                        blink::WebInputEvent::kShiftKey));
}

void KeyMap::Dispatch(const Entry& entry, const std::string& window_id) {
  if (!ModuleRegistry::Exists()) {
    return;
  }
  base::DictValue payload;
  payload.Set("command", entry.command);
  if (entry.arg) {
    payload.Set("arg", *entry.arg);
  } else {
    payload.Set("arg", base::Value());
  }
  payload.Set("windowId", window_id);
  payload.Set("focusGeneration", base::Value());
  ModuleRegistry::Get().Emit(kModule, "onCommand",
                             base::Value(std::move(payload)));
}

content::KeyboardEventProcessingResult KeyMap::PreHandle(
    const std::string& window_id,
    content::WebContents* page,
    const input::NativeWebKeyboardEvent& event) {
  if (!KeyDown(event)) {
    return content::KeyboardEventProcessingResult::NOT_HANDLED;
  }
  if (const Entry* entry = Match(event)) {
    if (page && entry->page_first) {
      return content::KeyboardEventProcessingResult::NOT_HANDLED_IS_SHORTCUT;
    }
    Dispatch(*entry, window_id);
    return content::KeyboardEventProcessingResult::HANDLED;
  }
  if (BuiltIn(event)) {
    AppLifetime::Get().RequestQuit();
    return content::KeyboardEventProcessingResult::HANDLED;
  }
  return content::KeyboardEventProcessingResult::NOT_HANDLED;
}

bool KeyMap::Handle(const std::string& window_id,
                    content::WebContents* page,
                    const input::NativeWebKeyboardEvent& event) {
  if (!page || !KeyDown(event) || event.skip_if_unhandled) {
    return false;
  }
  const Entry* entry = Match(event);
  if (!entry || !entry->page_first) {
    return false;
  }
  Dispatch(*entry, window_id);
  return true;
}

}
