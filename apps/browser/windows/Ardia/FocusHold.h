#pragma once

#include <algorithm>
#include <cstdlib>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "LaunchConfig.h"
#include "LaunchLog.h"
#include "Paths.h"
#include "WindowManager.h"

namespace Ardia::Menus {

struct FocusHold {
  static constexpr size_t kCapacity = 64;
  static constexpr ULONGLONG kReadyMs = 3000;
  static constexpr ULONGLONG kDeliveryMs = 1000;
  static constexpr ULONGLONG kAfterFirstMs = 50;
  static constexpr UINT_PTR kTimer = 2099;
  static constexpr UINT kTickMs = 15;
  static constexpr UINT kSentinel = WM_APP + 0x99;

  enum class Taken { Pass, Held };

  struct Counts {
    unsigned holds = 0;
    unsigned replayed = 0;
    std::map<std::string, unsigned> drops;
  };

  bool active = false;
  int generation = 0;
  int lastGeneration = 0;
  HWND window = nullptr;
  std::string command;
  ULONGLONG startedAt = 0;
  int claimedTag = 0;
  int askedTag = 0;
  int focusedTag = 0;
  bool ready = false;
  bool sentinelOut = false;
  bool announced = false;
  std::function<void(int, int)> announce;
  std::vector<wchar_t> held;
  unsigned replayed = 0;
  ULONGLONG postedAt = 0;
  ULONGLONG nextAt = 0;
  std::set<UINT> heldKeys;
  std::set<UINT> droppedKeys;
  HWND messages = nullptr;
  HHOOK mouseHook = nullptr;
  HWINEVENTHOOK foregroundHook = nullptr;
  std::mutex countsLock;
  Counts counts;

  static FocusHold &Shared() noexcept {
    static FocusHold *shared = new FocusHold();
    return *shared;
  }

  static HWND OwnerRoot(HWND hwnd) noexcept {
    return hwnd ? GetAncestor(hwnd, GA_ROOTOWNER) : nullptr;
  }

  static bool ClassIs(HWND hwnd, std::wstring_view name) noexcept {
    wchar_t buffer[64] = {};
    int length = hwnd ? GetClassNameW(hwnd, buffer, 64) : 0;
    return length > 0 && std::wstring_view(buffer, static_cast<size_t>(length)) == name;
  }

  static LRESULT CALLBACK MessageProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) noexcept {
    FocusHold &hold = Shared();
    if (message == WM_TIMER && wParam == kTimer) {
      hold.Tick();
      return 0;
    }
    if (message == kSentinel) {
      hold.Delivered(static_cast<int>(wParam));
      return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
  }

  static LRESULT CALLBACK MouseProc(int code, WPARAM wParam, LPARAM lParam) noexcept {
    FocusHold &hold = Shared();
    if (code == HC_ACTION && hold.active) {
      switch (wParam) {
        case WM_LBUTTONDOWN:
        case WM_RBUTTONDOWN:
        case WM_MBUTTONDOWN:
        case WM_XBUTTONDOWN:
        case WM_NCLBUTTONDOWN:
        case WM_NCRBUTTONDOWN:
        case WM_NCMBUTTONDOWN:
        case WM_NCXBUTTONDOWN:
          hold.Drop("mouse", L"a mouse button");
          break;
        default:
          break;
      }
    }
    return CallNextHookEx(hold.mouseHook, code, wParam, lParam);
  }

  static void CALLBACK ForegroundChanged(HWINEVENTHOOK, DWORD, HWND hwnd, LONG, LONG, DWORD, DWORD) noexcept {
    FocusHold &hold = Shared();
    if (hold.active && OwnerRoot(hwnd) != hold.window) hold.Drop("window", L"the window lost the keyboard");
  }

  HWND Messages() noexcept {
    if (messages) return messages;
    WNDCLASSW type{};
    type.lpfnWndProc = &FocusHold::MessageProc;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"ArdiaFocusHold";
    RegisterClassW(&type);
    messages = CreateWindowExW(0, L"ArdiaFocusHold", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, type.hInstance, nullptr);
    return messages;
  }

  static ULONGLONG ReadyFloorMs() noexcept {
    static const ULONGLONG floor = []() noexcept -> ULONGLONG {
      std::optional<std::string> asked = AppLaunch::TestValue("keyHoldReadyMs");
      if (!asked) return 0;
      char *end = nullptr;
      unsigned long long value = std::strtoull(asked->c_str(), &end, 10);
      return end && *end == '\0' ? (std::min)(static_cast<ULONGLONG>(value), kReadyMs / 2) : 0;
    }();
    return floor;
  }

  static bool Allowed() noexcept {
    return !WindowManager::Background() || AppLaunch::TestFlag("keyHold");
  }

  int Begin(HWND app, std::string const &name) noexcept {
    if (active) Drop("command", L"another command");
    HWND root = OwnerRoot(app);
    if (!root || !IsWindowVisible(root) || OwnerRoot(GetForegroundWindow()) != root || !Allowed() || !Messages()) return 0;
    active = true;
    generation = ++lastGeneration;
    window = root;
    command = name;
    startedAt = GetTickCount64();
    claimedTag = 0;
    askedTag = 0;
    nextAt = 0;
    ready = false;
    sentinelOut = false;
    held.clear();
    replayed = 0;
    {
      std::scoped_lock guard{countsLock};
      counts.holds++;
    }
    SetTimer(messages, kTimer, kTickMs, nullptr);
    if (!mouseHook) mouseHook = SetWindowsHookExW(WH_MOUSE, &FocusHold::MouseProc, nullptr, GetCurrentThreadId());
    if (!foregroundHook) {
      foregroundHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, &FocusHold::ForegroundChanged, 0, 0, WINEVENT_OUTOFCONTEXT);
    }
    LaunchLog::Write(L"keys", L"hold " + std::to_wstring(generation) + L" begun for " + Paths::Wide(name));
    return generation;
  }

  void OtherCommand() noexcept {
    if (active) Drop("command", L"another command");
  }

  bool Up(UINT virtualKey) noexcept {
    bool owed = heldKeys.erase(virtualKey) > 0;
    return droppedKeys.erase(virtualKey) > 0 || owed;
  }

  Taken PassOn(UINT virtualKey) noexcept {
    droppedKeys.erase(virtualKey);
    heldKeys.erase(virtualKey);
    return Taken::Pass;
  }

  Taken Key(UINT virtualKey, LPARAM flags) noexcept {
    bool repeat = (flags & (1u << 30)) != 0;
    if (droppedKeys.count(virtualKey)) {
      if (repeat) return Taken::Held;
      droppedKeys.erase(virtualKey);
    }
    if (!active) {
      heldKeys.erase(virtualKey);
      return Taken::Pass;
    }
    if (virtualKey == VK_PROCESSKEY || virtualKey == VK_PACKET) {
      Drop("ime", L"IME or packet input");
      return PassOn(virtualKey);
    }
    switch (virtualKey) {
      case VK_CONTROL:
      case VK_LCONTROL:
      case VK_RCONTROL:
      case VK_MENU:
      case VK_LMENU:
      case VK_RMENU:
      case VK_LWIN:
      case VK_RWIN:
        if (!repeat) Drop("modified", L"a key with Ctrl, Alt or Win");
        return PassOn(virtualKey);
      default:
        break;
    }
    switch (virtualKey) {
      case VK_SHIFT:
      case VK_LSHIFT:
      case VK_RSHIFT:
      case VK_CAPITAL:
      case VK_NUMLOCK:
      case VK_SCROLL:
        return PassOn(virtualKey);
      default:
        break;
    }
    bool modified = (GetKeyState(VK_CONTROL) & 0x8000) || (GetKeyState(VK_MENU) & 0x8000) || (GetKeyState(VK_LWIN) & 0x8000) || (GetKeyState(VK_RWIN) & 0x8000);
    if (modified) {
      Drop("modified", L"a key with Ctrl, Alt or Win");
      return PassOn(virtualKey);
    }
    if (virtualKey == VK_BACK || virtualKey == VK_RETURN) {
      Drop("edit", L"Backspace or Enter");
      return PassOn(virtualKey);
    }
    BYTE state[256] = {};
    if (!GetKeyboardState(state)) {
      Drop("character", L"a key without a character");
      return PassOn(virtualKey);
    }
    wchar_t units[8] = {};
    UINT scan = static_cast<UINT>((flags >> 16) & 0xFF);
    int typed = ToUnicodeEx(virtualKey, scan, state, units, 8, 0x4, GetKeyboardLayout(0));
    if (typed < 0) {
      Drop("dead", L"a dead key");
      return PassOn(virtualKey);
    }
    bool printable = typed > 0;
    for (int i = 0; i < typed; i++) printable = printable && units[i] >= 0x20 && units[i] != 0x7F;
    if (!printable) {
      Drop("character", L"a key without a character");
      return PassOn(virtualKey);
    }
    size_t times = (std::max)(static_cast<size_t>(flags & 0xFFFF), static_cast<size_t>(1));
    if (held.size() + times * static_cast<size_t>(typed) > kCapacity) {
      Drop("capacity", L"64 keys held");
      return PassOn(virtualKey);
    }
    for (size_t r = 0; r < times; r++) held.insert(held.end(), units, units + typed);
    heldKeys.insert(virtualKey);
    Pump();
    return Taken::Held;
  }

  void Claim(int claimed, int tag) noexcept {
    if (!active || claimed != generation || tag <= 0) return;
    if (askedTag && askedTag != tag) return Drop("focus", L"another field was asked to take focus");
    claimedTag = tag;
    Ready();
  }

  void Cancel(int cancelled) noexcept {
    if (active && cancelled == generation) Drop("cancelled", L"the focus move was cancelled");
  }

  void Focused(int tag) noexcept {
    focusedTag = tag;
    if (!active) return;
    if (claimedTag && tag != claimedTag) return Drop("focus", L"another field took focus");
    Ready();
  }

  void Asked(int tag) noexcept {
    if (!active) return;
    if (!claimedTag) askedTag = tag;
    else if (tag != claimedTag) Drop("focus", L"another field was asked to take focus");
  }

  void Blurred(int tag) noexcept {
    if (focusedTag == tag) focusedTag = 0;
    if (active && claimedTag && tag == claimedTag) Drop("focus", L"the field lost focus");
  }

  void Reloaded() noexcept {
    if (active) Drop("reload", L"the app reloaded");
  }

  void Ready() noexcept {
    if (!active || ready || !claimedTag || focusedTag != claimedTag || GetTickCount64() - startedAt < ReadyFloorMs()) return;
    if (GetTickCount64() - startedAt > kReadyMs) return Drop("timeout", L"no field took the keyboard in 3 s");
    ready = true;
    if (!held.empty() && announce) {
      announced = true;
      announce(claimedTag, static_cast<int>(held.size()));
    }
    Pump();
  }

  bool Deliverable(HWND &site) noexcept {
    site = GetFocus();
    return IsWindow(window) && OwnerRoot(GetForegroundWindow()) == window && ClassIs(site, L"InputSiteWindowClass") && GetAncestor(site, GA_ROOT) == window;
  }

  void Pump() noexcept {
    if (!active || !ready || sentinelOut || (nextAt && GetTickCount64() < nextAt)) return;
    nextAt = 0;
    if (held.empty()) return Finish();
    HWND site = nullptr;
    if (!Deliverable(site)) return Drop("site", L"the field's window doesn't have the keyboard");
    size_t units = held.size() > 1 && IS_HIGH_SURROGATE(held[0]) && IS_LOW_SURROGATE(held[1]) ? 2 : 1;
    for (size_t i = 0; i < units; i++) {
      if (!PostMessageW(site, WM_CHAR, held[i], 1)) return Drop("site", L"a held character could not be posted");
    }
    held.erase(held.begin(), held.begin() + static_cast<std::ptrdiff_t>(units));
    replayed++;
    if (!PostMessageW(messages, kSentinel, static_cast<WPARAM>(generation), 0)) return Drop("site", L"the replay's sentinel could not be posted");
    sentinelOut = true;
    postedAt = GetTickCount64();
  }

  void Delivered(int delivered) noexcept {
    if (!active || delivered != generation) return;
    if (GetTickCount64() - postedAt > kDeliveryMs) return Drop("timeout", L"a replayed character wasn't delivered in 1 s");
    sentinelOut = false;
    if (replayed == 1) nextAt = GetTickCount64() + kAfterFirstMs;
    Pump();
  }

  void Tick() noexcept {
    if (!active) {
      if (messages) KillTimer(messages, kTimer);
      return;
    }
    if (!IsWindow(window)) return Drop("window", L"the window closed");
    if (OwnerRoot(GetForegroundWindow()) != window) return Drop("window", L"the window lost the keyboard");
    if (!ready && GetTickCount64() - startedAt > kReadyMs) return Drop("timeout", L"no field took the keyboard in 3 s");
    if (sentinelOut && GetTickCount64() - postedAt > kDeliveryMs) return Drop("timeout", L"a replayed character wasn't delivered in 1 s");
    Ready();
    Pump();
  }

  void Stop() noexcept {
    if (announced && announce) announce(claimedTag, 0);
    announced = false;
    active = false;
    held.clear();
    sentinelOut = false;
    if (messages) KillTimer(messages, kTimer);
    if (mouseHook) {
      UnhookWindowsHookEx(mouseHook);
      mouseHook = nullptr;
    }
    if (foregroundHook) {
      UnhookWinEvent(foregroundHook);
      foregroundHook = nullptr;
    }
  }

  void Finish() noexcept {
    {
      std::scoped_lock guard{countsLock};
      counts.replayed += replayed;
    }
    LaunchLog::Write(L"keys", L"hold " + std::to_wstring(generation) + L" ready after " + std::to_wstring(GetTickCount64() - startedAt) + L" ms, replayed " + std::to_wstring(replayed));
    Stop();
  }

  void Drop(std::string const &reason, std::wstring const &why) noexcept {
    if (!active) return;
    {
      std::scoped_lock guard{countsLock};
      counts.replayed += replayed;
      counts.drops[reason]++;
    }
    droppedKeys.insert(heldKeys.begin(), heldKeys.end());
    heldKeys.clear();
    LaunchLog::Write(L"keys", L"hold " + std::to_wstring(generation) + L" dropped: " + why + L" with " + std::to_wstring(held.size()) + L" held, " + std::to_wstring(replayed) + L" replayed");
    Stop();
  }

  Counts Take() noexcept {
    std::scoped_lock guard{countsLock};
    Counts taken = counts;
    counts = Counts{};
    return taken;
  }
};

}
