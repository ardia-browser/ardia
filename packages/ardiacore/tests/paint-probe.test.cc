#include "../ios/ArdiaPaintProbeMath.h"

#include <cstdio>

using namespace ardia_paint_probe;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

int main() {
  CHECK(ReasonsOf(View{}) == 0);

  View alpha;
  alpha.alphaZero = true;
  CHECK(ReasonsOf(alpha) == kAlphaZero);

  View lent;
  lent.standInLent = true;
  lent.standInLeaving = true;
  CHECK(ReasonsOf(lent) == (kStandInLent | kStandInLeaving));

  View everything{true, true, true, true, true, true, true, true};
  CHECK(ReasonsOf(everything) == (1u << kReasonCount) - 1);

  Tally painted;
  painted.Add(0);
  painted.Add(0);
  CHECK(painted.views == 2 && painted.unpainted == 0 && painted.reasons == 0);

  Tally mixed;
  mixed.Add(0);
  mixed.Add(kFrameHoldAwaiting);
  mixed.Add(kVeilUp | kAlphaZero);
  CHECK(mixed.views == 3 && mixed.unpainted == 2);
  CHECK(mixed.reasons == (kFrameHoldAwaiting | kVeilUp | kAlphaZero));

  Episode episode;
  CHECK(!episode.ShouldSend(painted));
  CHECK(episode.ShouldSend(mixed));
  CHECK(!episode.ShouldSend(mixed));
  CHECK(!episode.ShouldSend(mixed));
  CHECK(!episode.ShouldSend(painted));
  CHECK(episode.ShouldSend(mixed));

  Tally none;
  CHECK(!Episode{}.ShouldSend(none));

  if (failures) return 1;
  std::printf("paint-probe: ok\n");
  return 0;
}
