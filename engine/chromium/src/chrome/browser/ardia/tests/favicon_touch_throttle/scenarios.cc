#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <utility>

#include "chrome/browser/ardia/ac_favicon_touch_throttle.h"

namespace {

using Clock = std::chrono::steady_clock;
using Key = std::pair<std::string, std::string>;
using Throttle = ardia::FaviconTouchThrottle<Key, Clock::time_point, Clock::duration>;

constexpr Clock::duration kDay = std::chrono::hours(24);
constexpr size_t kCap = 2048;

int failures = 0;

void Expect(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}

Key Icon(int n) {
  return {"/profile/Default", "https://site" + std::to_string(n) + ".example/favicon.ico"};
}

void ActiveEntriesStayThrottled() {
  Throttle throttle(kDay, kCap);
  const Clock::time_point start{};
  Expect(throttle.ShouldTouch(Icon(1), start), "first use touches");
  Expect(!throttle.ShouldTouch(Icon(1), start), "same instant is throttled");
  Expect(!throttle.ShouldTouch(Icon(1), start + std::chrono::hours(12)), "half a day later is throttled");
  Expect(!throttle.ShouldTouch(Icon(1), start + kDay - std::chrono::nanoseconds(1)), "just under a day is throttled");
  Expect(throttle.ShouldTouch(Icon(1), start + kDay), "exactly a day later touches again");
  Expect(!throttle.ShouldTouch(Icon(1), start + kDay + std::chrono::hours(1)), "re-touch restarts the day");
  Expect(throttle.ShouldTouch(Icon(1), start + 2 * kDay), "a day after the re-touch touches again");
  Expect(throttle.size() == 1, "one icon holds one entry");
  Key other_profile{"/profile/Work", Icon(1).second};
  Expect(throttle.ShouldTouch(other_profile, start + 2 * kDay), "another profile is tracked apart");
}

void ExpiredEntriesAreEvictedAndRetouched() {
  Throttle throttle(kDay, kCap);
  const Clock::time_point start{};
  for (int i = 0; i < 100; ++i) {
    Expect(throttle.ShouldTouch(Icon(i), start + std::chrono::seconds(i)), "first use of each icon touches");
  }
  Expect(throttle.size() == 100, "all hundred are held");
  const Clock::time_point later = start + kDay + std::chrono::seconds(50);
  Expect(throttle.ShouldTouch(Icon(1000), later), "new icon a day later touches");
  Expect(throttle.size() == 50, "the fifty icons a day old are pruned");
  for (int i = 0; i <= 50; ++i) {
    Expect(!throttle.Holds(Icon(i)), "a day-old icon is gone");
  }
  for (int i = 51; i < 100; ++i) {
    Expect(throttle.Holds(Icon(i)), "a younger icon is kept");
  }
  Expect(throttle.ShouldTouch(Icon(10), later), "a pruned icon is touched again");
  Expect(!throttle.ShouldTouch(Icon(60), later), "a kept icon stays throttled");
  Expect(throttle.ShouldTouch(Icon(60), start + kDay + std::chrono::seconds(60)), "a kept icon touches once its day is up");
  Expect(throttle.ShouldTouch(Icon(5000), start + 10 * kDay), "a much later use touches");
  Expect(throttle.size() == 1, "everything older than a day is gone after a long gap");
}

void TenThousandIconsInADayStayBounded() {
  Throttle throttle(kDay, kCap);
  const Clock::time_point start{};
  constexpr int kIcons = 10000;
  for (int i = 0; i < kIcons; ++i) {
    Expect(throttle.ShouldTouch(Icon(i), start + std::chrono::seconds(i)), "each distinct icon touches");
    if (throttle.size() > kCap) {
      Expect(false, "size never passes the cap");
      break;
    }
  }
  Expect(throttle.size() == kCap, "ten thousand icons in under a day settle at the cap");
  for (int i = 0; i < kIcons - static_cast<int>(kCap); ++i) {
    if (throttle.Holds(Icon(i))) {
      Expect(false, "the oldest icons are evicted");
      break;
    }
  }
  for (int i = kIcons - static_cast<int>(kCap); i < kIcons; ++i) {
    if (!throttle.Holds(Icon(i))) {
      Expect(false, "the newest icons are kept");
      break;
    }
  }
  const Clock::time_point now = start + std::chrono::seconds(kIcons);
  Expect(!throttle.ShouldTouch(Icon(kIcons - 1), now), "the newest icon stays throttled");
  Expect(throttle.ShouldTouch(Icon(0), now), "an evicted icon touches again");
  Expect(throttle.size() == kCap, "re-adding an evicted icon keeps the cap");
  Expect(!throttle.Holds(Icon(kIcons - static_cast<int>(kCap))), "re-adding evicts the oldest kept icon");
}

void HotIconSurvivesColdChurn() {
  Throttle throttle(kDay, kCap);
  const Clock::time_point start{};
  const Key hot{"/profile/Default", "https://hot.example/favicon.ico"};
  Expect(throttle.ShouldTouch(hot, start), "the hot icon touches first");
  constexpr int kCold = 3 * static_cast<int>(kCap);
  for (int i = 0; i < kCold; ++i) {
    const Clock::time_point now = start + std::chrono::seconds(i + 1);
    if (throttle.ShouldTouch(hot, now)) {
      Expect(false, "the hot icon stays throttled through cold churn");
      break;
    }
    Expect(throttle.ShouldTouch(Icon(i), now), "each cold icon touches");
    if (throttle.size() > kCap) {
      Expect(false, "cold churn never passes the cap");
      break;
    }
  }
  Expect(throttle.Holds(hot), "the hot icon is still held");
  Expect(throttle.size() == kCap, "cold churn settles at the cap");
  Expect(!throttle.Holds(Icon(0)), "the first cold icon is evicted");
  Expect(throttle.Holds(Icon(kCold - 1)), "the newest cold icon is kept");
  Expect(throttle.ShouldTouch(hot, start + kDay), "the hot icon still touches once its day is up");
}

void BackwardClockKeepsEachEntrysOwnDay() {
  Throttle throttle(kDay, 3);
  const Clock::time_point start = Clock::time_point{} + kDay;
  const Clock::time_point earlier = start - std::chrono::hours(1);
  Expect(throttle.ShouldTouch(Icon(1), start), "first touches");
  Expect(throttle.ShouldTouch(Icon(2), earlier), "an earlier reading still touches a new icon");
  Expect(!throttle.ShouldTouch(Icon(1), start - std::chrono::hours(2)), "an earlier reading never re-touches");
  Expect(!throttle.ShouldTouch(Icon(2), earlier + kDay - std::chrono::nanoseconds(1)), "the backward entry is throttled until its own day is up");
  Expect(throttle.ShouldTouch(Icon(2), earlier + kDay), "the backward entry touches exactly a day after its own reading");
  Expect(throttle.Holds(Icon(1)), "the later entry is not dropped early");
  Expect(!throttle.ShouldTouch(Icon(1), start + kDay - std::chrono::nanoseconds(1)), "the later entry keeps its own day");
  Expect(throttle.ShouldTouch(Icon(1), start + kDay), "the later entry touches at its own day");
}

void LeastRecentlyUsedIsEvictedFirst() {
  Throttle throttle(kDay, 3);
  const Clock::time_point start{};
  Expect(throttle.ShouldTouch(Icon(1), start), "first touches");
  Expect(throttle.ShouldTouch(Icon(2), start), "second touches");
  Expect(throttle.ShouldTouch(Icon(3), start), "third touches");
  Expect(!throttle.ShouldTouch(Icon(1), start + std::chrono::seconds(1)), "a throttled use of the first");
  Expect(throttle.ShouldTouch(Icon(4), start + std::chrono::seconds(2)), "fourth touches past the cap");
  Expect(throttle.Holds(Icon(1)) && !throttle.Holds(Icon(2)), "the least recently used icon is evicted, not the oldest touch");
  Expect(throttle.size() == 3, "cap of three holds");
}

void ExtremeClockReadingsDoNotOverflow() {
  Throttle throttle(kDay, 4);
  const Clock::time_point lowest = Clock::time_point::min();
  const Clock::time_point highest = Clock::time_point::max();
  Expect(throttle.ShouldTouch(Icon(1), lowest), "the lowest reading touches");
  Expect(!throttle.ShouldTouch(Icon(1), lowest + kDay - std::chrono::nanoseconds(1)), "just under a day after the lowest is throttled");
  Expect(throttle.ShouldTouch(Icon(2), highest), "the highest reading touches and drops the lowest");
  Expect(!throttle.Holds(Icon(1)), "the lowest entry expired across the epoch");
  Expect(!throttle.ShouldTouch(Icon(2), lowest), "a reading far behind never re-touches");
  Expect(throttle.ShouldTouch(Icon(3), Clock::time_point{} - std::chrono::hours(1)), "a reading just before the epoch touches");
  Expect(!throttle.ShouldTouch(Icon(3), Clock::time_point{} + kDay - std::chrono::hours(1) - std::chrono::nanoseconds(1)), "throttled across the epoch until its day is up");
  Expect(throttle.ShouldTouch(Icon(3), Clock::time_point{} + kDay - std::chrono::hours(1)), "touches across the epoch at its day");
}

void ZeroCapStillBounded() {
  Throttle throttle(kDay, 0);
  Expect(throttle.ShouldTouch(Icon(1), Clock::time_point{}), "touches with a zero cap");
  Expect(throttle.ShouldTouch(Icon(2), Clock::time_point{}), "second touches with a zero cap");
  Expect(throttle.size() == 1, "a zero cap holds one entry");
}

}

int main() {
  ActiveEntriesStayThrottled();
  ExpiredEntriesAreEvictedAndRetouched();
  TenThousandIconsInADayStayBounded();
  HotIconSurvivesColdChurn();
  BackwardClockKeepsEachEntrysOwnDay();
  LeastRecentlyUsedIsEvictedFirst();
  ExtremeClockReadingsDoNotOverflow();
  ZeroCapStillBounded();
  if (failures) {
    std::printf("%d failures\n", failures);
    return EXIT_FAILURE;
  }
  std::printf("favicon touch throttle scenarios passed\n");
  return EXIT_SUCCESS;
}
