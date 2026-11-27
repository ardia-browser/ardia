#include "../ios/ArdiaAutoPictureInPictureHold.h"

#include <cstdio>

using ardia_auto_pip::Hold;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

int main() {
  {
    Hold hold;
    CHECK(hold.tellsChrome(false));
    CHECK(hold.tellsChrome(true));
  }
  {
    Hold hold;
    CHECK(hold.ended(false, false));
    CHECK(hold.held);
    CHECK(!hold.tellsChrome(false));
    CHECK(!hold.tellsChrome(false));
    CHECK(hold.tellsChrome(true));
    CHECK(!hold.held);
    CHECK(hold.tellsChrome(false));
  }
  {
    Hold hold;
    CHECK(!hold.ended(true, false));
    CHECK(!hold.held);
    CHECK(hold.tellsChrome(false));
  }
  {
    Hold hold;
    CHECK(!hold.ended(false, true));
    CHECK(!hold.held);
    CHECK(hold.tellsChrome(false));
  }
  {
    Hold hold;
    CHECK(hold.ended(false, false));
    CHECK(!hold.ended(false, false));
    CHECK(!hold.ended(true, false));
    CHECK(hold.held);
    CHECK(hold.tellsChrome(true));
  }
  if (failures) return 1;
  std::printf("auto-pip-hold: ok\n");
  return 0;
}
