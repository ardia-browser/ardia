#include "../ios/ArdiaPiPSeekMath.h"

#include <cstdio>
#include <cstdlib>
#include <initializer_list>

using namespace ardia_pip_seek;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

int main() {
  CHECK(SkipSecondsAt(10, 480) == -10);
  CHECK(SkipSecondsAt(470, 480) == 10);
  CHECK(SkipSecondsAt(240, 480) == 0);

  CHECK(SkipSecondsAt(200, 480) == 0 && SkipSecondsAt(280, 480) == 0);
  CHECK(SkipSecondsAt(199.5, 480) == -10 && SkipSecondsAt(280.5, 480) == 10);

  CHECK(SkipSecondsAt(240 - 76, 480) == -10 && SkipSecondsAt(240 + 76, 480) == 10);
  CHECK(SkipSecondsAt(240 - 56, 480) == -10 && SkipSecondsAt(240 + 56, 480) == 10);

  CHECK(SkipSecondsAt(101.9, 284) == -10 && SkipSecondsAt(102, 284) == 0);
  CHECK(SkipSecondsAt(182, 284) == 0 && SkipSecondsAt(182.1, 284) == 10);
  CHECK(SkipSecondsAt(0, 284) == -10 && SkipSecondsAt(284, 284) == 10);

  CHECK(SkipSecondsAt(-1, 284) == 0 && SkipSecondsAt(285, 284) == 0);
  CHECK(SkipSecondsAt(0, 0) == 0 && SkipSecondsAt(40, 80) == 0 && SkipSecondsAt(0, 80) == 0);

  for (double w : {284.0, 400.0, 853.0, 1209.0})
    for (double x = 0; x <= w; x += 0.25) CHECK(SkipSecondsAt(x, w) == -SkipSecondsAt(w - x, w));

  CHECK(IsClick(0) && IsClick(2.99) && !IsClick(3));
  CHECK(IsClick(Travel(2, 2)) && !IsClick(Travel(3, 0)) && !IsClick(Travel(0, -3)) && !IsClick(Travel(2.2, 2.2)));

  if (failures) return std::printf("%d failed\n", failures), 1;
  std::printf("pip-seek: all passed\n");
  return 0;
}
