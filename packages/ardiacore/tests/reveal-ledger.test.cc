#include "../ios/ArdiaRevealLedger.h"

#include <cstdio>

using namespace ardia_reveal_ledger;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

constexpr unsigned kA = 0, kJ = 38, kLeftShift = 56, kRightShift = 60, kLeftCommand = 55, kRightCommand = 54;
constexpr unsigned kLeftOption = 58, kRightOption = 61, kLeftControl = 59, kRightControl = 62, kCapsLock = 57, kFunction = 63;

static void Keys() {
  {
    KeyLedger keys;
    CHECK(!keys.Swallows(kA, true, false, false, false));
    CHECK(!keys.Swallows(kA, true, true, false, false));
    CHECK(!keys.Swallows(kA, false, false, false, false));
    CHECK(keys.delivered.none() && keys.swallowed.none());
  }
  {
    KeyLedger keys;
    CHECK(keys.Swallows(kA, true, false, true, false));
    CHECK(keys.Swallows(kA, true, true, true, false));
    CHECK(keys.Swallows(kA, true, true, false, false));
    CHECK(keys.Swallows(kA, false, false, false, false));
    CHECK(!keys.Swallows(kA, true, false, false, false));
    CHECK(!keys.Swallows(kA, false, false, false, false));
  }
  {
    KeyLedger keys;
    CHECK(!keys.Swallows(kJ, true, false, false, false));
    CHECK(!keys.HeldOver(kJ));
    CHECK(!keys.Swallows(kJ, false, false, true, false));
    CHECK(keys.delivered.none());
  }
  {
    KeyLedger keys;
    CHECK(!keys.Swallows(kJ, true, false, false, false));
    CHECK(keys.Swallows(kJ, true, true, true, true));
    CHECK(keys.HeldOver(kJ));
    CHECK(keys.Swallows(kJ, true, true, false, false));
    CHECK(keys.Swallows(kJ, true, true, false, false));
    CHECK(keys.Swallows(kJ, false, false, false, false));
    CHECK(!keys.HeldOver(kJ) && keys.delivered.none() && keys.swallowed.none());
    CHECK(!keys.Swallows(kJ, true, false, false, false));
    CHECK(!keys.Swallows(kJ, true, true, false, false));
    CHECK(!keys.Swallows(kJ, false, false, false, false));
  }
  {
    KeyLedger keys;
    CHECK(!keys.Swallows(kJ, true, false, false, false));
    CHECK(keys.Swallows(kJ, true, true, true, true));
    CHECK(!keys.Swallows(kJ, false, false, true, true));
    CHECK(keys.delivered.none() && keys.swallowed.none());
  }
  {
    KeyLedger keys;
    CHECK(!keys.Swallows(kJ, true, false, false, false));
    CHECK(keys.Swallows(kJ, true, true, true, true));
    CHECK(!keys.Swallows(kJ, false, false, false, true));
  }
  {
    KeyLedger keys;
    CHECK(keys.Swallows(kJ, false, false, true, false));
    CHECK(keys.Swallows(kJ, true, true, true, false));
    CHECK(!keys.HeldOver(kJ));
    CHECK(keys.Swallows(kJ, false, false, false, true));
  }
  {
    KeyLedger keys;
    CHECK(keys.Swallows(kA, true, false, true, false));
    CHECK(!keys.Swallows(kA, true, false, false, false));
    CHECK(!keys.Swallows(kA, true, true, false, false));
    CHECK(!keys.Swallows(kA, false, false, false, false));
  }
  {
    KeyLedger keys;
    CHECK(keys.Swallows(kA, true, false, true, false));
    CHECK(!keys.Swallows(kJ, true, false, false, false));
    CHECK(keys.Swallows(kA, false, false, false, false));
    CHECK(!keys.Swallows(kJ, false, false, false, false));
  }
  {
    KeyLedger keys;
    CHECK(!keys.Swallows(300, true, false, false, false));
    CHECK(keys.delivered[300 & 0xFF]);
  }
}

static void Modifiers() {
  CHECK(ModifierIsDown(kLeftShift, kShiftFlag | kLeftShiftFlag));
  CHECK(!ModifierIsDown(kRightShift, kShiftFlag | kLeftShiftFlag));
  CHECK(ModifierIsDown(kRightShift, kShiftFlag | kLeftShiftFlag | kRightShiftFlag));
  CHECK(!ModifierIsDown(kLeftShift, kShiftFlag | kRightShiftFlag));
  CHECK(ModifierIsDown(kRightShift, kShiftFlag | kRightShiftFlag));
  CHECK(!ModifierIsDown(kRightShift, 0));
  CHECK(!ModifierIsDown(kLeftCommand, kCommandFlag | kRightCommandFlag));
  CHECK(ModifierIsDown(kRightCommand, kCommandFlag | kRightCommandFlag));
  CHECK(!ModifierIsDown(kLeftOption, kOptionFlag | kRightOptionFlag));
  CHECK(ModifierIsDown(kRightOption, kOptionFlag | kRightOptionFlag));
  CHECK(!ModifierIsDown(kLeftControl, kControlFlag | kRightControlFlag));
  CHECK(ModifierIsDown(kRightControl, kControlFlag | kRightControlFlag));
  CHECK(ModifierIsDown(kLeftControl, kControlFlag | kLeftControlFlag));
  CHECK(ModifierIsDown(kLeftShift, kShiftFlag));
  CHECK(ModifierIsDown(kRightShift, kShiftFlag));
  CHECK(!ModifierIsDown(kLeftShift, kCommandFlag | kLeftCommandFlag));
  CHECK(ModifierIsDown(kCapsLock, kCapsLockFlag) && !ModifierIsDown(kCapsLock, kShiftFlag));
  CHECK(ModifierIsDown(kFunction, kFunctionFlag) && !ModifierIsDown(kFunction, 0));
  CHECK(!ModifierIsDown(kA, kShiftFlag | kCommandFlag));

  KeyLedger keys;
  CHECK(!keys.Swallows(kLeftShift, ModifierIsDown(kLeftShift, kShiftFlag | kLeftShiftFlag), false, false, false));
  CHECK(!keys.Swallows(kRightShift, ModifierIsDown(kRightShift, kShiftFlag | kLeftShiftFlag | kRightShiftFlag), false, false, false));
  const bool leftStillDown = ModifierIsDown(kLeftShift, kShiftFlag | kRightShiftFlag);
  CHECK(!leftStillDown);
  CHECK(!keys.Swallows(kLeftShift, leftStillDown, false, true, false));
  CHECK(!keys.delivered[kLeftShift] && keys.delivered[kRightShift] && keys.swallowed.none());
}

static void SkippedByMonitors() {
  CHECK(SkipsEventMonitors(true, false, kEisuKeyCode, 0));
  CHECK(SkipsEventMonitors(true, false, kKanaKeyCode, kShiftFlag));
  CHECK(!SkipsEventMonitors(true, false, kA, kCommandFlag));
  CHECK(SkipsEventMonitors(false, true, kA, kCommandFlag));
  CHECK(SkipsEventMonitors(false, true, kA, kCommandFlag | kShiftFlag));
  CHECK(!SkipsEventMonitors(false, true, kA, kShiftFlag));
  CHECK(!SkipsEventMonitors(false, true, kEisuKeyCode, 0));
  CHECK(!SkipsEventMonitors(false, false, kEisuKeyCode, kCommandFlag));

  KeyLedger keys;
  CHECK(keys.Swallows(15, true, false, true, false));
  CHECK(keys.Swallows(15, false, false, true, false));
  CHECK(keys.swallowed.none() && keys.delivered.none());
  CHECK(!keys.Swallows(15, true, false, false, false));
  CHECK(!keys.Swallows(15, false, false, false, false));
  CHECK(keys.delivered.none());
}

static void Presses() {
  {
    PressLedger presses;
    CHECK(presses.Idle());
    CHECK(!presses.Swallows(0, Press::kDown, 7, false));
    CHECK(!presses.Swallows(0, Press::kDrag, 7, false));
    CHECK(!presses.Swallows(0, Press::kUp, 7, false));
    CHECK(presses.Idle());
  }
  {
    PressLedger presses;
    CHECK(presses.Swallows(0, Press::kDown, 7, true));
    CHECK(!presses.Idle());
    CHECK(presses.Swallows(0, Press::kDrag, 7, false));
    CHECK(presses.Swallows(0, Press::kDrag, 7, false));
    CHECK(presses.Swallows(0, Press::kUp, 7, false));
    CHECK(presses.Idle());
    CHECK(!presses.Swallows(0, Press::kUp, 7, false));
  }
  {
    PressLedger presses;
    CHECK(presses.Swallows(0, Press::kDown, 7, true));
    CHECK(!presses.Swallows(0, Press::kDown, 7, false));
    CHECK(presses.Idle());
    CHECK(!presses.Swallows(0, Press::kDrag, 7, false));
    CHECK(!presses.Swallows(0, Press::kUp, 7, false));
  }
  {
    PressLedger presses;
    CHECK(presses.Swallows(0, Press::kDown, 7, true));
    CHECK(!presses.Swallows(0, Press::kUp, 8, false));
    CHECK(!presses.Swallows(0, Press::kDrag, 8, false));
    CHECK(!presses.Swallows(0, Press::kDown, 8, false));
    CHECK(!presses.Swallows(0, Press::kUp, 8, false));
    CHECK(!presses.Swallows(0, Press::kUp, 7, false));
    CHECK(presses.Idle());
  }
  {
    PressLedger presses;
    CHECK(presses.Swallows(0, Press::kDown, 7, true));
    CHECK(!presses.Swallows(1, Press::kDown, 7, false));
    CHECK(!presses.Swallows(1, Press::kUp, 7, false));
    CHECK(presses.Swallows(1, Press::kDown, 7, true));
    CHECK(presses.Swallows(0, Press::kUp, 7, false));
    CHECK(!presses.Idle());
    CHECK(presses.Swallows(1, Press::kUp, 7, false));
    CHECK(presses.Idle());
  }
  {
    PressLedger presses;
    CHECK(presses.Swallows(40, Press::kDown, 7, true));
    CHECK(presses.Swallows(40, Press::kUp, 7, false));
    CHECK(presses.Idle());
  }
}

int main() {
  Keys();
  Modifiers();
  SkippedByMonitors();
  Presses();
  if (failures) return 1;
  std::printf("reveal-ledger ok\n");
  return 0;
}
