// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/edge_rules.h"

#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {
namespace {

const gfx::Rect kScreen(0, 0, 1920, 1080);
const gfx::Rect kAway(400, 100, 1200, 800);
const gfx::Rect kTiled(4, 0, 1200, 1080);
const SidebarEdgeStack kClear;

constexpr int kPanelHold = 240 + kSidebarEdgeReach;

bool Over(const gfx::Point& cursor,
          const gfx::Rect& window,
          SidebarEdgeWatch watch,
          bool holding,
          SidebarEdgeStack stack = kClear,
          bool pressed = false) {
  return SidebarEdgeOver(
      ProbeSidebarEdge(cursor, window, kScreen, watch, holding), stack, watch,
      pressed);
}

TEST(SidebarEdgeRulesTest, HoldStaysOutWithinReachOfThePanel) {
  const SidebarEdgeWatch peeking{kPanelHold, false, true};
  const int panel_edge = kAway.x() + 240;
  for (int right_of_panel : {2, 21, 23}) {
    EXPECT_TRUE(Over({panel_edge + right_of_panel, 400}, kAway, peeking, true))
        << right_of_panel;
  }
  EXPECT_FALSE(Over({panel_edge + 30, 400}, kAway, peeking, true));
}

TEST(SidebarEdgeRulesTest, LeavingUpwardHidesPastTheSlack) {
  const SidebarEdgeWatch peeking{kPanelHold, false, true};
  EXPECT_TRUE(Over({kAway.x() + 50, kAway.y() - 10}, kAway, peeking, true));
  EXPECT_FALSE(Over({kAway.x() + 50, kAway.y() - 30}, kAway, peeking, true));
  EXPECT_FALSE(Over({kAway.x() + 50, kAway.y() - 10}, kAway,
                    SidebarEdgeWatch{0, false, false}, false));
}

TEST(SidebarEdgeRulesTest, OvershootLeftOfTheWindowPeeksAndHolds) {
  const SidebarEdgeWatch watching{0, false, false};
  const SidebarEdgeWatch peeking{kPanelHold, false, true};
  for (int left : {10, 23}) {
    EXPECT_TRUE(Over({kAway.x() - left, 400}, kAway, watching, false)) << left;
    EXPECT_TRUE(Over({kAway.x() - left, 400}, kAway, peeking, true)) << left;
  }
  EXPECT_FALSE(Over({kAway.x() - 30, 400}, kAway, watching, false));
  EXPECT_FALSE(Over({kAway.x() - 30, 400}, kAway, peeking, true));
}

TEST(SidebarEdgeRulesTest, OvershootStopsAtTheWorkAreaEdge) {
  const SidebarEdgeWatch watching{0, false, false};
  EXPECT_TRUE(Over({2, 400}, kTiled, watching, false));
  EXPECT_FALSE(Over({-1, 400}, kTiled, watching, false));
  const gfx::Rect flush(0, 0, 1200, 1080);
  EXPECT_EQ(ProbeSidebarEdge({0, 400}, flush, kScreen, watching, false).zone,
            SidebarEdgeZone::kBand);
}

TEST(SidebarEdgeRulesTest, AwayFromTheScreenEdgeTheOvershootNeedsArdiaActive) {
  const SidebarEdgeWatch watching{0, false, false};
  SidebarEdgeStack inactive;
  inactive.app_active = false;
  EXPECT_FALSE(Over({kAway.x() - 10, 400}, kAway, watching, false, inactive));
  EXPECT_TRUE(Over({1, 400}, kTiled, watching, false, inactive));
  EXPECT_TRUE(Over({kAway.x() + 2, 400}, kAway, watching, false, inactive));
}

TEST(SidebarEdgeRulesTest, CoveredEdgesNeverPeek) {
  const SidebarEdgeWatch watching{0, false, false};
  SidebarEdgeStack over_other;
  over_other.cursor_over_other = true;
  EXPECT_FALSE(Over({kAway.x() - 10, 400}, kAway, watching, false, over_other));
  EXPECT_TRUE(Over({kAway.x() + 2, 400}, kAway, watching, false, over_other));
  SidebarEdgeStack edge_covered;
  edge_covered.window_on_top_inside = false;
  EXPECT_FALSE(
      Over({kAway.x() - 10, 400}, kAway, watching, false, edge_covered));
  EXPECT_FALSE(Over({kAway.x() + 2, 400}, kAway, watching, false, edge_covered));
  const SidebarEdgeWatch peeking{kPanelHold, false, true};
  EXPECT_FALSE(Over({kAway.x() + 50, kAway.y() - 10}, kAway, peeking, true,
                    over_other));
}

TEST(SidebarEdgeRulesTest, ButtonsHeldBlockTheEdgeUnlessWatchedWhilePressed) {
  const SidebarEdgeWatch watching{0, false, false};
  const SidebarEdgeWatch peeking{kPanelHold, false, true};
  EXPECT_FALSE(Over({kAway.x() + 2, 400}, kAway, watching, false, kClear, true));
  EXPECT_TRUE(Over({kAway.x() + 100, 400}, kAway, peeking, true, kClear, true));
  EXPECT_FALSE(Over({kAway.x() + 400, 400}, kAway, peeking, true, kClear, true));
}

TEST(SidebarEdgeRulesTest, TheBandIsAtLeastHalfTheReach) {
  const SidebarEdgeWatch watching{0, false, false};
  EXPECT_TRUE(Over({kAway.x() + kSidebarEdgeLeastBand - 1, 400}, kAway,
                   watching, false));
  EXPECT_FALSE(
      Over({kAway.x() + kSidebarEdgeLeastBand, 400}, kAway, watching, false));
}

TEST(SidebarEdgeRulesTest, RightSidebarMirrors) {
  const SidebarEdgeWatch watching{0, true, false};
  const SidebarEdgeWatch peeking{kPanelHold, true, true};
  const gfx::Rect left_half(100, 100, 800, 800);
  EXPECT_TRUE(Over({left_half.right() + 10, 400}, left_half, watching, false));
  EXPECT_TRUE(Over({left_half.right() + 23, 400}, left_half, peeking, true));
  EXPECT_FALSE(Over({left_half.right() + 30, 400}, left_half, peeking, true));
  EXPECT_TRUE(
      Over({left_half.right() - 240 - 21, 400}, left_half, peeking, true));
  EXPECT_FALSE(
      Over({left_half.right() - 240 - 30, 400}, left_half, peeking, true));
  EXPECT_FALSE(Over({left_half.x() - 10, 400}, left_half, watching, false));
  const gfx::Rect flush_right(1920 - 1200, 0, 1200, 1080);
  EXPECT_FALSE(Over({1920, 400}, flush_right, watching, false));
  EXPECT_TRUE(BesideWorkAreaEdge(gfx::Rect(1910 - 1200, 0, 1200, 1080),
                                 kScreen, true));
}

TEST(SidebarEdgeRulesTest, ProbesTheWindowJustInsideItsEdge) {
  const SidebarEdgeWatch watching{0, false, false};
  const SidebarEdgeProbe beyond =
      ProbeSidebarEdge({kAway.x() - 5, 300}, kAway, kScreen, watching, false);
  EXPECT_EQ(beyond.zone, SidebarEdgeZone::kBeyond);
  EXPECT_EQ(beyond.inside.x(), kAway.x() + 1);
  EXPECT_EQ(beyond.inside.y(), 300);
  EXPECT_TRUE(beyond.needs_active_app);
  const SidebarEdgeProbe slack = ProbeSidebarEdge(
      {kAway.x() + 3, kAway.bottom() + 5}, kAway, kScreen, watching, true);
  EXPECT_EQ(slack.zone, SidebarEdgeZone::kBand);
  EXPECT_EQ(slack.inside.x(), kAway.x() + 3);
  EXPECT_EQ(slack.inside.y(), kAway.bottom() - 1);
  EXPECT_FALSE(slack.cursor_in_window);
}

}
}
