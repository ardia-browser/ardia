#include "../ios/ArdiaPiPZoomMath.h"

#include <cmath>
#include <cstdio>
#include <initializer_list>
#include <cstdlib>

using namespace ardia_pip_zoom;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)
static bool Near(double a, double b, double eps = 0.51) { return std::fabs(a - b) <= eps; }

int main() {
  const Rect visible{0, 0, 1512, 945};
  const Size minSize{284, 160}, maxSize{1512 * 0.8, 945 * 0.8};
  const double aspect = 16.0 / 9;

  CHECK(ScrollFactor(10, true) > 1 && ScrollFactor(-10, true) < 1);
  CHECK(Near(ScrollFactor(25, true) * ScrollFactor(-25, true), 1, 1e-12));
  CHECK(Near(ScrollFactor(150, true), 1.82, 0.01));
  CHECK(Near(ScrollFactor(1, false), 1.083, 0.001));
  CHECK(ScrollFactor(0, true) == 1);
  CHECK(MagnifyFactor(0.1) > 1 && MagnifyFactor(-0.1) < 1 && MagnifyFactor(-5) > 0);

  {
    Rect frame{1512 - 16 - 480, 16, 480, 270};
    Result r = Zoom(frame, 480, aspect, 1.25, {1300, 100}, visible, minSize, maxSize);
    CHECK(r.frame.w == 600 && Near(r.frame.h, 337.5));
    CHECK(Near(r.frame.maxX(), 1512 - 16) && r.frame.y == 16);
    CHECK(Near(r.frame.w / r.frame.h, aspect, 0.01));
  }
  {
    Rect frame{20, 945 - 20 - 270, 480, 270};
    Result r = Zoom(frame, 480, aspect, 0.8, {100, 800}, visible, minSize, maxSize);
    CHECK(r.frame.x == 20 && Near(r.frame.maxY(), 945 - 20) && r.frame.w == 384);
  }
  {
    Rect frame{500, 300, 480, 270};
    Point pointer{500 + 480 * 0.25, 300 + 270 * 0.75};
    Result r = Zoom(frame, 480, aspect, 1.5, pointer, visible, minSize, maxSize);
    CHECK(Near((pointer.x - r.frame.x) / r.frame.w, 0.25, 0.01));
    CHECK(Near((pointer.y - r.frame.y) / r.frame.h, 0.75, 0.01));
  }
  {
    Rect frame{10, 300, 480, 270};
    Result r = Zoom(frame, 480, aspect, 1.2, {200, 435}, visible, minSize, maxSize);
    CHECK(r.frame.x == 10 && Near(r.frame.y + r.frame.h / 2, 435, 1));
  }
  {
    Rect frame{1000, 16, 480, 270};
    Result small = Zoom(frame, 480, aspect, 0.01, {1200, 100}, visible, minSize, maxSize);
    CHECK(small.frame.w == 285 && small.frame.h == 160 && Near(small.width, 160 * aspect, 1e-9));
    Result again = Zoom(small.frame, small.width, aspect, 0.5, {1200, 100}, visible, minSize, maxSize);
    CHECK(again.frame.w == small.frame.w && again.frame.x == small.frame.x && again.frame.y == small.frame.y);
    Result big = Zoom(frame, 480, aspect, 100, {1200, 100}, visible, minSize, maxSize);
    CHECK(big.frame.w == 1209 && big.frame.h <= 945 * 0.8 + 0.5);
    Result more = Zoom(big.frame, big.width, aspect, 3, {1200, 100}, visible, minSize, maxSize);
    Result back = Zoom(more.frame, more.width, aspect, ScrollFactor(-5, true), {1200, 100}, visible, minSize, maxSize);
    CHECK(more.frame.w == big.frame.w && back.frame.w < big.frame.w);
    CHECK(big.frame.x >= 0 && big.frame.maxX() <= 1512 && big.frame.y >= 0 && big.frame.maxY() <= 945);
  }
  {
    const double tall = 9.0 / 16;
    double low, high;
    WidthLimits(tall, minSize, maxSize, visible, &low, &high);
    CHECK(Near(high, 945 * 0.8 * tall, 1e-9) && Near(low, 284, 1e-9));
  }
  {
    Rect frame{900, 300, 480, 270};
    Result r = Zoom(frame, 480, aspect, 2, {1380, 435}, visible, minSize, maxSize);
    CHECK(r.frame.x >= 0 && r.frame.maxX() <= 1512 && r.frame.y >= 0 && r.frame.maxY() <= 945);
  }
  {
    Rect second{1512, -200, 1920, 1055};
    Rect frame{1512 + 1920 - 16 - 480, -200 + 16, 480, 270};
    Result r = Zoom(frame, 480, aspect, 1.5, {3200, -100}, second, minSize, {1920 * 0.8, 1055 * 0.8});
    CHECK(Near(r.frame.maxX(), 1512 + 1920 - 16) && r.frame.y == -200 + 16 && r.frame.w == 720);
  }
  {
    Rect frame{1000, 16, 480, 270};
    double width = 480;
    for (int i = 0; i < 100; i++) {
      Result r = Zoom(frame, width, aspect, ScrollFactor(0.5, true), {1200, 100}, visible, minSize, maxSize);
      frame = r.frame, width = r.width;
    }
    CHECK(Near(width, 480 * std::exp(0.004 * 50), 1e-6) && Near(frame.w, width));
  }
  {
    Rect frame{1000, 16, 480, 270};
    double width = 480;
    for (int i = 0; i < 400; i++) {
      double f = ScrollFactor(i < 200 ? 0.5 : -0.5, true);
      Result r = Zoom(frame, width, aspect, f, {1200, 100}, visible, minSize, maxSize);
      frame = r.frame, width = r.width;
      CHECK(Near(frame.h, frame.w / aspect));
    }
    CHECK(Near(width, 480, 1e-6) && frame.w == 480 && frame.h == 270 && Near(frame.maxX(), 1480) && frame.y == 16);
  }
  {
    const Rect parked{1512 - 300, 300, 480, 270};
    Result grown = Zoom(parked, 480, aspect, 1.25, {1400, 400}, visible, minSize, maxSize);
    CHECK(grown.frame.w == 600 && Near(grown.frame.maxX(), parked.maxX()) && grown.frame.x < parked.x);
    CHECK(grown.frame.maxX() > visible.maxX());
    Result shrunk = Zoom(parked, 480, aspect, 0.8, {1400, 400}, visible, minSize, maxSize);
    CHECK(shrunk.frame.w == 384 && shrunk.frame.x > parked.x && shrunk.frame.maxX() < parked.maxX());
    CHECK(shrunk.frame.x <= 1400 && shrunk.frame.maxX() >= 1400);
  }
  {
    const Rect parked{-200, 945 - 150, 480, 270};
    Result grown = Zoom(parked, 480, aspect, 1.25, {100, 900}, visible, minSize, maxSize);
    CHECK(grown.frame.x == parked.x && Near(grown.frame.maxY(), parked.maxY()));
    CHECK(grown.frame.maxX() > parked.maxX() && grown.frame.y < parked.y);
  }
  {
    for (const Rect parked : {Rect{1512 - 300, 300, 480, 270}, Rect{-200, 300, 480, 270}, Rect{500, 945 - 140, 480, 270}, Rect{500, -130, 480, 270}}) {
      Rect frame = parked;
      double width = parked.w;
      for (double f : {1.1, 1.3, 0.7, 1.6, 0.5, 1.2}) {
        Result r = Zoom(frame, width, aspect, f, {frame.x + frame.w / 2, frame.y + frame.h / 2}, visible, minSize, maxSize);
        CHECK(r.frame.x >= std::min(visible.x, frame.x) - 0.51 && r.frame.maxX() <= std::max(visible.maxX(), frame.maxX()) + 0.51);
        CHECK(r.frame.y >= std::min(visible.y, frame.y) - 0.51 && r.frame.maxY() <= std::max(visible.maxY(), frame.maxY()) + 0.51);
        CHECK(visible.x - r.frame.x <= r.frame.w * kMostPastEdge && r.frame.maxX() - visible.maxX() <= r.frame.w * kMostPastEdge);
        CHECK(visible.y - r.frame.y <= r.frame.h * kMostPastEdge && r.frame.maxY() - visible.maxY() <= r.frame.h * kMostPastEdge);
        frame = r.frame, width = r.width;
      }
    }
  }
  {
    CHECK(KeptWithin(900, 400, 800, 480, 0, 1512) == 900);
    CHECK(KeptWithin(1300, 400, 1212, 480, 0, 1512) == 1292);
    CHECK(KeptWithin(-300, 400, -200, 480, 0, 1512) == -200);
    CHECK(KeptWithin(1300, 400, 800, 480, 0, 1512) == 1112);
    CHECK(KeptWithin(1352, 360, 1232, 480, 0, 1512) == 1332);
    CHECK(KeptWithin(1500, 200, 1232, 480, 0, 1512) == 1412);
    CHECK(KeptWithin(-320, 200, -200, 480, 0, 1512) == -100);
  }
  {
    const Window pip{40, 0, {1000, 16, 480, 270}}, docPip{41, 0, {100, 600, 400, 300}};
    const std::vector<Window> windows{pip, docPip};
    CHECK(WindowUnder(windows, {1200, 100}, 40) == 40);
    CHECK(WindowUnder(windows, {200, 700}, 41) == 41);
    CHECK(WindowUnder(windows, {1200, 100}, 7) == 0);
    CHECK(WindowUnder(windows, {700, 500}, 7) == 0);
    CHECK(WindowUnder(windows, {1200, 100}, 0) == 0);
    CHECK(WindowUnder(windows, {200, 700}, 0) == 0);
    CHECK(WindowUnder(windows, {1480, 100}, 40) == 0);
    CHECK(WindowUnder(windows, {1000, 16}, 40) == 40);
    CHECK(WindowUnder({}, {1200, 100}, 40) == 0);
    const std::vector<Window> pinching{{40, 90, {1000, 16, 480, 270}, {1000, 16, 480, 270}, false}};
    CHECK(WindowUnder(pinching, {1200, 100}, 90) == 40);
    CHECK(WindowUnder(pinching, {1200, 100}, 40) == 40);
    CHECK(WindowUnder(pinching, {200, 100}, 90) == 0);
    const Rect stale{1000, 16, 480, 270}, grown{900, 16, 680, 383};
    const std::vector<Window> clear{{40, 90, stale, grown, true}}, covered{{40, 90, stale, grown, false}};
    CHECK(WindowUnder(clear, {950, 300}, 7) == 40);
    CHECK(WindowUnder(clear, {950, 300}, 0) == 40);
    CHECK(WindowUnder(covered, {950, 300}, 7) == 0);
    CHECK(WindowUnder(covered, {950, 300}, 40) == 40);
    CHECK(WindowUnder(covered, {1200, 100}, 7) == 0);
    CHECK(WindowUnder(clear, {850, 300}, 40) == 0);
    const std::vector<Window> noStandIn{{40, 0, stale, grown, true}};
    CHECK(WindowUnder(noStandIn, {950, 300}, 7) == 0);
    const Rect big{900, 16, 680, 383}, shrunk{1000, 60, 480, 270};
    const std::vector<Window> shrinking{{40, 90, big, shrunk, false}};
    CHECK(WindowUnder(shrinking, {920, 300}, 40) == 0);
    CHECK(WindowUnder(shrinking, {1200, 200}, 40) == 40);
    const std::vector<Window> shrinkingClear{{40, 90, big, shrunk, true}};
    CHECK(WindowUnder(shrinkingClear, {920, 300}, 40) == 0);
    CHECK(WindowUnder(shrinkingClear, {1200, 200}, 7) == 40);
    const std::vector<Window> overlapping{{50, 0, {1100, 50, 300, 200}}, pip};
    CHECK(WindowUnder(overlapping, {1200, 100}, 50) == 50);
    CHECK(WindowUnder(overlapping, {1200, 100}, 40) == 40);
  }
  {
    PinchLock lock;
    PinchStep began = StepPinch(lock, Phase::Began, 40, true);
    CHECK(began.window == 40 && began.consume && began.begin && began.apply && !began.end);
    PinchStep drifted = StepPinch(lock, Phase::Changed, 0, true);
    CHECK(drifted.window == 40 && drifted.consume && drifted.apply && !drifted.begin && !drifted.end);
    PinchStep elsewhere = StepPinch(lock, Phase::Changed, 41, true);
    CHECK(elsewhere.window == 40);
    PinchStep ended = StepPinch(lock, Phase::Ended, 0, true);
    CHECK(ended.window == 40 && ended.consume && ended.apply && ended.end);
    CHECK(lock.window == 0 && !lock.owned && !lock.elsewhere);
  }
  {
    PinchLock lock;
    PinchStep began = StepPinch(lock, Phase::Began, 0, false);
    CHECK(!began.consume && began.window == 0);
    PinchStep ontoPip = StepPinch(lock, Phase::Changed, 40, false);
    CHECK(!ontoPip.consume && ontoPip.window == 0);
    PinchStep ended = StepPinch(lock, Phase::Ended, 40, false);
    CHECK(!ended.consume && ended.window == 0);
    PinchStep next = StepPinch(lock, Phase::Began, 40, false);
    CHECK(next.window == 40 && next.begin);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    PinchStep hidden = StepPinch(lock, Phase::Changed, 0, false);
    CHECK(hidden.window == 40 && hidden.consume && hidden.cancel && !hidden.apply && !hidden.end);
    PinchStep after = StepPinch(lock, Phase::Changed, 41, true);
    CHECK(after.consume && after.window == 0 && !after.apply && !after.cancel);
    PinchStep ended = StepPinch(lock, Phase::Ended, 41, true);
    CHECK(ended.consume && ended.window == 0 && !ended.end);
    CHECK(!lock.owned);
  }
  {
    PinchLock lock;
    PinchStep loose = StepPinch(lock, Phase::Changed, 40, false);
    CHECK(loose.window == 40 && loose.consume && loose.apply && !loose.begin);
    PinchStep none = StepPinch(lock, Phase::None, 0, false);
    CHECK(!none.consume && none.window == 0);
    PinchStep phaseless = StepPinch(lock, Phase::None, 40, false);
    CHECK(phaseless.window == 40 && phaseless.apply && !phaseless.end);
    StepPinch(lock, Phase::Began, 40, true);
    PinchStep restarted = StepPinch(lock, Phase::Began, 41, true);
    CHECK(restarted.window == 41 && restarted.begin && lock.window == 41 && restarted.finish == 40);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    StepPinch(lock, Phase::Changed, 40, true);
    PinchStep stalled = StallPinch(lock);
    CHECK(stalled.window == 40 && stalled.end && !stalled.consume && !stalled.apply && !stalled.cancel);
    CHECK(lock.owned && lock.stalled);
    CHECK(StallPinch(lock).window == 0);
    PinchStep resumed = StepPinch(lock, Phase::Changed, 0, true);
    CHECK(resumed.window == 40 && resumed.consume && resumed.begin && resumed.apply && !resumed.end);
    CHECK(!lock.stalled);
    PinchStep ended = StepPinch(lock, Phase::Ended, 0, true);
    CHECK(ended.window == 40 && ended.end);
    CHECK(StallPinch(lock).window == 0);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    StallPinch(lock);
    PinchStep lateEnd = StepPinch(lock, Phase::Ended, 0, true);
    CHECK(lateEnd.consume && lateEnd.window == 0 && !lateEnd.begin && !lateEnd.end);
    CHECK(!lock.owned);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    PinchStep beside = StepPinch(lock, Phase::Began, 0, false);
    CHECK(beside.finish == 40 && beside.window == 0 && !beside.consume);
    CHECK(!lock.owned && lock.elsewhere && lock.window == 0);
    PinchStep again = StepPinch(lock, Phase::Began, 40, true);
    CHECK(again.finish == 0 && again.begin);
    PinchStep same = StepPinch(lock, Phase::Began, 40, true);
    CHECK(same.finish == 40 && same.window == 40 && same.begin);
    StallPinch(lock);
    PinchStep afterStall = StepPinch(lock, Phase::Began, 41, true);
    CHECK(afterStall.finish == 0 && afterStall.window == 41);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    StallPinch(lock);
    PinchStep hidden = StepPinch(lock, Phase::Changed, 0, false);
    CHECK(hidden.consume && !hidden.cancel && !hidden.begin && hidden.window == 0 && lock.window == 0);
  }
  {
    CHECK(KeepsStandIn(true, true, false));
    CHECK(!KeepsStandIn(true, true, true));
    CHECK(!KeepsStandIn(true, false, false));
    CHECK(!KeepsStandIn(false, true, false));
    CHECK(WantsOtherAppPinches(false, true, true));
    CHECK(!WantsOtherAppPinches(true, true, true));
    CHECK(!WantsOtherAppPinches(false, true, false));
    CHECK(!WantsOtherAppPinches(false, false, true));
  }
  {
    const double nan = std::nan(""), inf = HUGE_VAL;
    for (double hostile : {nan, inf, -inf, 1e308, -1e308, 4.9e-324, -0.0}) {
      const double factor = MagnifyFactor(hostile);
      CHECK(std::isfinite(factor) && factor >= kLeastMagnifyFactor && factor <= kMostMagnifyFactor);
      const double scroll = ScrollFactor(hostile, true), wheel = ScrollFactor(hostile, false);
      CHECK(std::isfinite(scroll) && scroll > 0 && std::isfinite(wheel) && wheel > 0);
      CHECK(!UsablePointer({hostile, 100}) || std::fabs(hostile) <= kFarthestPointer);
      CHECK(!UsablePointer({100, hostile}) || std::fabs(hostile) <= kFarthestPointer);
      const Rect frame{1000, 16, 480, 270};
      Result r = Zoom(frame, 480, aspect, factor, {1200, 100}, visible, minSize, maxSize);
      CHECK(Finite(r.frame) && r.frame.w >= minSize.w && r.frame.w <= maxSize.w);
      CHECK(r.frame.x >= visible.x && r.frame.maxX() <= visible.maxX() && r.frame.y >= visible.y && r.frame.maxY() <= visible.maxY());
    }
    CHECK(MagnifyFactor(nan) == 1 && MagnifyFactor(inf) == 1 && ScrollFactor(nan, true) == 1);
    CHECK(MagnifyFactor(1e308) == kMostMagnifyFactor && MagnifyFactor(-1e308) == kLeastMagnifyFactor);
    CHECK(!UsablePointer({nan, 1}) && !UsablePointer({1, inf}) && !UsablePointer({-inf, 1}) && !UsablePointer({1e9, 1}));
    CHECK(UsablePointer({-1512, 945}) && UsablePointer({0, 0}));
    CHECK(WindowUnder({{40, 0, {1000, 16, 480, 270}}}, {nan, nan}, 40) == 0);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    BindSession(lock, 40, 5);
    PinchStep changed = StepPinch(lock, Phase::Changed, 0, true);
    CHECK(changed.session == 5 && changed.apply);
    PinchStep stalled = StallPinch(lock);
    CHECK(stalled.end && stalled.session == 5);
    CHECK(SameSession(stalled.session, 5) && !SameSession(stalled.session, 6) && SameSession(0, 6));
    PinchStep resumed = StepPinch(lock, Phase::Changed, 0, true);
    CHECK(resumed.begin && resumed.session == 0);
    BindSession(lock, 40, 7);
    PinchStep replaced = StepPinch(lock, Phase::Began, 41, true);
    CHECK(replaced.finish == 40 && replaced.finishSession == 7 && replaced.session == 0);
    BindSession(lock, 40, 9);
    CHECK(lock.session == 0);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    BindSession(lock, 40, 5);
    YieldPinch(lock, 40);
    const long edgeDragSession = 6;
    PinchStep timeout = StallPinch(lock);
    CHECK(timeout.window == 0 && !timeout.end);
    CHECK(!SameSession(5, edgeDragSession));
    PinchStep late = StepPinch(lock, Phase::Changed, 40, true);
    CHECK(late.consume && late.window == 0 && !late.apply && !late.begin);
    PinchStep lateEnd = StepPinch(lock, Phase::Ended, 40, true);
    CHECK(lateEnd.consume && lateEnd.window == 0 && !lateEnd.end);
    CHECK(!lock.owned);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    YieldPinch(lock, 41);
    CHECK(lock.window == 40);
    YieldPinch(lock, 0);
    CHECK(lock.window == 0 && lock.owned);
    CHECK(StallPinch(lock).window == 0);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    BindSession(lock, 40, 3);
    PinchStep pending = FinishPending(lock);
    CHECK(pending.finish == 40 && pending.finishSession == 3 && pending.window == 0 && !pending.consume);
    CHECK(lock.window == 0 && lock.owned);
    PinchStep next = StepPinch(lock, Phase::Began, 40, true);
    CHECK(next.finish == 0 && next.window == 40 && next.begin);
    StallPinch(lock);
    CHECK(FinishPending(lock).finish == 0);
    PinchLock idle;
    CHECK(FinishPending(idle).finish == 0);
  }
  {
    PinchLock lock;
    PinchStep began = HoldPinch(lock, Phase::Began);
    CHECK(began.consume && began.window == 0 && !began.apply && lock.owned && lock.window == 0);
    PinchStep changed = HoldPinch(lock, Phase::Changed);
    CHECK(changed.consume && !changed.apply);
    CHECK(StallPinch(lock).window == 0);
    PinchStep afterResize = StepPinch(lock, Phase::Changed, 40, true);
    CHECK(afterResize.consume && afterResize.window == 0 && !afterResize.apply);
    PinchStep ended = HoldPinch(lock, Phase::Ended);
    CHECK(ended.consume && !lock.owned);
  }
  {
    const Rect big{900, 16, 680, 383}, shrunk{1000, 60, 480, 270};
    const std::vector<Window> shrinking{{40, 90, big, shrunk, false}};
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    BindSession(lock, 40, 4);
    PinchStart inside = StartPinch(lock, shrinking, {1200, 200}, 40);
    CHECK(inside.finish.finish == 40 && inside.finish.finishSession == 4);
    CHECK(inside.step.window == 40 && inside.step.begin && inside.step.finish == 0);
    BindSession(lock, 40, 5);
    PinchStart outside = StartPinch(lock, shrinking, {920, 300}, 40);
    CHECK(outside.finish.finish == 40 && outside.finish.finishSession == 5);
    CHECK(outside.step.window == 0 && !outside.step.consume && lock.elsewhere);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    BindSession(lock, 40, 8);
    PinchStep edgeDragOnOther = FinishPending(lock);
    CHECK(edgeDragOnOther.finish == 40 && edgeDragOnOther.finishSession == 8);
    CHECK(lock.window == 0 && lock.owned);
    PinchStep held = HoldPinch(lock, Phase::Began);
    CHECK(held.consume && held.finish == 0 && held.window == 0);
  }
  {
    PinchLock lock;
    StepPinch(lock, Phase::Began, 40, true);
    BindSession(lock, 40, 8);
    PinchStep began = HoldPinch(lock, Phase::Began);
    CHECK(began.finish == 40 && began.finishSession == 8 && began.consume);
    CHECK(lock.owned && lock.window == 0);
    PinchLock other;
    StepPinch(other, Phase::Began, 40, true);
    BindSession(other, 40, 9);
    PinchStep changed = HoldPinch(other, Phase::Changed);
    CHECK(changed.finish == 0 && other.window == 40);
    PinchStep ended = HoldPinch(other, Phase::Ended);
    CHECK(ended.finish == 40 && ended.finishSession == 9 && ended.consume && !other.owned);
  }
  if (failures) return std::printf("%d failed\n", failures), 1;
  std::printf("pip-zoom: all passed\n");
  return 0;
}
