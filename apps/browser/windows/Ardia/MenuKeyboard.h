#pragma once

#include <atomic>
#include <chrono>
#include <iterator>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>

#include "Events.h"
#include "FocusHold.h"
#include "LaunchLog.h"
#include "MenuKeys.h"
#include "MenuPopup.h"
#include "MenuStore.h"
#include "NativeModules.h"
#include "Paths.h"
#include "WindowManager.h"

namespace Ardia::Menus {

struct ActiveWindow {
  HWND hwnd = nullptr;
  std::string id;
};

inline ActiveWindow ActiveArdiaWindow() noexcept {
  HWND active = GetActiveWindow();
  if (!active) return {};
  HWND root = GetAncestor(active, GA_ROOTOWNER);
  WindowManager &manager = WindowManager::Shared();
  for (std::string const &id : manager.Ids()) {
    HWND hwnd = manager.Hwnd(id);
    if (hwnd && GetAncestor(hwnd, GA_ROOT) == root) return {hwnd, id};
  }
  return {};
}

inline HWND MenuOwnerWindow() noexcept {
  if (HWND active = ActiveArdiaWindow().hwnd) return active;
  return WindowManager::Shared().ActiveHwnd();
}

struct WindowsKeyHold {
  HWND page = nullptr;
  HWND app = nullptr;
  std::string windowId;
  ULONGLONG until = 0;
  bool windowsUp = false;
};

struct MenuKeyboard {
  static constexpr ULONGLONG WindowsKeyHoldMs = 5000;
  static constexpr ULONGLONG MenuPressToMenuMs = 2000;
  static constexpr int WindowsKeyCheckDelayMs = 150;

  winrt::Microsoft::ReactNative::ReactContext context{nullptr};
  HHOOK keyboardHook = nullptr;
  HHOOK mouseHook = nullptr;
  unsigned switcherHeld = 0;
  bool consumedWithAlt = false;
  bool escapeCaptured = false;
  bool switcherCaptured = false;
  bool capturedWHeld = false;
  std::atomic<bool> textInputFocused{false};
  std::set<UINT> swallowedKeyUps;
  std::optional<WindowsKeyHold> windowsKeyHold;
  HWINEVENTHOOK foregroundHook = nullptr;
  winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer windowsKeyCheckTimer{nullptr};
  winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer windowsKeyDeadlineTimer{nullptr};
  unsigned pagesHeldForWindowsKey = 0;
  unsigned pagesGivenBack = 0;
  unsigned pageReturnRequestsAfterMenu = 0;
  std::optional<winrt::Microsoft::ReactNative::ReactPromise<winrt::Microsoft::ReactNative::JSValue>> recording;

  static MenuKeyboard &Shared() noexcept {
    static MenuKeyboard *shared = new MenuKeyboard();
    return *shared;
  }

  void Install() noexcept {
    if (keyboardHook) return;
    keyboardHook = SetWindowsHookExW(WH_KEYBOARD, &MenuKeyboard::KeyboardProc, nullptr, GetCurrentThreadId());
    if (!keyboardHook) LaunchLog::Write(L"error", L"menus: the keyboard hook could not be installed");
  }

  static bool Background() noexcept {
    return WindowManager::Background();
  }

  void Emit(std::string const &command, std::optional<std::string> const &arg, std::string const &windowId) noexcept {
    using winrt::Microsoft::ReactNative::JSValue;
    using winrt::Microsoft::ReactNative::JSValueObject;
    JSValueObject payload;
    payload["command"] = JSValue{std::string{command}};
    payload["arg"] = arg ? JSValue{std::string{*arg}} : JSValue{nullptr};
    payload["windowId"] = windowId.empty() ? JSValue{nullptr} : JSValue{std::string{windowId}};
    int generation = 0;
    if (command == "newTab" || command == "focusCommandBar") generation = FocusHold::Shared().Begin(WindowManager::Shared().Hwnd(windowId), command);
    else FocusHold::Shared().OtherCommand();
    payload["focusGeneration"] = generation ? JSValue{static_cast<int64_t>(generation)} : JSValue{nullptr};
    EmitEvent(context, L"ArdiaMenus", L"onCommand", std::move(payload));
    LaunchLog::Write(L"command", Paths::Wide(command));
  }

  void EmitSwitcherReleased(bool afterMenu = false) noexcept {
    winrt::Microsoft::ReactNative::JSValueObject event{{"type", "switcherReleased"}};
    if (afterMenu) event["afterMenu"] = winrt::Microsoft::ReactNative::JSValue{true};
    EmitEvent(context, L"ArdiaShell", L"onAppEvent", std::move(event));
  }

  void ReconcileAfterMenu() noexcept {
    for (auto key = swallowedKeyUps.begin(); key != swallowedKeyUps.end();) key = PhysicallyDown(static_cast<int>(*key)) ? std::next(key) : swallowedKeyUps.erase(key);
    if (capturedWHeld && !PhysicallyDown('W')) capturedWHeld = false;
    if (consumedWithAlt && !PhysicallyDown(VK_MENU)) consumedWithAlt = false;
    if (!switcherHeld || (PhysicallyHeldModifiers() & switcherHeld) == switcherHeld) return;
    switcherHeld = 0;
    LaunchLog::Write(L"keys", L"switcher modifier let go while a menu was open");
    EmitSwitcherReleased(true);
  }

  void SetEscapeCapture(bool active) noexcept {
    if (escapeCaptured == active) return;
    escapeCaptured = active;
    LaunchLog::Write(L"keys", active ? L"escape capture on" : L"escape capture off");
  }

  void SetSwitcherCapture(bool active) noexcept {
    if (switcherCaptured == active) return;
    switcherCaptured = active;
    LaunchLog::Write(L"keys", active ? L"switcher capture on" : L"switcher capture off");
  }

  static bool BareEscape(KeyPress const &press) noexcept {
    return press.virtualKey == VK_ESCAPE && (press.modifiers & (ModifierControl | ModifierOption | ModifierShift | ModifierCommand)) == 0;
  }

  bool CaptureEscape() noexcept {
    EmitEvent(context, L"ArdiaShell", L"onAppEvent", winrt::Microsoft::ReactNative::JSValueObject{{"type", "dragEscape"}});
    LaunchLog::Write(L"keys", L"escape sent to the open popover or drag");
    return true;
  }

  static bool ClosesSwitcherRow(KeyPress const &press, bool repeat) noexcept {
    return press.virtualKey == 'W' && !repeat && (press.modifiers & (ModifierControl | ModifierCommand)) != 0 && (press.modifiers & ModifierOption) == 0;
  }

  bool CaptureSwitcherKey(KeyPress const &press, bool repeat) noexcept {
    CommandEntry const *entry = MenuStore::Shared().Match(press);
    if (entry && entry->command == "tabSwitcher") return Dispatch(press);
    if (press.virtualKey == 'W') capturedWHeld = true;
    const char *key = nullptr;
    if (press.virtualKey == VK_ESCAPE) key = "escape";
    else if (press.virtualKey == VK_RIGHT) key = "next";
    else if (press.virtualKey == VK_LEFT) key = "previous";
    else if (ClosesSwitcherRow(press, repeat)) key = "close";
    if (key) EmitEvent(context, L"ArdiaShell", L"onAppEvent", winrt::Microsoft::ReactNative::JSValueObject{{"type", "switcherKey"}, {"key", key}});
    return true;
  }

  static bool PlainUndo(KeyPress const &press) noexcept {
    return press.virtualKey == 'Z' && press.modifiers == ModifierControl;
  }

  static bool PageHasFocus() noexcept {
    HWND focus = GetFocus();
    if (!focus) focus = GetActiveWindow();
    wchar_t name[16] = {};
    return focus && GetClassNameW(focus, name, 16) >= 7 && std::wstring_view(name, 7) == L"Chrome_";
  }

  bool UndoReopensClosedTab(KeyPress const &press, ActiveWindow const &window) noexcept {
    MenuStore const &store = MenuStore::Shared();
    if (!PlainUndo(press) || !store.undoReopensClosedTab || store.Disabled("reopenClosedTab") || window.id.empty()) return false;
    if (store.Match(press)) return false;
    if (!WindowManager::Shared().IsBrowserWindow(window.id)) return false;
    if (GetActiveWindow() != window.hwnd) {
      LaunchLog::Write(L"keys", L"ctrl+z left to the focused dialog or page");
      return false;
    }
    if (textInputFocused.load()) {
      LaunchLog::Write(L"keys", L"ctrl+z left to the focused text field");
      return false;
    }
    if (PageHasFocus()) {
      LaunchLog::Write(L"keys", L"ctrl+z left to the focused page");
      return false;
    }
    return true;
  }

  bool ReopenClosedTab(ActiveWindow const &window) noexcept {
    Emit("reopenClosedTab", std::nullopt, window.id);
    LaunchLog::Write(L"keys", L"ctrl+z reopens the last closed tab");
    return true;
  }

  static unsigned HeldModifiersOf(Combo const &combo) noexcept {
    unsigned held = combo.modifiers & (ModifierControl | ModifierOption | ModifierCommand);
    return held ? held : static_cast<unsigned>(combo.modifiers & ModifierShift);
  }

  void OpenedSwitcher(CommandEntry const &entry, KeyPress const &press) noexcept {
    unsigned held = 0;
    for (Combo const &combo : entry.active) {
      if (Matches(combo, press)) {
        held = HeldModifiersOf(combo);
        break;
      }
    }
    switcherHeld = held && (press.modifiers & held) == held ? held : 0;
    if (!switcherHeld && context) RunOnUI(context, []() noexcept { Shared().EmitSwitcherReleased(); });
  }

  void ModifiersChanged(unsigned modifiers) noexcept {
    if (!switcherHeld || (modifiers & switcherHeld) == switcherHeld) return;
    switcherHeld = 0;
    EmitSwitcherReleased();
  }

  static bool NativeActionAvailable(std::string_view id, ActiveWindow const &window) noexcept {
    if (id == "std:miniaturizeAll:") return !WindowManager::Shared().Ids().empty();
    return window.hwnd != nullptr;
  }

  static void Minimize(HWND hwnd) noexcept {
    if (hwnd && IsWindowVisible(hwnd)) ShowWindow(hwnd, SW_MINIMIZE);
  }

  void PerformNative(std::string_view id, ActiveWindow const &window) noexcept {
    if (Background() && id != "std:closeWindow:" && id != "std:toggleKeepOnTop:") {
      LogActivation(std::string{id.substr(4)} + " (acted out)");
      return;
    }
    HWND hwnd = window.hwnd;
    if (id == "std:closeWindow:") {
      if (hwnd) PostMessageW(hwnd, WM_CLOSE, 0, 0);
    } else if (id == "std:toggleFullScreen:") {
      if (!hwnd) return;
      try {
        using winrt::Microsoft::UI::Windowing::AppWindow;
        using winrt::Microsoft::UI::Windowing::AppWindowPresenterKind;
        AppWindow appWindow = AppWindow::GetFromWindowId(winrt::Microsoft::UI::GetWindowIdFromWindow(hwnd));
        if (!appWindow) return;
        bool fullScreen = appWindow.Presenter().Kind() == AppWindowPresenterKind::FullScreen;
        appWindow.SetPresenter(fullScreen ? AppWindowPresenterKind::Overlapped : AppWindowPresenterKind::FullScreen);
      } catch (...) {
        LaunchLog::Write(L"error", L"menus: full screen could not be toggled");
      }
    } else if (id == "std:performMiniaturize:") {
      Minimize(hwnd);
    } else if (id == "std:miniaturizeAll:") {
      WindowManager &manager = WindowManager::Shared();
      for (std::string const &windowId : manager.Ids()) Minimize(manager.Hwnd(windowId));
    } else if (id == "std:performZoom:") {
      if (hwnd && IsWindowVisible(hwnd)) ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
    } else if (id == "std:toggleKeepOnTop:") {
      if (!hwnd) return;
      bool topmost = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
      SetWindowPos(hwnd, topmost ? HWND_NOTOPMOST : HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
  }

  bool Dispatch(KeyPress const &press) noexcept {
    MenuStore &store = MenuStore::Shared();
    CommandEntry const *entry = store.Match(press);
    if (!entry) return false;
    ActiveWindow window = ActiveArdiaWindow();
    if (entry->Native()) {
      if (!NativeActionAvailable(entry->id, window)) return false;
      PerformNative(entry->id, window);
      return true;
    }
    if (entry->command == "closeTab" && WindowManager::Shared().IsPopupWindow(window.id)) {
      PostMessageW(window.hwnd, WM_CLOSE, 0, 0);
      LaunchLog::Write(L"keys", L"close tab closes the pop-up window");
      return true;
    }
    if (!WindowManager::Shared().IsPopupWindow(window.id) && !store.EntryEnabled(*entry)) return false;
    Emit(entry->command, entry->arg, window.id);
    if (entry->command == "tabSwitcher") OpenedSwitcher(*entry, press);
    return true;
  }

  void StartRecording(winrt::Microsoft::ReactNative::ReactPromise<winrt::Microsoft::ReactNative::JSValue> const &promise) noexcept {
    FinishRecording(winrt::Microsoft::ReactNative::JSValue{nullptr});
    recording.emplace(promise);
    if (!mouseHook) mouseHook = SetWindowsHookExW(WH_MOUSE, &MenuKeyboard::MouseProc, nullptr, GetCurrentThreadId());
  }

  void FinishRecording(winrt::Microsoft::ReactNative::JSValue &&result) noexcept {
    if (mouseHook) {
      UnhookWindowsHookEx(mouseHook);
      mouseHook = nullptr;
    }
    if (!recording) return;
    auto pending = *recording;
    recording.reset();
    pending.Resolve(result);
  }

  bool Record(KeyPress const &press) noexcept {
    using winrt::Microsoft::ReactNative::JSValue;
    using winrt::Microsoft::ReactNative::JSValueArray;
    using winrt::Microsoft::ReactNative::JSValueObject;
    if (press.virtualKey == VK_ESCAPE && press.modifiers == 0) {
      FinishRecording(JSValue{nullptr});
      return true;
    }
    wchar_t key = RecordedKey(press);
    if (!key) return true;
    bool held = (press.modifiers & (ModifierControl | ModifierOption)) != 0;
    if (!held && !IsFunctionKey(key)) {
      MessageBeep(MB_OK);
      return true;
    }
    JSValueArray modifiers;
    for (unsigned modifier : kModifierOrder) {
      if (press.modifiers & modifier) modifiers.push_back(JSValue{std::string{ModifierNameOf(modifier)}});
    }
    FinishRecording(JSValue{JSValueObject{{"key", Paths::Utf8(std::wstring(1, key))}, {"modifiers", std::move(modifiers)}}});
    return true;
  }

  static bool IsSnapKey(UINT key) noexcept {
    return key == VK_UP || key == VK_DOWN || key == VK_LEFT || key == VK_RIGHT || key == 'Z';
  }

  static bool IsWindowsKey(UINT key) noexcept {
    return key == VK_LWIN || key == VK_RWIN;
  }

  static bool IsHeldModifierKey(UINT key) noexcept {
    switch (key) {
      case VK_SHIFT:
      case VK_LSHIFT:
      case VK_RSHIFT:
      case VK_CONTROL:
      case VK_LCONTROL:
      case VK_RCONTROL:
      case VK_MENU:
      case VK_LMENU:
      case VK_RMENU:
        return true;
      default:
        return false;
    }
  }

  static bool WindowsKeyPhysicallyHeld() noexcept {
    return (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
  }

  static bool OurWindow(HWND hwnd) noexcept {
    DWORD process = 0;
    if (hwnd) GetWindowThreadProcessId(hwnd, &process);
    return hwnd && process == GetCurrentProcessId();
  }

  static ActiveWindow HostOfPage(HWND page) noexcept {
    wchar_t name[16] = {};
    if (!page || GetClassNameW(page, name, 16) < 7 || std::wstring_view(name, 7) != L"Chrome_") return {};
    HWND owner = GetWindow(page, GW_OWNER);
    if (!owner) return {};
    WindowManager &manager = WindowManager::Shared();
    for (std::string const &id : manager.Ids()) {
      if (manager.Hwnd(id) == owner) return manager.IsBrowserWindow(id) ? ActiveWindow{owner, id} : ActiveWindow{};
    }
    return {};
  }

  void RestartTimer(winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer &timer, int delayMs, void (MenuKeyboard::*fire)() noexcept) noexcept {
    try {
      if (!timer) {
        auto queue = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread();
        if (!queue) return;
        timer = queue.CreateTimer();
        timer.Interval(std::chrono::milliseconds(delayMs));
        timer.IsRepeating(false);
        timer.Tick([fire](auto const &, auto const &) noexcept { (Shared().*fire)(); });
      }
      timer.Stop();
      timer.Start();
    } catch (...) {
      LaunchLog::Write(L"error", L"snap keys: a timer could not start");
    }
  }

  void WatchWindowsKey(UINT key, bool keyUp, bool repeat) noexcept {
    if (IsWindowsKey(key)) {
      if (!keyUp) {
        if (!repeat) HoldPageForWindowsKey();
      } else {
        WindowsKeyReleased();
      }
      return;
    }
    if (!windowsKeyHold || windowsKeyHold->windowsUp) return;
    if (!WindowsKeyPhysicallyHeld()) {
      WindowsKeyReleased();
      return;
    }
    if (!keyUp || IsSnapKey(key) || IsHeldModifierKey(key)) return;
    GivePageBack(L"at the key-up of another key pressed with the Windows key");
  }

  void WindowsKeyReleased() noexcept {
    if (!windowsKeyHold) return;
    windowsKeyHold->windowsUp = true;
    RestartTimer(windowsKeyCheckTimer, WindowsKeyCheckDelayMs, &MenuKeyboard::CheckWindowsKeyHold);
  }

  void HoldPageForWindowsKey() noexcept {
    HWND foreground = GetForegroundWindow();
    ActiveWindow host = HostOfPage(foreground);
    if (!host.hwnd) {
      if (windowsKeyHold) {
        windowsKeyHold->windowsUp = false;
        windowsKeyHold->until = GetTickCount64() + WindowsKeyHoldMs;
        RestartTimer(windowsKeyDeadlineTimer, static_cast<int>(WindowsKeyHoldMs), &MenuKeyboard::WindowsKeyHoldLapsed);
      }
      return;
    }
    if (!context) return;
    if (Background()) {
      LaunchLog::Write(L"keys", L"snap keys: the Windows key went down over a page (acted out)");
      return;
    }
    if (windowsKeyHold) LetPageGo(L"a new Windows key press over a page replaced it");
    windowsKeyHold = WindowsKeyHold{foreground, host.hwnd, host.id, GetTickCount64() + WindowsKeyHoldMs, false};
    RunOnUI(context, []() noexcept { Shared().GiveAppWindowTheKeyboard(); });
  }

  void GiveAppWindowTheKeyboard() noexcept {
    if (!windowsKeyHold) return;
    WindowsKeyHold hold = *windowsKeyHold;
    if (GetForegroundWindow() != hold.page || !IsWindow(hold.app)) {
      LetPageGo(L"the page lost the foreground before its app window could take it");
      return;
    }
    SetForegroundWindow(hold.app);
    if (GetForegroundWindow() != hold.app) {
      LetPageGo(L"the app window did not take the foreground");
      return;
    }
    ++pagesHeldForWindowsKey;
    LaunchLog::Write(L"keys", L"snap keys: the Windows key went down over a page, so its app window took the keyboard (" + std::to_wstring(pagesHeldForWindowsKey) + L" so far)");
    if (!foregroundHook) foregroundHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, &MenuKeyboard::ForegroundChanged, 0, 0, WINEVENT_OUTOFCONTEXT);
    RestartTimer(windowsKeyDeadlineTimer, static_cast<int>(WindowsKeyHoldMs), &MenuKeyboard::WindowsKeyHoldLapsed);
    if (windowsKeyHold && (windowsKeyHold->windowsUp || !WindowsKeyPhysicallyHeld())) WindowsKeyReleased();
  }

  static void CALLBACK ForegroundChanged(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD) noexcept {
    MenuKeyboard &keyboard = Shared();
    if (!keyboard.windowsKeyHold) return;
    if (keyboard.windowsKeyHold->windowsUp || !WindowsKeyPhysicallyHeld()) keyboard.WindowsKeyReleased();
  }

  void CheckWindowsKeyHold() noexcept {
    if (!windowsKeyHold || !windowsKeyHold->windowsUp) return;
    WindowsKeyHold hold = *windowsKeyHold;
    if (!IsWindow(hold.page) || !IsWindow(hold.app)) {
      LetPageGo(L"the page or its window went away");
      return;
    }
    HWND foreground = GetForegroundWindow();
    if (foreground == hold.app) {
      if (IsIconic(hold.app)) LetPageGo(L"the window is minimized");
      else GivePageBack(L"after the Windows key");
      return;
    }
    if (foreground == hold.page) {
      LetPageGo(L"the page has the keyboard already");
      return;
    }
    if (OurWindow(foreground)) {
      LetPageGo(L"another window of the app is in front");
      return;
    }
    LaunchLog::Write(L"keys", L"snap keys: another program is in front, so the page waits for its window to come back");
  }

  void WindowsKeyHoldLapsed() noexcept {
    if (!windowsKeyHold) return;
    HWND foreground = GetForegroundWindow();
    bool released = windowsKeyHold->windowsUp || !WindowsKeyPhysicallyHeld();
    if (released && IsWindow(windowsKeyHold->page) && foreground && !OurWindow(foreground)) GivePageBack(L"for when its window comes back, as another program is still in front");
    else LetPageGo(L"its deadline passed");
  }

  void GivePageBack(std::wstring_view when) noexcept {
    if (!windowsKeyHold) return;
    std::string windowId = windowsKeyHold->windowId;
    LetPageGo({});
    ++pagesGivenBack;
    EmitEvent(context, L"ArdiaShell", L"onAppEvent", winrt::Microsoft::ReactNative::JSValueObject{{"type", "snapKeyHandedBack"}, {"windowId", windowId}});
    LaunchLog::Write(L"keys", L"snap keys: the keyboard went back to the page " + std::wstring{when} + L" (" + std::to_wstring(pagesGivenBack) + L" so far)");
  }

  void LetPageGo(std::wstring_view reason) noexcept {
    windowsKeyHold.reset();
    try {
      if (windowsKeyCheckTimer) windowsKeyCheckTimer.Stop();
      if (windowsKeyDeadlineTimer) windowsKeyDeadlineTimer.Stop();
    } catch (...) {
      LaunchLog::Write(L"error", L"snap keys: a timer could not stop");
    }
    if (foregroundHook) {
      UnhookWinEvent(foregroundHook);
      foregroundHook = nullptr;
    }
    if (!reason.empty()) LaunchLog::Write(L"keys", L"snap keys: the page is let go: " + std::wstring{reason});
  }

  std::optional<MenuPageReturn> PageTheMenuPressLeft(HWND owner) noexcept {
    HWND page = WindowManager::Shared().TakePageLeftBySecondaryPress(owner, MenuPressToMenuMs);
    if (!page || GetForegroundWindow() != owner) return std::nullopt;
    ActiveWindow host = HostOfPage(page);
    if (host.hwnd != owner) return std::nullopt;
    return MenuPageReturn{page, owner, host.id};
  }

  std::wstring_view WhyTheAppKeepsTheKeyboard(MenuPageReturn const &left, bool chosen) const noexcept {
    if (chosen) return L"a choice was made";
    if (!IsWindow(left.app) || !IsWindow(left.page)) return L"the page or its window went away";
    if (WindowManager::Shared().Hwnd(left.windowId) != left.app || HostOfPage(left.page).hwnd != left.app) return L"the page is no longer that window's";
    HWND foreground = GetForegroundWindow();
    if (foreground == left.page) return L"the page has the keyboard already";
    if (foreground != left.app) return L"the window is no longer in front";
    if (IsIconic(left.app) || !IsWindowVisible(left.page)) return L"the window is minimized or the page hidden";
    if (!IsWindowEnabled(left.app) || DialogParts::ModalDialogOf(left.app)) return L"a dialog holds the window";
    if (switcherCaptured || switcherHeld || escapeCaptured) return L"the switcher or a popover is open";
    if (windowsKeyHold || FocusHold::Shared().active || recording) return L"another keyboard handoff is under way";
    return {};
  }

  void GivePageBackAfterMenu(MenuPageReturn const &left, bool chosen) noexcept {
    std::wstring_view kept = WhyTheAppKeepsTheKeyboard(left, chosen);
    if (!kept.empty()) {
      LaunchLog::Write(L"keys", L"menu: the keyboard stays in the app window: " + std::wstring{kept});
      return;
    }
    ++pageReturnRequestsAfterMenu;
    winrt::Microsoft::ReactNative::JSValueObject event{{"type", "snapKeyHandedBack"}, {"windowId", left.windowId}};
    event["afterMenu"] = winrt::Microsoft::ReactNative::JSValue{true};
    EmitEvent(context, L"ArdiaShell", L"onAppEvent", std::move(event));
    LaunchLog::Write(L"keys", L"menu: asked to give the keyboard back to the page the right-click took it from (" + std::to_wstring(pageReturnRequestsAfterMenu) + L" so far)");
  }

  bool HandleKey(UINT virtualKey, LPARAM flags) noexcept {
    bool keyUp = (flags & (1u << 31)) != 0;
    WatchWindowsKey(virtualKey, keyUp, (flags & (1u << 30)) != 0);
    if (keyUp) {
      if (virtualKey == 'W') capturedWHeld = false;
      if (unsigned released = ModifierOfKey(virtualKey)) ModifiersChanged(static_cast<unsigned>(HeldModifiers() & ~released));
      bool owedToHold = FocusHold::Shared().Up(virtualKey);
      bool swallowed = swallowedKeyUps.erase(virtualKey) > 0;
      if (owedToHold || swallowed) return true;
      if ((virtualKey == VK_MENU || virtualKey == VK_LMENU || virtualKey == VK_RMENU) && consumedWithAlt) {
        consumedWithAlt = false;
        return true;
      }
      return false;
    }
    if (FocusHold::Shared().Key(virtualKey, flags) == FocusHold::Taken::Held) return true;
    if (IsModifierKey(virtualKey)) return false;
    if (capturedWHeld && virtualKey == 'W') {
      if (flags & (1u << 30)) return true;
      capturedWHeld = false;
    }
    KeyPress press = ReadKeyPress(virtualKey, flags);
    if (press.windowsKey || press.altGraph) return false;
    bool handled = false;
    if (recording) {
      handled = Record(press);
    } else {
      ActiveWindow window = ActiveArdiaWindow();
      if (!window.hwnd) return false;
      if (switcherCaptured) handled = CaptureSwitcherKey(press, (flags & (1u << 30)) != 0);
      else if (escapeCaptured && BareEscape(press)) handled = CaptureEscape();
      else if (UndoReopensClosedTab(press, window)) handled = ReopenClosedTab(window);
      else handled = Dispatch(press);
    }
    if (handled) {
      swallowedKeyUps.insert(virtualKey);
      if (press.modifiers & ModifierOption) consumedWithAlt = true;
    }
    return handled;
  }

  static LRESULT CALLBACK KeyboardProc(int code, WPARAM wParam, LPARAM lParam) noexcept {
    MenuKeyboard &keyboard = Shared();
    if (code == HC_ACTION) {
      bool handled = false;
      try {
        handled = keyboard.HandleKey(static_cast<UINT>(wParam), lParam);
      } catch (...) {
        handled = false;
      }
      if (handled) return 1;
    }
    return CallNextHookEx(keyboard.keyboardHook, code, wParam, lParam);
  }

  static LRESULT CALLBACK MouseProc(int code, WPARAM wParam, LPARAM lParam) noexcept {
    MenuKeyboard &keyboard = Shared();
    if (code == HC_ACTION && keyboard.recording) {
      switch (wParam) {
        case WM_LBUTTONDOWN:
        case WM_RBUTTONDOWN:
        case WM_MBUTTONDOWN:
        case WM_NCLBUTTONDOWN:
        case WM_NCRBUTTONDOWN:
          keyboard.FinishRecording(winrt::Microsoft::ReactNative::JSValue{nullptr});
          break;
        default:
          break;
      }
    }
    return CallNextHookEx(keyboard.mouseHook, code, wParam, lParam);
  }
};

}
