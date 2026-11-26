#include "ardia/mac/ac_mac_swipe_policy.h"

#include <cstdint>
#include <limits>
#include <optional>

#include "check.h"

namespace sp = ardia_mac::swipe_policy;

sp::AckEvent At(sp::Ack ack, std::int64_t time = 1, bool main = true) {
  return sp::AckEvent{ack, time, main};
}

TEST(appkit_phase_masks_map_to_one_phase) {
  CHECK(sp::PhaseOf(0) == sp::Phase::kNone);
  CHECK(sp::PhaseOf(sp::kPhaseMayBegin) == sp::Phase::kMayBegin);
  CHECK(sp::PhaseOf(sp::kPhaseBegan) == sp::Phase::kBegan);
  CHECK(sp::PhaseOf(sp::kPhaseChanged) == sp::Phase::kChanged);
  CHECK(sp::PhaseOf(sp::kPhaseStationary) == sp::Phase::kChanged);
  CHECK(sp::PhaseOf(sp::kPhaseEnded) == sp::Phase::kEnded);
  CHECK(sp::PhaseOf(sp::kPhaseCancelled) == sp::Phase::kCancelled);
  CHECK(sp::PhaseOf(sp::kPhaseBegan | sp::kPhaseEnded) == sp::Phase::kEnded);
  CHECK(sp::PhaseOf(sp::kPhaseMayBegin | sp::kPhaseCancelled) == sp::Phase::kCancelled);
  CHECK(sp::PhaseOf(1u << 9) == sp::Phase::kNone);
  CHECK(sp::PhaseName(sp::Phase::kMayBegin) == "mayBegin");
  CHECK(sp::PhaseName(sp::Phase::kNone) == "none");
}

TEST(live_drags_momentum_and_wheel_clicks_are_told_apart_without_timing) {
  CHECK(sp::Classify(sp::Phase::kNone, sp::Phase::kNone, false) == sp::Kind::kWheel);
  CHECK(sp::Classify(sp::Phase::kNone, sp::Phase::kNone, true) == sp::Kind::kWheel);
  CHECK(sp::Classify(sp::Phase::kBegan, sp::Phase::kNone, true) == sp::Kind::kGesture);
  CHECK(sp::Classify(sp::Phase::kChanged, sp::Phase::kNone, true) == sp::Kind::kGesture);
  CHECK(sp::Classify(sp::Phase::kNone, sp::Phase::kBegan, true) == sp::Kind::kMomentum);
  CHECK(sp::Classify(sp::Phase::kNone, sp::Phase::kChanged, true) == sp::Kind::kMomentum);
  CHECK(sp::Classify(sp::Phase::kChanged, sp::Phase::kNone, false) == sp::Kind::kIgnored);
  CHECK(sp::KindPhaseName(sp::Kind::kWheel, sp::Phase::kNone) == "wheel");
  CHECK(sp::KindPhaseName(sp::Kind::kMomentum, sp::Phase::kNone) == "none");
}

TEST(deltas_points_and_times_are_finite_and_bounded) {
  CHECK(!sp::Delta(std::numeric_limits<double>::quiet_NaN()));
  CHECK(!sp::Delta(std::numeric_limits<double>::infinity()));
  CHECK(*sp::Delta(1e9) == sp::kDeltaLimit);
  CHECK(*sp::Delta(-1e9) == -sp::kDeltaLimit);
  CHECK(*sp::Delta(-3.5) == -3.5);
  CHECK(sp::FinitePoint(10, 20));
  CHECK(!sp::FinitePoint(std::numeric_limits<double>::quiet_NaN(), 0));
  CHECK(!sp::FinitePoint(0, 2e6));
  CHECK(sp::FiniteTime(0));
  CHECK(!sp::FiniteTime(-1));
  CHECK(!sp::FiniteTime(std::numeric_limits<double>::infinity()));
}

TEST(a_gesture_keeps_the_surface_it_began_on_and_its_momentum_follows) {
  sp::RouteLatch latch;
  CHECK(latch.Next(sp::Kind::kGesture, sp::Phase::kMayBegin, sp::Route::kShell) == sp::Route::kShell);
  CHECK(latch.Next(sp::Kind::kGesture, sp::Phase::kBegan, sp::Route::kShell) == sp::Route::kShell);
  CHECK(latch.TakeAbandoned() == sp::Route::kNone);
  CHECK(latch.Next(sp::Kind::kGesture, sp::Phase::kChanged, sp::Route::kPage) == sp::Route::kShell);
  CHECK(latch.Next(sp::Kind::kGesture, sp::Phase::kEnded, sp::Route::kNone) == sp::Route::kShell);
  CHECK(latch.Next(sp::Kind::kMomentum, sp::Phase::kNone, sp::Route::kPage) == sp::Route::kShell);
  CHECK(latch.Next(sp::Kind::kWheel, sp::Phase::kNone, sp::Route::kPage) == sp::Route::kPage);
  CHECK(latch.Next(sp::Kind::kIgnored, sp::Phase::kChanged, sp::Route::kShell) == sp::Route::kNone);
  CHECK(latch.Next(sp::Kind::kGesture, sp::Phase::kBegan, sp::Route::kPage) == sp::Route::kPage);
  CHECK(latch.TakeAbandoned() == sp::Route::kNone);
  latch.Reset();
  CHECK(latch.Next(sp::Kind::kMomentum, sp::Phase::kNone, sp::Route::kShell) == sp::Route::kNone);
}

TEST(a_gesture_that_retargets_or_is_interrupted_names_the_route_it_left) {
  sp::RouteLatch latch;
  latch.Next(sp::Kind::kGesture, sp::Phase::kMayBegin, sp::Route::kShell);
  CHECK(latch.Next(sp::Kind::kGesture, sp::Phase::kBegan, sp::Route::kPage) == sp::Route::kPage);
  CHECK(latch.TakeAbandoned() == sp::Route::kShell);
  CHECK(latch.TakeAbandoned() == sp::Route::kNone);
  CHECK(latch.Interrupt() == sp::Route::kPage);
  CHECK(latch.Next(sp::Kind::kGesture, sp::Phase::kChanged, sp::Route::kShell) == sp::Route::kNone);
  latch.Next(sp::Kind::kGesture, sp::Phase::kBegan, sp::Route::kShell);
  latch.Next(sp::Kind::kGesture, sp::Phase::kEnded, sp::Route::kShell);
  CHECK(latch.Interrupt() == sp::Route::kNone);
}

void Opened(sp::PageSwipe& swipe, std::uint64_t gesture = 1) {
  swipe.Begin(true, gesture, 1);
  swipe.Acknowledge(At(sp::Ack::kWheelBegan));
  swipe.Acknowledge(At(sp::Ack::kScrollBegin));
}

TEST(a_page_swipe_starts_after_an_unconsumed_first_update_and_horizontal_intent) {
  sp::PageSwipe swipe;
  swipe.Begin(true, 7, 1);
  CHECK(swipe.pending());
  CHECK(swipe.gesture() == 7);
  CHECK(!swipe.Scroll(2, 0));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollBegin)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kWheelBegan)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollBegin)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  CHECK(swipe.pending());
  const std::optional<sp::Step> began = swipe.Scroll(3, 1);
  CHECK(began && began->phase == sp::Phase::kBegan);
  CHECK(began && began->dx == 5 && began->dy == 1);
  const std::optional<sp::Step> changed = swipe.Scroll(12, 0);
  CHECK(changed && changed->phase == sp::Phase::kChanged && changed->dx == 12);
  CHECK(swipe.Claim(7, true));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollConsumed)));
  const std::optional<sp::Step> ended = swipe.End(false);
  CHECK(ended && ended->phase == sp::Phase::kEnded);
  CHECK(!swipe.Scroll(5, 0));
  CHECK(!swipe.End(false));
}

TEST(a_small_vertical_start_waits_and_a_later_consumed_update_gives_the_page_its_gesture) {
  sp::PageSwipe swipe;
  Opened(swipe);
  swipe.Scroll(1, 2);
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  CHECK(!swipe.tracking());
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollConsumed)));
  CHECK(swipe.page_owned());
  CHECK(!swipe.Scroll(40, 0));
  CHECK(!swipe.End(false));

  sp::PageSwipe vertical;
  Opened(vertical);
  vertical.Acknowledge(At(sp::Ack::kScrollUnconsumed));
  CHECK(!vertical.Scroll(1, 10));
  CHECK(vertical.page_owned());
}

TEST(a_page_that_scrolls_or_prevents_the_wheel_keeps_its_gesture) {
  sp::PageSwipe scrolled;
  Opened(scrolled);
  scrolled.Scroll(-20, 0);
  CHECK(!scrolled.Acknowledge(At(sp::Ack::kScrollConsumed)));
  CHECK(scrolled.page_owned());
  CHECK(!scrolled.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  CHECK(!scrolled.Scroll(-20, 0));
  CHECK(!scrolled.End(false));

  sp::PageSwipe prevented;
  prevented.Begin(true, 2, 1);
  prevented.Scroll(15, 0);
  prevented.Acknowledge(At(sp::Ack::kWheelBegan));
  CHECK(!prevented.Acknowledge(At(sp::Ack::kWheelConsumed)));
  CHECK(prevented.page_owned());
  CHECK(!prevented.Acknowledge(At(sp::Ack::kScrollBegin)));
  CHECK(!prevented.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  CHECK(!prevented.End(false));
}

TEST(stale_acks_from_an_earlier_gesture_never_start_or_end_a_swipe) {
  sp::PageSwipe swipe;
  swipe.Begin(true, 3, 1);
  swipe.Scroll(10, 0);
  CHECK(!swipe.Acknowledge(At(sp::Ack::kWheelConsumed)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollBegin)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollConsumed)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  CHECK(swipe.pending());
  CHECK(!swipe.End(false));
}

TEST(swipes_stay_off_when_the_system_setting_or_page_says_so) {
  sp::PageSwipe swipe;
  swipe.Begin(false, 4, 1);
  CHECK(!swipe.pending());
  swipe.Acknowledge(At(sp::Ack::kWheelBegan));
  swipe.Acknowledge(At(sp::Ack::kScrollBegin));
  CHECK(!swipe.Scroll(30, 0));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  CHECK(!swipe.End(false));
}

TEST(only_a_swipe_the_shell_claimed_swallows_and_only_its_horizontal_motion) {
  sp::PageSwipe swipe;
  Opened(swipe, 9);
  swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed));
  CHECK(swipe.Scroll(6, 0));
  CHECK(swipe.tracking());
  CHECK(!swipe.Swallows());
  CHECK(!swipe.Claim(8, true));
  CHECK(!swipe.Swallows());
  CHECK(swipe.Claim(9, true));
  CHECK(swipe.Swallows());
  swipe.Scroll(0, 30);
  CHECK(!swipe.Swallows());
  swipe.Scroll(60, 0);
  CHECK(swipe.Swallows());
  CHECK(swipe.Claim(9, false));
  CHECK(!swipe.Swallows());
  const std::optional<sp::Step> cancelled = swipe.End(true);
  CHECK(cancelled && cancelled->phase == sp::Phase::kCancelled);
  CHECK(!swipe.claimed());
  CHECK(!swipe.Claim(9, true));
  CHECK(!swipe.Swallows());
}

TEST(a_new_gesture_starts_from_a_clean_slate) {
  sp::PageSwipe swipe;
  Opened(swipe, 1);
  swipe.Scroll(8, 0);
  swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed));
  swipe.Claim(1, true);
  swipe.Begin(true, 2, 1);
  CHECK(swipe.pending());
  CHECK(!swipe.claimed());
  CHECK(swipe.gesture() == 2);
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  swipe.Acknowledge(At(sp::Ack::kWheelBegan));
  swipe.Acknowledge(At(sp::Ack::kScrollBegin));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  const std::optional<sp::Step> began = swipe.Scroll(5, 0);
  CHECK(began && began->phase == sp::Phase::kBegan && began->dx == 5);
}

TEST(claimed_gesture_ids_are_whole_positive_and_bounded) {
  CHECK(sp::GestureId(1.0) == 1u);
  CHECK(sp::GestureId(42.0) == 42u);
  CHECK(!sp::GestureId(std::nullopt));
  CHECK(!sp::GestureId(0.0));
  CHECK(!sp::GestureId(-3.0));
  CHECK(!sp::GestureId(1.5));
  CHECK(!sp::GestureId(1e300));
  CHECK(!sp::GestureId(std::numeric_limits<double>::quiet_NaN()));
  CHECK(!sp::GestureId(std::numeric_limits<double>::infinity()));
  CHECK(sp::HorizontalIntent(-4, 2));
  CHECK(!sp::HorizontalIntent(3, 0));
  CHECK(!sp::HorizontalIntent(4, 7));
  CHECK(sp::VerticalIntent(1, 5));
  CHECK(!sp::VerticalIntent(3, 5));
}

TEST(late_acks_from_an_earlier_gesture_never_authorize_the_next_one) {
  sp::PageSwipe swipe;
  swipe.Begin(true, 2, 10'000'000);
  CHECK(!swipe.Acknowledge(At(sp::Ack::kWheelBegan, 10'000'000)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollBegin, 9'999'600)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed, 9'999'800)));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed, 9'999'999)));
  CHECK(!swipe.Scroll(12, 0));
  CHECK(swipe.pending());
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollConsumed, 9'999'999)));
  CHECK(swipe.pending());
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollBegin, 10'000'000)));
  const std::optional<sp::Step> began = swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed, 10'000'000));
  CHECK(began && began->phase == sp::Phase::kBegan && began->dx == 12);
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollConsumed, 9'999'999)));
  CHECK(swipe.tracking());
  sp::PageSwipe unstarted;
  unstarted.Begin(true, 3, 0);
  CHECK(!unstarted.pending());
}

TEST(vertical_motion_latches_before_any_ack_arrives) {
  sp::PageSwipe swipe;
  swipe.Begin(true, 4, 1);
  CHECK(!swipe.Scroll(1, 10));
  CHECK(swipe.page_owned());
  CHECK(!swipe.Scroll(20, 0));
  swipe.Acknowledge(At(sp::Ack::kWheelBegan));
  swipe.Acknowledge(At(sp::Ack::kScrollBegin));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  CHECK(!swipe.tracking());
  CHECK(!swipe.End(false));
}

TEST(a_consumed_update_cancels_a_swipe_the_shell_has_not_claimed_yet) {
  sp::PageSwipe swipe;
  Opened(swipe, 5);
  swipe.Scroll(10, 0);
  CHECK(swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed)));
  const std::optional<sp::Step> cancelled = swipe.Acknowledge(At(sp::Ack::kScrollConsumed, 2));
  CHECK(cancelled && cancelled->phase == sp::Phase::kCancelled);
  CHECK(swipe.page_owned());
  CHECK(!swipe.Claim(5, true));
  CHECK(!swipe.Swallows());
  CHECK(!swipe.Scroll(10, 0));
  CHECK(!swipe.End(false));

  sp::PageSwipe claimed;
  Opened(claimed, 6);
  claimed.Scroll(10, 0);
  claimed.Acknowledge(At(sp::Ack::kScrollUnconsumed));
  CHECK(claimed.Claim(6, true));
  CHECK(!claimed.Acknowledge(At(sp::Ack::kScrollConsumed, 2)));
  CHECK(claimed.tracking());
}

TEST(a_child_frame_widget_opens_the_gesture_but_only_the_page_widget_can_start_it) {
  sp::PageSwipe swipe;
  swipe.Begin(true, 7, 1);
  swipe.Scroll(12, 0);
  swipe.Acknowledge(At(sp::Ack::kWheelBegan, 1, false));
  swipe.Acknowledge(At(sp::Ack::kScrollBegin, 1, false));
  CHECK(!swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed, 1, false)));
  CHECK(swipe.pending());
  swipe.Acknowledge(At(sp::Ack::kScrollBegin, 1, true));
  const std::optional<sp::Step> began = swipe.Acknowledge(At(sp::Ack::kScrollUnconsumed, 1, true));
  CHECK(began && began->phase == sp::Phase::kBegan);

  sp::PageSwipe child;
  Opened(child, 8);
  child.Scroll(12, 0);
  CHECK(!child.Acknowledge(At(sp::Ack::kScrollConsumed, 1, false)));
  CHECK(child.page_owned());
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
