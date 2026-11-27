#include "ardia/mac/ac_mac_glass_layout.h"

#include <cmath>
#include <limits>
#include <string>
#include <vector>

#include "check.h"

namespace glass = ardia_mac::glass;
using glass::Layer;
using glass::Material;
using glass::Page;
using glass::Placement;
using glass::Plane;
using glass::Rect;
using glass::Region;

namespace {

const Rect kWindow{0, 0, 1280, 800};

Region Make(std::string id, Rect rect, Layer layer = Layer::kAuto, double radius = 0) {
  Region region;
  region.id = std::move(id);
  region.rect = rect;
  region.radii = {radius, radius, radius, radius};
  region.layer = layer;
  return region;
}

const Placement* Find(const glass::Layout& layout, const std::string& id, int page) {
  for (const Placement& placement : layout.placements) {
    if (placement.id == id && placement.page == page) return &placement;
  }
  return nullptr;
}

bool Rejected(const glass::Layout& layout, const std::string& id, const std::string& reason) {
  for (const auto& rejection : layout.rejected) {
    if (rejection.id == id && rejection.reason == reason) return true;
  }
  return false;
}

}

TEST(behind_region_stays_behind_even_over_a_page) {
  const std::vector<Page> pages{{7, {300, 50, 900, 700}}};
  const auto layout = glass::Lay({Make("sidebar", {320, 60, 100, 100}, Layer::kBehind)}, pages, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].plane == Plane::kBehindWindow);
  CHECK(layout.placements[0].page == 0);
  CHECK(layout.placements[0].frame == (Rect{320, 60, 100, 100}));
}

TEST(over_page_region_goes_into_the_page_slot_in_page_coordinates) {
  const std::vector<Page> pages{{7, {300, 50, 900, 700}}};
  const auto layout = glass::Lay({Make("bar", {400, 100, 200, 40}, Layer::kOverPage, 12)}, pages, kWindow, 1);
  const Placement* placed = Find(layout, "bar", 7);
  CHECK(placed != nullptr);
  if (!placed) return;
  CHECK(placed->plane == Plane::kOverPage);
  CHECK(placed->frame == (Rect{100, 50, 200, 40}));
  CHECK(placed->visible == placed->frame);
  CHECK_NEAR(placed->radius, 12);
  CHECK(placed->corners == glass::kAllCorners);
}

TEST(auto_region_picks_the_page_it_covers) {
  const std::vector<Page> pages{{3, {300, 0, 980, 800}}};
  const auto layout = glass::Lay({Make("find", {900, 10, 300, 44}), Make("side", {0, 0, 280, 800})}, pages, kWindow, 1);
  CHECK(Find(layout, "find", 3) && Find(layout, "find", 3)->plane == Plane::kOverPage);
  CHECK(Find(layout, "side", 0) && Find(layout, "side", 0)->plane == Plane::kBehindWindow);
}

TEST(over_page_region_without_a_page_falls_back_behind) {
  const auto layout = glass::Lay({Make("bar", {10, 10, 50, 50}, Layer::kOverPage)}, {}, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].plane == Plane::kBehindWindow);
}

TEST(region_spanning_split_pages_gets_a_slot_in_each) {
  const std::vector<Page> pages{{1, {0, 0, 600, 800}}, {2, {610, 0, 670, 800}}};
  const auto layout = glass::Lay({Make("peek", {500, 100, 300, 200}, Layer::kOverPage)}, pages, kWindow, 1);
  const Placement* left = Find(layout, "peek", 1);
  const Placement* right = Find(layout, "peek", 2);
  CHECK(left && right);
  if (!left || !right) return;
  CHECK(left->frame == (Rect{500, 100, 300, 200}));
  CHECK(left->visible == (Rect{500, 100, 100, 200}));
  CHECK(right->frame == (Rect{-110, 100, 300, 200}));
  CHECK(right->visible == (Rect{0, 100, 190, 200}));
}

TEST(behind_region_is_clipped_to_the_window) {
  const auto layout = glass::Lay({Make("edge", {1200, 700, 200, 200}, Layer::kBehind)}, {}, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].visible == (Rect{1200, 700, 80, 100}));
  const auto gone = glass::Lay({Make("off", {2000, 2000, 10, 10}, Layer::kBehind)}, {}, kWindow, 1);
  CHECK(gone.placements.empty());
  CHECK(gone.accepted.size() == 1);
}

TEST(radii_scale_down_like_css_and_never_exceed_the_box) {
  Region region = Make("r", {0, 0, 100, 40}, Layer::kBehind);
  region.radii = {30, 30, 30, 30};
  const auto layout = glass::Lay({region}, {}, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK_NEAR(layout.placements[0].radius, 20);
  region.radii = {10, 0, 0, 0};
  const auto one = glass::Lay({region}, {}, kWindow, 1);
  CHECK(one.placements[0].corners == glass::kUpperLeft);
  region.radii = {-5, 4, 0, 0};
  const auto negative = glass::Lay({region}, {}, kWindow, 1);
  CHECK(negative.placements[0].corners == glass::kUpperRight);
}

TEST(shell_zoom_scales_rect_and_radii) {
  const auto layout = glass::Lay({Make("z", {10, 10, 100, 50}, Layer::kBehind, 8)}, {}, kWindow, 1.5);
  CHECK(layout.placements[0].frame == (Rect{15, 15, 150, 75}));
  CHECK_NEAR(layout.placements[0].radius, 12);
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const auto sane = glass::Lay({Make("z", {10, 10, 100, 50}, Layer::kBehind)}, {}, kWindow, nan);
  CHECK(sane.placements[0].frame == (Rect{10, 10, 100, 50}));
  const auto negative = glass::Lay({Make("z", {10, 10, 100, 50}, Layer::kBehind)}, {}, kWindow, -2);
  CHECK(negative.placements[0].frame == (Rect{10, 10, 100, 50}));
}

TEST(nan_infinite_and_empty_regions_are_refused) {
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  Region bad_radius = Make("radius", {0, 0, 10, 10});
  bad_radius.radii.lower_left = nan;
  Region bad_opacity = Make("opacity", {0, 0, 10, 10});
  bad_opacity.opacity = nan;
  Region bad_blur = Make("blur", {0, 0, 10, 10});
  bad_blur.blur = 1e9;
  const auto layout = glass::Lay({Make("nan", {nan, 0, 10, 10}), Make("inf", {0, 0, inf, 10}),
                                  Make("empty", {0, 0, 0, 10}), Make("negative", {0, 0, -4, 10}),
                                  Make("huge", {0, 0, 2e6, 10}), bad_radius, bad_opacity, bad_blur},
                                 {}, kWindow, 1);
  CHECK(layout.placements.empty());
  CHECK(layout.accepted.empty());
  CHECK(Rejected(layout, "nan", "rect"));
  CHECK(Rejected(layout, "inf", "rect"));
  CHECK(Rejected(layout, "empty", "rect"));
  CHECK(Rejected(layout, "negative", "rect"));
  CHECK(Rejected(layout, "huge", "rect"));
  CHECK(Rejected(layout, "radius", "radii"));
  CHECK(Rejected(layout, "opacity", "style"));
  CHECK(Rejected(layout, "blur", "style"));
}

TEST(ids_are_checked_and_unique) {
  const auto layout = glass::Lay({Make("", {0, 0, 10, 10}), Make("a b", {0, 0, 10, 10}), Make("ok", {0, 0, 10, 10}),
                                  Make("ok", {20, 0, 10, 10}), Make(std::string(200, 'x'), {0, 0, 10, 10})},
                                 {}, kWindow, 1);
  CHECK(layout.accepted == std::vector<std::string>{"ok"});
  CHECK(Rejected(layout, "ok", "duplicate"));
  CHECK(layout.rejected.size() == 4);
}

TEST(region_count_is_capped) {
  std::vector<Region> regions;
  for (int index = 0; index < 80; ++index) {
    regions.push_back(Make("r" + std::to_string(index), {static_cast<double>(index), 0, 4, 4}, Layer::kBehind));
  }
  const auto layout = glass::Lay(regions, {}, kWindow, 1);
  CHECK(layout.accepted.size() == glass::kMaxRegions);
  CHECK(layout.rejected.size() == 80 - glass::kMaxRegions);
}

TEST(transparent_regions_are_accepted_but_not_placed) {
  Region region = Make("faded", {0, 0, 10, 10});
  region.opacity = 0;
  const auto layout = glass::Lay({region}, {}, kWindow, 1);
  CHECK(layout.accepted.size() == 1);
  CHECK(layout.placements.empty());
  region.opacity = 7;
  CHECK_NEAR(glass::Lay({region}, {}, kWindow, 1).placements[0].opacity, 1);
}

TEST(plane_order_follows_input_order_per_plane_and_page) {
  const std::vector<Page> pages{{4, {300, 0, 980, 800}}};
  const auto layout = glass::Lay({Make("a", {0, 0, 10, 10}), Make("b", {400, 0, 10, 10}), Make("c", {20, 0, 10, 10}),
                                  Make("d", {500, 0, 10, 10})},
                                 pages, kWindow, 1);
  CHECK(Find(layout, "a", 0)->order == 0);
  CHECK(Find(layout, "c", 0)->order == 1);
  CHECK(Find(layout, "b", 4)->order == 0);
  CHECK(Find(layout, "d", 4)->order == 1);
}

TEST(invalid_pages_are_skipped) {
  const std::vector<Page> pages{{0, {0, 0, 500, 500}}, {5, {0, 0, 0, 0}}, {6, {std::nan(""), 0, 10, 10}}};
  const auto layout = glass::Lay({Make("a", {10, 10, 10, 10}, Layer::kOverPage)}, pages, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].plane == Plane::kBehindWindow);
}

TEST(diff_creates_updates_and_removes) {
  const std::vector<Page> pages{{1, {300, 0, 980, 800}}};
  const auto first = glass::Lay({Make("a", {0, 0, 10, 10}), Make("b", {400, 0, 10, 10})}, pages, kWindow, 1);
  const auto second = glass::Lay({Make("b", {410, 0, 10, 10}), Make("c", {20, 0, 10, 10})}, pages, kWindow, 1);
  const auto diff = glass::DiffPlacements(first.placements, second.placements, true);
  CHECK(diff.create.size() == 1 && diff.create[0].id == "c");
  CHECK(diff.update.size() == 1 && diff.update[0].id == "b");
  CHECK(diff.remove.size() == 1 && diff.remove[0].id == "a");
  const auto same = glass::DiffPlacements(second.placements, second.placements, true);
  CHECK(same.create.empty() && same.update.empty() && same.remove.empty());
}

TEST(diff_moves_a_region_between_planes) {
  const std::vector<Page> pages{{1, {300, 0, 980, 800}}};
  const auto on_page = glass::Lay({Make("m", {400, 0, 10, 10})}, pages, kWindow, 1);
  const auto behind = glass::Lay({Make("m", {10, 0, 10, 10})}, pages, kWindow, 1);
  const auto diff = glass::DiffPlacements(on_page.placements, behind.placements, true);
  CHECK(diff.create.size() == 1 && diff.create[0].plane == Plane::kBehindWindow);
  CHECK(diff.remove.size() == 1 && diff.remove[0].plane == Plane::kOverPage && diff.remove[0].page == 1);
  CHECK(diff.update.empty());
}

TEST(diff_recreates_when_the_effect_class_changes) {
  Region liquid = Make("x", {0, 0, 10, 10}, Layer::kBehind);
  Region sidebar = liquid;
  sidebar.material = Material::kSidebar;
  const auto a = glass::Lay({liquid}, {}, kWindow, 1);
  const auto b = glass::Lay({sidebar}, {}, kWindow, 1);
  const auto modern = glass::DiffPlacements(a.placements, b.placements, true);
  CHECK(modern.remove.size() == 1 && modern.create.size() == 1 && modern.update.empty());
  const auto legacy = glass::DiffPlacements(a.placements, b.placements, false);
  CHECK(legacy.remove.empty() && legacy.create.empty() && legacy.update.size() == 1);
}

TEST(effects_fall_back_to_vibrancy_without_liquid_glass) {
  CHECK(glass::EffectFor(Material::kLiquid, true) == glass::Effect::kLiquidGlass);
  CHECK(glass::EffectFor(Material::kLiquidClear, true) == glass::Effect::kLiquidGlass);
  CHECK(glass::EffectFor(Material::kLiquid, false) == glass::Effect::kVibrancy);
  CHECK(glass::EffectFor(Material::kSidebar, true) == glass::Effect::kVibrancy);
}

TEST(names_parse) {
  CHECK(glass::LayerNamed("") == Layer::kAuto);
  CHECK(glass::LayerNamed("behind") == Layer::kBehind);
  CHECK(glass::LayerNamed("over_page") == Layer::kOverPage);
  CHECK(!glass::LayerNamed("sideways"));
  CHECK(glass::MaterialNamed("clear") == Material::kLiquidClear);
  CHECK(glass::MaterialNamed("hud") == Material::kHud);
  CHECK(glass::MaterialNamed("underWindow") == Material::kUnderWindow);
  CHECK(glass::MaterialNamed("windowTreatment") == Material::kWindowTreatment);
  CHECK(glass::EffectFor(Material::kWindowTreatment, true) == glass::Effect::kVibrancy);
  CHECK(glass::EffectFor(Material::kWindowTreatment, false) == glass::Effect::kVibrancy);
  CHECK(glass::TreatmentMaterial(true) == 29);
  CHECK(glass::TreatmentMaterial(false) == 13);
  CHECK(!glass::MaterialNamed("glitter"));
}

TEST(pass_through_is_pages_minus_overlays) {
  const auto pass = glass::PassThrough({{300, 0, 980, 800}}, {{900, 10, 300, 44}, {0, 0, 280, 800}});
  CHECK(glass::Passes(pass, {500, 400}));
  CHECK(!glass::Passes(pass, {950, 20}));
  CHECK(!glass::Passes(pass, {100, 100}));
  CHECK(glass::Passes(pass, {950, 60}));
  CHECK(!glass::Passes(pass, {std::nan(""), 10}));
  CHECK(!glass::Passes(pass, {1280, 10}));
  double area = 0;
  for (const Rect& rect : pass) area += rect.width * rect.height;
  CHECK_NEAR(area, 980.0 * 800 - 300 * 44);
}

TEST(pass_through_ignores_bad_rects) {
  const double inf = std::numeric_limits<double>::infinity();
  const auto pass = glass::PassThrough({{0, 0, 100, 100}, {inf, 0, 10, 10}}, {{0, 0, inf, 10}});
  CHECK(pass.size() == 1);
  CHECK(glass::Passes(pass, {5, 5}));
}

TEST(presentable_generation) {
  CHECK(glass::PresentableGeneration(0) == 0);
  CHECK(glass::PresentableGeneration(42) == 42);
  CHECK(glass::PresentableGeneration(2147483647.0) == 2147483647);
  CHECK(!glass::PresentableGeneration(-1));
  CHECK(!glass::PresentableGeneration(1.5));
  CHECK(!glass::PresentableGeneration(2147483648.0));
  CHECK(!glass::PresentableGeneration(std::numeric_limits<double>::quiet_NaN()));
  CHECK(!glass::PresentableGeneration(std::numeric_limits<double>::infinity()));
}

TEST(clamp_to_int_never_overflows) {
  CHECK(glass::ClampToInt(12.4) == 12);
  CHECK(glass::ClampToInt(-12.6) == -13);
  CHECK(glass::ClampToInt(1e20) == 1000000);
  CHECK(glass::ClampToInt(-1e20) == -1000000);
  CHECK(glass::ClampToInt(std::numeric_limits<double>::quiet_NaN()) == 0);
  CHECK(glass::ClampToInt(std::numeric_limits<double>::infinity()) == 0);
  CHECK(glass::ClampToInt(5e9, 1e5) == 100000);
}

TEST(hostile_sinks) {
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  const std::vector<double> numbers{nan, inf, -inf, 1e20, -1e20, 1e308, -0.0, 4.9e-324};
  std::vector<Region> regions;
  int index = 0;
  for (double a : numbers) {
    for (double b : numbers) {
      Region region = Make("h" + std::to_string(index++), {a, b, a, b});
      region.radii = {a, b, a, b};
      region.opacity = a;
      region.blur = b;
      regions.push_back(region);
    }
  }
  for (const std::string& id : {std::string("x\n"), std::string("../etc"), std::string(4096, 'a'),
                                std::string("<script>"), std::string("\0", 1), std::string("id with space")}) {
    regions.push_back(Make(id, {0, 0, 10, 10}));
  }
  const std::vector<Page> pages{{1, {nan, 0, 10, 10}}, {2, {0, 0, inf, 10}}, {3, {0, 0, 500, 500}}};
  const auto layout = glass::Lay(regions, pages, kWindow, 1e300);
  for (const Placement& placement : layout.placements) {
    CHECK(std::isfinite(placement.frame.x) && std::isfinite(placement.frame.y));
    CHECK(std::isfinite(placement.frame.width) && std::isfinite(placement.frame.height));
    CHECK(placement.frame.width <= glass::kMaxCoordinate && placement.frame.height <= glass::kMaxCoordinate);
    CHECK(std::isfinite(placement.radius) && placement.radius >= 0);
    CHECK(placement.opacity >= 0 && placement.opacity <= 1);
    CHECK(glass::ValidId(placement.id));
  }
  CHECK(layout.accepted.size() <= glass::kMaxRegions);
  const auto pass = glass::PassThrough({{nan, nan, nan, nan}, {0, 0, 1e300, 1e300}}, {{-inf, -inf, inf, inf}});
  CHECK(pass.empty());
  CHECK(!glass::Passes({{0, 0, 100, 100}}, {inf, 5}));
  const auto control = glass::Lay({Make("ok", {10, 10, 20, 20}, Layer::kBehind)}, {}, kWindow, 1);
  CHECK(control.placements.size() == 1);
}

TEST(accepted_is_what_mounted_under_the_shared_cap) {
  std::vector<Region> backdrops;
  for (int index = 0; index < 60; ++index) {
    backdrops.push_back(Make("backdrop:" + std::to_string(index), {static_cast<double>(index), 0, 4, 4}, Layer::kBehind));
  }
  std::vector<Region> regions;
  for (int index = 0; index < 10; ++index) {
    regions.push_back(Make("g" + std::to_string(index), {static_cast<double>(index), 10, 4, 4}));
  }
  const auto mounted = glass::Lay(glass::Mounted(backdrops, regions), {}, kWindow, 1);
  CHECK(glass::MountedGlass(mounted.placements) == (std::vector<std::string>{"g0", "g1", "g2", "g3"}));
  const auto roomy = glass::Lay(glass::Mounted({backdrops[0]}, regions), {}, kWindow, 1);
  CHECK(glass::MountedGlass(roomy.placements).size() == 10);
}

TEST(glass_sharing_an_id_with_a_zero_width_backdrop_is_accepted) {
  const Region backdrop = Make("backdrop:0", {0, 0, 0, 40}, Layer::kBehind);
  const Region shared = Make("backdrop:0", {10, 10, 40, 40});
  const auto mounted = glass::Lay(glass::Mounted({backdrop}, {shared}), {}, kWindow, 1);
  CHECK(mounted.placements.size() == 1);
  CHECK(mounted.placements[0].source == glass::Source::kGlass);
  CHECK(glass::MountedGlass(mounted.placements) == (std::vector<std::string>{"backdrop:0"}));
  const Region live_backdrop = Make("backdrop:0", {0, 0, 40, 40}, Layer::kBehind);
  const auto both = glass::Lay(glass::Mounted({live_backdrop}, {shared}), {}, kWindow, 1);
  CHECK(both.placements.size() == 2);
  CHECK(glass::MountedGlass(both.placements) == (std::vector<std::string>{"backdrop:0"}));
  CHECK(glass::KeyOf(both.placements[0]) != glass::KeyOf(both.placements[1]));
}

TEST(nothing_is_accepted_without_a_native_surface) {
  const auto unmounted = glass::Layout{};
  CHECK(glass::MountedGlass(unmounted.placements).empty());
  const auto empty_surface = glass::Lay(glass::Mounted({}, {Make("g", {10, 10, 40, 40})}), {}, glass::Rect{}, 1);
  CHECK(empty_surface.placements.empty());
  CHECK(glass::MountedGlass(empty_surface.placements).empty());
  const auto offscreen = glass::Lay(glass::Mounted({}, {Make("g", {5000, 5000, 40, 40})}), {}, kWindow, 1);
  CHECK(glass::MountedGlass(offscreen.placements).empty());
}

TEST(a_page_without_a_native_view_mounts_nothing_on_it) {
  const std::vector<Page> pages{{7, {300, 0, 980, 800}}};
  const Region bar = Make("bar", {400, 100, 200, 40}, Layer::kOverPage);
  const auto unmountable = glass::Lay(glass::Mounted({}, {bar}), glass::MountablePages(pages, {}), kWindow, 1);
  CHECK(unmountable.placements.size() == 1);
  CHECK(unmountable.placements[0].plane == Plane::kBehindWindow && unmountable.placements[0].page == 0);
  const auto planned = glass::Lay(glass::Mounted({}, {bar}), pages, kWindow, 1);
  CHECK(planned.placements.size() == 1 && planned.placements[0].page == 7);
  const auto unattached = glass::KeepAttached(planned, {});
  CHECK(unattached.placements.empty());
  CHECK(glass::MountedGlass(unattached.placements).empty());
  const auto attached = glass::KeepAttached(planned, {glass::KeyOf(planned.placements[0])});
  CHECK(glass::MountedGlass(attached.placements) == (std::vector<std::string>{"bar"}));
  const auto live = glass::Lay(glass::Mounted({}, {bar}), glass::MountablePages(pages, {7}), kWindow, 1);
  CHECK(live.placements.size() == 1 && live.placements[0].page == 7);
}

TEST(mounted_glass_names_a_region_on_two_pages_once) {
  const std::vector<Page> pages{{1, {0, 0, 600, 800}}, {2, {610, 0, 670, 800}}};
  const auto split = glass::Lay(glass::Mounted({}, {Make("peek", {500, 100, 300, 200}, Layer::kOverPage)}), pages, kWindow, 1);
  CHECK(split.placements.size() == 3);
  CHECK(Find(split, "peek", 0) && Find(split, "peek", 0)->frame == (Rect{600, 100, 10, 200}));
  CHECK(glass::MountedGlass(split.placements) == (std::vector<std::string>{"peek"}));
}

TEST(clear_cancels_pending_presented) {
  glass::PresentedGate gate;
  const auto before = gate.Issue(7);
  CHECK(gate.Live(before));
  gate.Invalidate();
  CHECK(!gate.Live(before));
  const auto after = gate.Issue(8);
  CHECK(gate.Live(after) && after.generation == 8);
  gate.Invalidate();
  gate.Invalidate();
  CHECK(!gate.Live(after) && !gate.Live(before));
}

TEST(material_changes_within_a_family_update_the_reused_view) {
  Region sidebar = Make("m", {0, 0, 10, 10}, Layer::kBehind);
  sidebar.material = Material::kSidebar;
  Region hud = sidebar;
  hud.material = Material::kHud;
  const auto a = glass::Lay({sidebar}, {}, kWindow, 1);
  const auto b = glass::Lay({hud}, {}, kWindow, 1);
  const auto diff = glass::DiffPlacements(a.placements, b.placements, true);
  CHECK(diff.create.empty() && diff.remove.empty());
  CHECK(diff.update.size() == 1 && diff.update[0].material == Material::kHud);
  Region liquid = Make("l", {0, 0, 10, 10}, Layer::kBehind);
  Region clear = liquid;
  clear.material = Material::kLiquidClear;
  const auto glassy = glass::DiffPlacements(glass::Lay({liquid}, {}, kWindow, 1).placements,
                                            glass::Lay({clear}, {}, kWindow, 1).placements, true);
  CHECK(glassy.update.size() == 1 && glass::GlassStyle(glassy.update[0].material) == 1);
  CHECK(glass::GlassStyle(Material::kLiquid) == 0);
}

TEST(liquid_glass_keeps_square_corners_on_clipped_edges) {
  Region region = Make("c", {0, 0, 100, 40}, Layer::kBehind);
  region.radii = {0, 12, 12, 0};
  const auto layout = glass::Lay({region}, {}, kWindow, 1);
  const auto shape = glass::ShapeFor(layout.placements[0].radii);
  CHECK(!shape.uniform);
  CHECK(shape.radii == (glass::Radii{0, 12, 12, 0}));
  CHECK(glass::NativeCornerRadius(shape) == 0);
  CHECK(glass::ShapeFor({12, 12, 12, 12}).uniform);
  CHECK(glass::ShapeFor({0, 0, 0, 0}).uniform);
  const double nan = std::numeric_limits<double>::quiet_NaN();
  CHECK(glass::ShapeFor({nan, 0, 0, 0}).uniform);
}

TEST(corner_shape_transitions_update_native_radius_and_mask) {
  struct Step {
    glass::Radii radii;
    double native;
    bool masked;
  };
  for (const Step& step : {Step{{12, 12, 12, 12}, 12, false}, Step{{0, 12, 12, 0}, 0, true},
                           Step{{12, 12, 12, 12}, 12, false}, Step{{4, 12, 12, 12}, 0, true},
                           Step{{8, 8, 8, 8}, 8, false}}) {
    const auto shape = glass::ShapeFor(step.radii);
    CHECK(glass::NativeCornerRadius(shape) == step.native);
    CHECK(!shape.uniform == step.masked);
  }
  CHECK(glass::NativeCornerRadius(glass::ShapeFor({std::numeric_limits<double>::infinity(), 1, 1, 1})) == 0);
}

TEST(unequal_positive_radii_are_a_layout_change) {
  Region uniform = Make("r", {0, 0, 100, 40}, Layer::kBehind);
  uniform.radii = {12, 12, 12, 12};
  Region uneven = uniform;
  uneven.radii = {4, 12, 12, 12};
  const auto before = glass::Lay({uniform}, {}, kWindow, 1);
  const auto after = glass::Lay({uneven}, {}, kWindow, 1);
  CHECK(before.placements[0].radius == after.placements[0].radius);
  CHECK(before.placements[0].corners == after.placements[0].corners);
  const auto diff = glass::DiffPlacements(before.placements, after.placements, true);
  CHECK(diff.update.size() == 1 && diff.create.empty() && diff.remove.empty());
  const auto shape = glass::ShapeFor(diff.update[0].radii);
  CHECK(!shape.uniform && shape.radii == (glass::Radii{4, 12, 12, 12}));
}

TEST(tints_parse_from_hex_and_rgba) {
  CHECK(glass::ColorFrom("#ff0000") == (glass::Color{1, 0, 0, 1}));
  CHECK(glass::ColorFrom("#00ff0080") == (glass::Color{0, 1, 0, 128 / 255.0}));
  CHECK(glass::ColorFrom("#fff") == (glass::Color{1, 1, 1, 1}));
  CHECK(glass::ColorFrom("rgba(255, 0, 0, 0.5)") == (glass::Color{1, 0, 0, 0.5}));
  CHECK(glass::ColorFrom("rgb(0,0,255)") == (glass::Color{0, 0, 1, 1}));
  for (const char* bad : {"", "red", "#ff", "#gg0000", "rgba(1,2,3)", "rgb(1,2,3,4)", "rgba(256,0,0,1)",
                          "rgba(0,0,0,2)", "rgba(-1,0,0,1)", "rgba(1e3,0,0,1)", "rgba(0,0,0,1", "rgba(,,,)"}) {
    CHECK(!glass::ColorFrom(bad));
  }
}

TEST(groups_and_appearance_reach_the_placement) {
  Region region = Make("pin", {10, 10, 30, 30});
  region.group = "pins";
  region.tint = glass::Color{1, 1, 1, 0.2};
  region.appearance = glass::Appearance::kDark;
  const auto layout = glass::Lay({region}, {}, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].group == "pins" && layout.placements[0].tint == region.tint);
  CHECK(layout.placements[0].appearance == glass::Appearance::kDark);
  CHECK(glass::Grouped(layout.placements[0], true));
  CHECK(!glass::Grouped(layout.placements[0], false));
  CHECK(glass::LiveGroups(layout.placements, true).size() == 1);
  CHECK(glass::LiveGroups(layout.placements, false).empty());
  Region vibrant = region;
  vibrant.material = Material::kSidebar;
  CHECK(!glass::Grouped(glass::Lay({vibrant}, {}, kWindow, 1).placements[0], true));
  Region bad = region;
  bad.group = "no spaces";
  const auto refused = glass::Lay({bad}, {}, kWindow, 1);
  CHECK(refused.placements.empty() && refused.rejected.size() == 1 && refused.rejected[0].reason == "group");
  CHECK(glass::AppearanceNamed("dark") == glass::Appearance::kDark && !glass::AppearanceNamed("sepia"));
}

TEST(tint_and_group_changes_update_the_same_view) {
  Region region = Make("pin", {10, 10, 30, 30});
  const auto before = glass::Lay({region}, {}, kWindow, 1);
  region.tint = glass::Color{0, 0, 0, 0.1};
  region.group = "pins";
  const auto after = glass::Lay({region}, {}, kWindow, 1);
  const auto diff = glass::DiffPlacements(before.placements, after.placements, true);
  CHECK(diff.update.size() == 1 && diff.create.empty() && diff.remove.empty());
}

TEST(a_region_straddling_the_sidebar_and_a_page_is_glass_on_both_sides) {
  const std::vector<Page> pages{{1, {300, 0, 980, 800}}};
  const auto layout = glass::Lay({Make("menu", {200, 100, 300, 200})}, pages, kWindow, 1);
  CHECK(layout.placements.size() == 2);
  const Placement* page = Find(layout, "menu", 1);
  const Placement* behind = Find(layout, "menu", 0);
  CHECK(page && page->plane == Plane::kOverPage && page->visible == (Rect{0, 100, 200, 200}));
  CHECK(behind && behind->plane == Plane::kBehindWindow && behind->slice == 1);
  CHECK(behind && behind->frame == (Rect{200, 100, 100, 200}) && behind->visible == (Rect{200, 100, 100, 200}));
  const auto rounded = glass::Lay({Make("menu", {200, 100, 300, 200}, Layer::kAuto, 12)}, pages, kWindow, 1);
  const Placement* left = Find(rounded, "menu", 0);
  CHECK(left && left->outline == (Rect{200, 100, 300, 200}) && left->radii == (glass::Radii{12, 12, 12, 12}));
  const glass::SliceMask mask = left ? glass::MaskFor(*left) : glass::SliceMask{};
  CHECK(mask.active && mask.outline == (Rect{0, 0, 300, 200}) && mask.radii == (glass::Radii{12, 12, 12, 12}));
  const auto framed = glass::Lay({Make("ring", {250, 100, 200, 200})}, {{1, {300, 150, 100, 100}}}, kWindow, 1);
  int slices = 0;
  double area = 0;
  for (const Placement& placement : framed.placements) {
    if (placement.plane != Plane::kBehindWindow) continue;
    ++slices;
    area += placement.frame.width * placement.frame.height;
    CHECK(placement.frame == placement.visible);
  }
  CHECK(slices == 4 && area == 200 * 200 - 100 * 100);
  const auto inside = glass::Lay({Make("inside", {400, 100, 300, 200})}, pages, kWindow, 1);
  CHECK(inside.placements.size() == 1 && inside.placements[0].plane == Plane::kOverPage);
  const auto page_only = glass::KeepAttached(layout, {glass::KeyOf(*page)});
  CHECK(glass::MountedGlass(page_only).empty());
  CHECK(glass::MountedGlass(page_only.placements) == (std::vector<std::string>{"menu"}));
  const auto both = glass::KeepAttached(layout, {glass::KeyOf(*page), glass::KeyOf(*behind)});
  CHECK(glass::MountedGlass(both) == (std::vector<std::string>{"menu"}));
  const auto off_window = glass::Lay({Make("edge", {900, 700, 600, 300})}, {{1, {0, 0, 1280, 800}}}, kWindow, 1);
  CHECK(off_window.placements.size() == 1 && off_window.placements[0].plane == Plane::kOverPage);
}

TEST(a_slice_narrower_than_the_corner_radius_traces_the_whole_region_outline) {
  const auto layout = glass::Lay({Make("menu", {200, 100, 300, 200}, Layer::kAuto, 12)}, {{1, {205, 0, 1075, 800}}}, kWindow, 1);
  const Placement* sliver = Find(layout, "menu", 0);
  CHECK(sliver && sliver->slice == 1 && sliver->frame == (Rect{200, 100, 5, 200}));
  if (!sliver) return;
  const glass::SliceMask mask = glass::MaskFor(*sliver);
  CHECK(mask.active);
  CHECK(mask.outline == (Rect{0, 0, 300, 200}));
  CHECK(mask.outline.right() > sliver->frame.width && mask.radii.upper_left == 12);
  const Placement* page = Find(layout, "menu", 1);
  CHECK(page && page->seamed && glass::MaskFor(*page).outline == (Rect{0, 0, 300, 200}));
  const auto whole = glass::Lay({Make("free", {20, 20, 100, 100}, Layer::kAuto, 12)}, {}, kWindow, 1);
  CHECK(whole.placements.size() == 1 && !glass::MaskFor(whole.placements[0]).active);
}

TEST(both_sides_of_a_page_seam_trace_the_same_corner_outline) {
  const Rect page_rect{300, 0, 980, 800};
  const auto layout = glass::Lay({Make("menu", {200, 100, 300, 200}, Layer::kAuto, 12)}, {{1, page_rect}}, kWindow, 1);
  const Placement* page = Find(layout, "menu", 1);
  const Placement* sliver = Find(layout, "menu", 0);
  CHECK(page && sliver && page->seamed && !sliver->seamed && sliver->slice == 1);
  if (!page || !sliver) return;
  const glass::SliceMask over = glass::MaskFor(*page);
  const glass::SliceMask behind = glass::MaskFor(*sliver);
  CHECK(over.active && behind.active && over.radii == behind.radii);
  const Rect over_in_window{page_rect.x + page->frame.x + over.outline.x, page_rect.y + page->frame.y + over.outline.y,
                            over.outline.width, over.outline.height};
  const Rect behind_in_window{sliver->frame.x + behind.outline.x, sliver->frame.y + behind.outline.y, behind.outline.width,
                              behind.outline.height};
  CHECK(over_in_window == (Rect{200, 100, 300, 200}) && behind_in_window == over_in_window);
  const auto inside = glass::Lay({Make("inside", {400, 100, 300, 200}, Layer::kAuto, 12)}, {{1, page_rect}}, kWindow, 1);
  CHECK(inside.placements.size() == 1 && !inside.placements[0].seamed && !glass::MaskFor(inside.placements[0]).active);
}

TEST(glass_over_a_page_mounts_under_the_shell_in_the_compositor) {
  CHECK(glass::MountsUnderShell(Plane::kOverPage));
  CHECK(!glass::MountsUnderShell(Plane::kBehindWindow));
  CHECK(ardia_mac_test::Near(glass::UnderShellBlur(24, 1), 24));
  CHECK(ardia_mac_test::Near(glass::UnderShellBlur(24, 2), 48));
  CHECK(ardia_mac_test::Near(glass::UnderShellBlur(1e9, 1), glass::kMaxBlur));
  CHECK(ardia_mac_test::Near(glass::UnderShellBlur(-5, 1), 0));
  CHECK(ardia_mac_test::Near(glass::UnderShellBlur(std::numeric_limits<double>::quiet_NaN(), 1), 0));
  CHECK(ardia_mac_test::Near(glass::UnderShellBlur(24, std::numeric_limits<double>::infinity()), 24));
  CHECK(glass::kUnderShellFill > 0 && glass::kUnderShellFill < 0.05f);
  const std::vector<Page> pages{{7, {300, 60, 900, 700}}};
  const auto layout = glass::Lay({Make("sidebar", {280, 40, 260, 600}, Layer::kAuto, 12)}, pages, kWindow, 1);
  const Placement* over = Find(layout, "sidebar", 7);
  CHECK(over && glass::MountsUnderShell(over->plane));
  CHECK(over && ardia_mac_test::Near(over->frame.x, -20) && ardia_mac_test::Near(over->frame.y, -20));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
