// Copyright 2026 Ardia. Apache-2.0.

#include <cstdio>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "chrome/browser/ardia/ac_cli_plugin_clipboard_keys.h"
#include "chrome/browser/ardia/ac_cli_plugin_input.h"

#include "ardia/core/ac_pointer_outcome.h"

namespace {

int failures = 0;

void Expect(bool ok, const std::string& name, const std::string& detail) {
  if (!ok) {
    ++failures;
    std::printf("FAIL  %s  (%s)\n", name.c_str(), detail.c_str());
  }
}

ardia::PluginKeyEvent Key(std::optional<std::string> key,
                          std::optional<int> code,
                          int modifiers,
                          std::optional<std::string> dom_code = std::nullopt) {
  ardia::PluginKeyEvent event;
  event.type = "rawKeyDown";
  event.key = std::move(key);
  event.windows_key_code = code;
  event.modifiers = modifiers;
  event.code = std::move(dom_code);
  return event;
}

void Allowed(const ardia::PluginKeyEvent& event, const std::string& name) {
  const std::string refusal = ardia::PluginKeyRefusal(event);
  Expect(refusal.empty(), "allowed: " + name, refusal);
}

void Refused(const ardia::PluginKeyEvent& event, const std::string& name) {
  Expect(!ardia::PluginKeyRefusal(event).empty(), "refused: " + name,
         "no refusal");
}

const char* KeyForCode(int code) {
  switch (code) {
    case 45:
      return "Insert";
    case 46:
      return "Delete";
    case 67:
      return "c";
    case 86:
      return "v";
    case 88:
      return "x";
  }
  return "?";
}

}

int main() {
  using ardia::kCdpAlt;
  using ardia::kCdpCtrl;
  using ardia::kCdpMeta;
  using ardia::kCdpShift;

  Refused(Key("Insert", (2 << 16) | 45, 0), "a key code above 0xFFFF that forges Ctrl");
  Refused(Key("a", 256, 0), "a key code of 256");
  Refused(Key("a", -1, 0), "a negative key code");
  Refused(Key("a", 86, 0), "key a with the key code of v");
  Refused(Key("a", 65, 0, "KeyV"), "key a with the code KeyV");
  Refused(Key("ArrowLeft", 45, kCdpCtrl), "ArrowLeft with the key code of Insert");
  Refused(Key(";", 45, kCdpShift), "punctuation with the key code of Insert");
  Refused(Key(std::nullopt, 45, kCdpShift), "a key code with no key");
  ardia::PluginKeyEvent keyless_paste = Key(std::nullopt, 0, 0);
  keyless_paste.commands = {"paste"};
  Refused(keyless_paste, "no key, code 0, with commands paste");
  ardia::PluginKeyEvent keyless_copy = Key(std::nullopt, 0, 0);
  keyless_copy.commands = {"copy"};
  Refused(keyless_copy, "no key, code 0, with commands copy");
  ardia::PluginKeyEvent keyless_select = Key(std::nullopt, 0, 0);
  keyless_select.commands = {"selectAll"};
  Allowed(keyless_select, "no key with an allowed command");
  ardia::PluginKeyEvent key_up_command = Key("a", 65, kCdpMeta, "KeyA");
  key_up_command.type = "keyUp";
  key_up_command.commands = {"selectAll"};
  Refused(key_up_command, "commands on a keyUp");
  ardia::PluginKeyEvent char_command = Key("a", 0, 0);
  char_command.type = "char";
  char_command.commands = {"selectAll"};
  Refused(char_command, "commands on a char event");
  Allowed(Key("!", 49, kCdpShift, "Digit1"), "a shifted digit with its ordinary key code");
  Allowed(Key("\"", 222, kCdpShift, "Quote"), "a shifted quote");
  Refused(Key("a", 49, 0, "Digit1"), "key a with the code Digit1");
  Refused(Key("Shift", 17, kCdpShift, "ShiftLeft"), "Shift with Control's key code");
  Refused(Key("Shift", 16, kCdpShift, "KeyA"), "Shift with the code KeyA");
  Allowed(Key("Shift", 16, kCdpShift, "ShiftRight"), "Shift on the right with the generic key code");
  Allowed(Key("Meta", 93, kCdpMeta, "MetaRight"), "Meta on the right");
  Allowed(Key("\xc3\xa9", 0, 0), "a character the US layout doesn't have, with no key code");
  Refused(Key("\xc3\xa9", 69, 0), "a character the US layout doesn't have, with a key code");

  const int navigation_modifiers[] = {kCdpAlt, kCdpCtrl, kCdpMeta};
  const struct {
    const char* key;
    int code;
    const char* dom_code;
  } navigation[] = {
      {"ArrowLeft", 37, "ArrowLeft"}, {"ArrowUp", 38, "ArrowUp"},
      {"ArrowRight", 39, "ArrowRight"}, {"ArrowDown", 40, "ArrowDown"},
      {"Home", 36, "Home"}, {"End", 35, "End"},
      {"PageUp", 33, "PageUp"}, {"PageDown", 34, "PageDown"},
  };
  for (const auto& nav : navigation) {
    for (int modifier : navigation_modifiers) {
      for (int shift : {0, kCdpShift}) {
        Allowed(Key(nav.key, nav.code, modifier | shift, nav.dom_code),
                std::string(nav.key) + " with modifiers " +
                    std::to_string(modifier | shift));
      }
    }
  }
  Allowed(Key("a", 65, kCdpCtrl, "KeyA"), "Ctrl+A");
  Allowed(Key("a", 65, kCdpMeta, "KeyA"), "Meta+A");
  for (int modifier : {kCdpCtrl, kCdpMeta}) {
    Allowed(Key("Backspace", 8, modifier, "Backspace"),
            "Backspace with modifier " + std::to_string(modifier));
  }
  for (int modifier : navigation_modifiers) {
    Allowed(Key("Delete", 46, modifier, "Delete"),
            "Delete with modifier " + std::to_string(modifier));
  }
#if !defined(_WIN32)
  Allowed(Key("Backspace", 8, kCdpAlt, "Backspace"), "macOS word deletion with Alt+Backspace");
#else
  Refused(Key("Backspace", 8, kCdpAlt, "Backspace"), "Alt+Backspace, which undoes on Windows");
#endif
  Allowed(Key("Enter", 13, kCdpShift, "Enter"), "Shift+Enter");
  Allowed(Key("Tab", 9, kCdpShift, "Tab"), "Shift+Tab");
  Allowed(Key("h", 72, 0, "KeyH"), "plain typing");
  Allowed(Key("H", 72, kCdpShift, "KeyH"), "Shift+letter");
  Allowed(Key("7", 55, 0, "Digit7"), "a digit");
  Allowed(Key("Control", 17, kCdpCtrl, "ControlLeft"), "pressing Control");
  Allowed(Key("Shift", 16, kCdpShift, "ShiftLeft"), "pressing Shift");
  ardia::PluginKeyEvent select_all = Key("a", 65, kCdpMeta, "KeyA");
  select_all.commands = {"selectAll"};
  Allowed(select_all, "Meta+A with selectAll");

  Refused(Key("a", 65, kCdpAlt, "KeyA"), "Alt+A");
  Refused(Key("c", 67, kCdpMeta, "KeyC"), "Meta+C");
  Refused(Key("v", 86, kCdpMeta, "KeyV"), "Meta+V");
  Refused(Key("Insert", 45, kCdpCtrl, "Insert"), "Ctrl+Insert");
  Refused(Key("Insert", 45, kCdpShift, "Insert"), "Shift+Insert");
  Refused(Key("Delete", 46, kCdpShift, "Delete"), "Shift+Delete");
  Refused(Key("Delete", 46, kCdpCtrl | kCdpShift, "Delete"), "Ctrl+Shift+Delete");
  Refused(Key("Copy", 0, 0), "the Copy key");
  Refused(Key("Cut", 0, 0), "the Cut key");
  Refused(Key("Paste", 0, 0), "the Paste key");
  Refused(Key("a", 65, 16, "KeyA"), "an unknown modifier bit");
  ardia::PluginKeyEvent native = Key("a", 65, 0, "KeyA");
  native.has_native_key_code = true;
  Refused(native, "a native key code");
  ardia::PluginKeyEvent system = Key("a", 65, 0, "KeyA");
  system.has_system_key = true;
  Refused(system, "a system key");
  ardia::PluginKeyEvent paste = Key("v", 86, 0, "KeyV");
  paste.commands = {"paste"};
  Refused(paste, "the paste command");

  for (const ardia::PluginClipboardKey& entry : ardia::kPluginClipboardKeys) {
    const std::string key =
        entry.dom_key[0] ? entry.dom_key : KeyForCode(entry.windows_key_code);
    Refused(Key(key, entry.dom_key[0] ? 0 : entry.windows_key_code,
                entry.modifiers),
            "clipboard table entry " + key + " with modifiers " +
                std::to_string(entry.modifiers));
  }

  using Kind = ardia::PluginParam::Kind;
  const auto integer = [](long long value) {
    ardia::PluginParam param;
    param.kind = Kind::kInt;
    param.int_value = value;
    return param;
  };
  const auto real = [](double value) {
    ardia::PluginParam param;
    param.kind = Kind::kDouble;
    param.double_value = value;
    return param;
  };
  const auto text = [](std::string value) {
    ardia::PluginParam param;
    param.kind = Kind::kString;
    param.string_value = std::move(value);
    return param;
  };
  const auto mouse = [&](ardia::PluginParams params) {
    ardia::PluginMouseParams out;
    return ardia::PluginMouseRefusal(params, &out);
  };
  const auto click = [&](ardia::PluginParams params) {
    ardia::PluginClickParams out;
    return ardia::PluginClickRefusal(params, &out);
  };
  const ardia::PluginParams move = {{"type", text("mouseMoved")},
                                    {"x", integer(10)},
                                    {"y", real(20.5)}};
  Expect(mouse(move).empty(), "allowed: a move with no button", mouse(move));
  auto with = [](ardia::PluginParams params, const std::string& name,
                 ardia::PluginParam value) {
    params[name] = value;
    return params;
  };
  Expect(mouse(with(with(move, "button", text("none")), "buttons", integer(0)))
             .empty(),
         "allowed: a move with button none and buttons 0", "");
  Expect(mouse(with(with(move, "type", text("mouseWheel")), "deltaX",
                    integer(0)))
             .size() > 0,
         "refused: a wheel event without deltaY", "");
  Expect(mouse(with(with(with(move, "type", text("mouseWheel")), "deltaX",
                         integer(0)),
                    "deltaY", real(40)))
             .empty(),
         "allowed: a wheel event", "");
  Expect(!mouse(with(move, "type", text("mousePressed"))).empty(),
         "refused: mousePressed", "");
  Expect(!mouse(with(move, "type", text("mouseReleased"))).empty(),
         "refused: mouseReleased", "");
  Expect(!mouse(with(move, "buttons", integer(1))).empty(),
         "refused: a move with the left button held", "");
  Expect(!mouse(with(move, "buttons", real(0.0))).empty(),
         "refused: buttons as the double 0.0", "");
  Expect(!mouse(with(move, "buttons", real(-0.0))).empty(),
         "refused: buttons as negative zero", "");
  Expect(!mouse(with(move, "buttons", real(1e20))).empty(),
         "refused: buttons as a huge number", "");
  Expect(!mouse(with(move, "buttons", text("0"))).empty(),
         "refused: buttons as a string", "");
  Expect(!mouse(with(move, "button", text("left"))).empty(),
         "refused: a move naming a button", "");
  Expect(!mouse(with(move, "button", integer(0))).empty(),
         "refused: button as a number", "");
  Expect(!mouse(with(move, "modifiers", real(1.0))).empty(),
         "refused: modifiers as a double", "");
  Expect(!mouse(with(move, "x", text("10"))).empty(),
         "refused: x as a string", "");
  Expect(!mouse(with(move, "x", real(-1))).empty(), "refused: a negative x",
         "");
  Expect(!mouse(with(move, "clickCount", integer(1))).empty(),
         "refused: an unexpected field", "");
  Expect(!mouse(with(move, "deltaX", integer(5))).empty(),
         "refused: deltas on a move", "");

  const ardia::PluginParams plain = {{"x", integer(30)}, {"y", integer(40)}};
  Expect(click(plain).empty(), "allowed: a plain click", click(plain));
  Expect(click(with(with(with(plain, "button", text("right")), "clickCount",
                         integer(2)),
                    "modifiers", integer(8)))
             .empty(),
         "allowed: a right double click with Shift", "");
  Expect(!click(with(plain, "button", text("middle"))).empty(),
         "refused: a middle click", "");
  Expect(!click(with(plain, "clickCount", integer(4))).empty(),
         "refused: four clicks", "");
  Expect(!click(with(plain, "clickCount", integer(0))).empty(),
         "refused: zero clicks", "");
  Expect(!click(with(plain, "clickCount", real(2.0))).empty(),
         "refused: clickCount as a double", "");
  Expect(!click(with(plain, "clickCount", text("2"))).empty(),
         "refused: clickCount as a string", "");
  Expect(!click(with(plain, "modifiers", integer(16))).empty(),
         "refused: unknown modifier bits", "");
  Expect(!click(with(plain, "modifiers", real(-0.0))).empty(),
         "refused: modifiers as negative zero", "");
  Expect(!click(with(plain, "button", integer(1))).empty(),
         "refused: button as a number", "");
  Expect(!click({{"x", integer(30)}}).empty(), "refused: no y", "");
  Expect(!click(with(plain, "y", real(1e400))).empty(),
         "refused: an infinite y", "");
  Expect(!click(with(plain, "force", integer(1))).empty(),
         "refused: an unknown field", "");
  {
    ardia::PluginClickParams out;
    ardia::PluginClickRefusal(with(plain, "clickCount", integer(3)), &out);
    Expect(out.click_count == 3 && out.button == "left" && out.x == 30,
           "parsed: the validated click", "");
  }

  const ardia::PluginParams wheel = {{"type", text("mouseWheel")},
                                     {"x", integer(5)},
                                     {"y", integer(5)},
                                     {"deltaX", integer(0)},
                                     {"deltaY", real(-120.5)}};
  Expect(mouse(wheel).empty(), "allowed: a wheel with finite deltas",
         mouse(wheel));
  Expect(!mouse(with(wheel, "deltaY", text("10"))).empty(),
         "refused: a wheel delta as a string", "");
  Expect(!mouse(with(wheel, "deltaY", real(1e400))).empty(),
         "refused: an infinite wheel delta", "");
  Expect(!mouse(with(wheel, "y", real(-0.5))).empty(),
         "refused: a wheel at a negative y", "");
  Expect(!mouse(with(wheel, "buttons", integer(1))).empty(),
         "refused: a wheel with a button held", "");
  Expect(!mouse(with(move, "x", real(1e400))).empty(),
         "refused: a move at an infinite x", "");
  Expect(!mouse(with(move, "y", integer(-3))).empty(),
         "refused: a move at a negative y", "");
  {
    ardia::PluginMouseParams out;
    ardia::PluginMouseRefusal(wheel, &out);
    Expect(out.type == "mouseWheel" && out.delta_y && *out.delta_y == -120.5,
           "parsed: the validated wheel", "");
  }

  {
    ardia::PageEpoch epoch;
    const uint64_t admitted = epoch.value();
    Expect(epoch.Unchanged(admitted), "epoch: unchanged right after admission",
           "");
    epoch.Committed();
    Expect(!epoch.Unchanged(admitted),
           "epoch: any committed navigation changes it", "");
    Expect(!epoch.Unchanged(0), "epoch: 0 (no page) never matches", "");
  }
  using R = ardia::PointerEventResult;
  using O = ardia::PointerOutcome;
  const auto press = [](R result) { return ardia::PointerEvent{true, result}; };
  const auto release = [](R result) {
    return ardia::PointerEvent{false, result};
  };
  const auto outcome = [](std::vector<ardia::PointerEvent> events, bool epoch,
                          bool widget) {
    return ardia::PointerOutcomeOf(events, epoch, widget);
  };
  Expect(outcome({press(R::kAcked), release(R::kAcked)}, true, true) ==
             O::kDone,
         "outcome: every event acknowledged by the renderer is done", "");
  Expect(outcome({press(R::kAcked), release(R::kPending)}, true, true) ==
             O::kPending,
         "outcome: waits while the release is pending", "");
  Expect(outcome({press(R::kNotSent), release(R::kNotSent)}, true, true) ==
             O::kNotDelivered,
         "outcome: no press sent is not delivered", "");
  Expect(outcome({press(R::kNotSent), release(R::kAcked)}, true, true) ==
             O::kNotDelivered,
         "outcome: a release alone without a sent press is not delivered", "");
  Expect(outcome({press(R::kSentUnknown), release(R::kAcked)}, true, true) ==
             O::kUnknown,
         "outcome: a timed-out press is sent, outcome unknown", "");
  Expect(outcome({press(R::kAcked), release(R::kSentUnknown)}, true, true) ==
             O::kUnknown,
         "outcome: a timed-out release is unknown", "");
  Expect(outcome({press(R::kAcked), release(R::kNotSent)}, true, true) ==
             O::kUnknown,
         "outcome: an unsent release after a sent press is unknown", "");
  Expect(outcome({press(R::kNotSent), release(R::kNotSent), press(R::kAcked),
                  release(R::kNotSent)},
                 true, true) == O::kUnknown,
         "outcome: a later press of a double click that was sent is unknown",
         "");
  Expect(outcome({press(R::kAcked), release(R::kAcked)}, false, true) ==
             O::kUnknown,
         "outcome: an epoch change by the last ack is unknown", "");
  Expect(outcome({press(R::kAcked), release(R::kAcked)}, true, false) ==
             O::kUnknown,
         "outcome: a torn-down widget is unknown", "");
  Expect(outcome({release(R::kAcked)}, true, true) == O::kDone,
         "outcome: a move or wheel acknowledged is done", "");
  Expect(outcome({release(R::kNotSent)}, true, true) == O::kNotDelivered,
         "outcome: a move that wasn't sent is not delivered", "");
  Expect(outcome({}, true, true) == O::kNotDelivered,
         "outcome: no events is not delivered", "");
  Expect(ardia::NeedsRecoveryRelease(
             {press(R::kAcked), release(R::kSentUnknown)}, O::kUnknown),
         "recovery: a sent press with an unknown outcome needs a release", "");
  Expect(!ardia::NeedsRecoveryRelease(
             {press(R::kAcked), release(R::kAcked)}, O::kDone),
         "recovery: none after success", "");
  Expect(!ardia::NeedsRecoveryRelease({release(R::kSentUnknown)}, O::kUnknown),
         "recovery: none for a move", "");
  Expect(ardia::RefusesHiddenTarget(true, true),
         "hidden: a wheel to a hidden widget is refused", "");
  Expect(!ardia::RefusesHiddenTarget(true, false),
         "hidden: a wheel to a visible widget goes", "");
  Expect(!ardia::RefusesHiddenTarget(false, true),
         "hidden: clicks and moves to a hidden widget go", "");
  Expect(ardia::PersonBusy(false, true, 0),
         "busy: person input this instant defers a wheel", "");
  Expect(ardia::PersonBusy(false, true, 499999),
         "busy: person input 499.999 ms ago defers a wheel", "");
  Expect(!ardia::PersonBusy(false, true, 500000),
         "busy: person input 500 ms ago lets a wheel through", "");
  Expect(!ardia::PersonBusy(true, true, 0),
         "busy: a hidden widget never answers busy", "");
  Expect(!ardia::PersonBusy(false, false, 0),
         "busy: a widget with no person input never answers busy", "");
  Expect(!ardia::PersonBusy(false, true, -1000),
         "busy: a person input stamped after now is stale", "");

  const auto wheel_event = [](R result) { return ardia::PointerEvent{false, result}; };
  Expect(ardia::PointerOutcomeOf({wheel_event(R::kAcked), wheel_event(R::kAcked)}, true,
                                 true) == O::kDone,
         "wheel: the renderer acked the wheel and the phase-end is done", "");
  Expect(ardia::PointerOutcomeOf({wheel_event(R::kAcked), wheel_event(R::kPending)}, true,
                                 true) == O::kPending,
         "wheel: the phase-end still pending keeps it pending", "");
  Expect(ardia::PointerOutcomeOf({wheel_event(R::kSentUnknown), wheel_event(R::kAcked)},
                                 true, true) == O::kUnknown,
         "wheel: a browser ack or timeout for the wheel is unknown", "");
  Expect(ardia::PointerOutcomeOf({wheel_event(R::kNotSent), wheel_event(R::kNotSent)}, true,
                                 true) == O::kNotDelivered,
         "wheel: nothing forwarded is not delivered", "");
  Expect(ardia::PointerOutcomeOf({wheel_event(R::kAcked), wheel_event(R::kAcked)}, false,
                                 true) == O::kUnknown,
         "wheel: complete acks after an epoch change are unknown", "");
  ardia::OutstandingSlots<std::pair<std::string, const void*>> slots;
  const int tab_a = 0;
  const int tab_b = 0;
  Expect(slots.Take({"plugin-a", &tab_a}), "slots: the first wheel takes the slot", "");
  Expect(!slots.Take({"plugin-a", &tab_a}),
         "slots: a second wheel while one is pending is busy", "");
  Expect(slots.Take({"plugin-a", &tab_b}),
         "slots: another tab has its own slot", "");
  Expect(slots.Take({"plugin-b", &tab_a}),
         "slots: another credential has its own slot", "");
  slots.Release({"plugin-a", &tab_a});
  Expect(slots.Take({"plugin-a", &tab_a}),
         "slots: once released, the next wheel takes it again", "");

  {
    ardia::WheelSlotState slot;
    Expect(slot.Forward(), "wheel slot: a waiting wheel forwards", "");
    Expect(!slot.Expire(),
           "wheel slot: a deadline after forwarding doesn't free the slot", "");
    Expect(!slot.freed() && slot.forwarded(),
           "wheel slot: after that deadline the slot is still held", "");
    Expect(!slot.Acked(false),
           "wheel slot: the wheel's ack alone doesn't free it", "");
    Expect(slot.Acked(true) && slot.freed(),
           "wheel slot: the phase-end's ack frees it", "");
  }
  {
    ardia::WheelSlotState slot;
    Expect(slot.Expire() && slot.freed(),
           "wheel slot: a deadline before forwarding frees the slot", "");
    Expect(!slot.Forward(),
           "wheel slot: a late visual-state callback forwards nothing", "");
    Expect(!slot.Acked(false) && !slot.Acked(true) && !slot.Gone(),
           "wheel slot: nothing frees it twice", "");
  }
  {
    ardia::WheelSlotState waiting;
    Expect(waiting.Gone() && waiting.freed(),
           "wheel slot: widget destruction frees a waiting slot", "");
    Expect(!waiting.Forward(), "wheel slot: and nothing forwards after it", "");
    ardia::WheelSlotState forwarded;
    forwarded.Forward();
    forwarded.Acked(false);
    Expect(forwarded.Gone() && forwarded.freed(),
           "wheel slot: widget destruction frees a forwarded slot", "");
  }
  {
    ardia::WheelSlotState slot;
    Expect(slot.Abandon() && slot.freed(),
           "wheel slot: an answer before forwarding (refusal, detach) frees it", "");
    ardia::WheelSlotState sent;
    sent.Forward();
    Expect(!sent.Abandon() && !sent.freed(),
           "wheel slot: an answer after forwarding keeps it until the ack", "");
  }

  std::printf("%s\n", failures ? "FAILED" : "OK");
  return failures ? 1 : 0;
}
