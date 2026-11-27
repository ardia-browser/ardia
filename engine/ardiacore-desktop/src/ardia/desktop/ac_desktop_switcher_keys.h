#ifndef ARDIA_DESKTOP_AC_DESKTOP_SWITCHER_KEYS_H_
#define ARDIA_DESKTOP_AC_DESKTOP_SWITCHER_KEYS_H_

namespace ardia::desktop_switcher {

inline constexpr int kEscapeKeyCode = 0x1B;
inline constexpr int kLeftKeyCode = 0x25;
inline constexpr int kRightKeyCode = 0x27;
inline constexpr int kWKeyCode = 0x57;
inline constexpr int kSKeyCode = 0x53;

struct SwitcherKeyPress {
  int key_code = 0;
  bool control = false;
  bool alt = false;
  bool command = false;
  bool repeat = false;
};

constexpr const char* SwitcherKey(const SwitcherKeyPress& press) {
  if (press.key_code == kEscapeKeyCode) return "escape";
  if (press.key_code == kRightKeyCode) return "next";
  if (press.key_code == kLeftKeyCode) return "previous";
  if (press.key_code == kWKeyCode && !press.repeat && (press.control || press.command) && !press.alt) return "close";
  if (press.key_code == kSKeyCode && !press.repeat && (press.control || press.command) && !press.alt) return "sleep";
  return nullptr;
}

}

#endif
