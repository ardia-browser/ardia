#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <thread>
#include "Events.h"

namespace Ardia {

class FrameClock {
 public:
  explicit FrameClock(winrt::Microsoft::ReactNative::ReactContext context) {
    m_timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    if (!m_timer) m_timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);
    m_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    m_wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!m_timer || !m_stop || !m_wake) { m_failed = true; return; }
    try { m_worker = std::thread([this, context = std::move(context)]() noexcept {
      try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        Run(context);
        winrt::uninit_apartment();
      } catch (...) {
        Fail(context);
      }
    }); } catch (...) {
      for (HANDLE handle : {m_timer, m_stop, m_wake}) if (handle) CloseHandle(handle);
      m_timer = m_stop = m_wake = nullptr;
      m_failed = true;
    }
  }

  ~FrameClock() { Close(); }

  bool Request(double generation) noexcept {
    std::lock_guard lock(m_mutex);
    if (m_closed || m_failed || !std::isfinite(generation) || generation <= 0) return false;
    m_generation = generation;
    m_pending = true;
    SetEvent(m_wake);
    return true;
  }

  void Cancel(double generation) noexcept {
    std::lock_guard lock(m_mutex);
    if (m_closed || m_failed || !m_pending || m_generation != generation) return;
    m_pending = false;
    SetEvent(m_wake);
  }

  void Close() noexcept {
    {
      std::lock_guard lock(m_mutex);
      if (m_closed) return;
      m_closed = true;
      m_pending = false;
      if (m_stop) SetEvent(m_stop);
    }
    if (m_worker.joinable()) m_worker.join();
    for (HANDLE handle : {m_timer, m_stop, m_wake}) if (handle) CloseHandle(handle);
  }

 private:
  void Emit(winrt::Microsoft::ReactNative::ReactContext const &context, double generation, bool failed) noexcept {
    winrt::Microsoft::ReactNative::JSValueObject event;
    event["generation"] = generation;
    event["failed"] = failed;
    EmitEvent(context, L"ArdiaFrameClock", L"frame", std::move(event));
  }

  void Fail(winrt::Microsoft::ReactNative::ReactContext const &context) noexcept {
    double generation = 0;
    bool pending = false;
    {
      std::lock_guard lock(m_mutex);
      m_failed = true;
      pending = m_pending && !m_closed;
      generation = m_generation;
      m_pending = false;
    }
    if (pending) Emit(context, generation, true);
  }

  void Run(winrt::Microsoft::ReactNative::ReactContext const &context) noexcept {
    using Clock = std::chrono::steady_clock;
    const auto period = std::chrono::nanoseconds(16'666'667);
    auto deadline = Clock::time_point{};
    auto last = Clock::time_point{};
    HANDLE handles[]{m_stop, m_wake, m_timer};
    for (;;) {
      double generation = 0;
      bool pending = false;
      {
        std::lock_guard lock(m_mutex);
        if (m_closed) return;
        pending = m_pending;
        generation = m_generation;
      }
      if (!pending) {
        CancelWaitableTimer(m_timer);
        DWORD result = WaitForMultipleObjects(2, handles, FALSE, INFINITE);
        if (result == WAIT_OBJECT_0) return;
        if (result != WAIT_OBJECT_0 + 1) { Fail(context); return; }
        continue;
      }
      auto now = Clock::now();
      if (last == Clock::time_point{} || now - last > period * 3) deadline = now + period;
      else if (deadline <= now) deadline += period * ((now - deadline) / period + 1);
      LARGE_INTEGER due{};
      due.QuadPart = -(std::max)(int64_t{1}, std::chrono::duration_cast<std::chrono::nanoseconds>(deadline - now).count() / 100);
      if (!SetWaitableTimer(m_timer, &due, 0, nullptr, nullptr, FALSE)) { Fail(context); return; }
      DWORD result = WaitForMultipleObjects(3, handles, FALSE, INFINITE);
      if (result == WAIT_OBJECT_0) return;
      if (result == WAIT_FAILED) { Fail(context); return; }
      if (result != WAIT_OBJECT_0 + 2) continue;
      bool emit = false;
      {
        std::lock_guard lock(m_mutex);
        emit = !m_closed && m_pending && m_generation == generation;
        if (emit) m_pending = false;
      }
      if (emit) {
        last = Clock::now();
        deadline += period;
        Emit(context, generation, false);
      }
    }
  }

  std::mutex m_mutex;
  std::thread m_worker;
  HANDLE m_timer{nullptr};
  HANDLE m_stop{nullptr};
  HANDLE m_wake{nullptr};
  bool m_closed{false};
  bool m_failed{false};
  bool m_pending{false};
  double m_generation{0};
};

REACT_MODULE(FrameClockModule, L"ArdiaFrameClock")
struct FrameClockModule {
  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &context) noexcept {
    try { m_clock = std::make_unique<FrameClock>(context); } catch (...) { m_clock.reset(); }
  }

  REACT_SYNC_METHOD(requestFrame)
  bool requestFrame(double generation) noexcept { return m_clock && m_clock->Request(generation); }

  REACT_SYNC_METHOD(cancelFrame)
  bool cancelFrame(double generation) noexcept { if (m_clock) m_clock->Cancel(generation); return m_clock != nullptr; }

  std::unique_ptr<FrameClock> m_clock;
};

}
