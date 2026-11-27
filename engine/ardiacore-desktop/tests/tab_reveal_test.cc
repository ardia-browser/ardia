#include <cstdlib>
#include <functional>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/desktop/ac_desktop_tab_reveal.h"

namespace reveal = ardia::desktop_tab_reveal;
using reveal::Reveal;
using reveal::RevealAction;
using reveal::SwitchKind;
using reveal::TabId;
using reveal::TabRevealCoordinator;
using reveal::TabSurfaceState;
using Steps = std::vector<Reveal>;

namespace {

int failures = 0;
int checks = 0;

void Expect(bool ok, std::string_view what, int line) {
  ++checks;
  if (ok) return;
  ++failures;
  std::cerr << "tab_reveal_test.cc:" << line << ": expected " << what << "\n";
}

#define EXPECT(condition) Expect((condition), #condition, __LINE__)

constexpr reveal::PaneId kPane = 1;
constexpr reveal::PaneId kRight = 2;
constexpr TabId kA = 10;
constexpr TabId kB = 20;
constexpr TabId kC = 30;
constexpr TabId kD = 35;
constexpr TabId kNewTab = 40;
constexpr int32_t kWidth = 1200;
constexpr int32_t kHeight = 800;
constexpr int64_t kForever = std::numeric_limits<int64_t>::max();

TabSurfaceState Live(TabId tab, int32_t width = kWidth, int32_t height = kHeight) {
  TabSurfaceState state;
  state.tab_id = tab;
  state.has_committed_frame = true;
  state.surface_width = width;
  state.surface_height = height;
  return state;
}

TabSurfaceState Cold(TabId tab) {
  TabSurfaceState state;
  state.tab_id = tab;
  return state;
}

TabSurfaceState DomOnly(TabId tab) {
  TabSurfaceState state;
  state.tab_id = tab;
  state.is_dom_only = true;
  return state;
}

Reveal Last(const Steps& steps) {
  EXPECT(!steps.empty());
  return steps.empty() ? Reveal{} : steps.back();
}

Steps Frame(TabRevealCoordinator& coordinator, TabId tab, int32_t width, int32_t height, int64_t now) {
  return coordinator.OnTargetFrameCommitted(tab, coordinator.EpochOf(tab), width, height, now);
}

bool Hides(const Reveal& step, std::vector<TabId> wanted) {
  if (step.hide.size() != wanted.size()) return false;
  for (TabId tab : wanted) {
    bool found = false;
    for (TabId hidden : step.hide) found = found || hidden == tab;
    if (!found) return false;
  }
  return true;
}

void ExpectBalancedHolds(const TabRevealCoordinator& coordinator) {
  const reveal::RevealStats& stats = coordinator.stats();
  EXPECT(stats.hold_count == stats.held_until_frame + stats.deadline_fallbacks + stats.dropped_holds);
  EXPECT(stats.hold_duration_ms_max <= stats.hold_duration_ms_sum);
}

TabRevealCoordinator ShowingA() {
  TabRevealCoordinator coordinator;
  coordinator.ResizePane(kPane, kWidth, kHeight, 0);
  coordinator.UpdateTab(Live(kA), 0);
  coordinator.Switch(kPane, kA, 0);
  coordinator.TakeStats();
  return coordinator;
}

void InstantRevealOfALiveMatchingTab() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kB, kWidth + 1, kHeight - 1), 5);
  const Steps steps = coordinator.Switch(kPane, kB, 10);
  EXPECT(steps.size() == 1);
  const Reveal step = Last(steps);
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(step.kind == SwitchKind::kInstant);
  EXPECT(step.visible == kB);
  EXPECT(Hides(step, {kA}));
  EXPECT(step.awaiting == reveal::kNoTab);
  EXPECT(!coordinator.IsHolding(kPane));
  EXPECT(!coordinator.NextDeadlineMs().has_value());
  EXPECT(coordinator.stats().instant_reveals == 1);
  EXPECT(coordinator.stats().hold_count == 0);
}

void ExactSizeRequiredWithZeroTolerance() {
  TabRevealCoordinator coordinator(reveal::RevealConfig{150, 0});
  coordinator.ResizePane(kPane, kWidth, kHeight, 0);
  coordinator.UpdateTab(Live(kA), 0);
  coordinator.Switch(kPane, kA, 0);
  coordinator.UpdateTab(Live(kB, kWidth + 1, kHeight), 0);
  EXPECT(Last(coordinator.Switch(kPane, kB, 1)).action == RevealAction::kHoldPrevious);
}

void ColdTargetHoldsUntilItsFrame() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Cold(kB), 0);
  const Reveal step = Last(coordinator.Switch(kPane, kB, 100));
  EXPECT(step.action == RevealAction::kHoldPrevious);
  EXPECT(step.visible == kA);
  EXPECT(step.awaiting == kB);
  EXPECT(step.awaiting_epoch == coordinator.EpochOf(kB));
  EXPECT(step.awaiting_epoch != reveal::kNoEpoch);
  EXPECT(step.deadline_ms == 250);
  EXPECT(step.hide.empty());
  EXPECT(coordinator.NextDeadlineMs() == 250);
  EXPECT(coordinator.Tick(149).empty());
  const Steps settled = Frame(coordinator, kB, kWidth, kHeight, 160);
  EXPECT(settled.size() == 1);
  EXPECT(Last(settled).action == RevealAction::kShowTargetNow);
  EXPECT(Last(settled).visible == kB);
  EXPECT(Hides(Last(settled), {kA}));
  EXPECT(coordinator.VisibleTab(kPane) == kB);
  EXPECT(coordinator.Tick(1000).empty());
  ExpectBalancedHolds(coordinator);
  const reveal::RevealStats stats = coordinator.TakeStats();
  EXPECT(stats.held_until_frame == 1);
  EXPECT(stats.deadline_fallbacks == 0);
  EXPECT(stats.hold_duration_ms_sum == 60);
  EXPECT(stats.hold_duration_ms_max == 60);
  EXPECT(coordinator.stats().held_until_frame == 0);
}

void StaleSizedFrameKeepsWaiting() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kB, 600, 400), 0);
  EXPECT(Last(coordinator.Switch(kPane, kB, 0)).action == RevealAction::kHoldPrevious);
  EXPECT(Frame(coordinator, kB, 600, 400, 10).empty());
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(Frame(coordinator, kB, kWidth, kHeight, 20).size() == 1);
}

void DeadlineFallsBack() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 1000);
  const Steps settled = coordinator.Tick(1150);
  EXPECT(settled.size() == 1);
  EXPECT(Last(settled).action == RevealAction::kShowTargetNow);
  EXPECT(Last(settled).visible == kB);
  EXPECT(Hides(Last(settled), {kA}));
  EXPECT(coordinator.stats().deadline_fallbacks == 1);
  EXPECT(coordinator.stats().hold_duration_ms_max == 150);
  EXPECT(Frame(coordinator, kB, kWidth, kHeight, 1200).empty());
  EXPECT(coordinator.stats().held_until_frame == 0);
  ExpectBalancedHolds(coordinator);
}

void NoHoldWithoutAPaintedPrevious() {
  TabRevealCoordinator coordinator;
  coordinator.ResizePane(kPane, kWidth, kHeight, 0);
  const Reveal step = Last(coordinator.Switch(kPane, kB, 0));
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(step.kind == SwitchKind::kCold);
  EXPECT(step.hide.empty());
  EXPECT(coordinator.stats().cold_reveals == 1);
}

void NoHoldUnderReducedMotionOrZeroConfig() {
  TabRevealCoordinator coordinator = ShowingA();
  EXPECT(coordinator.SetReducedMotion(true, 0).empty());
  const Reveal step = Last(coordinator.Switch(kPane, kB, 0));
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(Hides(step, {kA}));

  TabRevealCoordinator zero(reveal::RevealConfig{0, 1});
  zero.UpdateTab(Live(kA), 0);
  zero.Switch(kPane, kA, 0);
  EXPECT(Last(zero.Switch(kPane, kB, 0)).action == RevealAction::kShowTargetNow);

  TabRevealCoordinator wild(reveal::RevealConfig{-5, -5});
  EXPECT(wild.config().hold_ms == 0);
  EXPECT(wild.config().size_tolerance_px == 0);
  TabRevealCoordinator huge(reveal::RevealConfig{kForever, 1 << 30});
  EXPECT(huge.config().hold_ms == reveal::kMaxHoldMs);
  EXPECT(huge.config().size_tolerance_px == reveal::kMaxSizeTolerancePx);
}

void TurningReducedMotionOnEndsActiveHolds() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.ResizePane(kRight, kWidth, kHeight, 0);
  coordinator.UpdateTab(Live(kC), 0);
  coordinator.Switch(kRight, kC, 0);
  coordinator.Switch(kPane, kB, 0);
  coordinator.Switch(kRight, kD, 10);
  const Steps steps = coordinator.SetReducedMotion(true, 30);
  EXPECT(steps.size() == 2);
  EXPECT(steps.at(0).visible == kB && Hides(steps.at(0), {kA}));
  EXPECT(steps.at(1).visible == kD && Hides(steps.at(1), {kC}));
  EXPECT(!coordinator.NextDeadlineMs().has_value());
  EXPECT(coordinator.stats().dropped_holds == 2);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 50);
  EXPECT(coordinator.Tick(1000).empty());
  EXPECT(coordinator.SetReducedMotion(false, 1001).empty());
  EXPECT(Last(coordinator.Switch(kPane, kA, 1002)).action == RevealAction::kShowTargetNow);
  coordinator.UpdateTab(Live(kB), 1003);
  coordinator.Switch(kPane, kB, 1003);
  EXPECT(Last(coordinator.Switch(kPane, kNewTab + 9, 1004)).action == RevealAction::kHoldPrevious);
  ExpectBalancedHolds(coordinator);
}

void DomOnlyTargetsNeverHold() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(DomOnly(kNewTab), 0);
  const Reveal step = Last(coordinator.Switch(kPane, kNewTab, 0));
  EXPECT(step.action == RevealAction::kHideAllNative);
  EXPECT(step.kind == SwitchKind::kDomOnly);
  EXPECT(step.visible == reveal::kNoTab);
  EXPECT(Hides(step, {kA}));
  EXPECT(!coordinator.IsHolding(kPane));
  EXPECT(coordinator.stats().dom_only_switches == 1);
  EXPECT(coordinator.Switch(kPane, kNewTab, 1).empty());
  const Reveal back = Last(coordinator.Switch(kPane, kA, 2));
  EXPECT(back.action == RevealAction::kShowTargetNow);
  EXPECT(back.hide.empty());
}

void DomOnlyWhileHoldingDropsEverything() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  coordinator.UpdateTab(DomOnly(kNewTab), 0);
  const Reveal step = Last(coordinator.Switch(kPane, kNewTab, 40));
  EXPECT(step.action == RevealAction::kHideAllNative);
  EXPECT(Hides(step, {kA, kB}));
  EXPECT(coordinator.stats().superseded_switches == 1);
  EXPECT(coordinator.stats().dropped_holds == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 40);
  EXPECT(coordinator.Tick(1000).empty());
  ExpectBalancedHolds(coordinator);
}

void EmptyPaneHidesNative() {
  TabRevealCoordinator coordinator = ShowingA();
  const Reveal step = Last(coordinator.Switch(kPane, reveal::kNoTab, 0));
  EXPECT(step.action == RevealAction::kHideAllNative);
  EXPECT(step.kind == SwitchKind::kEmpty);
  EXPECT(Hides(step, {kA}));
  EXPECT(coordinator.stats().dom_only_switches == 0);
}

void TabTurningDomOnlyOrNativeInPlace() {
  TabRevealCoordinator coordinator = ShowingA();
  Steps steps = coordinator.UpdateTab(DomOnly(kA), 0);
  EXPECT(steps.size() == 1);
  EXPECT(Last(steps).action == RevealAction::kHideAllNative);
  EXPECT(Hides(Last(steps), {kA}));
  steps = coordinator.UpdateTab(Live(kA), 1);
  EXPECT(steps.size() == 1);
  EXPECT(Last(steps).action == RevealAction::kShowTargetNow);
  EXPECT(Last(steps).visible == kA);
}

void InvalidatedOutgoingSurfaceDropsTheHold() {
  TabSurfaceState evicted = Live(kA);
  evicted.is_evicted = true;
  TabSurfaceState crashed = Live(kA);
  crashed.is_crashed = true;
  TabSurfaceState unpainted = Live(kA);
  unpainted.has_committed_frame = false;
  TabSurfaceState empty = Live(kA, 0, 0);
  for (const TabSurfaceState& invalid : {evicted, crashed, DomOnly(kA), unpainted, empty}) {
    TabRevealCoordinator coordinator = ShowingA();
    EXPECT(Last(coordinator.Switch(kPane, kB, 0)).action == RevealAction::kHoldPrevious);
    const Steps steps = coordinator.UpdateTab(invalid, 20);
    EXPECT(steps.size() == 1);
    EXPECT(Last(steps).action == RevealAction::kShowTargetNow);
    EXPECT(Last(steps).visible == kB);
    EXPECT(Hides(Last(steps), {kA}));
    EXPECT(!coordinator.IsHolding(kPane));
    EXPECT(coordinator.stats().dropped_holds == 1);
    EXPECT(coordinator.stats().hold_duration_ms_sum == 20);
    ExpectBalancedHolds(coordinator);
  }
}

void RapidSwitchSupersedesWithoutExtendingTheDeadline() {
  TabRevealCoordinator coordinator = ShowingA();
  const Reveal to_b = Last(coordinator.Switch(kPane, kB, 0));
  const Steps to_c_steps = coordinator.Switch(kPane, kC, 100);
  EXPECT(to_c_steps.size() == 1);
  const Reveal to_c = Last(to_c_steps);
  EXPECT(to_c.action == RevealAction::kHoldPrevious);
  EXPECT(to_c.visible == kA);
  EXPECT(to_c.awaiting == kC);
  EXPECT(to_c.deadline_ms == 150);
  EXPECT(to_c.generation > to_b.generation);
  EXPECT(Hides(to_c, {kB}));
  EXPECT(Frame(coordinator, kB, kWidth, kHeight, 110).empty());
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(coordinator.stats().superseded_switches == 1);
  const Steps settled = coordinator.Tick(150);
  EXPECT(settled.size() == 1);
  EXPECT(Last(settled).visible == kC);
  EXPECT(Hides(Last(settled), {kA}));
  EXPECT(coordinator.stats().hold_count == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 150);
  const Reveal to_b_again = Last(coordinator.Switch(kPane, kB, 200));
  EXPECT(to_b_again.action == RevealAction::kShowTargetNow);
  EXPECT(to_b_again.kind == SwitchKind::kInstant);
  ExpectBalancedHolds(coordinator);
}

void RapidSwitchToAReadyTabShowsItAtOnce() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kC), 0);
  coordinator.Switch(kPane, kB, 0);
  const Reveal step = Last(coordinator.Switch(kPane, kC, 30));
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(Hides(step, {kA, kB}));
  EXPECT(coordinator.stats().superseded_switches == 1);
  EXPECT(coordinator.stats().instant_reveals == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 30);
  ExpectBalancedHolds(coordinator);
}

void SwitchingBackToTheHeldTabRestoresIt() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kA, 10, 10), 0);
  coordinator.Switch(kPane, kB, 0);
  const Reveal step = Last(coordinator.Switch(kPane, kA, 20));
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(step.kind == SwitchKind::kInstant);
  EXPECT(step.visible == kA);
  EXPECT(Hides(step, {kB}));
  EXPECT(!coordinator.IsHolding(kPane));
  EXPECT(coordinator.Tick(1000).empty());
  ExpectBalancedHolds(coordinator);
}

void RepeatingTheSameSwitchIsANoOp() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  EXPECT(coordinator.Switch(kPane, kB, 100).empty());
  EXPECT(coordinator.NextDeadlineMs() == 150);
  EXPECT(Last(coordinator.Switch(kPane, kA, 120)).action == RevealAction::kShowTargetNow);
  EXPECT(coordinator.Switch(kPane, kA, 121).empty());
}

void RepeatingTheSwitchAfterTheDeadlineSettlesFirst() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const Steps steps = coordinator.Switch(kPane, kB, 200);
  EXPECT(steps.size() == 1);
  EXPECT(Last(steps).visible == kB);
  EXPECT(Hides(Last(steps), {kA}));
  EXPECT(coordinator.stats().deadline_fallbacks == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 200);
}

void EveryEntryPointEnforcesTheDeadline() {
  TabRevealCoordinator switching = ShowingA();
  switching.Switch(kPane, kB, 0);
  const Steps steps = switching.Switch(kPane, kC, 151);
  EXPECT(steps.size() == 2);
  EXPECT(steps.at(0).visible == kB && Hides(steps.at(0), {kA}));
  EXPECT(steps.at(1).action == RevealAction::kShowTargetNow);
  EXPECT(steps.at(1).kind == SwitchKind::kCold);
  EXPECT(steps.at(1).visible == kC && Hides(steps.at(1), {kB}));
  EXPECT(switching.stats().deadline_fallbacks == 1);
  EXPECT(switching.stats().superseded_switches == 0);
  EXPECT(switching.stats().hold_duration_ms_sum == 151);

  TabRevealCoordinator framing = ShowingA();
  framing.Switch(kPane, kB, 0);
  const Steps framed = Frame(framing, kB, kWidth, kHeight, 151);
  EXPECT(framed.size() == 1);
  EXPECT(framing.stats().deadline_fallbacks == 1);
  EXPECT(framing.stats().held_until_frame == 0);

  TabRevealCoordinator resizing = ShowingA();
  resizing.UpdateTab(Live(kB, 900, kHeight), 0);
  resizing.Switch(kPane, kB, 0);
  EXPECT(resizing.ResizePane(kPane, 900, kHeight, 150).size() == 1);
  EXPECT(resizing.stats().deadline_fallbacks == 1);
  EXPECT(resizing.stats().held_until_frame == 0);

  TabRevealCoordinator updating = ShowingA();
  updating.Switch(kPane, kB, 0);
  EXPECT(updating.UpdateTab(Live(kB), 400).size() == 1);
  EXPECT(updating.stats().deadline_fallbacks == 1);
  ExpectBalancedHolds(switching);
  ExpectBalancedHolds(framing);
  ExpectBalancedHolds(resizing);
  ExpectBalancedHolds(updating);
}

void NoHoldStartsWhoseDeadlineHasArrived() {
  TabRevealCoordinator coordinator = ShowingA();
  const Reveal step = Last(coordinator.Switch(kPane, kB, kForever));
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(step.kind == SwitchKind::kCold);
  EXPECT(Hides(step, {kA}));
  EXPECT(!coordinator.IsHolding(kPane));
  EXPECT(coordinator.stats().hold_count == 0);

  TabRevealCoordinator edge = ShowingA();
  const Reveal near = Last(edge.Switch(kPane, kB, kForever - 10));
  EXPECT(near.action == RevealAction::kHoldPrevious);
  EXPECT(near.deadline_ms == kForever);
  EXPECT(edge.Tick(kForever).size() == 1);
  EXPECT(edge.stats().hold_duration_ms_sum == 10);
}

void SplitPanesAreIndependent() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.ResizePane(kRight, 600, kHeight, 0);
  coordinator.UpdateTab(Live(kC, 600, kHeight), 0);
  EXPECT(Last(coordinator.Switch(kRight, kC, 0)).action == RevealAction::kShowTargetNow);
  coordinator.Switch(kPane, kB, 0);
  coordinator.UpdateTab(Live(kNewTab + 1, 600, kHeight), 0);
  EXPECT(Last(coordinator.Switch(kRight, kNewTab + 1, 50)).action == RevealAction::kShowTargetNow);
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(!coordinator.IsHolding(kRight));
  coordinator.Switch(kRight, kB + 1, 100);
  EXPECT(coordinator.NextDeadlineMs() == 150);
  const Steps first = coordinator.Tick(150);
  EXPECT(first.size() == 1);
  EXPECT(Last(first).pane_id == kPane);
  EXPECT(coordinator.IsHolding(kRight));
  EXPECT(coordinator.NextDeadlineMs() == 250);
  const Steps second = coordinator.Tick(250);
  EXPECT(second.size() == 1);
  EXPECT(Last(second).pane_id == kRight);
  EXPECT(coordinator.stats().deadline_fallbacks == 2);
  EXPECT(coordinator.stats().hold_duration_ms_max == 150);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 300);
  ExpectBalancedHolds(coordinator);
}

void ATabMovesBetweenPanesWithoutAContradictoryHide() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.ResizePane(kRight, kWidth, kHeight, 0);
  const Steps moved = coordinator.Switch(kRight, kA, 10);
  EXPECT(moved.size() == 2);
  EXPECT(moved.at(0).pane_id == kPane);
  EXPECT(moved.at(0).action == RevealAction::kHideAllNative);
  EXPECT(moved.at(0).hide.empty());
  EXPECT(moved.at(1).pane_id == kRight);
  EXPECT(moved.at(1).action == RevealAction::kShowTargetNow);
  EXPECT(moved.at(1).visible == kA);
  EXPECT(coordinator.VisibleTab(kPane) == reveal::kNoTab);
  EXPECT(coordinator.TargetTab(kPane) == reveal::kNoTab);
  const Reveal elsewhere = Last(coordinator.Switch(kPane, kC, 20));
  EXPECT(elsewhere.hide.empty());
  const Steps removed = coordinator.RemovePane(kPane, 30);
  EXPECT(removed.size() == 1);
  EXPECT(Hides(removed.at(0), {kC}));
  EXPECT(coordinator.VisibleTab(kRight) == kA);
  EXPECT(Last(coordinator.Switch(kPane, kA, 40)).visible == kA);
  EXPECT(coordinator.VisibleTab(kRight) == reveal::kNoTab);
}

void TakingAHeldTabEndsTheOtherPanesHold() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.ResizePane(kRight, kWidth, kHeight, 0);
  coordinator.Switch(kPane, kB, 0);
  const Steps moved = coordinator.Switch(kRight, kA, 25);
  EXPECT(moved.size() == 2);
  EXPECT(moved.at(0).pane_id == kPane);
  EXPECT(moved.at(0).action == RevealAction::kShowTargetNow);
  EXPECT(moved.at(0).visible == kB);
  EXPECT(moved.at(0).hide.empty());
  EXPECT(moved.at(1).visible == kA);
  EXPECT(moved.at(1).kind == SwitchKind::kInstant);
  EXPECT(!coordinator.IsHolding(kPane));
  EXPECT(coordinator.stats().dropped_holds == 1);
  ExpectBalancedHolds(coordinator);
}

void TakingAPendingTargetKeepsTheOtherHoldBounded() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.ResizePane(kRight, kWidth, kHeight, 0);
  coordinator.Switch(kPane, kB, 0);
  const Steps moved = coordinator.Switch(kRight, kB, 10);
  EXPECT(moved.size() == 2);
  EXPECT(moved.at(0).pane_id == kPane);
  EXPECT(moved.at(0).action == RevealAction::kHoldPrevious);
  EXPECT(moved.at(0).awaiting == reveal::kNoTab);
  EXPECT(moved.at(1).pane_id == kRight);
  EXPECT(moved.at(1).visible == kB);
  const Steps settled = coordinator.Tick(150);
  EXPECT(settled.size() == 1);
  EXPECT(Last(settled).action == RevealAction::kHideAllNative);
  EXPECT(Hides(Last(settled), {kA}));
  ExpectBalancedHolds(coordinator);
}

void ResizeUpdatesTheExpectedSize() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kB, 900, kHeight), 0);
  EXPECT(Last(coordinator.Switch(kPane, kB, 0)).action == RevealAction::kHoldPrevious);
  const Steps settled = coordinator.ResizePane(kPane, 900, kHeight, 20);
  EXPECT(settled.size() == 1);
  EXPECT(Last(settled).visible == kB);
  EXPECT(coordinator.stats().held_until_frame == 1);
  coordinator.UpdateTab(Live(kC), 30);
  EXPECT(Last(coordinator.Switch(kPane, kC, 40)).action == RevealAction::kHoldPrevious);
  EXPECT(coordinator.ResizePane(kPane, 500, 500, 50).empty());
  EXPECT(Frame(coordinator, kC, kWidth, kHeight, 60).empty());
  EXPECT(Frame(coordinator, kC, 500, 500, 70).size() == 1);
}

void ZeroAreaFramesNeverCount() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  EXPECT(Frame(coordinator, kB, 0, 0, 10).empty());
  EXPECT(Frame(coordinator, kB, kWidth, 0, 11).empty());
  EXPECT(Frame(coordinator, kB, -kWidth, -kHeight, 12).empty());
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(Frame(coordinator, kB, kWidth, kHeight, 13).size() == 1);

  TabRevealCoordinator unsized;
  unsized.UpdateTab(Live(kA), 0);
  unsized.Switch(kPane, kA, 0);
  EXPECT(unsized.VisibleTab(kPane) == kA);
  EXPECT(Last(unsized.Switch(kPane, kB, 0)).action == RevealAction::kHoldPrevious);
  EXPECT(Frame(unsized, kB, 0, 0, 10).empty());
  EXPECT(Frame(unsized, kB, 300, 200, 20).size() == 1);

  TabRevealCoordinator partial = ShowingA();
  partial.ResizePane(kPane, kWidth, 0, 0);
  partial.UpdateTab(Live(kB), 0);
  EXPECT(Last(partial.Switch(kPane, kB, 0)).action == RevealAction::kHoldPrevious);
  EXPECT(Frame(partial, kB, kWidth, kHeight, 10).empty());
  EXPECT(partial.ResizePane(kPane, kWidth, kHeight, 20).size() == 1);

  TabRevealCoordinator negative = ShowingA();
  negative.ResizePane(kPane, -1, -1, 0);
  negative.UpdateTab(Live(kB, 640, 480), 0);
  EXPECT(Last(negative.Switch(kPane, kB, 0)).kind == SwitchKind::kInstant);

  TabRevealCoordinator flat;
  flat.ResizePane(kPane, kWidth, kHeight, 0);
  flat.UpdateTab(Live(kA, 0, 0), 0);
  flat.Switch(kPane, kA, 0);
  EXPECT(Last(flat.Switch(kPane, kB, 1)).kind == SwitchKind::kCold);
}

void ClosingTheHeldTabDropsTheHold() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const Steps steps = coordinator.OnTabClosed(kA, 25);
  EXPECT(steps.size() == 1);
  EXPECT(Last(steps).action == RevealAction::kShowTargetNow);
  EXPECT(Last(steps).visible == kB);
  EXPECT(Last(steps).hide.empty());
  EXPECT(coordinator.stats().dropped_holds == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 25);
  EXPECT(coordinator.Tick(1000).empty());
  ExpectBalancedHolds(coordinator);
}

void CrashingTheHeldTabDropsTheHold() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const Steps steps = coordinator.OnTabCrashed(kA, 10);
  EXPECT(steps.size() == 1);
  EXPECT(Last(steps).visible == kB);
  EXPECT(Hides(Last(steps), {kA}));
  const Reveal back = Last(coordinator.Switch(kPane, kA, 20));
  EXPECT(back.action == RevealAction::kShowTargetNow);
  EXPECT(back.kind == SwitchKind::kCold);
  ExpectBalancedHolds(coordinator);
}

void CrashingTheTargetShowsItAtOnce() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const Steps steps = coordinator.OnTabCrashed(kB, 10);
  EXPECT(steps.size() == 1);
  EXPECT(Last(steps).visible == kB);
  EXPECT(Hides(Last(steps), {kA}));
  EXPECT(coordinator.OnTabCrashed(999, 11).empty());
}

void ClosingThePendingTargetKeepsTheHoldBounded() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const Steps closed = coordinator.OnTabClosed(kB, 10);
  EXPECT(closed.size() == 1);
  EXPECT(Last(closed).action == RevealAction::kHoldPrevious);
  EXPECT(Last(closed).visible == kA);
  EXPECT(coordinator.TargetTab(kPane) == reveal::kNoTab);
  const Reveal next = Last(coordinator.Switch(kPane, kC, 20));
  EXPECT(next.action == RevealAction::kHoldPrevious);
  EXPECT(next.deadline_ms == 150);
  EXPECT(coordinator.stats().superseded_switches == 0);
  coordinator.OnTabClosed(kC, 30);
  const Steps settled = coordinator.Tick(150);
  EXPECT(settled.size() == 1);
  EXPECT(Last(settled).action == RevealAction::kHideAllNative);
  EXPECT(Hides(Last(settled), {kA}));
  ExpectBalancedHolds(coordinator);
}

void ClosingTheVisibleTabHidesIt() {
  TabRevealCoordinator coordinator = ShowingA();
  const Steps steps = coordinator.OnTabClosed(kA, 0);
  EXPECT(steps.size() == 1);
  EXPECT(Last(steps).action == RevealAction::kHideAllNative);
  EXPECT(coordinator.VisibleTab(kPane) == reveal::kNoTab);
  EXPECT(coordinator.TargetTab(kPane) == reveal::kNoTab);
  EXPECT(coordinator.OnTabClosed(kA, 1).empty());
  EXPECT(coordinator.OnTabClosed(reveal::kNoTab, 1).empty());
}

void StaleFramesAreIgnored() {
  TabRevealCoordinator closing = ShowingA();
  closing.Switch(kPane, kB, 0);
  const reveal::SurfaceEpoch closed_epoch = closing.EpochOf(kB);
  closing.OnTabClosed(kB, 10);
  EXPECT(closing.OnTargetFrameCommitted(kB, closed_epoch, kWidth, kHeight, 20).empty());
  EXPECT(closing.EpochOf(kB) == reveal::kNoEpoch);
  closing.UpdateTab(Cold(kB), 30);
  EXPECT(closing.EpochOf(kB) != closed_epoch);
  EXPECT(closing.OnTargetFrameCommitted(kB, closed_epoch, kWidth, kHeight, 40).empty());
  EXPECT(Last(closing.Switch(kPane, kB, 50)).action == RevealAction::kHoldPrevious);

  TabRevealCoordinator crashing = ShowingA();
  crashing.Switch(kPane, kB, 0);
  const reveal::SurfaceEpoch before_crash = crashing.EpochOf(kB);
  crashing.OnTabCrashed(kB, 5);
  EXPECT(crashing.OnTargetFrameCommitted(kB, before_crash, kWidth, kHeight, 6).empty());
  EXPECT(Frame(crashing, kB, kWidth, kHeight, 7).empty());
  EXPECT(Last(crashing.Switch(kPane, kA, 8)).kind == SwitchKind::kInstant);
  EXPECT(Last(crashing.Switch(kPane, kB, 9)).action == RevealAction::kHoldPrevious);
  crashing.UpdateTab(Cold(kB), 10);
  EXPECT(Frame(crashing, kB, kWidth, kHeight, 11).size() == 1);

  TabRevealCoordinator evicting = ShowingA();
  evicting.UpdateTab(Live(kB), 0);
  const reveal::SurfaceEpoch before_eviction = evicting.EpochOf(kB);
  TabSurfaceState evicted = Live(kB);
  evicted.is_evicted = true;
  evicting.UpdateTab(evicted, 1);
  EXPECT(evicting.EpochOf(kB) != before_eviction);
  EXPECT(Last(evicting.Switch(kPane, kB, 2)).action == RevealAction::kHoldPrevious);
  EXPECT(evicting.OnTargetFrameCommitted(kB, before_eviction, kWidth, kHeight, 3).empty());
  EXPECT(evicting.IsHolding(kPane));
  EXPECT(Frame(evicting, kB, kWidth, kHeight, 4).size() == 1);

  TabRevealCoordinator steady = ShowingA();
  const reveal::SurfaceEpoch epoch = steady.EpochOf(kA);
  steady.UpdateTab(Live(kA, 900, 700), 1);
  EXPECT(steady.EpochOf(kA) == epoch);
}

void AnInvalidatedTargetReissuesItsEpoch() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Cold(kB), 0);
  const Reveal held = Last(coordinator.Switch(kPane, kB, 0));
  EXPECT(held.action == RevealAction::kHoldPrevious);
  const reveal::SurfaceEpoch first = held.awaiting_epoch;
  TabSurfaceState evicted = Cold(kB);
  evicted.is_evicted = true;
  const Steps steps = coordinator.UpdateTab(evicted, 20);
  EXPECT(steps.size() == 1);
  const Reveal reissued = Last(steps);
  EXPECT(reissued.pane_id == kPane);
  EXPECT(reissued.action == RevealAction::kHoldPrevious);
  EXPECT(reissued.awaiting == kB);
  EXPECT(reissued.visible == kA);
  EXPECT(reissued.deadline_ms == held.deadline_ms);
  EXPECT(reissued.awaiting_epoch != first);
  EXPECT(reissued.hide.empty());
  EXPECT(coordinator.OnTargetFrameCommitted(kB, first, kWidth, kHeight, 30).empty());
  EXPECT(coordinator.IsHolding(kPane));
  const Steps settled = coordinator.OnTargetFrameCommitted(kB, reissued.awaiting_epoch, kWidth, kHeight, 40);
  EXPECT(settled.size() == 1);
  EXPECT(Last(settled).visible == kB);
  EXPECT(coordinator.stats().held_until_frame == 1);
  EXPECT(coordinator.stats().deadline_fallbacks == 0);
  EXPECT(coordinator.UpdateTab(Live(kB, 900, 700), 50).empty());
  ExpectBalancedHolds(coordinator);
}

void LosingACommittedFrameRejectsQueuedFrames() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kB, 600, 400), 0);
  const Reveal held = Last(coordinator.Switch(kPane, kB, 0));
  EXPECT(held.action == RevealAction::kHoldPrevious);
  const reveal::SurfaceEpoch queued = held.awaiting_epoch;
  const Steps steps = coordinator.UpdateTab(Cold(kB), 10);
  EXPECT(steps.size() == 1);
  const Reveal reissued = Last(steps);
  EXPECT(reissued.action == RevealAction::kHoldPrevious);
  EXPECT(reissued.awaiting == kB);
  EXPECT(reissued.deadline_ms == held.deadline_ms);
  EXPECT(reissued.awaiting_epoch != queued);
  EXPECT(coordinator.OnTargetFrameCommitted(kB, queued, kWidth, kHeight, 20).empty());
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(coordinator.OnTargetFrameCommitted(kB, reissued.awaiting_epoch, kWidth, kHeight, 30).size() == 1);
  EXPECT(coordinator.stats().held_until_frame == 1);

  TabRevealCoordinator idle = ShowingA();
  idle.UpdateTab(Live(kB), 0);
  EXPECT(idle.UpdateTab(Cold(kB), 1).empty());
  ExpectBalancedHolds(coordinator);
}

void GenerationsNeverRepeat() {
  TabRevealCoordinator coordinator = ShowingA();
  const uint64_t first = Last(coordinator.Switch(kPane, kB, 0)).generation;
  coordinator.RemovePane(kPane, 1);
  coordinator.ResizePane(kPane, kWidth, kHeight, 2);
  const uint64_t again = Last(coordinator.Switch(kPane, kC, 3)).generation;
  EXPECT(again > first);
  const uint64_t other = Last(coordinator.Switch(kRight, kD, 4)).generation;
  EXPECT(other > again);
}

void HidingTheWindowCancelsHolds() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const Steps steps = coordinator.SetWindowVisible(false, 30);
  EXPECT(steps.size() == 1);
  EXPECT(Last(steps).visible == kB);
  EXPECT(Hides(Last(steps), {kA}));
  EXPECT(!coordinator.window_visible());
  EXPECT(Last(coordinator.Switch(kPane, kC, 40)).action == RevealAction::kShowTargetNow);
  EXPECT(coordinator.SetWindowVisible(true, 50).empty());
  EXPECT(Last(coordinator.Switch(kPane, kA, 60)).action == RevealAction::kShowTargetNow);
  EXPECT(Last(coordinator.Switch(kPane, kB, 70)).action == RevealAction::kHoldPrevious);
  ExpectBalancedHolds(coordinator);
}

void TimestampsNeverRunBackwards() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 1000);
  EXPECT(coordinator.Tick(5).empty());
  EXPECT(coordinator.Tick(-1).empty());
  EXPECT(coordinator.Tick(std::numeric_limits<int64_t>::min()).empty());
  EXPECT(Frame(coordinator, kB, kWidth, kHeight, 900).size() == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 0);
  EXPECT(coordinator.stats().held_until_frame == 1);
}

void InvalidInputsAreHarmless() {
  TabRevealCoordinator coordinator = ShowingA();
  EXPECT(coordinator.UpdateTab(Cold(reveal::kNoTab), 0).empty());
  EXPECT(coordinator.OnTargetFrameCommitted(reveal::kNoTab, 1, 1, 1, 0).empty());
  EXPECT(coordinator.OnTargetFrameCommitted(999, 1, 1, 1, 0).empty());
  coordinator.UpdateTab(Live(kB, -5, -5), 0);
  EXPECT(Last(coordinator.Switch(kPane, kB, 0)).action == RevealAction::kHoldPrevious);
  EXPECT(coordinator.ResizePane(kPane, -1, -1, 1).empty());
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(Frame(coordinator, kB, 5, 5, 2).size() == 1);
  EXPECT(coordinator.VisibleTab(kPane) == kB);
  EXPECT(coordinator.VisibleTab(99) == reveal::kNoTab);
  EXPECT(!coordinator.IsHolding(99));
  EXPECT(coordinator.RemovePane(99, 3).empty());
}

void RemovingAPaneHidesItsSurfaces() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const Steps steps = coordinator.RemovePane(kPane, 40);
  EXPECT(steps.size() == 1);
  EXPECT(Hides(Last(steps), {kA, kB}));
  EXPECT(coordinator.stats().hold_duration_ms_sum == 40);
  EXPECT(coordinator.stats().dropped_holds == 1);
  EXPECT(!coordinator.NextDeadlineMs().has_value());
  ExpectBalancedHolds(coordinator);
}

void EvictedSurfacesAreCold() {
  TabRevealCoordinator coordinator = ShowingA();
  TabSurfaceState evicted = Live(kB);
  evicted.is_evicted = true;
  coordinator.UpdateTab(evicted, 0);
  EXPECT(Last(coordinator.Switch(kPane, kB, 0)).action == RevealAction::kHoldPrevious);
  EXPECT(Frame(coordinator, kB, kWidth, kHeight, 5).size() == 1);
}

void StatsAccumulateAndReset() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kC), 0);
  coordinator.Switch(kPane, kC, 0);
  coordinator.Switch(kPane, kB, 10);
  Frame(coordinator, kB, kWidth, kHeight, 50);
  coordinator.Switch(kPane, kNewTab + 10, 60);
  coordinator.Tick(210);
  coordinator.UpdateTab(Live(kNewTab + 10), 215);
  coordinator.Switch(kPane, kD, 215);
  coordinator.Switch(kPane, kNewTab + 11, 220);
  coordinator.UpdateTab(DomOnly(kNewTab), 230);
  coordinator.Switch(kPane, kNewTab, 230);
  coordinator.Switch(kRight, kNewTab + 12, 240);
  ExpectBalancedHolds(coordinator);
  const reveal::RevealStats stats = coordinator.TakeStats();
  EXPECT(stats.instant_reveals == 1);
  EXPECT(stats.held_until_frame == 1);
  EXPECT(stats.deadline_fallbacks == 1);
  EXPECT(stats.superseded_switches == 2);
  EXPECT(stats.dom_only_switches == 1);
  EXPECT(stats.cold_reveals == 1);
  EXPECT(stats.dropped_holds == 1);
  EXPECT(stats.hold_count == 3);
  EXPECT(stats.hold_duration_ms_sum == 205);
  EXPECT(stats.hold_duration_ms_max == 150);
  const reveal::RevealStats empty = coordinator.TakeStats();
  EXPECT(empty.instant_reveals == 0 && empty.hold_count == 0 && empty.hold_duration_ms_max == 0);
  EXPECT(empty.superseded_switches == 0 && empty.dropped_holds == 0 && empty.cold_reveals == 0);
}

}

int main() {
  const std::vector<std::pair<std::string_view, std::function<void()>>> tests = {
      {"InstantRevealOfALiveMatchingTab", InstantRevealOfALiveMatchingTab},
      {"ExactSizeRequiredWithZeroTolerance", ExactSizeRequiredWithZeroTolerance},
      {"ColdTargetHoldsUntilItsFrame", ColdTargetHoldsUntilItsFrame},
      {"StaleSizedFrameKeepsWaiting", StaleSizedFrameKeepsWaiting},
      {"DeadlineFallsBack", DeadlineFallsBack},
      {"NoHoldWithoutAPaintedPrevious", NoHoldWithoutAPaintedPrevious},
      {"NoHoldUnderReducedMotionOrZeroConfig", NoHoldUnderReducedMotionOrZeroConfig},
      {"TurningReducedMotionOnEndsActiveHolds", TurningReducedMotionOnEndsActiveHolds},
      {"DomOnlyTargetsNeverHold", DomOnlyTargetsNeverHold},
      {"DomOnlyWhileHoldingDropsEverything", DomOnlyWhileHoldingDropsEverything},
      {"EmptyPaneHidesNative", EmptyPaneHidesNative},
      {"TabTurningDomOnlyOrNativeInPlace", TabTurningDomOnlyOrNativeInPlace},
      {"InvalidatedOutgoingSurfaceDropsTheHold", InvalidatedOutgoingSurfaceDropsTheHold},
      {"RapidSwitchSupersedesWithoutExtendingTheDeadline", RapidSwitchSupersedesWithoutExtendingTheDeadline},
      {"RapidSwitchToAReadyTabShowsItAtOnce", RapidSwitchToAReadyTabShowsItAtOnce},
      {"SwitchingBackToTheHeldTabRestoresIt", SwitchingBackToTheHeldTabRestoresIt},
      {"RepeatingTheSameSwitchIsANoOp", RepeatingTheSameSwitchIsANoOp},
      {"RepeatingTheSwitchAfterTheDeadlineSettlesFirst", RepeatingTheSwitchAfterTheDeadlineSettlesFirst},
      {"EveryEntryPointEnforcesTheDeadline", EveryEntryPointEnforcesTheDeadline},
      {"NoHoldStartsWhoseDeadlineHasArrived", NoHoldStartsWhoseDeadlineHasArrived},
      {"SplitPanesAreIndependent", SplitPanesAreIndependent},
      {"ATabMovesBetweenPanesWithoutAContradictoryHide", ATabMovesBetweenPanesWithoutAContradictoryHide},
      {"TakingAHeldTabEndsTheOtherPanesHold", TakingAHeldTabEndsTheOtherPanesHold},
      {"TakingAPendingTargetKeepsTheOtherHoldBounded", TakingAPendingTargetKeepsTheOtherHoldBounded},
      {"ResizeUpdatesTheExpectedSize", ResizeUpdatesTheExpectedSize},
      {"ZeroAreaFramesNeverCount", ZeroAreaFramesNeverCount},
      {"ClosingTheHeldTabDropsTheHold", ClosingTheHeldTabDropsTheHold},
      {"CrashingTheHeldTabDropsTheHold", CrashingTheHeldTabDropsTheHold},
      {"CrashingTheTargetShowsItAtOnce", CrashingTheTargetShowsItAtOnce},
      {"ClosingThePendingTargetKeepsTheHoldBounded", ClosingThePendingTargetKeepsTheHoldBounded},
      {"ClosingTheVisibleTabHidesIt", ClosingTheVisibleTabHidesIt},
      {"StaleFramesAreIgnored", StaleFramesAreIgnored},
      {"AnInvalidatedTargetReissuesItsEpoch", AnInvalidatedTargetReissuesItsEpoch},
      {"LosingACommittedFrameRejectsQueuedFrames", LosingACommittedFrameRejectsQueuedFrames},
      {"GenerationsNeverRepeat", GenerationsNeverRepeat},
      {"HidingTheWindowCancelsHolds", HidingTheWindowCancelsHolds},
      {"TimestampsNeverRunBackwards", TimestampsNeverRunBackwards},
      {"InvalidInputsAreHarmless", InvalidInputsAreHarmless},
      {"RemovingAPaneHidesItsSurfaces", RemovingAPaneHidesItsSurfaces},
      {"EvictedSurfacesAreCold", EvictedSurfacesAreCold},
      {"StatsAccumulateAndReset", StatsAccumulateAndReset},
  };
  for (const auto& [name, test] : tests) {
    const int before = failures;
    test();
    if (failures != before) std::cerr << "FAIL " << name << "\n";
  }
  std::cout << tests.size() << " tests, " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
