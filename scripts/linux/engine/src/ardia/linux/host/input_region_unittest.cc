// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/host/input_region.h"

#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

RoundedArea Area(float x, float y, float width, float height, float radius) {
  RoundedArea area;
  area.rect = gfx::RectF(x, y, width, height);
  area.radius = radius;
  return area;
}

TEST(InputRegionTest, PointsOutsideEveryPageGoToTheUi) {
  InputRegion region;
  region.SetPage("a", Area(100, 50, 400, 300, 0), {});
  EXPECT_EQ(region.PageAt(gfx::PointF(10, 10)), "");
  EXPECT_EQ(region.PageAt(gfx::PointF(500, 50)), "");
  EXPECT_EQ(region.PageAt(gfx::PointF(100, 50)), "a");
  EXPECT_EQ(region.PageAt(gfx::PointF(499.5f, 349.5f)), "a");
}

TEST(InputRegionTest, RoundedCornersBelongToTheUi) {
  InputRegion region;
  region.SetPage("a", Area(0, 0, 200, 200, 20), {});
  EXPECT_EQ(region.PageAt(gfx::PointF(1, 1)), "");
  EXPECT_EQ(region.PageAt(gfx::PointF(20, 1)), "a");
  EXPECT_EQ(region.PageAt(gfx::PointF(6, 6)), "a");
  EXPECT_EQ(region.PageAt(gfx::PointF(198, 198)), "");
}

TEST(InputRegionTest, HolesGiveTheUiTheirPoints) {
  InputRegion region;
  base::ListValue holes;
  base::ListValue bar;
  bar.Append(296);
  bar.Append(4);
  bar.Append(811);
  bar.Append(104);
  bar.Append(20);
  holes.Append(std::move(bar));
  region.SetPage("a", Area(0, 0, 1400, 900, 12),
                 InputRegion::HolesFrom(&holes));
  EXPECT_EQ(region.PageAt(gfx::PointF(500, 50)), "");
  EXPECT_EQ(region.PageAt(gfx::PointF(297, 5)), "a");
  EXPECT_EQ(region.PageAt(gfx::PointF(500, 200)), "a");
}

TEST(InputRegionTest, TheLaterPageWinsWhereTheyOverlapAndItsHolesHold) {
  InputRegion region;
  region.SetPage("under", Area(0, 0, 400, 400, 0), {});
  region.SetPage("peek", Area(100, 100, 200, 200, 0),
                 {Area(150, 150, 20, 20, 0)});
  EXPECT_EQ(region.PageAt(gfx::PointF(50, 50)), "under");
  EXPECT_EQ(region.PageAt(gfx::PointF(120, 120)), "peek");
  EXPECT_EQ(region.PageAt(gfx::PointF(155, 155)), "");
  region.RaisePage("under");
  EXPECT_EQ(region.PageAt(gfx::PointF(120, 120)), "under");
  region.RemovePage("under");
  EXPECT_EQ(region.PageAt(gfx::PointF(50, 50)), "");
  EXPECT_FALSE(region.Has("under"));
}

TEST(InputRegionTest, MalformedHolesAreSkipped) {
  base::ListValue holes;
  holes.Append(3);
  base::ListValue short_hole;
  short_hole.Append(1);
  holes.Append(std::move(short_hole));
  EXPECT_TRUE(InputRegion::HolesFrom(&holes).empty());
  EXPECT_TRUE(InputRegion::HolesFrom(nullptr).empty());
}

}

}
