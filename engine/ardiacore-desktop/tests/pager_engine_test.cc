#include <array>
#include <climits>
#include <cmath>
#include <iostream>
#include <limits>
#include <numbers>
#include <string>
#include <vector>

#include "ardia/desktop/ac_desktop_gesture_router.h"
#include "ardia/desktop/ac_desktop_pager_spring.h"

namespace {

namespace pager = ardia::desktop_pager;
namespace gesture = ardia::desktop_gesture;

using pager::PagerInput;
using pager::PagerPhase;
using pager::PagerSpring;

int failures = 0;
const char* current = "";

#define EXPECT(cond)                                                                         \
  do {                                                                                       \
    if (!(cond)) {                                                                           \
      std::cerr << "FAIL " << current << " (" << __FILE__ << ":" << __LINE__ << "): " << #cond << "\n"; \
      ++failures;                                                                            \
    }                                                                                        \
  } while (0)

#define EXPECT_NEAR(a, b, eps)                                                                                   \
  do {                                                                                                           \
    const double expect_a = (a);                                                                                 \
    const double expect_b = (b);                                                                                 \
    if (!(std::abs(expect_a - expect_b) <= (eps))) {                                                             \
      std::cerr << "FAIL " << current << " (" << __FILE__ << ":" << __LINE__ << "): " << #a << " = " << expect_a \
                << ", expected " << expect_b << "\n";                                                            \
      ++failures;                                                                                                \
    }                                                                                                            \
  } while (0)

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr double kWidth = 1000;
constexpr double kFrame = 1.0 / 120;

struct Settle {
  double seconds = -1;
  int frames = 0;
  bool monotonic = true;
  bool overshoot = false;
  int settled_events = 0;
  int selected_events = 0;
  pager::Frame last;
};

Settle RunFrames(PagerSpring& spring, double& now, double limit = 3) {
  Settle out;
  const double start = now;
  const pager::Frame first = spring.Snapshot();
  const double target = first.selected;
  double previous_gap = std::abs(first.position - target);
  const double side = first.position - target;
  while (now - start < limit) {
    now += kFrame;
    const pager::Frame frame = spring.StepFrame(now);
    ++out.frames;
    if (frame.settled) ++out.settled_events;
    if (frame.selected_changed) ++out.selected_events;
    const double gap = std::abs(frame.position - target);
    if (gap > previous_gap + 1e-12) out.monotonic = false;
    if (side != 0 && (frame.position - target) * side < -1e-12) out.overshoot = true;
    previous_gap = gap;
    out.last = frame;
    if (frame.settled) {
      out.seconds = now - start;
      return out;
    }
  }
  return out;
}

PagerSpring Configured(int count, int selected) {
  PagerSpring spring;
  spring.Configure(count, selected, 0);
  spring.StepFrame(0);
  return spring;
}

void DragTo(PagerSpring& spring, double pages, double& t, double duration, int steps, bool hold) {
  spring.Input(PagerInput::kBegan, 0, -1, kWidth, t);
  for (int i = 1; i <= steps; ++i) {
    t += duration / steps;
    spring.Input(PagerInput::kChanged, pages * kWidth / pager::kTrackingScale * i / steps, -1, kWidth, t);
  }
  if (hold) {
    t += 0.15;
    spring.Input(PagerInput::kChanged, pages * kWidth / pager::kTrackingScale, -1, kWidth, t);
  }
}

void ConstantsMatchMacPager() {
  EXPECT(pager::kTrackingScale == 0.5);
  EXPECT(pager::kRubberDimension == 255);
  EXPECT(pager::kRubberCoefficient == 0.15);
  EXPECT(pager::kFlickVelocity == 5);
  EXPECT_NEAR(pager::kOmega, 2 * std::numbers::pi / 0.25, 1e-12);
  EXPECT(pager::kRestDisplacement == 0.003);
  EXPECT(pager::kRestSpeed == 0.1);
  EXPECT(pager::kHistoryWindow == 0.1);
  EXPECT(gesture::kStartDominance == 1.5);
  EXPECT(gesture::kCancelDominance == 2);
  EXPECT(gesture::kPagerVerticalIntent == 12);
  EXPECT(pager::ParseInput("prepare") == PagerInput::kPrepare);
  EXPECT(pager::ParseInput("abandon") == PagerInput::kAbandon);
  EXPECT(pager::ParseInput("cancelled") == PagerInput::kCancelled);
  EXPECT(!pager::ParseInput("wheel"));
  EXPECT(!pager::ParseInput(""));
  EXPECT(pager::PhaseName(PagerPhase::kHolding) == "holding");
}

void TrackingIsHalfScale() {
  PagerSpring spring = Configured(3, 1);
  spring.Input(PagerInput::kBegan, 0, -1, kWidth, 0);
  const pager::Frame began = spring.StepFrame(0.001);
  EXPECT(began.began);
  EXPECT(began.phase == PagerPhase::kTracking);
  spring.Input(PagerInput::kChanged, 200, -1, kWidth, 0.01);
  EXPECT_NEAR(spring.position(), 1.1, 1e-12);
  spring.Input(PagerInput::kChanged, 200, 1, kWidth, 0.02);
  EXPECT_NEAR(spring.position(), 0.9, 1e-12);
  spring.Input(PagerInput::kChanged, 100, -1, 500, 0.03);
  EXPECT_NEAR(spring.position(), 1.1, 1e-12);
}

void RubberBandsPastTheEnds() {
  EXPECT_NEAR(pager::RubberBand(500, 255), (1 - 1 / (500 * 0.15 / 255 + 1)) * 255, 1e-12);
  EXPECT(pager::RubberBand(-5, 255) == 0);
  EXPECT(pager::RubberBand(kNaN, 255) == 0);
  EXPECT(pager::RubberBand(kInf, 255) == 255);
  PagerSpring spring = Configured(1, 0);
  spring.Input(PagerInput::kBegan, 0, -1, kWidth, 0);
  spring.Input(PagerInput::kChanged, 1000, -1, kWidth, 0.01);
  EXPECT_NEAR(spring.position(), pager::RubberBand(500, 255) / kWidth, 1e-12);
  EXPECT(spring.position() < 0.5);
  spring.Input(PagerInput::kChanged, 1e12, -1, kWidth, 0.02);
  EXPECT(spring.position() > 0.25 && spring.position() <= 0.255);
  spring.Input(PagerInput::kChanged, 1e12, 1, kWidth, 0.03);
  EXPECT(spring.position() < -0.25 && spring.position() >= -0.255);
  double now = 0.03;
  spring.Input(PagerInput::kEnded, 1e12, 1, kWidth, 0.03);
  const Settle settle = RunFrames(spring, now);
  EXPECT(settle.seconds > 0);
  EXPECT(spring.position() == 0);
  EXPECT(spring.selected() == 0);
}

void ShortDragSnapsBackCriticallyDamped() {
  PagerSpring spring = Configured(3, 0);
  double t = 0;
  DragTo(spring, 0.3, t, 0.1, 10, true);
  EXPECT_NEAR(spring.position(), 0.3, 1e-12);
  spring.Input(PagerInput::kEnded, 0.3 * kWidth / pager::kTrackingScale, -1, kWidth, t);
  const pager::Frame released = spring.StepFrame(t);
  EXPECT(!released.selected_changed);
  EXPECT(released.needs_frame);
  double now = t;
  const Settle settle = RunFrames(spring, now);
  EXPECT(settle.monotonic);
  EXPECT(!settle.overshoot);
  EXPECT(settle.settled_events == 1);
  EXPECT(settle.seconds >= 0.25 && settle.seconds <= 0.29);
  EXPECT(spring.position() == 0);
  EXPECT(spring.selected() == 0);
  EXPECT(spring.phase() == PagerPhase::kIdle);
  EXPECT(!spring.StepFrame(now + kFrame).needs_frame);
}

void PastHalfwayCommitsWithoutFlick() {
  PagerSpring spring = Configured(3, 0);
  double t = 0;
  DragTo(spring, 0.6, t, 0.1, 10, true);
  spring.Input(PagerInput::kEnded, 0.6 * kWidth / pager::kTrackingScale, -1, kWidth, t);
  const pager::Frame released = spring.StepFrame(t);
  EXPECT(released.selected_changed);
  EXPECT(released.selected == 1);
  EXPECT(released.selection_sequence == released.sequence);
  double now = t;
  const Settle settle = RunFrames(spring, now);
  EXPECT(settle.monotonic);
  EXPECT(settle.seconds >= 0.22 && settle.seconds <= 0.29);
  EXPECT(spring.position() == 1);
}

void FlickVelocityCrossesTheThreshold() {
  {
    PagerSpring spring = Configured(3, 0);
    double t = 0;
    DragTo(spring, 0.2, t, 0.08, 10, false);
    spring.Input(PagerInput::kEnded, 0.2 * kWidth / pager::kTrackingScale, -1, kWidth, t);
    EXPECT(spring.selected() == 1);
    EXPECT(spring.velocity() > 0);
    double now = t;
    const Settle settle = RunFrames(spring, now);
    EXPECT(settle.seconds >= 0.2 && settle.seconds <= 0.49);
    EXPECT(spring.position() == 1);
  }
  {
    PagerSpring spring = Configured(3, 0);
    double t = 0;
    spring.Input(PagerInput::kBegan, 0, -1, kWidth, t);
    spring.Input(PagerInput::kChanged, 900, -1, kWidth, t += 0.01);
    t += 0.2;
    spring.Input(PagerInput::kChanged, 900, -1, kWidth, t);
    t += 0.05;
    spring.Input(PagerInput::kChanged, 900.2, -1, kWidth, t);
    t += 0.05;
    spring.Input(PagerInput::kChanged, 900.4, -1, kWidth, t);
    spring.Input(PagerInput::kEnded, 900.4, -1, kWidth, t);
    EXPECT(spring.selected() == 0);
  }
  {
    PagerSpring spring = Configured(3, 0);
    double t = 0;
    spring.Input(PagerInput::kBegan, 0, -1, kWidth, t);
    spring.Input(PagerInput::kChanged, 900, -1, kWidth, t += 0.01);
    t += 0.2;
    spring.Input(PagerInput::kChanged, 900, -1, kWidth, t);
    t += 0.05;
    spring.Input(PagerInput::kChanged, 904, -1, kWidth, t);
    t += 0.05;
    spring.Input(PagerInput::kChanged, 908, -1, kWidth, t);
    spring.Input(PagerInput::kEnded, 908, -1, kWidth, t);
    EXPECT(spring.selected() == 1);
  }
  {
    PagerSpring spring = Configured(3, 0);
    double t = 0;
    DragTo(spring, 0.7, t, 0.1, 10, true);
    spring.Input(PagerInput::kChanged, 1200, -1, kWidth, t += 0.02);
    spring.Input(PagerInput::kChanged, 1000, -1, kWidth, t += 0.02);
    spring.Input(PagerInput::kEnded, 1000, -1, kWidth, t);
    EXPECT(spring.selected() == 0);
  }
  {
    PagerSpring spring = Configured(5, 2);
    double t = 0;
    spring.Input(PagerInput::kBegan, 0, -1, kWidth, t);
    for (int i = 1; i <= 10; ++i) spring.Input(PagerInput::kChanged, 400.0 * i, -1, kWidth, t += 0.005);
    EXPECT(spring.position() > 3);
    spring.Input(PagerInput::kEnded, 4000, -1, kWidth, t);
    EXPECT(spring.selected() == 3);
  }
}

void DetentCrossingsAreReportedOnce() {
  PagerSpring spring = Configured(3, 0);
  spring.Input(PagerInput::kBegan, 0, -1, kWidth, 0);
  spring.StepFrame(0);
  spring.Input(PagerInput::kChanged, 900, -1, kWidth, 0.01);
  EXPECT(!spring.StepFrame(0.01).detent_crossed);
  spring.Input(PagerInput::kChanged, 1100, -1, kWidth, 0.02);
  const pager::Frame crossed = spring.StepFrame(0.02);
  EXPECT(crossed.detent_crossed);
  EXPECT(crossed.moved);
  spring.Input(PagerInput::kChanged, 1200, -1, kWidth, 0.03);
  EXPECT(!spring.StepFrame(0.03).detent_crossed);
  spring.Input(PagerInput::kChanged, 800, -1, kWidth, 0.04);
  EXPECT(spring.StepFrame(0.04).detent_crossed);
  const pager::Frame quiet = spring.StepFrame(0.05);
  EXPECT(!quiet.detent_crossed);
  EXPECT(!quiet.moved);
}

void PrepareHoldsAndAbandonResettles() {
  PagerSpring spring = Configured(3, 0);
  double t = 0;
  DragTo(spring, 0.2, t, 0.08, 10, false);
  spring.Input(PagerInput::kEnded, 400, -1, kWidth, t);
  EXPECT(spring.selected() == 1);
  double now = t;
  for (int i = 0; i < 6; ++i) spring.StepFrame(now += kFrame);
  const double caught = spring.position();
  EXPECT(caught > 0.2 && caught < 1);
  spring.Input(PagerInput::kPrepare, 0, 0, 0, now);
  EXPECT(spring.phase() == PagerPhase::kHolding);
  for (int i = 0; i < 10; ++i) {
    const pager::Frame frame = spring.StepFrame(now += kFrame);
    EXPECT(frame.position == caught);
    EXPECT(!frame.needs_frame);
  }
  spring.Input(PagerInput::kAbandon, 0, 0, 0, now);
  EXPECT(spring.phase() == PagerPhase::kSettling);
  const Settle settle = RunFrames(spring, now);
  EXPECT(settle.seconds > 0 && settle.seconds < 0.4);
  EXPECT(spring.position() == 1);

  PagerSpring regrab = Configured(3, 0);
  t = 0;
  DragTo(regrab, 0.2, t, 0.08, 10, false);
  regrab.Input(PagerInput::kEnded, 400, -1, kWidth, t);
  now = t;
  for (int i = 0; i < 6; ++i) regrab.StepFrame(now += kFrame);
  const double held = regrab.position();
  regrab.Input(PagerInput::kPrepare, 0, 0, 0, now);
  regrab.Input(PagerInput::kBegan, 0, 1, kWidth, now);
  EXPECT(regrab.phase() == PagerPhase::kTracking);
  EXPECT_NEAR(regrab.position(), held, 1e-12);
  regrab.Input(PagerInput::kChanged, 2 * held * kWidth, 1, kWidth, now + 0.2);
  EXPECT_NEAR(regrab.position(), 0, 1e-9);
  regrab.Input(PagerInput::kChanged, 2 * held * kWidth, 1, kWidth, now + 0.4);
  regrab.Input(PagerInput::kEnded, 2 * held * kWidth, 1, kWidth, now + 0.4);
  EXPECT(regrab.selected() == 0);

  PagerSpring idle = Configured(3, 1);
  idle.Input(PagerInput::kPrepare, 0, 0, 0, 0);
  EXPECT(idle.phase() == PagerPhase::kIdle);
  idle.Input(PagerInput::kAbandon, 0, 0, 0, 0);
  EXPECT(idle.phase() == PagerPhase::kIdle);
  EXPECT(idle.position() == 1);

  PagerSpring tracking = Configured(3, 0);
  t = 0;
  DragTo(tracking, 0.7, t, 0.1, 10, true);
  tracking.Input(PagerInput::kAbandon, 0, 0, 0, t);
  EXPECT(tracking.phase() == PagerPhase::kSettling);
  EXPECT(tracking.selected() == 1);
}

void OrderChangesFollowTheUnacknowledgedSelection() {
  const std::vector<std::string> abc = {"a", "b", "c"};
  const std::vector<std::string> bac = {"b", "a", "c"};
  const std::vector<std::string> cab = {"c", "a", "b"};
  PagerSpring spring;
  spring.Configure(3, 0, 0, &abc);
  EXPECT(spring.selected_id() == "a");
  double t = 0;
  DragTo(spring, 0.7, t, 0.1, 10, true);
  spring.Input(PagerInput::kEnded, 1400, -1, kWidth, t);
  EXPECT(spring.selected_id() == "b");
  const int64_t unacked = spring.selection_sequence();
  EXPECT(unacked > 0);
  spring.Configure(3, 0, 0, &bac);
  EXPECT(spring.selected() == 0);
  EXPECT(spring.selected_id() == "b");
  EXPECT(spring.phase() == PagerPhase::kIdle);

  spring.Configure(3, 0, unacked, &cab);
  EXPECT(spring.selected() == 0);
  EXPECT(spring.selected_id() == "c");

  PagerSpring stale;
  stale.Configure(3, 0, 0, &abc);
  t = 0;
  DragTo(stale, 0.7, t, 0.1, 10, true);
  stale.Input(PagerInput::kEnded, 1400, -1, kWidth, t);
  double now = t;
  RunFrames(stale, now);
  const int64_t picked = stale.selection_sequence();
  stale.Configure(3, 0, picked - 1, &abc);
  EXPECT(stale.selected() == 1);
  stale.Configure(3, 0, picked - 5, &abc);
  EXPECT(stale.selected() == 1);
  stale.Configure(3, 1, picked, &abc);
  EXPECT(stale.selected() == 1);
  stale.Configure(3, 2, picked, &abc);
  EXPECT(stale.selected() == 2);
  stale.Configure(3, 0, 0, &abc);
  EXPECT(stale.selected() == 0);

  PagerSpring removed;
  removed.Configure(3, 2, 0, &abc);
  removed.Configure(2, 5, 0, nullptr);
  EXPECT(removed.count() == 2);
  EXPECT(removed.selected() == 1);
  EXPECT(!removed.selected_id());

  PagerSpring settling;
  settling.Configure(3, 0, 0, &abc);
  t = 0;
  DragTo(settling, 0.7, t, 0.1, 10, true);
  settling.Input(PagerInput::kEnded, 1400, -1, kWidth, t);
  settling.StepFrame(t + kFrame);
  EXPECT(settling.phase() == PagerPhase::kSettling);
  settling.Configure(3, 0, 0, &cab);
  EXPECT(settling.phase() == PagerPhase::kIdle);
  EXPECT(settling.selected_id() == "b");
  EXPECT(settling.position() == 2);
}

void ReducedMotionSnapsInstantly() {
  PagerSpring spring = Configured(3, 0);
  spring.SetReduceMotion(true);
  double t = 0;
  DragTo(spring, 0.2, t, 0.08, 10, false);
  EXPECT(spring.phase() == PagerPhase::kTracking);
  spring.Input(PagerInput::kEnded, 400, -1, kWidth, t);
  EXPECT(spring.phase() == PagerPhase::kIdle);
  EXPECT(spring.position() == 1);
  const pager::Frame frame = spring.StepFrame(t);
  EXPECT(frame.settled);
  EXPECT(frame.selected_changed);
  EXPECT(!frame.needs_frame);
  EXPECT(spring.SwitchTo(2));
  EXPECT(spring.position() == 2);
  EXPECT(spring.phase() == PagerPhase::kIdle);

  PagerSpring midway = Configured(3, 0);
  EXPECT(midway.SwitchTo(2));
  double now = 0;
  for (int i = 0; i < 4; ++i) midway.StepFrame(now += kFrame);
  EXPECT(midway.phase() == PagerPhase::kSettling);
  midway.SetReduceMotion(true);
  EXPECT(midway.phase() == PagerPhase::kIdle);
  EXPECT(midway.position() == 2);
  EXPECT(midway.StepFrame(now += kFrame).settled);
}

void SwitchStepAndSelect() {
  const std::vector<std::string> abc = {"a", "b", "c"};
  PagerSpring unconfigured;
  EXPECT(!unconfigured.SwitchTo(1));
  EXPECT(!unconfigured.Step(1, true));
  EXPECT(!unconfigured.Select("a", abc));
  unconfigured.Input(PagerInput::kBegan, 10, -1, kWidth, 0);
  EXPECT(unconfigured.phase() == PagerPhase::kIdle);

  PagerSpring spring;
  spring.Configure(3, 2, 0, &abc);
  EXPECT(spring.Step(1, true));
  EXPECT(spring.selected() == 0);
  double now = 0;
  const Settle across = RunFrames(spring, now);
  EXPECT(across.seconds > 0.3 && across.seconds < 0.49);
  EXPECT(spring.Step(-1, false));
  EXPECT(spring.selected() == 0);
  EXPECT(spring.phase() == PagerPhase::kIdle);
  EXPECT(spring.Step(INT_MAX, false));
  EXPECT(spring.selected() == 2);
  EXPECT(spring.Step(INT_MIN, true));
  EXPECT(spring.selected() >= 0 && spring.selected() < 3);
  EXPECT(spring.SwitchTo(-50));
  EXPECT(spring.selected() == 0);
  EXPECT(spring.SwitchTo(50));
  EXPECT(spring.selected() == 2);
  for (int i = 0; i < 5; ++i) spring.StepFrame(now += kFrame);
  const double carried = spring.velocity();
  EXPECT(spring.SwitchTo(2));
  EXPECT(spring.velocity() == carried);

  EXPECT(!spring.Select("z", abc));
  const std::vector<std::string> ab = {"a", "b"};
  EXPECT(spring.Select("b", ab));
  EXPECT(spring.count() == 2);
  EXPECT(spring.selected() == 1);
  EXPECT(spring.phase() == PagerPhase::kIdle);
  const pager::Frame selected = spring.StepFrame(now += kFrame);
  EXPECT(selected.selected_changed);
  EXPECT(selected.selection_sequence == selected.sequence);

  const std::vector<std::string> ba = {"b", "a"};
  EXPECT(spring.SwitchTo(1, &ba));
  EXPECT(spring.selected() == 1);
  const std::vector<std::string> ca = {"c", "a"};
  spring.Configure(2, 0, 0, &ba);
  EXPECT(spring.Step(0, false, &ca));
  EXPECT(spring.count() == 2);
}

void AdversarialInputsStayBounded() {
  PagerSpring spring = Configured(0, -4);
  EXPECT(spring.count() == 1);
  EXPECT(spring.selected() == 0);
  PagerSpring big = Configured(3, 99);
  EXPECT(big.selected() == 2);

  PagerSpring s = Configured(3, 1);
  s.Input(PagerInput::kChanged, 100, -1, kWidth, 0);
  s.Input(PagerInput::kEnded, 100, -1, kWidth, 0);
  EXPECT(s.phase() == PagerPhase::kIdle);
  s.Input(PagerInput::kBegan, 100, -1, 0, 0);
  EXPECT(s.phase() == PagerPhase::kTracking);
  EXPECT(s.position() == 1);
  s.Input(PagerInput::kChanged, 100, -1, -kWidth, 0.01);
  EXPECT(s.position() == 1);
  s.Input(PagerInput::kChanged, 100, -1, kNaN, 0.01);
  EXPECT(s.position() == 1);
  s.Input(PagerInput::kChanged, 100, -1, 1e-300, 0.01);
  EXPECT(s.position() == 1);
  s.Input(PagerInput::kChanged, kNaN, -1, kWidth, 0.02);
  EXPECT(s.position() == 1);
  s.Input(PagerInput::kChanged, kInf, -1, kWidth, 0.02);
  EXPECT(s.position() == 1);
  s.Input(PagerInput::kChanged, 100, -1, kWidth, 0.03);
  EXPECT_NEAR(s.position(), 1.05, 1e-12);
  s.Input(PagerInput::kChanged, 120, -1, kNaN, 0.04);
  EXPECT_NEAR(s.position(), 1.06, 1e-12);
  s.Input(PagerInput::kChanged, 140, -1, kWidth, kNaN);
  EXPECT_NEAR(s.position(), 1.07, 1e-12);
  s.Input(PagerInput::kChanged, 160, -1, kWidth, -100);
  s.Input(PagerInput::kChanged, 180, -1, kWidth, 0.03);
  EXPECT(std::isfinite(s.position()));
  s.Input(PagerInput::kChanged, 1e308, -1, kWidth, 0.05);
  EXPECT(s.position() <= 2.255);
  s.Input(PagerInput::kChanged, -1e308, -1, kWidth, 0.06);
  EXPECT(s.position() >= -0.255);
  s.Input(PagerInput::kEnded, kNaN, 7, kInf, kNaN);
  EXPECT(s.phase() == PagerPhase::kSettling);
  EXPECT(std::isfinite(s.velocity()));
  EXPECT(std::abs(s.velocity()) <= pager::kMaxReleaseVelocity);
  double now = 1;
  EXPECT(!s.StepFrame(kNaN).settled);
  EXPECT(!s.StepFrame(kInf).settled);
  const Settle settle = RunFrames(s, now);
  EXPECT(settle.seconds > 0 && settle.seconds <= pager::kMaxSettleSeconds + kFrame);
  EXPECT(std::isfinite(s.position()));
  EXPECT(s.position() == s.selected());

  PagerSpring burst = Configured(3, 0);
  burst.Input(PagerInput::kBegan, 0, -1, kWidth, 5);
  for (int i = 1; i <= 10000; ++i) burst.Input(PagerInput::kChanged, i * 0.01, -1, kWidth, 5);
  EXPECT(burst.history_size() <= pager::kHistoryCapacity);
  burst.Input(PagerInput::kChanged, 1600, -1, kWidth, 5 + 1e-12);
  burst.Input(PagerInput::kEnded, 1600, -1, kWidth, 5 + 1e-12);
  EXPECT(std::abs(burst.velocity()) <= pager::kMaxReleaseVelocity);
  now = 5;
  const Settle fast = RunFrames(burst, now);
  EXPECT(fast.seconds > 0 && fast.seconds <= pager::kMaxSettleSeconds + kFrame);
  EXPECT(burst.position() == 1);

  PagerSpring backwards = Configured(3, 0);
  EXPECT(backwards.SwitchTo(1));
  backwards.StepFrame(10);
  backwards.StepFrame(10.05);
  const double ahead = backwards.position();
  backwards.StepFrame(3);
  EXPECT(backwards.position() == ahead);
  backwards.StepFrame(-1e300);
  EXPECT(backwards.position() == ahead);

  PagerSpring stalled = Configured(3, 0);
  stalled.StepFrame(100);
  EXPECT(stalled.SwitchTo(1));
  const pager::Frame first = stalled.StepFrame(5000);
  EXPECT(first.phase == PagerPhase::kSettling);
  EXPECT(first.position > 0 && first.position < 0.2);

  PagerSpring wrap = Configured(INT_MAX, INT_MAX - 1);
  EXPECT(wrap.Step(INT_MAX, true));
  EXPECT(wrap.selected() >= 0);
  wrap.Configure(3, 0, INT64_MAX, nullptr);
  wrap.Configure(3, 0, INT64_MIN, nullptr);
  EXPECT(wrap.count() == 3);
}

struct RouterHarness {
  gesture::GestureRouter router;
  std::vector<gesture::Action> log;
  double t = 0;

  gesture::Result Send(gesture::TouchPhase phase, double dx, double dy, const gesture::Target* hit = nullptr,
                       const gesture::ContentState* content = nullptr, int64_t window = 0) {
    t += kFrame;
    gesture::Result result = router.Scroll(phase, dx, dy, t, hit, content, window);
    log.insert(log.end(), result.actions.begin(), result.actions.end());
    return result;
  }
};

gesture::Target NativePager(int64_t id = 1) {
  gesture::Target target;
  target.id = id;
  target.is_pager = true;
  target.has_native_pager = true;
  target.can_swipe_back = true;
  target.can_swipe_forward = true;
  return target;
}

gesture::Target History(int64_t id = 2) {
  gesture::Target target;
  target.id = id;
  target.can_swipe_back = true;
  target.can_swipe_forward = true;
  return target;
}

void RouterStartsOnAxisDominance() {
  const gesture::Target pager_target = NativePager();
  {
    RouterHarness h;
    EXPECT(h.Send(gesture::TouchPhase::kBegan, 0, 0, &pager_target).verdict == gesture::Verdict::kWaiting);
    EXPECT(h.router.pending());
    EXPECT(h.Send(gesture::TouchPhase::kChanged, 1, 2).verdict == gesture::Verdict::kWaiting);
    const gesture::Result go = h.Send(gesture::TouchPhase::kChanged, 1, 0);
    EXPECT(go.verdict == gesture::Verdict::kTracking);
    EXPECT(go.swallow);
    EXPECT(h.router.tracking());
    EXPECT(go.actions.size() == 1);
    EXPECT(go.actions[0].input == PagerInput::kBegan);
    EXPECT(go.actions[0].native_pager);
    EXPECT(go.actions[0].direction == 1);
    EXPECT(go.actions[0].distance == 2);
  }
  {
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, 1, 11, &pager_target);
    EXPECT(h.router.pending());
    EXPECT(h.Send(gesture::TouchPhase::kChanged, 0, 1).verdict == gesture::Verdict::kVerticalIntent);
    EXPECT(!h.router.pending());
    EXPECT(h.Send(gesture::TouchPhase::kChanged, -100, 0).actions.empty());
  }
  {
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, 8, 12, &pager_target);
    EXPECT(h.router.tracking());
  }
  {
    const gesture::Target history = History();
    RouterHarness h;
    EXPECT(h.Send(gesture::TouchPhase::kBegan, 3, 0, &history).verdict == gesture::Verdict::kWaiting);
    EXPECT(h.Send(gesture::TouchPhase::kChanged, -1, 4).verdict == gesture::Verdict::kWaiting);
    EXPECT(h.Send(gesture::TouchPhase::kChanged, 0, 1).verdict == gesture::Verdict::kVerticalIntent);
    RouterHarness g;
    EXPECT(g.Send(gesture::TouchPhase::kBegan, -4, 0, &history).verdict == gesture::Verdict::kTracking);
    EXPECT(g.router.direction() == -1);
    EXPECT(!g.log[0].native_pager);
  }
}

void RouterCancelsOnVerticalDominanceForNonPagers() {
  const gesture::Target history = History();
  RouterHarness h;
  h.Send(gesture::TouchPhase::kBegan, 10, 0, &history);
  EXPECT(h.router.tracking());
  EXPECT(h.Send(gesture::TouchPhase::kChanged, 0, 15).verdict == gesture::Verdict::kTracking);
  const gesture::Result cancel = h.Send(gesture::TouchPhase::kChanged, 0, 10);
  EXPECT(cancel.verdict == gesture::Verdict::kAxisCancelled);
  EXPECT(!cancel.swallow);
  EXPECT(cancel.actions.size() == 1 && cancel.actions[0].input == PagerInput::kCancelled);
  EXPECT(!h.router.tracking());

  gesture::Target vertical = History();
  vertical.allows_vertical_motion = true;
  RouterHarness v;
  v.Send(gesture::TouchPhase::kBegan, 10, 0, &vertical);
  EXPECT(v.Send(gesture::TouchPhase::kChanged, 0, 100).verdict == gesture::Verdict::kTracking);

  const gesture::Target pager_target = NativePager();
  RouterHarness p;
  p.Send(gesture::TouchPhase::kBegan, 10, 0, &pager_target);
  EXPECT(p.Send(gesture::TouchPhase::kChanged, 0, 100).verdict == gesture::Verdict::kTracking);
}

void RouterRejectsScrollableDescendantsAndUnavailableDirections() {
  gesture::Target scrolling = NativePager();
  scrolling.content_scrolls_forward = true;
  RouterHarness forward;
  EXPECT(forward.Send(gesture::TouchPhase::kBegan, -5, 0, &scrolling).verdict == gesture::Verdict::kContentScrolls);
  RouterHarness back;
  EXPECT(back.Send(gesture::TouchPhase::kBegan, 5, 0, &scrolling).verdict == gesture::Verdict::kTracking);

  const gesture::Target pager_target = NativePager();
  RouterHarness consumed;
  const gesture::ContentState taken{gesture::ContentAck::kConsumed, false, true};
  EXPECT(consumed.Send(gesture::TouchPhase::kBegan, 5, 0, &pager_target, &taken).verdict ==
         gesture::Verdict::kContentConsumed);

  gesture::Target edge = History();
  edge.can_swipe_back = false;
  RouterHarness blocked;
  EXPECT(blocked.Send(gesture::TouchPhase::kBegan, 5, 0, &edge).verdict == gesture::Verdict::kUnavailable);
  edge.tracks_unavailable_directions = true;
  RouterHarness rubber;
  rubber.Send(gesture::TouchPhase::kBegan, 5, 0, &edge);
  EXPECT(rubber.router.tracking());
  EXPECT(!rubber.log[0].available);
}

void RouterPreparesAndAbandonsPagers() {
  const gesture::Target pager_target = NativePager(1);
  const gesture::Target other = NativePager(9);
  const gesture::Target history = History(2);
  RouterHarness h;
  gesture::Result may = h.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_target);
  EXPECT(may.actions.size() == 1 && may.actions[0].input == PagerInput::kPrepare && may.actions[0].target == 1);
  EXPECT(h.router.prepared() == 1);
  may = h.Send(gesture::TouchPhase::kMayBegin, 0, 0, &other);
  EXPECT(may.actions.size() == 2);
  EXPECT(may.actions[0].input == PagerInput::kAbandon && may.actions[0].target == 1);
  EXPECT(may.actions[1].input == PagerInput::kPrepare && may.actions[1].target == 9);
  EXPECT(h.Send(gesture::TouchPhase::kBegan, 0, 0, &other).actions.empty());
  EXPECT(h.router.prepared() == 9);
  const gesture::Result untracked = h.Send(gesture::TouchPhase::kEnded, 0, 0);
  EXPECT(untracked.actions.size() == 1 && untracked.actions[0].input == PagerInput::kAbandon);
  EXPECT(!h.router.prepared());

  RouterHarness k;
  k.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_target);
  k.Send(gesture::TouchPhase::kBegan, -3, 0, &pager_target);
  EXPECT(k.router.tracking());
  EXPECT(!k.router.prepared());
  EXPECT(k.Send(gesture::TouchPhase::kEnded, 0, 0).actions[0].input == PagerInput::kEnded);

  RouterHarness elsewhere;
  elsewhere.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_target);
  const gesture::Result moved = elsewhere.Send(gesture::TouchPhase::kBegan, 0, 0, &history);
  EXPECT(moved.actions.size() == 1 && moved.actions[0].input == PagerInput::kAbandon);

  RouterHarness nothing;
  nothing.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_target);
  const gesture::Result none = nothing.Send(gesture::TouchPhase::kBegan, 0, 0, nullptr);
  EXPECT(none.actions.size() == 1 && none.actions[0].input == PagerInput::kAbandon);

  RouterHarness restart;
  restart.Send(gesture::TouchPhase::kBegan, -5, 0, &pager_target);
  const gesture::Result again = restart.Send(gesture::TouchPhase::kBegan, 0, 0, &pager_target);
  EXPECT(again.actions.size() == 1 && again.actions[0].input == PagerInput::kAbandon);
}

void RouterSwallowsOnlyItsOwnMomentum() {
  const gesture::Target pager_target = NativePager();
  RouterHarness h;
  h.Send(gesture::TouchPhase::kBegan, -5, 0, &pager_target);
  h.Send(gesture::TouchPhase::kEnded, 0, 0);
  EXPECT(h.router.Momentum(gesture::MomentumPhase::kBegan, h.t + 0.05));
  EXPECT(h.router.Momentum(gesture::MomentumPhase::kChanged, h.t + 0.06));
  EXPECT(!h.router.Momentum(gesture::MomentumPhase::kChanged, h.t + 0.06, 7));
  EXPECT(h.router.Momentum(gesture::MomentumPhase::kEnded, h.t + 0.3));
  EXPECT(!h.router.Momentum(gesture::MomentumPhase::kChanged, h.t + 0.31));

  RouterHarness late;
  late.Send(gesture::TouchPhase::kBegan, -5, 0, &pager_target);
  late.Send(gesture::TouchPhase::kEnded, 0, 0);
  EXPECT(!late.router.Momentum(gesture::MomentumPhase::kBegan, late.t + 0.2));
  EXPECT(!late.router.Momentum(gesture::MomentumPhase::kBegan, late.t + 0.01));

  gesture::Target page = NativePager();
  page.page_hit = true;
  RouterHarness web;
  web.Send(gesture::TouchPhase::kBegan, -5, 0, &page);
  web.Send(gesture::TouchPhase::kEnded, 0, 0);
  EXPECT(!web.router.Momentum(gesture::MomentumPhase::kBegan, web.t + 0.01));

  RouterHarness nan;
  nan.Send(gesture::TouchPhase::kBegan, -5, 0, &pager_target);
  nan.Send(gesture::TouchPhase::kEnded, 0, 0);
  EXPECT(!nan.router.Momentum(gesture::MomentumPhase::kBegan, kNaN));
}

void RouterSurvivesAdversarialInput() {
  const gesture::Target pager_target = NativePager();
  RouterHarness h;
  h.Send(gesture::TouchPhase::kBegan, kNaN, kInf, &pager_target);
  EXPECT(h.router.pending());
  h.Send(gesture::TouchPhase::kChanged, -kInf, 0);
  EXPECT(h.router.pending());
  h.Send(gesture::TouchPhase::kChanged, -3, 0);
  EXPECT(h.router.tracking());
  EXPECT(h.router.Forget(1).verdict == gesture::Verdict::kTargetGone);
  EXPECT(h.Send(gesture::TouchPhase::kChanged, -3, 0).actions.empty());
  EXPECT(h.Send(gesture::TouchPhase::kEnded, -3, 0).actions.empty());
  EXPECT(h.Send(gesture::TouchPhase::kChanged, -3, 0, &pager_target).actions.empty());

  RouterHarness stale;
  stale.router.Scroll(gesture::TouchPhase::kBegan, -3, 0, kNaN, &pager_target);
  const gesture::Result next = stale.router.Scroll(gesture::TouchPhase::kEnded, -3, 0, kNaN, nullptr);
  EXPECT(next.actions.size() == 1 && std::isfinite(next.actions[0].timestamp));

  RouterHarness idle;
  EXPECT(idle.Send(gesture::TouchPhase::kChanged, -5, 0).actions.empty());
  EXPECT(idle.Send(gesture::TouchPhase::kEnded, -5, 0).actions.empty());
  EXPECT(!idle.router.Momentum(gesture::MomentumPhase::kBegan, 0));
}

void RouterDrivesThePagerEndToEnd() {
  const gesture::Target pager_target = NativePager();
  PagerSpring spring = Configured(3, 0);
  RouterHarness h;
  const auto feed = [&](const gesture::Result& result) {
    for (const gesture::Action& action : result.actions) gesture::ApplyToPager(spring, action, kWidth);
  };
  feed(h.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_target));
  feed(h.Send(gesture::TouchPhase::kBegan, -20, 1, &pager_target));
  EXPECT(spring.phase() == PagerPhase::kTracking);
  int crossings = 0;
  for (int i = 0; i < 12; ++i) {
    feed(h.Send(gesture::TouchPhase::kChanged, -20, 0.5));
    if (spring.StepFrame(h.t).detent_crossed) ++crossings;
  }
  EXPECT_NEAR(spring.position(), 260 * 0.5 / kWidth, 1e-12);
  EXPECT(crossings == 0);
  feed(h.Send(gesture::TouchPhase::kEnded, -20, 0));
  EXPECT(spring.selected() == 1);
  double now = h.t;
  const Settle settle = RunFrames(spring, now);
  EXPECT(settle.seconds >= 0.2 && settle.seconds <= 0.49);
  EXPECT(spring.position() == 1);

  feed(h.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_target));
  EXPECT(spring.phase() == PagerPhase::kIdle);
  feed(h.Send(gesture::TouchPhase::kEnded, 0, 0));
  EXPECT(spring.phase() == PagerPhase::kIdle);
  EXPECT(spring.position() == 1);
}

void MotionToRestBeatsTheWebUiSpike() {
  const gesture::Target pager_target = NativePager();
  PagerSpring spring = Configured(3, 0);
  RouterHarness h;
  const double start = h.t;
  for (const gesture::Action& action : h.Send(gesture::TouchPhase::kBegan, -40, 0, &pager_target).actions)
    gesture::ApplyToPager(spring, action, kWidth);
  for (int i = 0; i < 10; ++i) {
    for (const gesture::Action& action : h.Send(gesture::TouchPhase::kChanged, -40, 0).actions)
      gesture::ApplyToPager(spring, action, kWidth);
    spring.StepFrame(h.t);
  }
  for (const gesture::Action& action : h.Send(gesture::TouchPhase::kEnded, 0, 0).actions)
    gesture::ApplyToPager(spring, action, kWidth);
  double now = h.t;
  const Settle settle = RunFrames(spring, now);
  const double motion_to_rest = now - start;
  std::cout << "motion-to-rest " << std::lround(motion_to_rest * 1000) << " ms (settle "
            << std::lround(settle.seconds * 1000) << " ms, " << settle.frames << " frames)\n";
  EXPECT(spring.position() == 1);
  EXPECT(motion_to_rest <= 0.49);
}

void RouterWaitsForThePageToRefuseFirst() {
  gesture::Target page = NativePager();
  page.page_hit = true;
  const gesture::ContentState pending{gesture::ContentAck::kPending, false, true};
  const gesture::ContentState unconsumed{gesture::ContentAck::kUnconsumed, false, true};
  const gesture::ContentState overscrolled{gesture::ContentAck::kUnconsumed, true, true};
  const gesture::ContentState blocked{gesture::ContentAck::kUnconsumed, true, false};
  const gesture::ContentState consumed{gesture::ContentAck::kConsumed, false, true};
  RouterHarness h;
  const gesture::Result first = h.Send(gesture::TouchPhase::kBegan, -10, 0, &page);
  EXPECT(first.verdict == gesture::Verdict::kWaiting);
  EXPECT(!first.swallow);
  EXPECT(first.actions.empty());
  EXPECT(h.router.pending());
  EXPECT(h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &pending).verdict == gesture::Verdict::kWaiting);
  EXPECT(h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &unconsumed).verdict == gesture::Verdict::kWaiting);
  EXPECT(h.Send(gesture::TouchPhase::kChanged, -10, 0).verdict == gesture::Verdict::kWaiting);
  EXPECT(!h.router.tracking());
  const gesture::Result claimed = h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &overscrolled);
  EXPECT(claimed.verdict == gesture::Verdict::kTracking);
  EXPECT(claimed.swallow);
  EXPECT(claimed.actions.size() == 1 && claimed.actions[0].input == PagerInput::kBegan);
  EXPECT(claimed.actions[0].distance == 50);

  RouterHarness taken;
  taken.Send(gesture::TouchPhase::kBegan, -10, 0, &page);
  EXPECT(taken.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &consumed).verdict ==
         gesture::Verdict::kContentConsumed);
  EXPECT(taken.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &overscrolled).actions.empty());

  RouterHarness refused;
  EXPECT(refused.Send(gesture::TouchPhase::kBegan, -10, 0, &page, &blocked).verdict ==
         gesture::Verdict::kOverscrollBlocked);
  EXPECT(!refused.router.pending() && !refused.router.tracking());

  RouterHarness stored;
  stored.Send(gesture::TouchPhase::kBegan, 0, 0, &page, &overscrolled);
  EXPECT(stored.Send(gesture::TouchPhase::kChanged, -10, 0).verdict == gesture::Verdict::kTracking);
}

void RouterBindsGesturesToTheirWindow() {
  const gesture::Target a = History(2);
  const gesture::Target b = History(3);
  RouterHarness h;
  h.Send(gesture::TouchPhase::kBegan, -10, 0, &a, nullptr, 100);
  EXPECT(h.router.tracking());
  const gesture::Result superseded = h.Send(gesture::TouchPhase::kBegan, -10, 0, &b, nullptr, 200);
  EXPECT(superseded.actions.size() == 2);
  EXPECT(superseded.actions[0].target == 2 && superseded.actions[0].input == PagerInput::kCancelled);
  EXPECT(superseded.actions[1].target == 3 && superseded.actions[1].input == PagerInput::kBegan);
  EXPECT(h.router.target() == 3);
  const gesture::Result late_change = h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, nullptr, 100);
  EXPECT(late_change.verdict == gesture::Verdict::kStale);
  EXPECT(late_change.actions.empty() && !late_change.swallow);
  const gesture::Result late_cancel = h.Send(gesture::TouchPhase::kCancelled, 0, 0, nullptr, nullptr, 100);
  EXPECT(late_cancel.verdict == gesture::Verdict::kStale);
  EXPECT(late_cancel.actions.empty());
  EXPECT(h.router.tracking());
  const gesture::Result own = h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, nullptr, 200);
  EXPECT(own.actions.size() == 1 && own.actions[0].target == 3 && own.actions[0].distance == 20);
  const gesture::Result ended = h.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 200);
  EXPECT(ended.actions.size() == 1 && ended.actions[0].input == PagerInput::kEnded);
  EXPECT(!h.router.Momentum(gesture::MomentumPhase::kBegan, h.t + 0.01, 100));

  RouterHarness armed;
  armed.Send(gesture::TouchPhase::kBegan, -10, 0, &a, nullptr, 100);
  armed.Send(gesture::TouchPhase::kBegan, -10, 0, &b, nullptr, 200);
  armed.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 100);
  armed.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 200);
  EXPECT(armed.router.Momentum(gesture::MomentumPhase::kBegan, armed.t + 0.01, 200));

  const gesture::Target pager_a = NativePager(4);
  RouterHarness native;
  native.Send(gesture::TouchPhase::kBegan, -10, 0, &pager_a, nullptr, 100);
  const gesture::Result taken = native.Send(gesture::TouchPhase::kBegan, 0, 0, &b, nullptr, 200);
  EXPECT(taken.actions.size() == 1 && taken.actions[0].target == 4 && taken.actions[0].input == PagerInput::kAbandon);

  RouterHarness prepared;
  prepared.Send(gesture::TouchPhase::kBegan, -10, 0, &a, nullptr, 100);
  prepared.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 100);
  prepared.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_a, nullptr, 300);
  EXPECT(prepared.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 100).actions.empty());
  EXPECT(prepared.router.prepared() == 4);
}

void ForgetReleasesThePagerItWasDriving() {
  const gesture::Target pager_target = NativePager();
  {
    PagerSpring spring = Configured(3, 0);
    RouterHarness h;
    const auto feed = [&](const gesture::Result& result) {
      for (const gesture::Action& action : result.actions) gesture::ApplyToPager(spring, action, kWidth);
    };
    feed(h.Send(gesture::TouchPhase::kBegan, -10, 0, &pager_target));
    for (int i = 0; i < 10; ++i) feed(h.Send(gesture::TouchPhase::kChanged, -120, 0));
    EXPECT(spring.phase() == PagerPhase::kTracking);
    const gesture::Result forgotten = h.router.Forget(1);
    EXPECT(forgotten.verdict == gesture::Verdict::kTargetGone);
    EXPECT(forgotten.actions.size() == 1 && forgotten.actions[0].input == PagerInput::kCancelled);
    feed(forgotten);
    EXPECT(spring.phase() == PagerPhase::kSettling);
    EXPECT(spring.selected() == 0);
    double now = h.t;
    RunFrames(spring, now);
    EXPECT(spring.phase() == PagerPhase::kIdle);
    EXPECT(spring.position() == 0);
    EXPECT(h.Send(gesture::TouchPhase::kEnded, 0, 0).actions.empty());
  }
  {
    PagerSpring spring = Configured(3, 0);
    EXPECT(spring.SwitchTo(2));
    double now = 0;
    for (int i = 0; i < 4; ++i) spring.StepFrame(now += kFrame);
    RouterHarness h;
    for (const gesture::Action& action : h.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_target).actions)
      gesture::ApplyToPager(spring, action, kWidth);
    EXPECT(spring.phase() == PagerPhase::kHolding);
    const gesture::Result forgotten = h.router.Forget(1);
    EXPECT(forgotten.actions.size() == 1 && forgotten.actions[0].input == PagerInput::kAbandon);
    for (const gesture::Action& action : forgotten.actions) gesture::ApplyToPager(spring, action, kWidth);
    EXPECT(spring.phase() == PagerPhase::kSettling);
    RunFrames(spring, now);
    EXPECT(spring.position() == 2);
    EXPECT(!h.router.prepared());
  }
  {
    const gesture::Target history = History();
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, 10, 0, &history);
    const gesture::Result forgotten = h.router.Forget(2);
    EXPECT(forgotten.actions.size() == 1 && forgotten.actions[0].input == PagerInput::kCancelled);
    EXPECT(!forgotten.actions[0].native_pager);
    EXPECT(h.router.Forget(2).actions.empty());
  }
  {
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, -10, 0, &pager_target);
    h.Send(gesture::TouchPhase::kEnded, 0, 0);
    h.router.Forget(1);
    EXPECT(!h.router.Momentum(gesture::MomentumPhase::kBegan, h.t + 0.01));
  }
}

void ReconfiguringDropsASupersededSelectionEvent() {
  const std::vector<std::string> abc = {"a", "b", "c"};
  const std::vector<std::string> ac = {"a", "c"};
  const std::vector<std::string> bac = {"b", "a", "c"};
  {
    PagerSpring spring;
    spring.Configure(3, 0, 0, &abc);
    spring.StepFrame(0);
    EXPECT(spring.SwitchTo(1));
    spring.Configure(2, 0, 0, &ac);
    const pager::Frame frame = spring.StepFrame(0.01);
    EXPECT(!frame.selected_changed);
    EXPECT(frame.selected == 0);
    EXPECT(spring.selected_id() == "a");
  }
  {
    PagerSpring spring;
    spring.Configure(3, 0, 0, &abc);
    spring.StepFrame(0);
    EXPECT(spring.SwitchTo(1));
    spring.Configure(3, 0, 0, &bac);
    const pager::Frame frame = spring.StepFrame(0.01);
    EXPECT(frame.selected_changed);
    EXPECT(frame.selected == 0);
    EXPECT(spring.selected_id() == "b");
    EXPECT(!spring.StepFrame(0.02).selected_changed);
  }
  {
    PagerSpring spring = Configured(3, 0);
    EXPECT(spring.SwitchTo(2));
    spring.Configure(4, 2, 0);
    const pager::Frame kept = spring.StepFrame(0.01);
    EXPECT(kept.selected_changed);
    EXPECT(kept.selected == 2);
  }
  {
    PagerSpring spring = Configured(3, 0);
    EXPECT(spring.SwitchTo(2));
    spring.Configure(2, 0, 0);
    EXPECT(!spring.StepFrame(0.01).selected_changed);
  }
  {
    PagerSpring spring;
    spring.Configure(3, 0, 0, &abc);
    EXPECT(spring.Select("c", abc));
    const int64_t picked = spring.selection_sequence();
    spring.Configure(3, 1, picked, &bac);
    EXPECT(spring.selected_id() == "a");
    EXPECT(!spring.StepFrame(0.01).selected_changed);
  }
}

void DetentCrossingsAreCountedWithinAFrame() {
  PagerSpring spring = Configured(3, 0);
  spring.Input(PagerInput::kBegan, 0, -1, kWidth, 0);
  spring.StepFrame(0);
  spring.Input(PagerInput::kChanged, 1100, -1, kWidth, 0.01);
  spring.Input(PagerInput::kChanged, 900, -1, kWidth, 0.02);
  const pager::Frame back_and_forth = spring.StepFrame(0.02);
  EXPECT(back_and_forth.detent_crossed);
  EXPECT(back_and_forth.detent_crossings == 2);
  const pager::Frame quiet = spring.StepFrame(0.03);
  EXPECT(!quiet.detent_crossed && quiet.detent_crossings == 0);

  PagerSpring wide = Configured(3, 1);
  wide.Input(PagerInput::kBegan, 0, 1, kWidth, 0);
  wide.Input(PagerInput::kChanged, 2000, 1, kWidth, 0.01);
  wide.Input(PagerInput::kChanged, 2000, -1, kWidth, 0.02);
  const pager::Frame jumped = wide.StepFrame(0.02);
  EXPECT(jumped.detent_crossings == 3);
}

void MomentumNeverPrecedesTheTouchEnd() {
  gesture::Target pager_target = NativePager();
  RouterHarness h;
  h.Send(gesture::TouchPhase::kBegan, -10, 0, &pager_target);
  h.Send(gesture::TouchPhase::kEnded, 0, 0);
  EXPECT(!h.router.Momentum(gesture::MomentumPhase::kBegan, h.t - 0.001));
  EXPECT(!h.router.Momentum(gesture::MomentumPhase::kBegan, h.t + 0.01));

  RouterHarness exact;
  exact.Send(gesture::TouchPhase::kBegan, -10, 0, &pager_target);
  exact.Send(gesture::TouchPhase::kEnded, 0, 0);
  EXPECT(exact.router.Momentum(gesture::MomentumPhase::kBegan, exact.t));

  RouterHarness edge;
  edge.Send(gesture::TouchPhase::kBegan, -10, 0, &pager_target);
  edge.Send(gesture::TouchPhase::kEnded, 0, 0);
  EXPECT(edge.router.Momentum(gesture::MomentumPhase::kBegan, edge.t + gesture::kMomentumStartWait));
}

void RouterReleasesAPagerPreparedBeforeItBegan() {
  const gesture::Target pager_target = NativePager();
  for (const gesture::TouchPhase finish : {gesture::TouchPhase::kCancelled, gesture::TouchPhase::kEnded}) {
    PagerSpring spring = Configured(3, 0);
    EXPECT(spring.SwitchTo(2));
    double now = 0;
    for (int i = 0; i < 4; ++i) spring.StepFrame(now += kFrame);
    RouterHarness h;
    const auto feed = [&](const gesture::Result& result) {
      for (const gesture::Action& action : result.actions) gesture::ApplyToPager(spring, action, kWidth);
    };
    feed(h.Send(gesture::TouchPhase::kMayBegin, 0, 0, &pager_target, nullptr, 42));
    EXPECT(spring.phase() == PagerPhase::kHolding);
    EXPECT(h.Send(finish, 0, 0, nullptr, nullptr, 7).actions.empty());
    EXPECT(spring.phase() == PagerPhase::kHolding);
    const gesture::Result released = h.Send(finish, 0, 0, nullptr, nullptr, 42);
    EXPECT(released.actions.size() == 1 && released.actions[0].input == PagerInput::kAbandon);
    feed(released);
    EXPECT(spring.phase() == PagerPhase::kSettling);
    RunFrames(spring, now);
    EXPECT(spring.position() == 2);
    EXPECT(!h.router.prepared());
  }
}

void RouterKeepsEachWindowsStateApart() {
  const gesture::Target a = NativePager(1);
  const gesture::Target b = NativePager(2);
  {
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, 0, 0, &a, nullptr, 1);
    EXPECT(h.router.pending());
    h.Send(gesture::TouchPhase::kMayBegin, 0, 0, &b, nullptr, 2);
    EXPECT(h.router.prepared() == 2);
    const gesture::Result rejected = h.Send(gesture::TouchPhase::kChanged, 0, 20, nullptr, nullptr, 1);
    EXPECT(rejected.verdict == gesture::Verdict::kVerticalIntent);
    EXPECT(rejected.actions.empty());
    EXPECT(h.router.prepared() == 2);
    EXPECT(h.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 1).actions.empty());
    const gesture::Result own = h.Send(gesture::TouchPhase::kCancelled, 0, 0, nullptr, nullptr, 2);
    EXPECT(own.actions.size() == 1 && own.actions[0].target == 2 && own.actions[0].input == PagerInput::kAbandon);
  }
  {
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, -10, 0, &b, nullptr, 2);
    h.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 2);
    h.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 1);
    h.Send(gesture::TouchPhase::kMayBegin, 0, 0, nullptr, nullptr, 1);
    EXPECT(!h.router.Momentum(gesture::MomentumPhase::kBegan, h.t, 1));
    EXPECT(h.router.Momentum(gesture::MomentumPhase::kBegan, h.t + 0.01, 2));
    EXPECT(h.router.Momentum(gesture::MomentumPhase::kEnded, h.t + 0.2, 2));
  }
  {
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, -10, 0, &b, nullptr, 2);
    h.Send(gesture::TouchPhase::kEnded, 0, 0, nullptr, nullptr, 2);
    h.Send(gesture::TouchPhase::kBegan, 0, 0, &a, nullptr, 1);
    EXPECT(!h.router.Momentum(gesture::MomentumPhase::kBegan, h.t, 2));
  }
}

void ContentRefusalLatchesForTheGesture() {
  gesture::Target page = NativePager();
  page.page_hit = true;
  const gesture::ContentState consumed{gesture::ContentAck::kConsumed, false, true};
  const gesture::ContentState unconsumed{gesture::ContentAck::kUnconsumed, false, true};
  const gesture::ContentState overscrolled{gesture::ContentAck::kUnconsumed, true, true};
  const gesture::ContentState blocked{gesture::ContentAck::kUnconsumed, true, false};
  {
    RouterHarness h;
    EXPECT(h.Send(gesture::TouchPhase::kBegan, 0, 0, &page, &consumed).verdict == gesture::Verdict::kWaiting);
    EXPECT(h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &overscrolled).verdict ==
           gesture::Verdict::kContentConsumed);
    EXPECT(!h.router.tracking());
  }
  {
    RouterHarness h;
    EXPECT(h.Send(gesture::TouchPhase::kBegan, 0, 0, &page, &blocked).verdict == gesture::Verdict::kWaiting);
    EXPECT(h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &overscrolled).verdict ==
           gesture::Verdict::kOverscrollBlocked);
    EXPECT(!h.router.tracking());
  }
  {
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, 0, 0, &page, &unconsumed);
    EXPECT(h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &consumed).verdict == gesture::Verdict::kWaiting);
    EXPECT(h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, &overscrolled).verdict ==
           gesture::Verdict::kTracking);
  }
  {
    RouterHarness h;
    h.Send(gesture::TouchPhase::kBegan, 0, 0, &page, &consumed);
    h.Send(gesture::TouchPhase::kEnded, 0, 0);
    h.Send(gesture::TouchPhase::kBegan, 0, 0, &page, &overscrolled);
    EXPECT(h.Send(gesture::TouchPhase::kChanged, -10, 0).verdict == gesture::Verdict::kTracking);
  }
}

void ARemovedProfileDoesNotReviveItsSelectionEvent() {
  const std::vector<std::string> abc = {"a", "b", "c"};
  const std::vector<std::string> ac = {"a", "c"};
  for (const bool by_select : {true, false}) {
    PagerSpring spring;
    spring.Configure(3, 0, 0, &abc);
    spring.StepFrame(0);
    if (by_select) {
      EXPECT(spring.Select("b", abc));
    } else {
      EXPECT(spring.SwitchTo(1));
    }
    const int64_t picked = spring.selection_sequence();
    spring.Configure(2, 0, 0, &ac);
    spring.Configure(3, 1, picked, &abc);
    EXPECT(spring.selected_id() == "b");
    EXPECT(!spring.StepFrame(0.01).selected_changed);
  }
  PagerSpring kept;
  kept.Configure(3, 0, 0, &abc);
  kept.StepFrame(0);
  EXPECT(kept.Select("b", abc));
  const std::vector<std::string> cba = {"c", "b", "a"};
  kept.Configure(3, 2, 0, &cba);
  kept.Configure(3, 1, 0, &abc);
  EXPECT(kept.selected_id() == "b");
  EXPECT(kept.StepFrame(0.01).selected_changed);
}

void ATouchInAnotherWindowReleasesItsOwnPreparedPager() {
  const gesture::Target live = NativePager(7);
  const gesture::Target held = NativePager(42);
  for (const bool tracking : {false, true}) {
    for (const gesture::TouchPhase finish : {gesture::TouchPhase::kEnded, gesture::TouchPhase::kCancelled}) {
      PagerSpring spring = Configured(3, 0);
      EXPECT(spring.SwitchTo(2));
      double now = 0;
      for (int i = 0; i < 4; ++i) spring.StepFrame(now += kFrame);
      RouterHarness h;
      const auto feed = [&](const gesture::Result& result) {
        for (const gesture::Action& action : result.actions) {
          if (action.target == 42) gesture::ApplyToPager(spring, action, kWidth);
        }
      };
      h.Send(gesture::TouchPhase::kBegan, tracking ? -10 : 0, 0, &live, nullptr, 7);
      EXPECT(tracking ? h.router.tracking() : h.router.pending());
      feed(h.Send(gesture::TouchPhase::kMayBegin, 0, 0, &held, nullptr, 42));
      EXPECT(spring.phase() == PagerPhase::kHolding);
      const gesture::Result released = h.Send(finish, 0, 0, nullptr, nullptr, 42);
      EXPECT(released.verdict == gesture::Verdict::kStale);
      EXPECT(released.actions.size() == 1);
      EXPECT(released.actions[0].target == 42 && released.actions[0].input == PagerInput::kAbandon);
      EXPECT(!released.swallow);
      feed(released);
      EXPECT(spring.phase() == PagerPhase::kSettling);
      RunFrames(spring, now);
      EXPECT(spring.position() == 2);
      EXPECT(!h.router.prepared());
      EXPECT(h.router.target() == 7);
      EXPECT(tracking ? h.router.tracking() : h.router.pending());
      EXPECT(h.Send(finish, 0, 0, nullptr, nullptr, 42).actions.empty());
      const gesture::Result own = h.Send(gesture::TouchPhase::kChanged, -10, 0, nullptr, nullptr, 7);
      EXPECT(own.verdict == gesture::Verdict::kTracking);
      EXPECT(own.actions.size() == 1 && own.actions[0].target == 7);
      EXPECT(own.actions[0].input == (tracking ? PagerInput::kChanged : PagerInput::kBegan));
      EXPECT(own.actions[0].distance == (tracking ? 20 : 10));
    }
  }
}

void FastFlicksNeverOvershootTheTarget() {
  for (const bool forward : {true, false}) {
    PagerSpring spring = Configured(3, forward ? 0 : 2);
    const int direction = forward ? -1 : 1;
    double t = 0;
    spring.Input(PagerInput::kBegan, 0, direction, kWidth, t);
    for (int i = 1; i <= 4; ++i) spring.Input(PagerInput::kChanged, 450.0 * i, direction, kWidth, t += 0.01);
    spring.Input(PagerInput::kEnded, 1800, direction, kWidth, t);
    EXPECT_NEAR(spring.position(), forward ? 0.9 : 1.1, 1e-12);
    EXPECT(spring.selected() == 1);
    EXPECT(std::abs(spring.velocity()) <= pager::kOmega * 0.1 + 1e-12);
    double now = t;
    bool beyond = false;
    for (int i = 0; i < 600 && spring.phase() != PagerPhase::kIdle; ++i) {
      const pager::Frame frame = spring.StepFrame(now += kFrame);
      if (forward ? frame.position > 1.0 : frame.position < 1.0) beyond = true;
    }
    EXPECT(!beyond);
    EXPECT(spring.position() == 1);
    EXPECT(now - t <= 0.3);
  }
  for (const double start : {0.05, 0.3, 0.6, 0.95}) {
    for (const double speed : {0.5, 2.0, 8.0, 40.0}) {
      PagerSpring spring = Configured(3, 0);
      double t = 0;
      const double distance = start * kWidth / pager::kTrackingScale;
      spring.Input(PagerInput::kBegan, 0, -1, kWidth, t);
      spring.Input(PagerInput::kChanged, distance - speed * 0.05 * kWidth / pager::kTrackingScale, -1, kWidth,
                   t += 0.05);
      spring.Input(PagerInput::kChanged, distance, -1, kWidth, t += 0.05);
      spring.Input(PagerInput::kEnded, distance, -1, kWidth, t);
      double now = t;
      const Settle settle = RunFrames(spring, now);
      EXPECT(!settle.overshoot);
      EXPECT(settle.monotonic);
      EXPECT(settle.seconds > 0);
    }
  }
  PagerSpring carried = Configured(3, 0);
  EXPECT(carried.SwitchTo(2));
  double now = 0;
  for (int i = 0; i < 12; ++i) carried.StepFrame(now += kFrame);
  EXPECT(carried.SwitchTo(1));
  EXPECT(std::abs(carried.velocity()) <= pager::kOmega * std::abs(1 - carried.position()) + 1e-12);
  const Settle settle = RunFrames(carried, now);
  EXPECT(!settle.overshoot);
  EXPECT(carried.position() == 1);
}

struct Case {
  const char* name;
  void (*run)();
};

}

int main() {
  const auto cases = std::to_array<Case>({
      {"constants match the macOS pager", ConstantsMatchMacPager},
      {"tracking is half scale", TrackingIsHalfScale},
      {"rubber bands past the ends", RubberBandsPastTheEnds},
      {"short drag snaps back critically damped", ShortDragSnapsBackCriticallyDamped},
      {"past halfway commits without flick", PastHalfwayCommitsWithoutFlick},
      {"flick velocity crosses the threshold", FlickVelocityCrossesTheThreshold},
      {"detent crossings are reported once", DetentCrossingsAreReportedOnce},
      {"prepare holds and abandon resettles", PrepareHoldsAndAbandonResettles},
      {"order changes follow the unacknowledged selection", OrderChangesFollowTheUnacknowledgedSelection},
      {"reduced motion snaps instantly", ReducedMotionSnapsInstantly},
      {"switch, step and select", SwitchStepAndSelect},
      {"adversarial inputs stay bounded", AdversarialInputsStayBounded},
      {"router starts on axis dominance", RouterStartsOnAxisDominance},
      {"router cancels on vertical dominance for non-pagers", RouterCancelsOnVerticalDominanceForNonPagers},
      {"router rejects scrollable descendants and unavailable directions",
       RouterRejectsScrollableDescendantsAndUnavailableDirections},
      {"router prepares and abandons pagers", RouterPreparesAndAbandonsPagers},
      {"router swallows only its own momentum", RouterSwallowsOnlyItsOwnMomentum},
      {"router survives adversarial input", RouterSurvivesAdversarialInput},
      {"router drives the pager end to end", RouterDrivesThePagerEndToEnd},
      {"motion to rest beats the WebUI spike", MotionToRestBeatsTheWebUiSpike},
      {"router waits for the page to refuse first", RouterWaitsForThePageToRefuseFirst},
      {"router binds gestures to their window", RouterBindsGesturesToTheirWindow},
      {"forget releases the pager it was driving", ForgetReleasesThePagerItWasDriving},
      {"reconfiguring drops a superseded selection event", ReconfiguringDropsASupersededSelectionEvent},
      {"detent crossings are counted within a frame", DetentCrossingsAreCountedWithinAFrame},
      {"momentum never precedes the touch end", MomentumNeverPrecedesTheTouchEnd},
      {"router releases a pager prepared before it began", RouterReleasesAPagerPreparedBeforeItBegan},
      {"router keeps each window's state apart", RouterKeepsEachWindowsStateApart},
      {"content refusal latches for the gesture", ContentRefusalLatchesForTheGesture},
      {"a removed profile does not revive its selection event", ARemovedProfileDoesNotReviveItsSelectionEvent},
      {"a touch in another window releases its own prepared pager", ATouchInAnotherWindowReleasesItsOwnPreparedPager},
      {"fast flicks never overshoot the target", FastFlicksNeverOvershootTheTarget},
  });
  for (const Case& test : cases) {
    current = test.name;
    const int before = failures;
    test.run();
    std::cout << (failures == before ? "ok   " : "FAIL ") << test.name << "\n";
  }
  std::cout << failures << " failure(s)\n";
  return failures ? 1 : 0;
}
