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
  CHECK(ReasonsOf(everything) == (1u << 8) - 1);
  CHECK(kReasonCount == 9);
  CHECK(kStandInLent == 1u << 5 && kVeilUp == 1u << 7 && kStandInShowing == 1u << 8);

  View showing;
  showing.standInLent = true;
  showing.standInShowing = true;
  CHECK(ReasonsOf(showing) == kStandInShowing);
  CHECK((ReasonsOf(showing) & kBlockingReasons) == 0);

  View covered = showing;
  covered.awaitingFrame = true;
  covered.pageHidden = true;
  covered.pageDetached = true;
  CHECK(ReasonsOf(covered) == kStandInShowing);

  View leaving = showing;
  leaving.standInLeaving = true;
  CHECK(ReasonsOf(leaving) == (kStandInLent | kStandInLeaving));
  View blankHolder = showing;
  blankHolder.alphaZero = true;
  CHECK(ReasonsOf(blankHolder) == (kAlphaZero | kStandInShowing));
  View veiled = showing;
  veiled.veilUp = true;
  CHECK(ReasonsOf(veiled) == (kVeilUp | kStandInShowing));
  CHECK((ReasonsOf(veiled) & kBlockingReasons) == kVeilUp);

  View notShown;
  notShown.standInLent = true;
  CHECK(ReasonsOf(notShown) == kStandInLent);
  View lender;
  lender.standInLent = true;
  lender.pageDetached = true;
  CHECK(ReasonsOf(lender) == (kStandInLent | kPageDetached));

  View stray;
  stray.standInShowing = true;
  CHECK(ReasonsOf(stray) == 0);

  Tally painted;
  painted.Add(0);
  painted.Add(0);
  CHECK(painted.views == 2 && painted.unpainted == 0 && painted.reasons == 0 && painted.heldMs == 0);

  Tally mixed;
  mixed.Add(0);
  mixed.Add(kFrameHoldAwaiting);
  mixed.Add(kVeilUp | kAlphaZero);
  CHECK(mixed.views == 3 && mixed.unpainted == 2);
  CHECK(mixed.reasons == (kFrameHoldAwaiting | kVeilUp | kAlphaZero));

  Tally onlyShowing;
  onlyShowing.Add(0);
  onlyShowing.Add(kStandInShowing, 120);
  CHECK(onlyShowing.views == 2 && onlyShowing.unpainted == 0 && onlyShowing.reasons == kStandInShowing);
  Episode quiet;
  CHECK(!quiet.ShouldSend(onlyShowing));

  Tally withShowing;
  withShowing.Add(kStandInShowing);
  withShowing.Add(kAlphaZero | kFrameHoldAwaiting);
  CHECK(withShowing.unpainted == 1 && withShowing.reasons == (kStandInShowing | kAlphaZero | kFrameHoldAwaiting));

  Tally held;
  held.Add(kFrameHoldAwaiting, 340);
  held.Add(kStandInLent, 1200);
  held.Add(kStandInShowing, 90);
  held.Add(0, 9000);
  held.Add(kVeilUp);
  CHECK(held.views == 5 && held.unpainted == 3 && held.heldMs == 1200);

  CHECK(HeldMs(10.0, 0) == 0);
  CHECK(HeldMs(10.0, 10.0) == 0);
  CHECK(HeldMs(10.0, 11.0) == 0);
  CHECK(HeldMs(10.25, 10.0) == 250);
  CHECK(HeldMs(10.3504, 10.0) == 350);
  CHECK(HeldMs(1e9, 10.0) == kMaxHeldMs);
  CHECK(EarliestHold(0, 0) == 0);
  CHECK(EarliestHold(0, 7) == 7);
  CHECK(EarliestHold(7, 0) == 7);
  CHECK(EarliestHold(9, 7) == 7);

  Episode episode;
  CHECK(!episode.ShouldSend(painted));
  CHECK(episode.ShouldSend(mixed));
  CHECK(!episode.ShouldSend(mixed));
  CHECK(!episode.ShouldSend(mixed));
  CHECK(!episode.ShouldSend(painted));
  CHECK(episode.ShouldSend(mixed));

  Tally none;
  CHECK(!Episode{}.ShouldSend(none));

  Tally stillBlank;
  stillBlank.Add(0);
  stillBlank.Add(kAlphaZero | kFrameHoldAwaiting, 2400);
  CHECK(stillBlank.unpainted == 1 && stillBlank.reasons == (kAlphaZero | kFrameHoldAwaiting) && stillBlank.heldMs == 2400);
  Tally cleared;
  cleared.Add(0);
  cleared.Add(0);
  CHECK(cleared.unpainted == 0 && cleared.reasons == 0);

  const StackPath chromium{{0, 2}, {0, 0}};
  const StackPath webkitAfter{{0, 2}, {0, 1}};
  const StackPath webkitBefore{{0, 1}, {0, 5}};
  const StackPath webkitRaised{{3, 1}, {0, 0}};
  const StackPath webkitHere{{0, 2}, {0, 0}};
  CHECK(DrawnAbove(webkitAfter, chromium));
  CHECK(!DrawnAbove(chromium, webkitAfter));
  CHECK(!DrawnAbove(webkitBefore, chromium));
  CHECK(DrawnAbove(chromium, webkitBefore));
  CHECK(DrawnAbove(webkitRaised, chromium));
  CHECK(!DrawnAbove(chromium, webkitRaised));
  CHECK(!DrawnAbove(webkitHere, chromium));
  CHECK(!DrawnAbove(StackPath{}, chromium));
  CHECK(!DrawnAbove(StackPath{{0, 2}}, chromium));

  CHECK(EarliestHold(0, 0, 0) == 0);
  CHECK(EarliestHold(0, 0, 4) == 4);
  CHECK(EarliestHold(5, 0, 4) == 4);
  CHECK(EarliestHold(3, 7, 4) == 3);

  CHECK(Invisible(true, 1, 1));
  CHECK(Invisible(false, 0, 1));
  CHECK(Invisible(false, 1, 0));
  CHECK(!Invisible(false, 1, 1));
  CHECK(!Invisible(false, 0.5, 0.5));

  StandInLayer coveringLayer{true, false, 1, true, true};
  CHECK(StandInShows(coveringLayer));
  StandInLayer tuckedUnder{true, false, 1, false, true};
  CHECK(!StandInShows(tuckedUnder));
  StandInLayer pageGone{true, false, 1, false, false};
  CHECK(StandInShows(pageGone));
  StandInLayer transparentLayer{true, false, 0, true, true};
  CHECK(!StandInShows(transparentLayer));
  StandInLayer hiddenLayer{true, true, 1, true, true};
  CHECK(!StandInShows(hiddenLayer));
  CHECK(!StandInShows(StandInLayer{}));

  View tucked;
  tucked.standInLent = true;
  tucked.awaitingFrame = true;
  tucked.standInShowing = StandInShows(tuckedUnder);
  CHECK(ReasonsOf(tucked) == (kStandInLent | kFrameHoldAwaiting));
  CHECK((ReasonsOf(tucked) & kBlockingReasons) != 0);
  Tally tuckedTally;
  tuckedTally.Add(ReasonsOf(tucked));
  CHECK(tuckedTally.unpainted == 1);

  FollowUp followUp;
  const unsigned long first = followUp.Hold();
  CHECK(followUp.pending);
  CHECK(followUp.Take(first));
  CHECK(!followUp.Take(first));
  const unsigned long interrupted = followUp.Hold();
  Episode stillBlankEpisode;
  CHECK(stillBlankEpisode.ShouldSend(stillBlank));
  CHECK(!stillBlankEpisode.ShouldSend(stillBlank));
  CHECK(followUp.Take(interrupted));
  const unsigned long replaced = followUp.Hold();
  const unsigned long newer = followUp.Hold();
  CHECK(!followUp.Take(replaced));
  CHECK(followUp.Take(newer));
  const unsigned long closed = followUp.Hold();
  followUp.Drop();
  CHECK(!followUp.Take(closed));

  Tally cleanFollowUp;
  cleanFollowUp.Add(0);
  Episode settled;
  CHECK(settled.ShouldSend(stillBlank));
  settled.Settle(cleanFollowUp);
  CHECK(settled.ShouldSend(stillBlank));
  Episode stillOpen;
  CHECK(stillOpen.ShouldSend(stillBlank));
  stillOpen.Settle(stillBlank);
  CHECK(!stillOpen.ShouldSend(stillBlank));
  Episode resetByPaint;
  CHECK(resetByPaint.ShouldSend(stillBlank));
  CHECK(!resetByPaint.ShouldSend(cleared));
  resetByPaint.Settle(stillBlank);
  CHECK(resetByPaint.ShouldSend(stillBlank));

  if (failures) return 1;
  std::printf("paint-probe: ok\n");
  return 0;
}
