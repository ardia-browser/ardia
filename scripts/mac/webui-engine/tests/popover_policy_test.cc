#include "ardia/mac/ac_mac_popover_policy.h"

#include <cmath>
#include <limits>
#include <optional>
#include <string_view>
#include <vector>

#include "check.h"

namespace popover = ardia_mac::popover;
using popover::Edge;
using popover::Event;
using popover::Reason;
using popover::Rect;
using popover::State;

namespace {

const std::vector<Rect> kOneScreen{{0, 25, 1440, 875}};
const std::vector<Rect> kTwoScreens{{0, 25, 1440, 875}, {1440, -200, 1920, 1080}};

popover::Request Below(Rect anchor, double width, double height) {
  popover::Request request;
  request.anchor = anchor;
  request.size = {width, height};
  return request;
}

}

TEST(places_below_and_centers_on_the_anchor) {
  const auto placed = popover::Place(Below({600, 100, 40, 30}, 200, 150), kOneScreen);
  CHECK(placed.has_value());
  if (!placed) return;
  CHECK(placed->edge == Edge::kBelow);
  CHECK(!placed->flipped);
  CHECK(placed->frame == (Rect{520, 136, 200, 150}));
}

TEST(flips_above_when_below_is_short) {
  const auto placed = popover::Place(Below({600, 800, 40, 30}, 200, 300), kOneScreen);
  CHECK(placed && placed->edge == Edge::kAbove && placed->flipped);
  if (!placed) return;
  CHECK(placed->frame.bottom() <= 800 - 6 + 0.5);
}

TEST(keeps_preferred_side_when_neither_fits_and_it_has_more_room) {
  const auto placed = popover::Place(Below({600, 300, 40, 30}, 200, 2000), kOneScreen);
  CHECK(placed && placed->edge == Edge::kBelow && !placed->flipped && placed->shrunk);
  if (!placed) return;
  CHECK(placed->frame.bottom() <= 900 - 8 + 0.5);
  CHECK(placed->frame.y >= 336 - 0.5);
}

TEST(clamps_horizontally_inside_the_visible_frame) {
  const auto left = popover::Place(Below({2, 100, 10, 20}, 300, 100), kOneScreen);
  CHECK(left && left->frame.x == 8);
  const auto right = popover::Place(Below({1430, 100, 10, 20}, 300, 100), kOneScreen);
  CHECK(right && right->frame.right() == 1432);
}

TEST(trailing_and_leading_edges) {
  popover::Request request = Below({100, 300, 40, 40}, 200, 120);
  request.edge = Edge::kTrailing;
  const auto trailing = popover::Place(request, kOneScreen);
  CHECK(trailing && trailing->edge == Edge::kTrailing && trailing->frame.x == 146);
  request.edge = Edge::kLeading;
  const auto flipped = popover::Place(request, kOneScreen);
  CHECK(flipped && flipped->edge == Edge::kTrailing && flipped->flipped);
}

TEST(alignment) {
  popover::Request request = Below({600, 100, 100, 30}, 200, 100);
  request.align = popover::Align::kStart;
  CHECK(popover::Place(request, kOneScreen)->frame.x == 600);
  request.align = popover::Align::kEnd;
  CHECK(popover::Place(request, kOneScreen)->frame.x == 500);
}

TEST(picks_the_screen_holding_most_of_the_anchor) {
  const auto placed = popover::Place(Below({2000, 100, 40, 30}, 300, 200), kTwoScreens);
  CHECK(placed && placed->screen == 1);
  if (!placed) return;
  CHECK(placed->frame.x >= 1440 + 8);
}

TEST(negative_coordinates_on_a_display_above_and_left) {
  const std::vector<Rect> screens{{0, 0, 1440, 900}, {-1920, -1080, 1920, 1080}};
  const auto placed = popover::Place(Below({-400, -500, 40, 30}, 300, 200), screens);
  CHECK(placed && placed->screen == 1);
  if (!placed) return;
  CHECK(placed->frame.x >= -1920 + 8 && placed->frame.right() <= -8);
  CHECK(placed->frame.y >= -1080 + 8 && placed->frame.bottom() <= -8);
}

TEST(off_screen_anchor_uses_the_nearest_screen) {
  const auto placed = popover::Place(Below({5000, 100, 10, 10}, 100, 100), kTwoScreens);
  CHECK(placed && placed->screen == 1);
}

TEST(refuses_bad_input) {
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  CHECK(!popover::Place(Below({nan, 0, 10, 10}, 100, 100), kOneScreen));
  CHECK(!popover::Place(Below({0, 0, 10, 10}, inf, 100), kOneScreen));
  CHECK(!popover::Place(Below({0, 0, 10, 10}, 0, 100), kOneScreen));
  CHECK(!popover::Place(Below({0, 0, 10, 10}, -5, 100), kOneScreen));
  CHECK(!popover::Place(Below({0, 0, 10, 10}, 100, 100), {}));
  CHECK(!popover::Place(Below({0, 0, 10, 10}, 100, 100), {{nan, 0, 100, 100}}));
  popover::Request request = Below({0, 0, 10, 10}, 100, 100);
  request.gap = nan;
  CHECK(!popover::Place(request, kOneScreen));
}

TEST(window_rect_maps_to_screen_with_zoom) {
  const auto mapped = popover::WindowToScreen({10, 20, 200, 100}, {100, 50, 1280, 800}, 1.25);
  CHECK(mapped && *mapped == (Rect{112.5, 75, 250, 125}));
  const auto beyond = popover::WindowToScreen({-50, -30, 200, 100}, {100, 50, 1280, 800}, 1);
  CHECK(beyond && beyond->x == 50 && beyond->y == 20);
  CHECK(!popover::WindowToScreen({0, 0, 0, 10}, {0, 0, 100, 100}, 1));
  CHECK(!popover::WindowToScreen({std::nan(""), 0, 10, 10}, {0, 0, 100, 100}, 1));
  const auto bad_zoom = popover::WindowToScreen({10, 10, 10, 10}, {0, 0, 100, 100}, std::nan(""));
  CHECK(bad_zoom && bad_zoom->x == 10);
}

TEST(beyond_window_rect_is_clamped_to_the_visible_frame) {
  const Rect content{100, 100, 800, 600};
  const auto clamped = popover::ClampToScreen({-60, 10, 300, 200}, {120, 120, 20, 20}, kOneScreen, true, content);
  CHECK(clamped && clamped->moved && !clamped->shrunk);
  if (!clamped) return;
  CHECK(clamped->frame == (Rect{0, 25, 300, 200}));
  const auto big = popover::ClampToScreen({0, 0, 3000, 3000}, {}, kOneScreen, true, content);
  CHECK(big && big->shrunk && big->frame == (Rect{0, 25, 1440, 875}));
}

TEST(inside_window_rect_is_clamped_to_the_window) {
  const Rect content{100, 100, 800, 600};
  const auto clamped = popover::ClampToScreen({850, 650, 200, 100}, {860, 640, 10, 10}, kOneScreen, false, content);
  CHECK(clamped && clamped->frame == (Rect{700, 600, 200, 100}));
}

TEST(clamp_follows_the_anchor_screen) {
  const auto clamped = popover::ClampToScreen({1300, 100, 300, 200}, {1500, 80, 20, 20}, kTwoScreens, true, {});
  CHECK(clamped && clamped->screen == 1 && clamped->frame.x == 1440);
}

TEST(flip_vertical_round_trips) {
  const Rect rect{10, 20, 300, 200};
  const Rect cocoa = popover::FlipVertical(rect, 900);
  CHECK(cocoa == (Rect{10, 680, 300, 200}));
  CHECK(popover::FlipVertical(cocoa, 900) == rect);
}

TEST(lifecycle_open_update_close) {
  auto t = popover::Step(State::kClosed, Event::kOpen);
  CHECK(t.next == State::kOpen && t.show && t.reposition && !t.notify);
  t = popover::Step(State::kOpen, Event::kUpdate);
  CHECK(t.next == State::kOpen && t.reposition && !t.hide);
  t = popover::Step(State::kOpen, Event::kClose);
  CHECK(t.next == State::kClosed && t.hide && !t.notify && t.reason == Reason::kClosed);
  t = popover::Step(State::kClosed, Event::kClose);
  CHECK(t.next == State::kClosed && !t.hide && !t.notify);
  t = popover::Step(State::kClosed, Event::kEscape);
  CHECK(!t.notify && !t.show);
}

TEST(lifecycle_dismissals_notify_with_wave_3b_reasons) {
  CHECK(popover::ReasonName(popover::Step(State::kOpen, Event::kEscape).reason) == "escape");
  CHECK(popover::ReasonName(popover::Step(State::kOpen, Event::kOutsideClick).reason) == "outside");
  CHECK(popover::ReasonName(popover::Step(State::kOpen, Event::kResignedKey).reason) == "blur");
  CHECK(popover::ReasonName(popover::Step(State::kOpen, Event::kAppDeactivated).reason) == "blur");
  CHECK(popover::ReasonName(popover::Step(State::kOpen, Event::kParentResized).reason) == "resize");
  CHECK(popover::ReasonName(popover::Step(State::kOpen, Event::kParentClosed).reason) == "host");
  CHECK(popover::ReasonName(popover::Step(State::kOpen, Event::kShellReloaded).reason) == "host");
  CHECK(popover::ReasonName(popover::Step(State::kOpen, Event::kContentFailed).reason) == "failed");
  CHECK(popover::Step(State::kOpen, Event::kEscape).notify);
  CHECK(!popover::Step(State::kOpen, Event::kReplaced).notify);
}

TEST(lifecycle_options) {
  popover::Options options;
  options.dismiss_on_parent_resize = false;
  const auto resized = popover::Step(State::kOpen, Event::kParentResized, options);
  CHECK(resized.next == State::kOpen && resized.reposition);
  options.takes_focus = false;
  const auto blurred = popover::Step(State::kOpen, Event::kResignedKey, options);
  CHECK(blurred.next == State::kOpen && !blurred.notify);
  CHECK(popover::Step(State::kOpen, Event::kInsideClick).next == State::kOpen);
  CHECK(popover::Step(State::kOpen, Event::kParentMoved).reposition);
}

TEST(clicks_are_classified) {
  const Rect panel{100, 100, 200, 100};
  CHECK(popover::ClassifyClick({150, 150}, panel) == Event::kInsideClick);
  CHECK(popover::ClassifyClick({50, 150}, panel) == Event::kOutsideClick);
  CHECK(popover::ClassifyClick({300, 150}, panel) == Event::kOutsideClick);
  CHECK(popover::ClassifyClick({std::nan(""), 150}, panel) == Event::kOutsideClick);
}

TEST(focus_never_activates_and_background_only_logs) {
  const auto background = popover::FocusFor(true, true, true, true);
  CHECK(!background.shown && background.logged && !background.becomes_key && !background.activates_app);
  const auto focused = popover::FocusFor(false, true, true, true);
  CHECK(focused.shown && focused.becomes_key && !focused.activates_app);
  CHECK(!popover::FocusFor(false, true, false, true).becomes_key);
  CHECK(!popover::FocusFor(false, true, true, false).becomes_key);
  CHECK(!popover::FocusFor(false, false, true, true).becomes_key);
}

TEST(names_and_ids) {
  CHECK(popover::EdgeNamed("top") == Edge::kAbove);
  CHECK(popover::EdgeNamed("left") == Edge::kLeading);
  CHECK(!popover::EdgeNamed("diagonal"));
  CHECK(popover::EdgeName(Edge::kTrailing) == "right");
  CHECK(popover::ReasonNamed("outside") == Reason::kOutside);
  CHECK(!popover::ReasonNamed("explode"));
  CHECK(popover::ValidId("popover-main-1"));
  CHECK(!popover::ValidId(""));
  CHECK(!popover::ValidId("a b"));
  CHECK(popover::ValidRoute("downloads"));
  CHECK(popover::ValidRoute("settings/site"));
  CHECK(!popover::ValidRoute("../etc"));
  CHECK(!popover::ValidRoute("/abs"));
  CHECK(!popover::ValidRoute("a//b"));
  CHECK(!popover::ValidRoute("a?b"));
}

TEST(beyond_window_survives_an_update_without_it) {
  const Rect content{100, 100, 800, 600};
  std::optional<bool> stored;
  const bool opened = popover::ResolveBeyondWindow(false, stored);
  CHECK(!opened);
  stored = opened;
  const bool updated = popover::ResolveBeyondWindow(std::nullopt, stored);
  CHECK(!updated);
  const auto clamped = popover::ClampToScreen({-60, 10, 300, 200}, {120, 120, 20, 20}, kOneScreen, updated, content);
  CHECK(clamped && clamped->frame.x >= content.x && clamped->frame.right() <= content.right());
  CHECK(clamped && clamped->frame.y >= content.y && clamped->frame.bottom() <= content.bottom());
  CHECK(popover::ResolveBeyondWindow(true, stored));
  CHECK(popover::ResolveBeyondWindow(std::nullopt, std::nullopt));
}

TEST(hostile_sinks) {
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  const std::vector<double> numbers{nan, inf, -inf, 1e20, -1e20, 1e308, -0.0, 4.9e-324, 1e5 + 1};
  for (double a : numbers) {
    for (double b : numbers) {
      const Rect hostile{a, b, a, b};
      const auto mapped = popover::WindowToScreen(hostile, {0, 0, 1280, 800}, a);
      if (mapped) CHECK(std::isfinite(mapped->x) && std::isfinite(mapped->width));
      const auto clamped = popover::ClampToScreen(hostile, hostile, kTwoScreens, false, hostile);
      if (clamped) CHECK(std::isfinite(clamped->frame.x) && clamped->frame.width <= popover::kMaxExtent);
      popover::Request request = Below(hostile, a, b);
      request.gap = a;
      request.margin = b;
      const auto placed = popover::Place(request, kTwoScreens);
      if (placed) CHECK(std::isfinite(placed->frame.x) && std::isfinite(placed->frame.y));
      CHECK(popover::ClassifyClick({a, b}, {0, 0, 10, 10}) == popover::Event::kOutsideClick ||
            (a >= 0 && a < 10 && b >= 0 && b < 10));
    }
  }
  for (std::string_view text : {"", "../x", "/abs", "a//b", "a b", "x\n", "<script>", "%2e%2e", "route?x=1"}) {
    CHECK(!popover::ValidRoute(text));
    CHECK(!popover::ValidId(text));
  }
  CHECK(!popover::ReasonNamed(std::string_view("\0", 1)) && !popover::EdgeNamed("bottom\n"));
  CHECK(popover::ClampToScreen({10, 10, 100, 100}, {10, 10, 5, 5}, kOneScreen, true, {}).has_value());
}

TEST(popover_renderer_ships_with_bounded_messages_and_props) {
  CHECK(popover::kPopoverRendererShipped);
  CHECK(popover::MessageFits(0) && popover::MessageFits(popover::kMaxMessageBytes));
  CHECK(!popover::MessageFits(popover::kMaxMessageBytes + 1));
  CHECK(popover::PropsFit(popover::kMaxPropsBytes) && !popover::PropsFit(popover::kMaxPropsBytes + 1));
  CHECK(!popover::MessageFits(std::nullopt) && !popover::PropsFit(std::nullopt));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
