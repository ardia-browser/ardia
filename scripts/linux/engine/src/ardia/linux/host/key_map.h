// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_HOST_KEY_MAP_H_
#define ARDIA_LINUX_HOST_KEY_MAP_H_

#include <map>
#include <optional>
#include <string>

#include "base/no_destructor.h"
#include "base/values.h"
#include "content/public/browser/keyboard_event_processing_result.h"

namespace content {
class WebContents;
}

namespace input {
struct NativeWebKeyboardEvent;
}

namespace ardia_linux {

class ModuleRegistry;

class KeyMap {
 public:
  struct Entry {
    std::string command;
    std::optional<std::string> arg;
    bool page_first = false;
  };

  KeyMap(const KeyMap&) = delete;
  KeyMap& operator=(const KeyMap&) = delete;

  static KeyMap& Get();

  void Register(ModuleRegistry& registry);
  int Set(const base::ListValue& entries);

  content::KeyboardEventProcessingResult PreHandle(
      const std::string& window_id,
      content::WebContents* page,
      const input::NativeWebKeyboardEvent& event);
  bool Handle(const std::string& window_id,
              content::WebContents* page,
              const input::NativeWebKeyboardEvent& event);

 private:
  friend class base::NoDestructor<KeyMap>;

  KeyMap();
  ~KeyMap();

  static std::string KeyOf(const std::string& code, int modifiers);
  const Entry* Match(const input::NativeWebKeyboardEvent& event) const;
  bool BuiltIn(const input::NativeWebKeyboardEvent& event) const;
  void Dispatch(const Entry& entry, const std::string& window_id);

  std::map<std::string, Entry> entries_;
};

}

#endif
