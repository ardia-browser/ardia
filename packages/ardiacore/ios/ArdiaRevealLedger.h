#pragma once

#include <bitset>
#include <cstddef>
#include <cstdint>

namespace ardia_reveal_ledger {

constexpr uint64_t kCapsLockFlag = 1 << 16;
constexpr uint64_t kShiftFlag = 1 << 17;
constexpr uint64_t kControlFlag = 1 << 18;
constexpr uint64_t kOptionFlag = 1 << 19;
constexpr uint64_t kCommandFlag = 1 << 20;
constexpr uint64_t kFunctionFlag = 1 << 23;
constexpr uint64_t kLeftControlFlag = 0x1;
constexpr uint64_t kLeftShiftFlag = 0x2;
constexpr uint64_t kRightShiftFlag = 0x4;
constexpr uint64_t kLeftCommandFlag = 0x8;
constexpr uint64_t kRightCommandFlag = 0x10;
constexpr uint64_t kLeftOptionFlag = 0x20;
constexpr uint64_t kRightOptionFlag = 0x40;
constexpr uint64_t kRightControlFlag = 0x2000;
constexpr unsigned kEisuKeyCode = 102;
constexpr unsigned kKanaKeyCode = 104;

struct ModifierKey {
  uint64_t own = 0;
  uint64_t paired = 0;
  uint64_t either = 0;
};

constexpr ModifierKey ModifierKeyOf(unsigned keyCode) {
  switch (keyCode) {
    case 55: return {kLeftCommandFlag, kRightCommandFlag, kCommandFlag};
    case 54: return {kRightCommandFlag, kLeftCommandFlag, kCommandFlag};
    case 56: return {kLeftShiftFlag, kRightShiftFlag, kShiftFlag};
    case 60: return {kRightShiftFlag, kLeftShiftFlag, kShiftFlag};
    case 58: return {kLeftOptionFlag, kRightOptionFlag, kOptionFlag};
    case 61: return {kRightOptionFlag, kLeftOptionFlag, kOptionFlag};
    case 59: return {kLeftControlFlag, kRightControlFlag, kControlFlag};
    case 62: return {kRightControlFlag, kLeftControlFlag, kControlFlag};
    case 57: return {0, 0, kCapsLockFlag};
    case 63: return {0, 0, kFunctionFlag};
    default: return {};
  }
}

constexpr bool ModifierIsDown(unsigned keyCode, uint64_t flags) {
  const ModifierKey key = ModifierKeyOf(keyCode);
  const bool either = (flags & key.either) != 0;
  const bool own = (flags & key.own) != 0;
  const bool paired = (flags & key.paired) != 0;
  return either == (own || paired) ? own : either;
}

constexpr bool SkipsEventMonitors(bool keyDown, bool keyUp, unsigned keyCode, uint64_t flags) {
  if (keyUp) return (flags & kCommandFlag) != 0;
  return keyDown && (keyCode == kEisuKeyCode || keyCode == kKanaKeyCode);
}

struct KeyLedger {
  std::bitset<256> delivered;
  std::bitset<256> swallowed;

  bool HeldOver(unsigned keyCode) const { return delivered[keyCode & 0xFF] && swallowed[keyCode & 0xFF]; }

  bool Swallows(unsigned keyCode, bool down, bool repeat, bool ahead, bool holderHasKeyboard) {
    const size_t key = keyCode & 0xFF;
    const bool wentDown = delivered[key];
    const bool held = swallowed[key];
    if (!down) {
      delivered[key] = false;
      swallowed[key] = false;
      return wentDown ? held && !holderHasKeyboard : held || ahead;
    }
    if (repeat) {
      swallowed[key] = held || ahead;
      delivered[key] = wentDown || !swallowed[key];
      return swallowed[key];
    }
    swallowed[key] = ahead;
    delivered[key] = !ahead;
    return ahead;
  }
};

enum class Press { kDown, kDrag, kUp };

struct PressLedger {
  uint32_t held = 0;
  long window[32] = {};

  bool Idle() const { return held == 0; }

  bool Swallows(unsigned button, Press press, long inWindow, bool overCoveredPage) {
    const unsigned slot = button & 31;
    const uint32_t bit = 1u << slot;
    if (press == Press::kDown) {
      held &= ~bit;
      if (!overCoveredPage) return false;
      held |= bit;
      window[slot] = inWindow;
      return true;
    }
    if (!(held & bit) || window[slot] != inWindow) return false;
    if (press == Press::kUp) held &= ~bit;
    return true;
  }
};

}
