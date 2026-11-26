#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include <limits>
#include <vector>

#include "ardia/desktop/ac_desktop_layout_sync.h"

namespace sync = ardia::desktop_layout_sync;

namespace {

int failures = 0;

void Check(bool ok, const char* what, int line) {
  if (ok) return;
  ++failures;
  std::fprintf(stderr, "layout_sync_test.cc:%d: %s\n", line, what);
}

#define CHECK(expr) Check((expr), #expr, __LINE__)

bool Near(double a, double b, double epsilon = 1e-9) { return std::abs(a - b) <= epsilon; }

bool OnGrid(double dip, double scale) { return Near(dip * scale, std::round(dip * scale), 1e-6); }

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

std::vector<sync::SplitSlot> Slots(std::initializer_list<double> sizes) {
  std::vector<sync::SplitSlot> slots;
  for (const double size : sizes) slots.push_back(sync::SplitSlot{size, false, {0.5, 0.5}});
  return slots;
}

constexpr sync::DividerRef Root(size_t index) { return {sync::DividerKind::kRoot, index}; }
constexpr sync::DividerRef Stack(size_t index) { return {sync::DividerKind::kStack, index}; }

sync::LayoutInput Window(double width, double height, double scale = 1) {
  sync::LayoutInput input;
  input.window = {width, height, scale};
  input.sidebar_width = 190;
  input.card_insets = {0, 9, 9, 9};
  return input;
}

void SidebarLimitMatchesTheBrowserUi() {
  CHECK(sync::SidebarWidthLimit(kNaN) == 400);
  CHECK(sync::SidebarWidthLimit(0) == 400);
  CHECK(sync::SidebarWidthLimit(-5) == 400);
  CHECK(sync::SidebarWidthLimit(1200) == 400);
  CHECK(sync::SidebarWidthLimit(600) == 290);
  CHECK(sync::SidebarWidthLimit(600.9) == 290);
  CHECK(sync::SidebarWidthLimit(400) == 160);
  CHECK(sync::ShownSidebarWidth(350, 600) == 290);
  CHECK(sync::ShownSidebarWidth(kNaN, 1200) == 190);
  CHECK(sync::KeptSidebarWidth(400, 400, 520) == 520);
  CHECK(sync::KeptSidebarWidth(300, 400, 520) == 300);
}

void RubberBandRoundTrips() {
  for (const double width : {130.0, 150.0, 160.0, 250.0, 400.0, 410.0, 430.0}) {
    CHECK(Near(sync::RubberBand(sync::Unstretch(width, 160, 400), 160, 400), width, 1e-6));
  }
  CHECK(sync::RubberBand(10000, 160, 400) <= 436);
  CHECK(sync::RubberBand(-10000, 160, 400) >= 124);
  CHECK(sync::RubberBand(kNaN, 160, 400) == 160);
  CHECK(sync::ClampWidth(kInf, 160, 400) == 160);
}

void LeftSidebarDragFollowsThePointerAndSettles() {
  sync::LayoutDragSession session(Window(1200, 800));
  const uint64_t start = session.Sequence();
  CHECK(session.Snapshot().sidebar_width == 190);
  CHECK(session.Snapshot().content == (sync::Rect{190, 9, 1001, 782}));
  CHECK(session.BeginSidebar(190));
  CHECK(session.Active() == sync::DragKind::kSidebar);
  CHECK(session.Move(250));
  CHECK(session.Snapshot().sidebar_width == 250);
  CHECK(session.Snapshot().sidebar == (sync::Rect{0, 0, 250, 800}));
  CHECK(session.Snapshot().content.x == 250);
  CHECK(session.Snapshot().css.sidebar_width == 250);
  CHECK(session.Snapshot().css.sequence == session.Sequence());
  CHECK(session.Sequence() == start + 2);
  CHECK(session.Move(700));
  const double stretched = session.Input().sidebar_width;
  CHECK(stretched > 400 && stretched < 436);
  const auto release = session.End(700);
  CHECK(release.has_value());
  CHECK(release->needs_settle);
  CHECK(release->target == 400);
  CHECK(release->kept == 400);
  CHECK(session.Active() == sync::DragKind::kSidebar);
  CHECK(!session.Move(300));
  CHECK(session.Settle(405));
  CHECK(session.Snapshot().sidebar_width == 405);
  CHECK(session.Settle(400));
  CHECK(session.Active() == sync::DragKind::kNone);
  CHECK(session.Input().sidebar_width == 400);
  CHECK(!session.Input().sidebar_live);
}

void RightSidebarGrowsTowardTheLeft() {
  sync::LayoutInput input = Window(1200, 800);
  input.side = sync::SidebarSide::kRight;
  input.card_insets = {9, 9, 0, 9};
  sync::LayoutDragSession session(input);
  CHECK(session.Snapshot().sidebar == (sync::Rect{1010, 0, 190, 800}));
  CHECK(session.Snapshot().content == (sync::Rect{9, 9, 1001, 782}));
  CHECK(session.BeginSidebar(1010));
  CHECK(session.Move(960));
  CHECK(session.Snapshot().sidebar_width == 240);
  CHECK(session.Snapshot().sidebar.x == 960);
  CHECK(session.Snapshot().content.width == 951);
  const auto release = session.End(960);
  CHECK(release && !release->needs_settle && release->target == 240 && release->kept == 240);
}

void GrabOffsetAnchorsOnTheFirstMove() {
  sync::LayoutDragSession session(Window(1200, 800));
  CHECK(session.BeginSidebar(193, 3));
  CHECK(session.Snapshot().sidebar_width == 190);
  CHECK(session.Move(194));
  CHECK(Near(session.Input().sidebar_width, 194));
}

void CancelRevertsToTheWidthBeforeTheGesture() {
  sync::LayoutDragSession session(Window(1200, 800));
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(320));
  const uint64_t before = session.Sequence();
  CHECK(session.Cancel());
  CHECK(session.Sequence() == before + 1);
  CHECK(session.Snapshot().sidebar_width == 190);
  CHECK(session.Active() == sync::DragKind::kNone);
  CHECK(!session.Cancel());
}

void CollapseThresholdHidesTheSidebar() {
  sync::LayoutInput input = Window(1200, 800);
  input.collapse_below = 140;
  input.card_insets = {9, 9, 9, 9};
  sync::LayoutDragSession session(input);
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(0));
  const auto release = session.End(0);
  CHECK(release && release->collapsed && release->target == 0 && release->kept == 190);
  CHECK(session.Snapshot().sidebar_collapsed);
  CHECK(session.Snapshot().sidebar.width == 0);
  CHECK(session.Snapshot().content.x == 9);
  CHECK(session.Snapshot().css.sidebar_width == 0);
  CHECK(session.BeginSidebar(0));
  CHECK(!session.Snapshot().sidebar_collapsed);
  CHECK(session.Snapshot().sidebar_width == 190);
}

void HostileInputLeavesTheLayoutAlone() {
  sync::LayoutDragSession session(Window(1200, 800));
  const uint64_t sequence = session.Sequence();
  CHECK(!session.BeginSidebar(kNaN));
  CHECK(!session.BeginSidebar(0, kInf));
  CHECK(!session.Move(5));
  CHECK(session.BeginSidebar(190));
  const uint64_t begun = session.Sequence();
  CHECK(!session.Move(kNaN));
  CHECK(!session.Move(-kInf));
  CHECK(session.Sequence() == begun);
  CHECK(!session.ResizeWindow(kNaN, 800));
  CHECK(!session.ResizeWindow(-1, 800));
  CHECK(!session.ResizeWindow(1e9, 800));
  CHECK(!session.ResizeWindow(1200, 800));
  CHECK(begun == sequence + 1);
  CHECK(!sync::ComputeLayout(Window(0, 800), 1));
  CHECK(!sync::ComputeLayout(Window(kNaN, 800), 1));
  CHECK(!sync::ComputeLayout(Window(800, -3), 1));
  sync::LayoutInput hostile = Window(1000, 700, kNaN);
  hostile.card_insets = {kNaN, -40, kInf, 9};
  hostile.sidebar_width = -kInf;
  hostile.split_slots = Slots({kNaN, -1, kInf});
  hostile.split_gap = kNaN;
  const auto layout = sync::ComputeLayout(hostile, 7);
  CHECK(layout.has_value());
  CHECK(layout->device_scale == 1);
  CHECK(layout->sidebar_width == 190);
  CHECK(layout->content == (sync::Rect{190, 0, 810, 691}));
  CHECK(layout->panes.size() == 3);
  for (const sync::PaneLayout& pane : layout->panes) CHECK(pane.rect.width >= 0 && std::isfinite(pane.rect.width));
  sync::LayoutInput too_many = Window(1000, 700);
  too_many.split_slots = std::vector<sync::SplitSlot>(sync::kMaxSlots + 1);
  CHECK(!sync::ComputeLayout(too_many, 1));
}

void WindowResizeMidDragRebandsAgainstTheNewLimit() {
  sync::LayoutDragSession session(Window(1200, 800));
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(390));
  CHECK(session.Snapshot().sidebar_width == 390);
  CHECK(session.ResizeWindow(600, 800));
  CHECK(session.Snapshot().sidebar_width > 290 && session.Snapshot().sidebar_width < 326);
  const auto release = session.End(390);
  CHECK(release && release->needs_settle && release->target == 290);
  CHECK(session.ResizeWindow(500, 800));
  CHECK(session.Settle(9999));
  CHECK(session.Settle(190));
  CHECK(session.Active() == sync::DragKind::kNone);
  CHECK(session.Snapshot().sidebar_width == 190);
}

void FractionalScalesShareEveryEdge() {
  for (const double scale : {1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 3.0}) {
    sync::LayoutInput input = Window(1237.6, 811.2, scale);
    input.sidebar_width = 203.3;
    input.card_insets = {0, 9, 9, 9};
    input.split_slots = Slots({0.31, 0.27, 0.42});
    input.split_gap = 9;
    const auto layout = sync::ComputeLayout(input, 1);
    CHECK(layout.has_value());
    if (!layout) continue;
    CHECK(OnGrid(layout->sidebar_width, scale));
    CHECK(Near(layout->sidebar.x + layout->sidebar.width, layout->content.x));
    CHECK(layout->panes.size() == 3 && layout->dividers.size() == 2);
    for (size_t i = 0; i < layout->panes.size(); ++i) {
      const sync::Rect& pane = layout->panes[i].rect;
      CHECK(OnGrid(pane.x, scale) && OnGrid(pane.x + pane.width, scale));
      CHECK(OnGrid(pane.y, scale) && OnGrid(pane.y + pane.height, scale));
      CHECK(pane.y == layout->content.y && pane.height == layout->content.height);
      if (i + 1 < layout->panes.size()) {
        const sync::Rect& divider = layout->dividers[i].rect;
        CHECK(Near(pane.x + pane.width, divider.x));
        CHECK(Near(divider.x + divider.width, layout->panes[i + 1].rect.x));
      }
    }
    CHECK(Near(layout->panes.front().rect.x, layout->content.x));
    CHECK(Near(layout->panes.back().rect.x + layout->panes.back().rect.width, layout->content.x + layout->content.width));
    for (const sync::PaneLayout& pane : layout->panes) {
      const sync::PixelRect px = sync::ToPixels(pane.rect, scale);
      CHECK(px == pane.pixels);
      CHECK(Near(px.x / scale, pane.rect.x) && Near(px.width / scale, pane.rect.width));
    }
  }
}

void SplitCutMatchesTheBrowserGeometry() {
  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.card_insets = {9, 9, 9, 9};
  input.split_slots = Slots({1, 1, 1});
  input.split_gap = 9;
  const auto layout = sync::ComputeLayout(input, 3);
  CHECK(layout.has_value());
  if (!layout) return;
  CHECK(layout->content == (sync::Rect{9, 9, 1182, 782}));
  CHECK(layout->panes[0].rect == (sync::Rect{9, 9, 388, 782}));
  CHECK(layout->dividers[0].rect == (sync::Rect{397, 9, 9, 782}));
  CHECK(layout->panes[1].rect == (sync::Rect{406, 9, 388, 782}));
  CHECK(layout->panes[2].rect == (sync::Rect{803, 9, 388, 782}));
  CHECK(Near(layout->split_ratio, 0.5));
  input.orientation = sync::SplitOrientation::kVertical;
  input.split_slots = Slots({0.25, 0.75});
  const auto vertical = sync::ComputeLayout(input, 4);
  CHECK(vertical.has_value());
  if (!vertical) return;
  CHECK(vertical->panes[0].rect == (sync::Rect{9, 9, 1182, 193}));
  CHECK(vertical->dividers[0].rect == (sync::Rect{9, 202, 1182, 9}));
  CHECK(vertical->panes[1].rect == (sync::Rect{9, 211, 1182, 580}));
  CHECK(Near(vertical->split_ratio, 0.25));
}

void SplitResizeClampsLikeTheBrowser() {
  const std::vector<double> half{0.5, 0.5};
  const auto moved = sync::ResizePair(half, 0, 100, 1009, 9);
  CHECK(Near(moved[0] * 1000, 600) && Near(moved[1] * 1000, 400));
  const auto pinned = sync::ResizePair(half, 0, -10000, 1009, 9);
  CHECK(Near(pinned[0] * 1000, 220));
  const auto far = sync::ResizePair(half, 0, 10000, 1009, 9);
  CHECK(Near(far[1] * 1000, 220));
  const std::vector<double> narrow{0.1, 0.9};
  const auto held = sync::ResizePair(narrow, 0, -50, 1009, 9);
  CHECK(Near(held[0] * 1000, 100));
  CHECK(sync::ResizePair(half, 1, 10, 1009, 9) == half);
  CHECK(sync::ResizePair(half, 0, kNaN, 1009, 9) == half);
  CHECK(sync::EvenPair({0.2, 0.3, 0.5}, 1) == (std::vector<double>{0.2, 0.4, 0.4}));
  CHECK(sync::EvenPair(half, 4) == half);
}

void SplitDragSessionPublishesRatioAndReverts() {
  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.card_insets = {9, 9, 9, 9};
  input.split_slots = Slots({0.5, 0.5});
  input.split_gap = 9;
  sync::LayoutDragSession session(input);
  CHECK(!session.BeginSplit(Root(1), 600));
  CHECK(session.BeginSplit(Root(0), 600));
  CHECK(!session.BeginSidebar(10));
  CHECK(session.Move(700));
  CHECK(session.Snapshot().active_divider == Root(0));
  CHECK(Near(session.Snapshot().split_ratio, (586.5 + 100) / 1173));
  CHECK(session.Snapshot().css.split_ratio == session.Snapshot().split_ratio);
  CHECK(session.Snapshot().panes[0].rect.width == 687);
  CHECK(session.ResizeWindow(1000, 800));
  CHECK(Near(session.Snapshot().split_ratio, (486.5 + 100) / 973));
  CHECK(session.Cancel());
  CHECK(Near(session.Snapshot().split_ratio, 0.5));
  CHECK(session.Snapshot().content.width == 982);
  CHECK(session.BeginSplit(Root(0), 500));
  CHECK(session.Move(-4000));
  const auto release = session.End(-4000);
  CHECK(release && !release->needs_settle);
  CHECK(session.Snapshot().panes[0].rect.width == 220);
  CHECK(!session.Snapshot().active_divider.has_value());
  CHECK(session.ResetSplitPair(Root(0)));
  CHECK(Near(session.Snapshot().split_ratio, 0.5));
}

void DeviceScaleChangesResnap() {
  sync::LayoutInput input = Window(1000, 700, 1);
  input.sidebar_width = 190.4;
  sync::LayoutDragSession session(input);
  CHECK(session.Snapshot().sidebar_width == 190);
  const uint64_t before = session.Sequence();
  CHECK(session.SetDeviceScale(2.5));
  CHECK(session.Sequence() == before + 1);
  CHECK(Near(session.Snapshot().sidebar_width, 190.4));
  CHECK(!session.SetDeviceScale(2.5));
  CHECK(session.SetDeviceScale(kNaN));
  CHECK(session.Snapshot().device_scale == 1);
  CHECK(session.SetDeviceScale(1000));
  CHECK(session.Snapshot().device_scale == sync::kMaxDeviceScale);
  CHECK(sync::ToPixels({kNaN, 0, 1, 1}, 2) == sync::PixelRect{});
  CHECK(sync::ToPixels({1.25, 2.5, 10.5, 3}, 2) == (sync::PixelRect{3, 5, 21, 6}));
}

void TrackerPresentsWhenParentAndChildrenMatch() {
  sync::SurfaceSyncTracker tracker(16667);
  CHECK(tracker.Decide(0).reason == sync::PresentReason::kIdle);
  CHECK(!tracker.ExpectLayout(1, {0, 0, 1200, 800}, {}, 0));
  tracker.Begin();
  const auto ids = tracker.ExpectLayout(1, {0, 0, 1200, 800}, {{11, {190, 9, 500, 782}}, {12, {700, 9, 491, 782}}}, 1000);
  CHECK(ids && ids->size() == 2);
  if (!ids) return;
  CHECK(tracker.ExpectedShell() == (sync::SurfaceId{1, 1}));
  CHECK((*ids)[0] == (sync::SurfaceId{1, 2}) && (*ids)[1] == (sync::SurfaceId{1, 3}));
  auto decision = tracker.Decide(2000);
  CHECK(decision.reason == sync::PresentReason::kHolding && !decision.present);
  CHECK(decision.waiting_on == 3 && decision.deadline_micros == 17667);
  CHECK(tracker.ShellSubmitted({1, 1}));
  CHECK(tracker.ChildSubmitted(11, (*ids)[0]));
  CHECK(tracker.Decide(3000).waiting_on == 1);
  CHECK(tracker.ChildSubmitted(12, (*ids)[1]));
  decision = tracker.Decide(4000);
  CHECK(decision.reason == sync::PresentReason::kMatched && decision.present && decision.frame_sequence == 1);
  CHECK(tracker.Decide(4100).reason == sync::PresentReason::kIdle);
  const auto next = tracker.ExpectLayout(2, {0, 0, 1200, 800}, {{11, {190, 9, 500, 782}}, {12, {700, 9, 480, 782}}}, 5000);
  CHECK(next && (*next)[0] == (sync::SurfaceId{1, 2}) && (*next)[1] == (sync::SurfaceId{2, 4}));
  CHECK(tracker.Decide(5100).waiting_on == 2);
  CHECK(tracker.ShellSubmitted({2, 1}));
  CHECK(tracker.ChildSubmitted(12, {2, 4}));
  CHECK(tracker.Decide(6000).reason == sync::PresentReason::kMatched);
  CHECK(tracker.Counts().matched == 2 && tracker.Counts().layouts == 2);
  tracker.End();
  CHECK(tracker.Decide(7000).reason == sync::PresentReason::kIdle);
}

void TrackerNeverWaitsPastOneFrame() {
  sync::SurfaceSyncTracker tracker(16667);
  tracker.Begin();
  int64_t now = 0;
  for (uint64_t sequence = 1; sequence <= 4; ++sequence) {
    CHECK(tracker.ExpectLayout(sequence, {0, 0, 1200, 800}, {{7, {0, 0, 300.0 + static_cast<double>(sequence), 700}}},
                               now)
              .has_value());
    CHECK(tracker.ShellSubmitted({sequence, 1}));
    CHECK(tracker.Decide(now).reason == sync::PresentReason::kHolding);
    now += 4000;
  }
  const auto decision = tracker.Decide(16667);
  CHECK(decision.reason == sync::PresentReason::kDeadline && decision.present && decision.waiting_on == 1);
  CHECK(tracker.Counts().deadline_fallbacks == 1);
  CHECK(!tracker.IsStalled(7));
  CHECK(tracker.ExpectLayout(5, {0, 0, 1200, 800}, {{7, {0, 0, 320, 700}}}, 20000).has_value());
  CHECK(tracker.ShellSubmitted({5, 1}));
  CHECK(tracker.Decide(36667).reason == sync::PresentReason::kDeadline);
  CHECK(tracker.IsStalled(7));
  CHECK(tracker.Counts().stalls == 1);
  CHECK(tracker.ExpectLayout(6, {0, 0, 1200, 800}, {{7, {0, 0, 330, 700}}}, 40000).has_value());
  CHECK(tracker.ShellSubmitted({6, 1}));
  CHECK(tracker.Decide(40001).reason == sync::PresentReason::kMatched);
  const auto expected = tracker.Expected(7);
  CHECK(expected && expected->frame_sequence == 6);
  if (expected) CHECK(tracker.ChildSubmitted(7, *expected));
  CHECK(!tracker.IsStalled(7));
}

void TrackerRejectsForgeriesAndDuplicates() {
  sync::SurfaceSyncTracker tracker;
  tracker.Begin();
  CHECK(tracker.ExpectLayout(3, {0, 0, 100, 100}, {{1, {0, 0, 50, 50}}}, 0).has_value());
  CHECK(!tracker.ExpectLayout(3, {0, 0, 100, 100}, {}, 0));
  CHECK(!tracker.ExpectLayout(2, {0, 0, 100, 100}, {}, 0));
  CHECK(!tracker.ExpectLayout(4, {0, 0, kNaN, 100}, {}, 0));
  CHECK(!tracker.ExpectLayout(4, {0, 0, 100, 100}, {{1, {0, 0, -5, 50}}}, 0));
  CHECK(!tracker.ExpectLayout(4, {0, 0, 100, 100}, {{1, {0, 0, 5, 50}}, {1, {5, 0, 5, 50}}}, 0));
  std::vector<sync::ChildGeometry> crowd(sync::kMaxSurfaces + 1);
  for (size_t i = 0; i < crowd.size(); ++i) crowd[i] = {i, {0, 0, 1, 1}};
  CHECK(!tracker.ExpectLayout(4, {0, 0, 100, 100}, crowd, 0));
  CHECK(tracker.ExpectedShell() == (sync::SurfaceId{3, 1}));
  CHECK(!tracker.ShellSubmitted({4, 1}));
  CHECK(!tracker.ShellSubmitted({3, 2}));
  CHECK(!tracker.ShellSubmitted({2, 1}));
  CHECK(!tracker.ChildSubmitted(1, {3, 3}));
  CHECK(!tracker.ChildSubmitted(1, {4, 2}));
  CHECK(!tracker.ChildSubmitted(1, {2, 2}));
  CHECK(!tracker.ChildSubmitted(99, {3, 2}));
  CHECK(tracker.Counts().rejected_submissions == 7);
  CHECK(tracker.ShellSubmitted({3, 1}));
  CHECK(!tracker.ShellSubmitted({3, 1}));
  CHECK(tracker.Counts().stale_submissions == 1);
  CHECK(tracker.Decide(1).waiting_on == 1);
  CHECK(tracker.ChildSubmitted(1, {3, 2}));
  CHECK(!tracker.ChildSubmitted(1, {3, 2}));
  CHECK(tracker.Counts().stale_submissions == 2);
  CHECK(tracker.Decide(2).reason == sync::PresentReason::kMatched);
  CHECK(tracker.RemoveChild(1));
  CHECK(!tracker.RemoveChild(1));
}

void TrackerNeverAcceptsAReplayAfterRecreation() {
  sync::SurfaceSyncTracker tracker;
  tracker.Begin();
  const auto first = tracker.ExpectLayout(1, {0, 0, 1200, 800}, {{7, {0, 0, 600, 800}}}, 0);
  CHECK(first && (*first)[0] == (sync::SurfaceId{1, 2}));
  CHECK(tracker.ShellSubmitted({1, 1}));
  CHECK(tracker.ChildSubmitted(7, {1, 2}));
  CHECK(tracker.Decide(1).reason == sync::PresentReason::kMatched);
  CHECK(tracker.RemoveChild(7));
  CHECK(tracker.ExpectLayout(2, {0, 0, 1200, 800}, {}, 10).has_value());
  const auto recreated = tracker.ExpectLayout(3, {0, 0, 1200, 800}, {{7, {0, 0, 600, 800}}}, 20);
  CHECK(recreated.has_value());
  if (!recreated) return;
  CHECK((*recreated)[0].frame_sequence == 3 && (*recreated)[0].surface_generation > 2);
  CHECK(tracker.ShellSubmitted({3, 1}));
  CHECK(!tracker.ChildSubmitted(7, {1, 2}));
  CHECK(!tracker.ChildSubmitted(7, {1, (*recreated)[0].surface_generation}));
  CHECK(!tracker.ChildSubmitted(7, {4, (*recreated)[0].surface_generation}));
  const auto holding = tracker.Decide(21);
  CHECK(holding.reason == sync::PresentReason::kHolding && holding.waiting_on == 1);
  CHECK(tracker.ChildSubmitted(7, (*recreated)[0]));
  CHECK(tracker.Decide(22).reason == sync::PresentReason::kMatched);

  sync::SurfaceSyncTracker evicting;
  evicting.Begin();
  std::vector<sync::ChildGeometry> old_children;
  for (uint64_t id = 0; id < sync::kMaxSurfaces; ++id) old_children.push_back({id, {0, 0, 10, 10}});
  const auto old_ids = evicting.ExpectLayout(1, {0, 0, 100, 100}, old_children, 0);
  CHECK(old_ids.has_value());
  if (!old_ids) return;
  std::vector<sync::ChildGeometry> new_children;
  for (uint64_t id = 1000; id < 1000 + sync::kMaxSurfaces; ++id) new_children.push_back({id, {0, 0, 10, 10}});
  CHECK(evicting.ExpectLayout(2, {0, 0, 100, 100}, new_children, 1).has_value());
  CHECK(evicting.ExpectLayout(3, {0, 0, 100, 100}, new_children, 2).has_value());
  CHECK(!evicting.Expected(0).has_value());
  const auto back = evicting.ExpectLayout(4, {0, 0, 100, 100}, {{0, {0, 0, 10, 10}}}, 3);
  CHECK(back && (*back)[0].surface_generation > (*old_ids).back().surface_generation);
  CHECK(!evicting.ChildSubmitted(0, (*old_ids)[0]));
}

void TrackerDeadlinesAreFixedAndSaturate() {
  sync::SurfaceSyncTracker tracker(8333);
  CHECK(tracker.HoldBudget() == 8333);
  tracker.SetVsyncInterval(0);
  CHECK(tracker.HoldBudget() == sync::kMaxHoldMicros);
  tracker.SetVsyncInterval(-50);
  CHECK(tracker.HoldBudget() == sync::kMaxHoldMicros);
  tracker.SetVsyncInterval(100);
  CHECK(tracker.HoldBudget() == sync::kMinHoldMicros);
  tracker.SetVsyncInterval(std::numeric_limits<int64_t>::max());
  CHECK(tracker.HoldBudget() == sync::kMaxHoldMicros);
  tracker.Begin();
  CHECK(tracker.ExpectLayout(1, {0, 0, 10, 10}, {}, 0).has_value());
  tracker.SetVsyncInterval(1000);
  const auto kept = tracker.Decide(2000);
  CHECK(kept.reason == sync::PresentReason::kHolding && kept.deadline_micros == 16667);
  CHECK(tracker.Decide(16667).reason == sync::PresentReason::kDeadline);
  CHECK(tracker.ExpectLayout(2, {0, 0, 10, 10}, {}, 20000).has_value());
  CHECK(tracker.Decide(20500).deadline_micros == 21000);
  CHECK(tracker.Decide(21000).reason == sync::PresentReason::kDeadline);

  sync::SurfaceSyncTracker late(16667);
  late.Begin();
  const int64_t max = std::numeric_limits<int64_t>::max();
  CHECK(late.ExpectLayout(1, {0, 0, 10, 10}, {{4, {0, 0, 5, 5}}}, max - 10).has_value());
  const auto near_end = late.Decide(max - 1);
  CHECK(near_end.reason == sync::PresentReason::kHolding && near_end.deadline_micros == max);
  CHECK(late.Decide(max).reason == sync::PresentReason::kDeadline);

  sync::SurfaceSyncTracker backwards(16667);
  backwards.Begin();
  CHECK(backwards.ExpectLayout(1, {0, 0, 10, 10}, {{4, {0, 0, 5, 5}}}, 1000000).has_value());
  const auto jumped = backwards.Decide(5);
  CHECK(jumped.reason == sync::PresentReason::kDeadline && jumped.present);
  CHECK(backwards.Counts().clock_jumps == 1);
  CHECK(!backwards.IsStalled(4));
  CHECK(backwards.ExpectLayout(2, {0, 0, 10, 10}, {{4, {0, 0, 6, 6}}}, 10).has_value());
  CHECK(backwards.ExpectLayout(3, {0, 0, 10, 10}, {{4, {0, 0, 7, 7}}}, 3).has_value());
  CHECK(backwards.Decide(4).reason == sync::PresentReason::kDeadline);
  CHECK(backwards.Counts().clock_jumps == 2);

  sync::SurfaceSyncTracker extremes(16667);
  extremes.Begin();
  CHECK(extremes.ExpectLayout(1, {0, 0, 10, 10}, {}, std::numeric_limits<int64_t>::min()).has_value());
  CHECK(extremes.Decide(max).reason == sync::PresentReason::kDeadline);
}

void TrackerIssuesNewSurfacesOnScaleChange() {
  sync::SurfaceSyncTracker tracker;
  tracker.Begin();
  const auto first = tracker.ExpectLayout(1, {0, 0, 100, 100}, {{2, {0, 0, 50, 50}}}, 0);
  tracker.SetDeviceScale(2);
  const auto second = tracker.ExpectLayout(2, {0, 0, 100, 100}, {{2, {0, 0, 50, 50}}}, 1);
  CHECK(first && second && (*second)[0].surface_generation > (*first)[0].surface_generation);
  CHECK(tracker.ExpectedShell().surface_generation > 1);
  tracker.SetDeviceScale(2);
  const auto third = tracker.ExpectLayout(3, {0, 0, 100, 100}, {{2, {0, 0, 50, 50}}}, 2);
  CHECK(second && third && (*third)[0] == (*second)[0]);
}

void DividerIndicesNeverWrap() {
  constexpr size_t kWrap = std::numeric_limits<size_t>::max();
  CHECK(!sync::HasDivider(0, kWrap) && !sync::HasDivider(2, kWrap) && !sync::HasDivider(1, 0));
  CHECK(sync::HasDivider(2, 0) && !sync::HasDivider(2, 1));
  const std::vector<double> half{0.5, 0.5};
  CHECK(sync::ResizePair(half, kWrap, 50, 1000, 9) == half);
  CHECK(sync::EvenPair(half, kWrap) == half);
  const std::vector<sync::SplitSlot> slots = Slots({0.5, 0.5});
  CHECK(sync::ResizeSlots(slots, Root(kWrap), 50, 1000, 9) == slots);
  CHECK(sync::ResizeSlots(slots, Stack(kWrap), 50, 1000, 9) == slots);
  CHECK(sync::EvenSlots(slots, Root(kWrap)) == slots);
  sync::LayoutInput input = Window(1200, 800);
  input.split_slots = slots;
  input.ratio_divider = Root(kWrap);
  const auto layout = sync::ComputeLayout(input, 1, Root(kWrap));
  CHECK(layout && !layout->active_divider && Near(layout->split_ratio, 0.5));
  sync::LayoutDragSession session(input);
  const uint64_t sequence = session.Sequence();
  CHECK(!session.BeginSplit(Root(kWrap), 10));
  CHECK(!session.BeginSplit(Stack(kWrap), 10));
  CHECK(!session.BeginSplit(Stack(0), 10));
  CHECK(!session.ResetSplitPair(Root(kWrap)));
  CHECK(session.Active() == sync::DragKind::kNone && session.Sequence() == sequence);
}

void ReleasingASecondaryDividerKeepsItsRatio() {
  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.card_insets = {9, 9, 9, 9};
  input.split_slots = Slots({1, 1, 1});
  input.split_gap = 9;
  sync::LayoutDragSession session(input);
  CHECK(session.BeginSplit(Root(1), 800));
  CHECK(session.Move(860));
  const double live = session.Snapshot().split_ratio;
  CHECK(!Near(live, 0.5));
  const auto release = session.End(860);
  CHECK(release && Near(release->target, live));
  CHECK(Near(session.Snapshot().split_ratio, live) && Near(session.Snapshot().css.split_ratio, live));
  CHECK(!session.Snapshot().active_divider.has_value());
  CHECK(session.Input().ratio_divider == Root(1));
  const auto& sizes = session.Snapshot().split_slots;
  CHECK(Near(live, sizes[1].size / (sizes[1].size + sizes[2].size)));
  CHECK(!Near(live, sizes[0].size / (sizes[0].size + sizes[1].size)));
}

void ShrinkingDuringSettleExposesTheNewTarget() {
  sync::LayoutDragSession session(Window(600, 800));
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(500));
  const auto release = session.End(500);
  CHECK(release && release->needs_settle && release->target == 290);
  CHECK(session.SettleTarget() == 290.0 && session.Snapshot().settle_target == 290.0);
  CHECK(session.ResizeWindow(500, 800));
  CHECK(session.SettleTarget() == 190.0 && session.Snapshot().settle_target == 190.0);
  CHECK(session.Settle(290));
  CHECK(session.Active() == sync::DragKind::kSidebar);
  const auto finished = session.FinishSettle();
  CHECK(finished && finished->target == 190 && !finished->needs_settle);
  CHECK(session.Active() == sync::DragKind::kNone && !session.SettleTarget());
  CHECK(!session.Snapshot().settle_target && session.Snapshot().sidebar_width == 190);
  CHECK(!session.FinishSettle());
}

void ZeroGapPanesShareTheirPixelBoundary() {
  for (const bool card_insets : {false, true}) {
    sync::LayoutInput input = Window(2023.4, 800, 1.3);
    input.sidebar_width = 306 / 1.3;
    input.card_insets = card_insets ? sync::Insets{0, 9, 9, 9} : sync::Insets{};
    input.split_slots = Slots({596, 199, 993});
    input.split_gap = 0;
    const auto layout = sync::ComputeLayout(input, 1);
    CHECK(layout && layout->panes.size() == 3);
    if (!layout) continue;
    for (size_t i = 0; i + 1 < layout->panes.size(); ++i) {
      const sync::PixelRect& left = layout->panes[i].pixels;
      const sync::PixelRect& right = layout->panes[i + 1].pixels;
      CHECK(left.x + left.width == right.x);
      CHECK(layout->dividers[i].pixels.width == 0);
      const sync::PixelRect rounded_left = sync::ToPixels(layout->panes[i].rect, 1.3);
      const sync::PixelRect rounded_right = sync::ToPixels(layout->panes[i + 1].rect, 1.3);
      CHECK(rounded_left.x + rounded_left.width == rounded_right.x);
    }
  }
  unsigned seed = 12345;
  const auto next = [&seed]() {
    seed = seed * 1103515245u + 12345u;
    return static_cast<double>((seed >> 8) % 100000) / 100000.0;
  };
  for (int round = 0; round < 4000; ++round) {
    sync::LayoutInput input = Window(600 + next() * 3000, 400 + next() * 1500, 0.5 + next() * 3.5);
    input.sidebar_width = 160 + next() * 240;
    input.side = next() < 0.5 ? sync::SidebarSide::kLeft : sync::SidebarSide::kRight;
    input.orientation = next() < 0.5 ? sync::SplitOrientation::kHorizontal : sync::SplitOrientation::kVertical;
    input.card_insets = {next() * 12, next() * 12, next() * 12, next() * 12};
    input.split_slots = Slots({1 + next() * 999, 1 + next() * 999, 1 + next() * 999});
    input.split_slots[1].stacked = next() < 0.5;
    input.split_slots[1].stack_sizes = {1 + next() * 99, 1 + next() * 99};
    input.split_gap = next() < 0.5 ? 0 : next() * 12;
    const auto layout = sync::ComputeLayout(input, 1);
    CHECK(layout.has_value());
    if (!layout) continue;
    const bool horizontal = input.orientation == sync::SplitOrientation::kHorizontal;
    std::vector<sync::PixelRect> along;
    for (const sync::PaneLayout& pane : layout->panes) {
      if (pane.stack_index == 0) along.push_back(pane.pixels);
    }
    for (const sync::DividerLayout& divider : layout->dividers) {
      if (divider.ref.kind != sync::DividerKind::kRoot) continue;
      const sync::PixelRect& before = along[divider.ref.index];
      const sync::PixelRect& after = along[divider.ref.index + 1];
      const int before_end = horizontal ? before.x + before.width : before.y + before.height;
      const int divider_start = horizontal ? divider.pixels.x : divider.pixels.y;
      const int divider_end = horizontal ? divider.pixels.x + divider.pixels.width : divider.pixels.y + divider.pixels.height;
      const int after_start = horizontal ? after.x : after.y;
      CHECK(before_end == divider_start && divider_end == after_start);
      if (input.split_gap == 0) CHECK(before_end == after_start);
    }
    const sync::PixelRect& first = along.front();
    const sync::PixelRect& last = along.back();
    const sync::PixelRect& content = layout->content_pixels;
    CHECK((horizontal ? first.x : first.y) == (horizontal ? content.x : content.y));
    CHECK((horizontal ? last.x + last.width : last.y + last.height) ==
          (horizontal ? content.x + content.width : content.y + content.height));
    if (failures > 0) break;
  }
}

void StackedSlotsMatchTheBrowserSplitModel() {
  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.card_insets = {9, 9, 9, 9};
  input.split_slots = {sync::SplitSlot{0.5, false, {0.5, 0.5}}, sync::SplitSlot{0.5, true, {0.3, 0.7}}};
  input.split_gap = 9;
  const auto layout = sync::ComputeLayout(input, 1);
  CHECK(layout && layout->panes.size() == 3 && layout->dividers.size() == 2);
  if (!layout || layout->panes.size() != 3 || layout->dividers.size() != 2) return;
  CHECK(layout->panes[0].rect == (sync::Rect{9, 9, 587, 782}));
  CHECK(layout->panes[1].rect == (sync::Rect{605, 9, 586, 232}));
  CHECK(layout->panes[1].slot == 1 && layout->panes[1].stack_index == 0);
  CHECK(layout->panes[2].rect == (sync::Rect{605, 250, 586, 541}));
  CHECK(layout->panes[2].slot == 1 && layout->panes[2].stack_index == 1);
  CHECK(layout->dividers[0].ref == Root(0) && layout->dividers[0].vertical);
  CHECK(layout->dividers[0].rect == (sync::Rect{596, 9, 9, 782}));
  CHECK(layout->dividers[1].ref == Stack(1) && !layout->dividers[1].vertical);
  CHECK(layout->dividers[1].rect == (sync::Rect{605, 241, 586, 9}));

  sync::LayoutDragSession session(input);
  CHECK(!session.BeginSplit(Stack(0), 241));
  CHECK(session.BeginSplit(Stack(1), 241));
  CHECK(session.Move(341));
  CHECK(session.Snapshot().active_divider == Stack(1));
  CHECK(Near(session.Snapshot().split_ratio, (0.3 * 773 + 100) / 773));
  CHECK(Near(session.Snapshot().split_slots[0].size, 0.5));
  CHECK(session.Move(-5000));
  CHECK(Near(session.Snapshot().split_ratio, 220.0 / 773));
  CHECK(session.Snapshot().panes[1].rect.height == 220);
  const auto release = session.End(-5000);
  CHECK(release && Near(release->target, 220.0 / 773));
  CHECK(Near(session.Snapshot().split_ratio, 220.0 / 773));
  CHECK(session.ResetSplitPair(Stack(1)));
  CHECK(Near(session.Snapshot().split_ratio, 0.5));
  CHECK(Near(session.Snapshot().split_slots[1].stack_sizes[0], 0.5));

  input.orientation = sync::SplitOrientation::kVertical;
  const auto vertical = sync::ComputeLayout(input, 2);
  CHECK(vertical && vertical->panes.size() == 3);
  if (!vertical || vertical->panes.size() != 3) return;
  CHECK(vertical->panes[1].rect.y == vertical->panes[2].rect.y);
  CHECK(vertical->dividers[1].vertical && !vertical->dividers[0].vertical);
}

void TerminationCommitsAndCancelRollsBack() {
  sync::LayoutDragSession sidebar(Window(1200, 800));
  CHECK(!sidebar.Terminate());
  CHECK(sidebar.BeginSidebar(190));
  CHECK(sidebar.Move(900));
  const auto terminated = sidebar.Terminate();
  CHECK(terminated && !terminated->needs_settle && terminated->target == 400 && terminated->kept == 400);
  CHECK(sidebar.Active() == sync::DragKind::kNone && sidebar.Snapshot().sidebar_width == 400);

  CHECK(sidebar.BeginSidebar(400));
  CHECK(sidebar.Move(300));
  const auto mid = sidebar.Terminate();
  CHECK(mid && mid->target == 300 && sidebar.Snapshot().sidebar_width == 300);

  CHECK(sidebar.BeginSidebar(300));
  CHECK(sidebar.Move(900));
  CHECK(sidebar.End(900)->needs_settle);
  const auto settled = sidebar.Terminate();
  CHECK(settled && settled->target == 400 && sidebar.Active() == sync::DragKind::kNone);

  CHECK(sidebar.BeginSidebar(400));
  CHECK(sidebar.Move(250));
  CHECK(sidebar.Cancel());
  CHECK(sidebar.Snapshot().sidebar_width == 400);

  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.split_slots = Slots({0.5, 0.5});
  sync::LayoutDragSession split(input);
  CHECK(split.BeginSplit(Root(0), 600));
  CHECK(split.Move(700));
  const double ratio = split.Snapshot().split_ratio;
  const auto committed = split.Terminate();
  CHECK(committed && Near(committed->target, ratio) && Near(split.Snapshot().split_ratio, ratio));
  CHECK(split.BeginSplit(Root(0), 700));
  CHECK(split.Move(400));
  CHECK(split.Cancel());
  CHECK(Near(split.Snapshot().split_ratio, ratio));
}

void FailedBeginsLeaveTheSessionUntouched() {
  sync::LayoutDragSession broken(Window(0, 800));
  CHECK(!broken.BeginSidebar(10));
  CHECK(broken.Active() == sync::DragKind::kNone && !broken.Input().sidebar_live);
  CHECK(broken.Sequence() == 0);
  CHECK(broken.ResizeWindow(1200, 800));
  CHECK(broken.Sequence() == 1 && broken.Snapshot().sidebar_width == 190);

  sync::LayoutInput input = Window(1200, 800);
  input.split_slots = Slots({0.5, 0.5});
  sync::LayoutDragSession full(input, std::numeric_limits<uint64_t>::max() - 1);
  CHECK(full.Sequence() == std::numeric_limits<uint64_t>::max());
  CHECK(full.Snapshot().css.sequence == std::numeric_limits<uint64_t>::max());
  CHECK(!full.BeginSidebar(190));
  CHECK(!full.BeginSplit(Root(0), 600));
  CHECK(full.Active() == sync::DragKind::kNone && !full.Input().sidebar_live);
  CHECK(!full.ResizeWindow(1000, 800));
  CHECK(full.Input().window.width == 1200 && full.Snapshot().sequence == std::numeric_limits<uint64_t>::max());
}

void ScaleChangesReapplyTheActiveDrag() {
  sync::LayoutInput input = Window(1001.3, 800, 1);
  input.sidebar_shown = false;
  input.card_insets = {9.3, 9, 9.3, 9};
  input.split_slots = Slots({0.5, 0.5});
  input.split_gap = 9;
  sync::LayoutDragSession session(input);
  CHECK(session.BeginSplit(Root(0), 500));
  CHECK(session.Move(600));
  const double at_one = session.Snapshot().split_ratio;
  CHECK(session.SetDeviceScale(1.5));
  CHECK(session.Snapshot().active_divider == Root(0));
  sync::LayoutInput scaled = input;
  scaled.window.device_scale = 1.5;
  sync::LayoutDragSession fresh(scaled);
  CHECK(fresh.BeginSplit(Root(0), 500));
  CHECK(fresh.Move(600));
  CHECK(Near(session.Snapshot().split_ratio, fresh.Snapshot().split_ratio));
  CHECK(!Near(at_one, fresh.Snapshot().split_ratio));
  CHECK(session.Snapshot().panes[0].pixels == fresh.Snapshot().panes[0].pixels);
}
}

void ClockJumpsNeverChargeAMiss() {
  sync::SurfaceSyncTracker tracker(16667);
  tracker.Begin();
  CHECK(tracker.ExpectLayout(1, {0, 0, 100, 100}, {{4, {0, 0, 50, 50}}}, 0).has_value());
  CHECK(tracker.ShellSubmitted(tracker.ExpectedShell()));
  CHECK(tracker.Decide(16667).reason == sync::PresentReason::kDeadline);
  CHECK(!tracker.IsStalled(4));
  CHECK(tracker.ExpectLayout(2, {0, 0, 100, 100}, {{4, {0, 0, 51, 51}}}, 20000).has_value());
  CHECK(tracker.ExpectLayout(3, {0, 0, 100, 100}, {{4, {0, 0, 52, 52}}}, 3).has_value());
  CHECK(tracker.ShellSubmitted(tracker.ExpectedShell()));
  const auto jumped = tracker.Decide(4);
  CHECK(jumped.reason == sync::PresentReason::kDeadline && jumped.present);
  CHECK(!tracker.IsStalled(4));
  CHECK(tracker.Counts().stalls == 0 && tracker.Counts().clock_jumps == 1);
  CHECK(tracker.ExpectLayout(4, {0, 0, 100, 100}, {{4, {0, 0, 53, 53}}}, 10).has_value());
  CHECK(tracker.ShellSubmitted(tracker.ExpectedShell()));
  CHECK(tracker.Decide(11).reason == sync::PresentReason::kHolding);
  CHECK(tracker.Decide(16677).reason == sync::PresentReason::kDeadline);
  CHECK(tracker.IsStalled(4) && tracker.Counts().stalls == 1);

  sync::SurfaceSyncTracker idle(16667);
  idle.Begin();
  CHECK(idle.ExpectLayout(1, {0, 0, 100, 100}, {{4, {0, 0, 50, 50}}}, 1000000).has_value());
  CHECK(idle.ShellSubmitted(idle.ExpectedShell()));
  const auto expected = idle.Expected(4);
  if (expected) CHECK(idle.ChildSubmitted(4, *expected));
  CHECK(idle.Decide(1000001).reason == sync::PresentReason::kMatched);
  CHECK(idle.ExpectLayout(2, {0, 0, 100, 100}, {{4, {0, 0, 60, 60}}}, 5).has_value());
  const auto fresh_hold = idle.Decide(5);
  CHECK(fresh_hold.reason == sync::PresentReason::kDeadline && fresh_hold.present);
  CHECK(!idle.IsStalled(4) && idle.Counts().clock_jumps == 1);
  CHECK(idle.ExpectLayout(3, {0, 0, 100, 100}, {{4, {0, 0, 61, 61}}}, 6).has_value());
  CHECK(idle.Decide(7).reason == sync::PresentReason::kHolding);
}

void TerminateNeverCollapsesTheSidebar() {
  sync::LayoutInput input = Window(1200, 800);
  input.collapse_below = 140;
  sync::LayoutDragSession session(input);
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(0));
  CHECK(session.Snapshot().sidebar_collapsed);
  const auto terminated = session.Terminate();
  CHECK(terminated && !terminated->collapsed && !terminated->needs_settle);
  CHECK(terminated && terminated->target == 160 && terminated->kept == 160);
  CHECK(session.Active() == sync::DragKind::kNone);
  CHECK(!session.Snapshot().sidebar_collapsed && session.Snapshot().sidebar_width == 160);
  CHECK(session.Input().sidebar_shown);
}

void EndSpendsOneSequence() {
  constexpr uint64_t kLast = std::numeric_limits<uint64_t>::max();
  sync::LayoutDragSession sidebar(Window(1200, 800), kLast - 3);
  CHECK(sidebar.BeginSidebar(190));
  CHECK(sidebar.Sequence() == kLast - 1);
  const auto released = sidebar.End(250);
  CHECK(released && released->target == 250 && !released->needs_settle);
  CHECK(sidebar.Sequence() == kLast && sidebar.Active() == sync::DragKind::kNone);
  CHECK(sidebar.Snapshot().sidebar_width == 250 && !sidebar.Input().sidebar_live);

  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.card_insets = {};
  input.split_slots = Slots({0.5, 0.5});
  sync::LayoutDragSession split(input, kLast - 3);
  CHECK(split.BeginSplit(Root(0), 600));
  const auto split_release = split.End(700);
  CHECK(split_release && Near(split_release->target, 700.0 / 1200));
  CHECK(split.Sequence() == kLast && split.Active() == sync::DragKind::kNone);
  CHECK(Near(split.Snapshot().split_ratio, 700.0 / 1200));

  sync::LayoutDragSession spring(Window(1200, 800), kLast - 3);
  CHECK(spring.BeginSidebar(190));
  const auto stretched = spring.End(900);
  CHECK(stretched && !stretched->needs_settle && stretched->target == 400 && stretched->kept == 400);
  CHECK(spring.Sequence() == kLast && spring.Active() == sync::DragKind::kNone && !spring.SettleTarget());
  CHECK(spring.Snapshot().sidebar_width == 400 && !spring.Input().sidebar_live);

  sync::LayoutDragSession roomy(Window(1200, 800), kLast - 4);
  CHECK(roomy.BeginSidebar(190));
  const auto springing = roomy.End(900);
  CHECK(springing && springing->needs_settle && roomy.SettleTarget() == 400.0);
  CHECK(roomy.Sequence() == kLast - 1);
  CHECK(roomy.Settle(420));
  CHECK(roomy.Sequence() == kLast && roomy.Active() == sync::DragKind::kNone);
  CHECK(roomy.Snapshot().sidebar_width == 400 && !roomy.Input().sidebar_live);
}

void IdleClockJumpsPresentTheNextLayout() {
  sync::SurfaceSyncTracker tracker(16667);
  tracker.Begin();
  CHECK(tracker.ExpectLayout(1, {0, 0, 100, 100}, {{4, {0, 0, 50, 50}}}, 1000000).has_value());
  CHECK(tracker.ShellSubmitted(tracker.ExpectedShell()));
  const auto expected = tracker.Expected(4);
  if (expected) CHECK(tracker.ChildSubmitted(4, *expected));
  CHECK(tracker.Decide(1000001).reason == sync::PresentReason::kMatched);
  CHECK(tracker.Decide(5).reason == sync::PresentReason::kIdle);
  CHECK(tracker.Counts().clock_jumps == 1);
  CHECK(tracker.ExpectLayout(2, {0, 0, 100, 100}, {{4, {0, 0, 60, 60}}}, 6).has_value());
  const auto fallback = tracker.Decide(7);
  CHECK(fallback.reason == sync::PresentReason::kDeadline && fallback.present);
  CHECK(!tracker.IsStalled(4) && tracker.Counts().clock_jumps == 1);
  CHECK(tracker.ExpectLayout(3, {0, 0, 100, 100}, {{4, {0, 0, 61, 61}}}, 8).has_value());
  CHECK(tracker.Decide(9).reason == sync::PresentReason::kHolding);
}

void CommittedWidthsNeverAutoCollapse() {
  sync::LayoutInput input = Window(1200, 800);
  input.collapse_below = 170;
  sync::LayoutDragSession session(input);
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(0));
  CHECK(session.Snapshot().sidebar_collapsed);
  const auto terminated = session.Terminate();
  CHECK(terminated && !terminated->collapsed && terminated->target == 160);
  CHECK(!session.Snapshot().sidebar_collapsed && session.Snapshot().sidebar_width == 160);
  CHECK(session.Snapshot().sidebar.width == 160 && session.Snapshot().css.sidebar_width == 160);
  sync::LayoutInput narrow = Window(1200, 800);
  narrow.collapse_below = 170;
  narrow.sidebar_width = 160;
  const auto layout = sync::ComputeLayout(narrow, 1);
  CHECK(layout && !layout->sidebar_collapsed && layout->sidebar_width == 160);
  CHECK(session.BeginSidebar(160));
  CHECK(session.Move(0));
  const auto released = session.End(0);
  CHECK(released && released->collapsed && session.Snapshot().sidebar_collapsed);
  CHECK(session.Snapshot().sidebar_width == 0);
}

void ClockJumpsSurviveBegin() {
  sync::SurfaceSyncTracker tracker(16667);
  CHECK(tracker.Decide(100).reason == sync::PresentReason::kIdle);
  CHECK(tracker.Decide(5).reason == sync::PresentReason::kIdle);
  CHECK(tracker.Counts().clock_jumps == 1);
  tracker.Begin();
  CHECK(tracker.ExpectLayout(1, {0, 0, 100, 100}, {{4, {0, 0, 50, 50}}}, 6).has_value());
  const auto fallback = tracker.Decide(7);
  CHECK(fallback.reason == sync::PresentReason::kDeadline && fallback.present);
  CHECK(!tracker.IsStalled(4) && tracker.Counts().stalls == 0);
  CHECK(tracker.ExpectLayout(2, {0, 0, 100, 100}, {{4, {0, 0, 60, 60}}}, 8).has_value());
  CHECK(tracker.Decide(9).reason == sync::PresentReason::kHolding);
  tracker.End();
  CHECK(tracker.Decide(3).reason == sync::PresentReason::kIdle);
  tracker.Begin();
  CHECK(tracker.ExpectLayout(3, {0, 0, 100, 100}, {{4, {0, 0, 70, 70}}}, 4).has_value());
  CHECK(tracker.Decide(5).reason == sync::PresentReason::kDeadline);
  CHECK(tracker.Counts().clock_jumps == 2 && !tracker.IsStalled(4));
}

void LastSequenceFinishesInsteadOfStranding() {
  constexpr uint64_t kLast = std::numeric_limits<uint64_t>::max();
  for (const int change : {0, 1, 2}) {
    sync::LayoutDragSession session(Window(1200, 800), kLast - 4);
    CHECK(session.BeginSidebar(190));
    const auto release = session.End(900);
    CHECK(release && release->needs_settle && session.Sequence() == kLast - 1);
    if (change == 0) CHECK(session.ResizeWindow(1100, 800));
    if (change == 1) CHECK(session.SetDeviceScale(2));
    if (change == 2) CHECK(session.ResizeWindow(600, 800));
    const double expected = change == 2 ? 290 : 400;
    CHECK(session.Sequence() == kLast && session.Active() == sync::DragKind::kNone && !session.SettleTarget());
    CHECK(session.Snapshot().sidebar_width == expected && !session.Input().sidebar_live);
    CHECK(!session.Snapshot().settle_target.has_value());
  }

  sync::LayoutDragSession live(Window(1200, 800), kLast - 3);
  CHECK(live.BeginSidebar(190));
  CHECK(live.Sequence() == kLast - 1);
  CHECK(!live.Move(300));
  CHECK(live.Active() == sync::DragKind::kSidebar && live.Sequence() == kLast - 1);
  CHECK(live.ResizeWindow(1100, 800));
  CHECK(live.Sequence() == kLast && live.Active() == sync::DragKind::kNone);
  CHECK(live.Snapshot().sidebar_width == 190 && !live.Input().sidebar_live);

  sync::LayoutDragSession ended(Window(1200, 800), kLast - 3);
  CHECK(ended.BeginSidebar(190));
  CHECK(!ended.Move(300));
  const auto finished = ended.End(300);
  CHECK(finished && finished->target == 300 && ended.Sequence() == kLast);
  CHECK(ended.Active() == sync::DragKind::kNone);

  sync::LayoutDragSession late_begin(Window(1200, 800), kLast - 2);
  CHECK(late_begin.Sequence() == kLast - 1);
  CHECK(!late_begin.BeginSidebar(190));
  CHECK(late_begin.Active() == sync::DragKind::kNone && late_begin.Sequence() == kLast - 1);

  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.card_insets = {};
  input.split_slots = Slots({0.5, 0.5});
  sync::LayoutDragSession split(input, kLast - 3);
  CHECK(split.BeginSplit(Root(0), 600));
  CHECK(split.SetDeviceScale(2));
  CHECK(split.Sequence() == kLast && split.Active() == sync::DragKind::kNone);
  CHECK(Near(split.Snapshot().split_ratio, 0.5) && split.Snapshot().device_scale == 2);
}

void ClockJumpsOutliveAMatchedLayout() {
  sync::SurfaceSyncTracker tracker(16667);
  CHECK(tracker.Decide(100).reason == sync::PresentReason::kIdle);
  CHECK(tracker.Decide(5).reason == sync::PresentReason::kIdle);
  tracker.Begin();
  const auto first = tracker.ExpectLayout(1, {0, 0, 100, 100}, {{4, {0, 0, 50, 50}}}, 6);
  CHECK(first.has_value());
  CHECK(tracker.ShellSubmitted(tracker.ExpectedShell()));
  if (first) CHECK(tracker.ChildSubmitted(4, (*first)[0]));
  CHECK(tracker.Decide(7).reason == sync::PresentReason::kMatched);
  CHECK(tracker.ExpectLayout(2, {0, 0, 100, 100}, {{4, {0, 0, 60, 60}}}, 8).has_value());
  const auto fallback = tracker.Decide(9);
  CHECK(fallback.reason == sync::PresentReason::kDeadline && fallback.present);
  CHECK(!tracker.IsStalled(4) && tracker.Counts().stalls == 0 && tracker.Counts().clock_jumps == 1);
  CHECK(tracker.ExpectLayout(3, {0, 0, 100, 100}, {{4, {0, 0, 70, 70}}}, 10).has_value());
  CHECK(tracker.Decide(11).reason == sync::PresentReason::kHolding);
}

int main() {
  SidebarLimitMatchesTheBrowserUi();
  RubberBandRoundTrips();
  LeftSidebarDragFollowsThePointerAndSettles();
  RightSidebarGrowsTowardTheLeft();
  GrabOffsetAnchorsOnTheFirstMove();
  CancelRevertsToTheWidthBeforeTheGesture();
  CollapseThresholdHidesTheSidebar();
  HostileInputLeavesTheLayoutAlone();
  WindowResizeMidDragRebandsAgainstTheNewLimit();
  FractionalScalesShareEveryEdge();
  SplitCutMatchesTheBrowserGeometry();
  SplitResizeClampsLikeTheBrowser();
  SplitDragSessionPublishesRatioAndReverts();
  DeviceScaleChangesResnap();
  TrackerPresentsWhenParentAndChildrenMatch();
  TrackerNeverWaitsPastOneFrame();
  TrackerRejectsForgeriesAndDuplicates();
  TrackerNeverAcceptsAReplayAfterRecreation();
  TrackerDeadlinesAreFixedAndSaturate();
  TrackerIssuesNewSurfacesOnScaleChange();
  DividerIndicesNeverWrap();
  ReleasingASecondaryDividerKeepsItsRatio();
  ShrinkingDuringSettleExposesTheNewTarget();
  ZeroGapPanesShareTheirPixelBoundary();
  StackedSlotsMatchTheBrowserSplitModel();
  TerminationCommitsAndCancelRollsBack();
  FailedBeginsLeaveTheSessionUntouched();
  ScaleChangesReapplyTheActiveDrag();
  ClockJumpsNeverChargeAMiss();
  TerminateNeverCollapsesTheSidebar();
  EndSpendsOneSequence();
  IdleClockJumpsPresentTheNextLayout();
  CommittedWidthsNeverAutoCollapse();
  ClockJumpsSurviveBegin();
  LastSequenceFinishesInsteadOfStranding();
  ClockJumpsOutliveAMatchedLayout();
  if (failures) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}
