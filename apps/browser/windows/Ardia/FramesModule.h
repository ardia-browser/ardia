#pragma once

#include <dwmapi.h>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>

#include "NativeModules.h"

#include "Events.h"

#pragma comment(lib, "dwmapi.lib")

namespace Ardia {

namespace FramesParts {

constexpr wchar_t ModuleName[] = L"ArdiaFrames";
constexpr wchar_t FrameEvent[] = L"onFrame";

using WaitForCompositorClock = DWORD(WINAPI *)(UINT count, HANDLE const *handles, DWORD timeoutMs);

inline double TicksToMilliseconds(LONGLONG ticks) noexcept {
  static const double perTick = [] {
    LARGE_INTEGER frequency{};
    QueryPerformanceFrequency(&frequency);
    return frequency.QuadPart > 0 ? 1000.0 / static_cast<double>(frequency.QuadPart) : 0.0;
  }();
  return static_cast<double>(ticks) * perTick;
}

inline double NowMilliseconds() noexcept {
  LARGE_INTEGER counter{};
  QueryPerformanceCounter(&counter);
  return TicksToMilliseconds(counter.QuadPart);
}

inline WaitForCompositorClock CompositorClock() noexcept {
  static const WaitForCompositorClock wait = [] {
    HMODULE dcomp = LoadLibraryExW(L"dcomp.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    return dcomp ? reinterpret_cast<WaitForCompositorClock>(GetProcAddress(dcomp, "DCompositionWaitForCompositorClock")) : nullptr;
  }();
  return wait;
}

inline double RefreshPeriodMilliseconds() noexcept {
  DWM_TIMING_INFO timing{};
  timing.cbSize = sizeof(timing);
  if (FAILED(DwmGetCompositionTimingInfo(nullptr, &timing)) || timing.qpcRefreshPeriod == 0) return 0;
  return TicksToMilliseconds(static_cast<LONGLONG>(timing.qpcRefreshPeriod));
}

class FrameClock {
 public:
  FrameClock() noexcept : m_stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)} {}

  ~FrameClock() noexcept {
    Shutdown();
    if (m_stop) CloseHandle(m_stop);
  }

  void Attach(winrt::Microsoft::ReactNative::ReactContext const &context) noexcept {
    std::scoped_lock lock{m_mutex};
    m_context = context;
  }

  void Request() noexcept {
    {
      std::scoped_lock lock{m_mutex};
      if (m_stopping) return;
      m_requested = true;
      if (m_thread.joinable() && !m_running) {
        try {
          m_thread.join();
        } catch (...) {
          m_requested = false;
          return;
        }
      }
      if (!m_thread.joinable()) {
        try {
          m_running = true;
          m_thread = std::thread([this]() noexcept { Loop(); });
        } catch (...) {
          m_running = false;
          m_requested = false;
          return;
        }
      }
    }
    m_wake.notify_all();
  }

  void Shutdown() noexcept {
    {
      std::scoped_lock lock{m_mutex};
      m_stopping = true;
      m_requested = false;
    }
    if (m_stop) SetEvent(m_stop);
    m_wake.notify_all();
    if (m_thread.joinable()) {
      try {
        m_thread.join();
      } catch (...) {
      }
    }
  }

 private:
  void Loop() noexcept {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
    struct Exit {
      FrameClock *clock;
      ~Exit() {
        std::scoped_lock lock{clock->m_mutex};
        clock->m_running = false;
        clock->m_requested = false;
      }
    } exit{this};
    try {
      for (;;) {
        {
          std::unique_lock lock{m_mutex};
          m_wake.wait(lock, [this] { return m_stopping || m_requested; });
          if (m_stopping) return;
        }
        if (!WaitForTick()) return;
        double time = NowMilliseconds();
        winrt::Microsoft::ReactNative::ReactContext context{nullptr};
        {
          std::scoped_lock lock{m_mutex};
          if (m_stopping) return;
          if (!m_requested) continue;
          m_requested = false;
          context = m_context;
        }
        Send(context, time);
      }
    } catch (...) {
    }
  }

  bool WaitForTick() noexcept {
    if (WaitForCompositorClock wait = CompositorClock()) {
      DWORD woke = m_stop ? wait(1, &m_stop, INFINITE) : wait(0, nullptr, INFINITE);
      if (m_stop && woke == WAIT_OBJECT_0) return false;
      if (woke == (m_stop ? WAIT_OBJECT_0 + 1 : WAIT_OBJECT_0)) return !Stopping();
    }
    if (SUCCEEDED(DwmFlush())) return !Stopping();
    double period = RefreshPeriodMilliseconds();
    DWORD waitMs = period > 0 ? static_cast<DWORD>(period + 0.5) : 16;
    if (!m_stop) {
      Sleep(waitMs);
      return !Stopping();
    }
    return WaitForSingleObject(m_stop, waitMs) == WAIT_TIMEOUT;
  }

  bool Stopping() noexcept {
    std::scoped_lock lock{m_mutex};
    return m_stopping;
  }

  void Send(winrt::Microsoft::ReactNative::ReactContext const &context, double time) noexcept {
    if (!context) return;
    winrt::Microsoft::ReactNative::JSValueObject payload;
    payload["time"] = winrt::Microsoft::ReactNative::JSValue{time};
    payload["interval"] = winrt::Microsoft::ReactNative::JSValue{RefreshPeriodMilliseconds()};
    EmitEvent(context, ModuleName, FrameEvent, std::move(payload));
  }

  HANDLE m_stop = nullptr;
  std::mutex m_mutex;
  std::condition_variable m_wake;
  winrt::Microsoft::ReactNative::ReactContext m_context{nullptr};
  bool m_requested = false;
  bool m_stopping = false;
  bool m_running = false;
  std::thread m_thread;
};

}

REACT_MODULE(FramesModule, L"ArdiaFrames")
struct FramesModule {
  FramesModule() noexcept = default;
  FramesModule(FramesModule const &) = delete;
  FramesModule &operator=(FramesModule const &) = delete;

  ~FramesModule() noexcept {
    if (m_clock) m_clock->Shutdown();
  }

  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &context) noexcept {
    try {
      if (!m_clock) m_clock = std::make_unique<FramesParts::FrameClock>();
    } catch (...) {
      return;
    }
    m_clock->Attach(context);
  }

  REACT_METHOD(requestFrame)
  void requestFrame() noexcept {
    if (m_clock) m_clock->Request();
  }

  REACT_SYNC_METHOD(now)
  double now() noexcept {
    return FramesParts::NowMilliseconds();
  }

 private:
  std::unique_ptr<FramesParts::FrameClock> m_clock;
};

}
