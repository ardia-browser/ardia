#include "../ios/ArdiaPageMetricsMath.h"

#include <cstdio>
#include <limits>

using namespace ardia_page_metrics;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

static Batch Good(double generation) {
  Batch b;
  b.generation = generation;
  for (int i = 0; i < kMediaErrorKinds; i++) b.errors[i] = i;
  b.frames = 600;
  b.dropped = 12;
  b.scrolls = 2;
  b.scrollFrames = 67;
  b.scrollMs = 535;
  return b;
}

static bool Untouched(const Counts &c) {
  if (c.accepted) return false;
  for (int i = 0; i < kMediaErrorKinds; i++)
    if (c.errors[i] != 0) return false;
  return c.frames == 0 && c.dropped == 0 && c.scrolls == 0 && c.scrollFrames == 0 && c.scrollMs == 0;
}

int main() {
  const double inf = std::numeric_limits<double>::infinity();
  const double nan = std::numeric_limits<double>::quiet_NaN();

  Counts good = Accept(true, 7, Good(7));
  CHECK(good.accepted);
  CHECK(good.errors[4] == 4);
  CHECK(good.frames == 600 && good.dropped == 12);
  CHECK(good.scrolls == 2 && good.scrollFrames == 67 && good.scrollMs == 535);

  CHECK(Untouched(Accept(false, 7, Good(7))));
  CHECK(Untouched(Accept(true, 7, Good(6))));
  CHECK(Untouched(Accept(true, 7, Good(8))));
  CHECK(Untouched(Accept(true, 0, Good(0))));
  CHECK(Untouched(Accept(true, 7, Good(nan))));
  CHECK(Untouched(Accept(true, 7, Good(inf))));
  CHECK(Untouched(Accept(true, 7, Good(7.5))));
  CHECK(Untouched(Accept(true, 7, Good(-7))));
  CHECK(Untouched(Accept(true, 7, Batch{})));

  for (double hostile : {nan, inf, -inf, -1.0, -0.0, 1e300, std::numeric_limits<double>::denorm_min()}) {
    Batch b = Good(3);
    for (int i = 0; i < kMediaErrorKinds; i++) b.errors[i] = hostile;
    b.frames = hostile;
    b.dropped = hostile;
    b.scrolls = hostile;
    b.scrollFrames = hostile;
    b.scrollMs = hostile;
    Counts c = Accept(true, 3, b);
    CHECK(c.accepted);
    for (int i = 0; i < kMediaErrorKinds; i++) CHECK(c.errors[i] >= 0 && c.errors[i] <= kMostPerMessage && c.errors[i] == std::floor(c.errors[i]));
    CHECK(c.frames >= 0 && c.frames <= kMostPerMessage);
    CHECK(c.dropped <= c.frames);
    CHECK(c.scrollFrames <= kMostPerMessage && c.scrollMs <= kMostPerMessage);
  }

  Batch more = Good(3);
  more.dropped = 900;
  more.frames = 10;
  CHECK(Accept(true, 3, more).dropped == 10);

  Batch noScrollTime = Good(3);
  noScrollTime.scrollMs = 0;
  Counts noTime = Accept(true, 3, noScrollTime);
  CHECK(noTime.scrolls == 0 && noTime.scrollFrames == 0);

  CHECK(NextGeneration(0) == 1);
  CHECK(NextGeneration(41) == 42);
  CHECK(NextGeneration(kMostGeneration) == 1);

  if (failures) return 1;
  std::printf("page metrics: all checks passed\n");
  return 0;
}
