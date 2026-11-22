#include "../ios/ArdiaFreezeArming.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>

using ardia_freeze::FreezeArming;

namespace {

int failures = 0;

void expect(bool ok, const char *what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL %s\n", what);
    failures++;
  } else {
    std::fprintf(stderr, "ok   %s\n", what);
  }
}

struct Timer {
  std::atomic<uint64_t> due{0};
  std::atomic<int> sets{0};
  static void set(void *context, uint64_t due) {
    auto *timer = static_cast<Timer *>(context);
    timer->due = due;
    timer->sets++;
  }
};

struct WakeDuringDisarm;
FreezeArming<WakeDuringDisarm> *gRaced;
std::atomic<bool> gWakeDone{false};
std::atomic<bool> gInjected{false};

struct WakeDuringDisarm {
  static void insideDisarm() {
    if (gInjected.exchange(true)) return;
    std::thread waker([] {
      gRaced->wake(2000, 400, true);
      gWakeDone = true;
    });
    for (int i = 0; i < 200 && !gWakeDone; i++) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    waker.detach();
  }
};

void wakeDuringIdleCancellationKeepsTheWatchdogArmed() {
  Timer timer;
  FreezeArming<WakeDuringDisarm> arming(&Timer::set, &timer);
  gRaced = &arming;
  arming.wake(1000, 400, true);
  arming.sleep();
  for (int i = 0; i < 2000 && !gWakeDone; i++) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  expect(gWakeDone, "the waking loop finished");
  expect(arming.busy() == 1, "one loop is busy after the interleaving");
  expect(arming.deadline() != 0 && timer.due == arming.deadline(), "a loop that woke while idle cancellation ran still has its watchdog armed");
}

void shortStretchesCostNoWakeup() {
  Timer timer;
  FreezeArming<> arming(&Timer::set, &timer);
  arming.wake(1000, 400, true);
  expect(timer.due == 1400, "a wake arms 400 ms ahead");
  arming.sleep();
  expect(arming.deadline() == 0 && timer.due == 0, "sleeping with no capture disarms");
  arming.wake(5000, 400, false);
  expect(arming.deadline() == 0, "an inactive app never arms");
  arming.sleep();
}

void aCaptureKeepsItsDeadline() {
  Timer timer;
  FreezeArming<> arming(&Timer::set, &timer);
  arming.wake(1000, 400, true);
  arming.captureBegan();
  arming.sleep();
  expect(arming.deadline() == 1400, "a capture in progress keeps the deadline when the loops sleep");
  arming.captureEnded();
  arming.disarmIfIdle();
  expect(arming.deadline() == 0, "once the capture ends an idle disarm clears it");
}

void theOtherLoopBusyKeepsTheDeadline() {
  Timer timer;
  FreezeArming<> arming(&Timer::set, &timer);
  arming.wake(1000, 400, true);
  arming.wake(1100, 400, true);
  arming.sleep();
  expect(arming.deadline() == 1400, "one loop sleeping leaves the other's watchdog armed");
  arming.sleep();
  expect(arming.deadline() == 0, "both asleep: disarmed");
}

void stressWakesAndSleeps() {
  Timer timer;
  FreezeArming<> arming(&Timer::set, &timer);
  std::atomic<bool> stop{false};
  std::atomic<int> lost{0};
  auto loop = [&](int self) {
    for (int i = 0; i < 200000; i++) {
      arming.wake(1000 + i, 400, true);
      if (arming.deadline() == 0) lost++;
      arming.sleep();
    }
    (void)self;
  };
  std::thread a(loop, 0), b(loop, 1);
  a.join();
  b.join();
  stop = true;
  expect(lost == 0, "200,000 wakes on each of two threads: no busy loop ever saw its watchdog disarmed");
  expect(arming.busy() == 0 && arming.deadline() == 0, "both asleep at the end: disarmed");
}

}

int main() {
  wakeDuringIdleCancellationKeepsTheWatchdogArmed();
  shortStretchesCostNoWakeup();
  aCaptureKeepsItsDeadline();
  theOtherLoopBusyKeepsTheDeadline();
  stressWakesAndSleeps();
  std::fprintf(stderr, "%s\n", failures ? "FAILED" : "all passed");
  return failures ? 1 : 0;
}
