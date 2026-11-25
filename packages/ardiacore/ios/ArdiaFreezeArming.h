#pragma once

#include <atomic>
#include <cstdint>
#include <os/lock.h>

namespace ardia_freeze {

struct NoArmingHooks {
  static void insideDisarm() {}
};

template <typename Hooks = NoArmingHooks>
class FreezeArming {
 public:
  using SetTimer = void (*)(void *context, uint64_t due);

  FreezeArming(SetTimer setTimer, void *context) : setTimer_(setTimer), context_(context) {}

  void wake(uint64_t now, uint64_t freezeTicks, bool active) {
    busy_++;
    if (!active) return;
    armAt(now + freezeTicks);
  }

  void sleep() {
    if (busy_.fetch_sub(1) == 1) disarmIfIdle();
  }

  void armAt(uint64_t due) {
    os_unfair_lock_lock(&lock_);
    const uint64_t current = deadline_.load();
    if (!current || due < current) {
      deadline_.store(due);
      setTimer_(context_, due);
    }
    os_unfair_lock_unlock(&lock_);
  }

  void fired() {
    os_unfair_lock_lock(&lock_);
    deadline_.store(0);
    os_unfair_lock_unlock(&lock_);
  }

  void disarmIfIdle() {
    os_unfair_lock_lock(&lock_);
    if (deadline_.load() && busy_.load() == 0 && capturing_.load() == 0) {
      Hooks::insideDisarm();
      deadline_.store(0);
      setTimer_(context_, 0);
    }
    os_unfair_lock_unlock(&lock_);
  }

  void captureBegan() { capturing_++; }
  void captureEnded() { capturing_--; }
  uint64_t deadline() const { return deadline_.load(); }
  int busy() const { return busy_.load(); }

 private:
  SetTimer setTimer_;
  void *context_;
  os_unfair_lock lock_ = OS_UNFAIR_LOCK_INIT;
  std::atomic<uint64_t> deadline_{0};
  std::atomic<int> busy_{0};
  std::atomic<int> capturing_{0};
};

}
