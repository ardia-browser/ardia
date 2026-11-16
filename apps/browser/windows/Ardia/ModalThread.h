#pragma once

#include <objbase.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <string_view>
#include <thread>
#include <string>
#include <utility>

#include "LaunchLog.h"

namespace Ardia::DialogParts {

constexpr UINT OwnerWatchMs = 250;
constexpr UINT StubbornEveryMs = 100;
constexpr UINT LateTickSlackMs = 100;
constexpr int SettledAfterIdleTicks = 2;
constexpr UINT ModalCancelMessage = WM_APP + 56;

struct ModalRegistry {
  std::mutex lock;
  std::condition_variable freed;
  std::set<HWND> busy;
  std::atomic<uint64_t> releases{0};
  std::atomic<bool> stopping{false};
  std::atomic<int> threads{0};
  std::atomic<ULONGLONG> stoppedAt{0};
  std::atomic<ULONGLONG> releasedAt{0};
  std::mutex parentsLock;
  std::set<HWND> parents;

  static ModalRegistry &Shared() noexcept {
    static ModalRegistry *registry = new ModalRegistry();
    return *registry;
  }
};

inline bool Stopping() noexcept {
  return ModalRegistry::Shared().stopping.load();
}

constexpr int StopWaitMs = 2000;

inline void DeliverSentMessages(DWORD waitMs) noexcept {
  MsgWaitForMultipleObjects(0, nullptr, FALSE, waitMs, QS_SENDMESSAGE);
  MSG message{};
  PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE | PM_QS_SENDMESSAGE);
}

inline void WakeModals() noexcept {
  ModalRegistry &registry = ModalRegistry::Shared();
  std::lock_guard<std::mutex> guard(registry.parentsLock);
  for (HWND parent : registry.parents) PostMessageW(parent, ModalCancelMessage, 0, 0);
}

inline int StopAllModals() noexcept {
  ModalRegistry &registry = ModalRegistry::Shared();
  registry.stoppedAt = GetTickCount64();
  registry.stopping = true;
  registry.freed.notify_all();
  WakeModals();
  ULONGLONG began = GetTickCount64();
  while (registry.threads.load() > 0 && GetTickCount64() - began < StopWaitMs) DeliverSentMessages(10);
  return static_cast<int>(GetTickCount64() - began);
}

inline void ReleaseAllModals() noexcept {
  ModalRegistry::Shared().releasedAt = GetTickCount64();
  ModalRegistry::Shared().releases++;
  WakeModals();
}

inline ULONGLONG AskedToCloseAt() noexcept {
  ModalRegistry &registry = ModalRegistry::Shared();
  return (std::max)(registry.stoppedAt.load(), registry.releasedAt.load());
}

struct OwnerSlot {
  explicit OwnerSlot(HWND owner) noexcept : m_owner(owner) {
    if (!owner) return;
    ModalRegistry &registry = ModalRegistry::Shared();
    std::unique_lock<std::mutex> guard(registry.lock);
    while (!registry.stopping.load() && IsWindow(owner) && registry.busy.contains(owner)) registry.freed.wait_for(guard, std::chrono::milliseconds(OwnerWatchMs));
    m_held = !registry.stopping.load() && IsWindow(owner) && registry.busy.insert(owner).second;
  }
  ~OwnerSlot() noexcept {
    if (!m_held) return;
    ModalRegistry &registry = ModalRegistry::Shared();
    {
      std::lock_guard<std::mutex> guard(registry.lock);
      registry.busy.erase(m_owner);
    }
    registry.freed.notify_all();
  }
  OwnerSlot(OwnerSlot const &) = delete;
  OwnerSlot &operator=(OwnerSlot const &) = delete;

  bool Usable() const noexcept { return !m_owner || m_held; }

 private:
  HWND m_owner;
  bool m_held = false;
};

struct ModalWatchState {
  HWND owner = nullptr;
  uint64_t release = 0;
  std::function<void()> abandon;
  std::function<void()> stubborn;
  std::function<void()> tick;
  UINT_PTR stubbornTimer = 0;
  std::wstring kind;
  bool opensFolders = false;
  ULONGLONG startedAt = 0;
  ULONGLONG shownAt = 0;
  ULONGLONG firstFolderAt = 0;
  ULONGLONG cancelTakenAt = 0;
  ULONGLONG askedAt = 0;
  ULONGLONG lastTickAt = 0;
  int idleTicks = 0;
  ULONGLONG settledAt = 0;
};

inline ModalWatchState &WatchState() noexcept {
  thread_local ModalWatchState state;
  return state;
}

inline void CALLBACK AfterAbandon(HWND, UINT, UINT_PTR, DWORD) noexcept {
  std::function<void()> stubborn = WatchState().stubborn;
  if (stubborn) stubborn();
}

inline void NoteTick(ModalWatchState &state) noexcept {
  ULONGLONG now = GetTickCount64();
  bool onTime = state.lastTickAt && now - state.lastTickAt <= OwnerWatchMs + LateTickSlackMs;
  state.lastTickAt = now;
  state.idleTicks = state.shownAt && onTime ? state.idleTicks + 1 : 0;
}

inline void CALLBACK WatchOwner(HWND, UINT, UINT_PTR timer, DWORD) noexcept {
  ModalWatchState &state = WatchState();
  bool ownerGone = state.owner && !IsWindow(state.owner);
  bool released = ModalRegistry::Shared().releases.load() != state.release;
  if (!ownerGone && !released && !Stopping()) {
    if (timer) NoteTick(state);
    if (state.tick) state.tick();
    return;
  }
  std::function<void()> abandon = std::move(state.abandon);
  state.abandon = nullptr;
  if (!abandon) return;
  state.cancelTakenAt = GetTickCount64();
  state.askedAt = released || Stopping() ? AskedToCloseAt() : 0;
  abandon();
  if (state.stubborn && !state.stubbornTimer) state.stubbornTimer = SetTimer(nullptr, 0, StubbornEveryMs, &AfterAbandon);
}

inline std::wstring SinceStart(ModalWatchState const &state, ULONGLONG at) noexcept {
  return std::to_wstring(at - state.startedAt) + L" ms";
}

inline std::wstring DialogLifetime(ModalWatchState const &state) noexcept {
  std::wstring line = state.kind + L" gone " + SinceStart(state, GetTickCount64()) + L" after its thread started: ";
  line += state.shownAt ? L"its window showed at " + SinceStart(state, state.shownAt) : std::wstring{L"its window never showed"};
  if (state.settledAt) line += L", its thread settled at " + SinceStart(state, state.settledAt);
  if (state.opensFolders) line += state.firstFolderAt ? L", its first folder opened at " + SinceStart(state, state.firstFolderAt) : std::wstring{L", it opened no folder"};
  if (state.cancelTakenAt) line += L", its thread took the cancel at " + SinceStart(state, state.cancelTakenAt);
  if (state.cancelTakenAt && state.askedAt) line += L", " + std::to_wstring(state.cancelTakenAt - state.askedAt) + L" ms after the app asked";
  return line;
}

struct ModalWatch {
  ModalWatch(HWND owner, std::string_view kind) noexcept {
    ModalWatchState &state = WatchState();
    state.owner = owner;
    state.release = ModalRegistry::Shared().releases.load();
    state.abandon = nullptr;
    state.kind.assign(kind.begin(), kind.end());
    state.opensFolders = false;
    state.startedAt = GetTickCount64();
    state.shownAt = state.firstFolderAt = state.cancelTakenAt = state.askedAt = state.lastTickAt = state.settledAt = 0;
    state.idleTicks = 0;
    LaunchLog::Write(L"dialog", state.kind + L" thread started");
    m_timer = SetTimer(nullptr, 0, OwnerWatchMs, &WatchOwner);
  }
  ~ModalWatch() noexcept {
    if (m_timer) KillTimer(nullptr, m_timer);
    ModalWatchState &state = WatchState();
    LaunchLog::Write(L"dialog", DialogLifetime(state));
    if (state.stubbornTimer) KillTimer(nullptr, state.stubbornTimer);
    state.stubbornTimer = 0;
    state.owner = nullptr;
    state.abandon = nullptr;
    state.stubborn = nullptr;
    state.tick = nullptr;
  }
  ModalWatch(ModalWatch const &) = delete;
  ModalWatch &operator=(ModalWatch const &) = delete;

  static void OnAbandon(std::function<void()> abandon) noexcept { WatchState().abandon = std::move(abandon); }
  static void OnStubborn(std::function<void()> stubborn) noexcept { WatchState().stubborn = std::move(stubborn); }
  static void Disarm() noexcept {
    ModalWatchState &state = WatchState();
    if (state.stubbornTimer) KillTimer(nullptr, state.stubbornTimer);
    state.stubbornTimer = 0;
    state.abandon = nullptr;
    state.stubborn = nullptr;
  }
  static void OnTick(std::function<void()> tick) noexcept { WatchState().tick = std::move(tick); }
  static void OpensFolders() noexcept { WatchState().opensFolders = true; }
  static bool Cancelled() noexcept { return WatchState().cancelTakenAt != 0; }
  static void NoteFirstFolder() noexcept {
    ModalWatchState &state = WatchState();
    if (state.firstFolderAt || !state.startedAt) return;
    state.firstFolderAt = GetTickCount64();
    LaunchLog::Write(L"dialog", state.kind + L" opened its first folder " + SinceStart(state, state.firstFolderAt) + L" after its thread started");
  }
  static bool SettledNow() noexcept {
    ModalWatchState &state = WatchState();
    if (state.idleTicks < SettledAfterIdleTicks) return false;
    if (state.settledAt) return true;
    state.settledAt = GetTickCount64();
    LaunchLog::Write(L"dialog", state.kind + L" settled " + SinceStart(state, state.settledAt) + L" after its thread started: its last " + std::to_wstring(SettledAfterIdleTicks) + L" checks came on time");
    return true;
  }
  static void NoteShown() noexcept {
    ModalWatchState &state = WatchState();
    if (state.shownAt || !state.startedAt) return;
    state.shownAt = GetTickCount64();
    LaunchLog::Write(L"dialog", state.kind + L" window seen shown " + SinceStart(state, state.shownAt) + L" after its thread started");
  }

 private:
  UINT_PTR m_timer = 0;
};

struct ModalDialogs {
  std::mutex lock;
  std::map<HWND, HWND> byOwner;
  std::set<HWND> settled;

  static ModalDialogs &Shared() noexcept {
    static ModalDialogs *dialogs = new ModalDialogs();
    return *dialogs;
  }
};

inline void NoteModalDialog(HWND owner, HWND dialog) noexcept {
  if (!owner) return;
  ModalDialogs &dialogs = ModalDialogs::Shared();
  std::lock_guard<std::mutex> guard(dialogs.lock);
  if (dialog) dialogs.byOwner[owner] = dialog;
  else dialogs.byOwner.erase(owner);
  if (!dialog) dialogs.settled.erase(owner);
}

inline void NoteModalSettled(HWND owner) noexcept {
  if (!owner) return;
  ModalDialogs &dialogs = ModalDialogs::Shared();
  std::lock_guard<std::mutex> guard(dialogs.lock);
  dialogs.settled.insert(owner);
}

inline int SettledDialogCount() noexcept {
  ModalDialogs &dialogs = ModalDialogs::Shared();
  std::lock_guard<std::mutex> guard(dialogs.lock);
  int settled = 0;
  for (HWND owner : dialogs.settled) {
    auto found = dialogs.byOwner.find(owner);
    if (found != dialogs.byOwner.end() && found->second && IsWindowVisible(found->second)) settled++;
  }
  return settled;
}

inline HWND ModalDialogOf(HWND owner) noexcept {
  ModalDialogs &dialogs = ModalDialogs::Shared();
  std::lock_guard<std::mutex> guard(dialogs.lock);
  auto found = dialogs.byOwner.find(owner);
  return found == dialogs.byOwner.end() ? nullptr : found->second;
}

inline int ShownDialogCount() noexcept {
  ModalDialogs &dialogs = ModalDialogs::Shared();
  std::lock_guard<std::mutex> guard(dialogs.lock);
  int shown = 0;
  for (auto const &[owner, dialog] : dialogs.byOwner)
    if (dialog && IsWindowVisible(dialog)) shown++;
  return shown;
}

inline bool BringModalForward(HWND owner) noexcept {
  HWND dialog = ModalDialogOf(owner);
  if (!dialog || !IsWindow(dialog) || !IsWindowVisible(dialog)) return false;
  SetWindowPos(dialog, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  SetForegroundWindow(dialog);
  return true;
}

constexpr wchar_t ModalParentClass[] = L"ArdiaModalParent";

inline LRESULT CALLBACK ModalParentProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) noexcept {
  if (message != ModalCancelMessage) return DefWindowProcW(window, message, wParam, lParam);
  WatchOwner(nullptr, 0, 0, 0);
  return 0;
}

inline bool RegisterModalParent() noexcept {
  static bool const registered = [] {
    WNDCLASSEXW type{};
    type.cbSize = sizeof(type);
    type.lpfnWndProc = ModalParentProcedure;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = ModalParentClass;
    return RegisterClassExW(&type) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
  }();
  return registered;
}

struct ModalParent {
  ModalParent(HWND owner, bool givesFocusBack) noexcept : m_owner(owner), m_givesFocusBack(givesFocusBack) {
    if (!owner || !RegisterModalParent()) return;
    RECT area{};
    if (!GetWindowRect(owner, &area)) return;
    m_window = CreateWindowExW(WS_EX_TOOLWINDOW, ModalParentClass, L"", WS_POPUP, area.left, area.top, area.right - area.left, area.bottom - area.top, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (m_window) Listed(true);
    m_ownerWasEnabled = IsWindowEnabled(owner) != FALSE;
    if (m_ownerWasEnabled) EnableWindow(owner, FALSE);
  }
  ~ModalParent() noexcept {
    Release();
    if (!m_window) return;
    Listed(false);
    DestroyWindow(m_window);
  }
  ModalParent(ModalParent const &) = delete;
  ModalParent &operator=(ModalParent const &) = delete;

  HWND Handle() const noexcept { return m_window; }

  void KeepDialogAboveOwner() noexcept {
    HWND dialog = Dialog();
    if (!dialog || !m_owner || !IsWindow(m_owner)) return;
    NoteModalDialog(m_owner, dialog);
    ModalWatch::NoteShown();
    if (ModalWatch::SettledNow()) NoteModalSettled(m_owner);
    bool above = false;
    for (HWND higher = GetWindow(m_owner, GW_HWNDPREV); higher && !above; higher = GetWindow(higher, GW_HWNDPREV)) above = higher == dialog;
    if (!above) {
      HWND justAbove = GetWindow(m_owner, GW_HWNDPREV);
      SetWindowPos(dialog, justAbove ? justAbove : HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    if (GetForegroundWindow() == m_owner) SetForegroundWindow(dialog);
  }

  void Release() noexcept {
    if (m_released) return;
    m_released = true;
    NoteModalDialog(m_owner, nullptr);
    if (!m_owner || !IsWindow(m_owner) || !m_ownerWasEnabled || Stopping()) return;
    bool hadFocus = m_givesFocusBack && DialogInFront();
    EnableWindow(m_owner, TRUE);
    if (hadFocus) SetForegroundWindow(m_owner);
  }

  HWND Dialog() const noexcept {
    if (!m_window) return nullptr;
    HWND found = nullptr;
    auto visit = [](HWND window, LPARAM data) noexcept -> BOOL {
      auto *self = reinterpret_cast<std::pair<HWND, HWND> *>(data);
      if (GetWindow(window, GW_OWNER) != self->first || !IsWindowVisible(window)) return TRUE;
      self->second = window;
      return FALSE;
    };
    std::pair<HWND, HWND> search{m_window, nullptr};
    EnumThreadWindows(GetCurrentThreadId(), visit, reinterpret_cast<LPARAM>(&search));
    found = search.second;
    return found;
  }

 private:
  void Listed(bool listed) const noexcept {
    ModalRegistry &registry = ModalRegistry::Shared();
    std::lock_guard<std::mutex> guard(registry.parentsLock);
    if (listed) registry.parents.insert(m_window);
    else registry.parents.erase(m_window);
  }

  bool DialogInFront() const noexcept {
    HWND front = GetForegroundWindow();
    if (!front) return false;
    if (front == m_window) return true;
    for (HWND owner = GetWindow(front, GW_OWNER); owner; owner = GetWindow(owner, GW_OWNER))
      if (owner == m_window) return true;
    return false;
  }

  HWND m_owner;
  bool m_givesFocusBack;
  HWND m_window = nullptr;
  bool m_ownerWasEnabled = false;
  bool m_released = false;
};

struct ComApartment {
  bool owned = false;
  ComApartment() noexcept {
    HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    owned = SUCCEEDED(result);
  }
  ~ComApartment() noexcept {
    if (owned) CoUninitialize();
  }
  ComApartment(ComApartment const &) = delete;
  ComApartment &operator=(ComApartment const &) = delete;
};

template <class TShow>
bool RunModal(HWND owner, TShow &&show) noexcept {
  if (Stopping()) return false;
  try {
    ModalRegistry::Shared().threads++;
    std::thread([owner, show = std::forward<TShow>(show)]() mutable noexcept {
      SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
      {
        ComApartment apartment;
        OwnerSlot slot(owner);
        show(slot.Usable() && !Stopping());
      }
      if (Stopping()) LaunchLog::Write(L"dialog", L"a dialog's thread ended " + std::to_wstring(GetTickCount64() - ModalRegistry::Shared().stoppedAt.load()) + L" ms after the stop began");
      ModalRegistry::Shared().threads--;
    }).detach();
    return true;
  } catch (...) {
    ModalRegistry::Shared().threads--;
    return false;
  }
}

}
