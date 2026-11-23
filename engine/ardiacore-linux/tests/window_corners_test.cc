#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>
#include <utility>

#include "ardia/linux/ac_linux_window_corners.h"

namespace corners = ardia::linux_window_corners;

namespace {

constexpr corners::Corners kFrame{.upper_left = 8, .upper_right = 8};
constexpr corners::Corners kSquare{};
constexpr float kCard = corners::kPageCardRadius;
constexpr corners::Corners kPageCardCorners12() { return corners::Corners{12, 12, 12, 12}; }

}

int main() {
  using corners::DecorationAnswer;
  static_assert(corners::DecorationAnswerOf(0) == DecorationAnswer::kNone);
  static_assert(corners::DecorationAnswerOf(1) == DecorationAnswer::kClientSide);
  static_assert(corners::DecorationAnswerOf(2) == DecorationAnswer::kServerSide);
  static_assert(corners::DecorationAnswerOf(3) == DecorationAnswer::kNone);

  for (const char* tiling : {"Hyprland", "hyprland", "sway", "SWAY", "niri", "i3", "river", "dwl", "bspwm", "awesome",
                             "qtile", "xmonad", "dwm", "herbstluftwm", "Regolith:GNOME", "regolith",
                             "Hyprland:Omarchy", "wlroots:sway", " niri "}) {
    assert(corners::IsTilingDesktop(tiling));
  }
  for (const char* floating : {"GNOME", "ubuntu:GNOME", "KDE", "X-Cinnamon", "XFCE", "MATE", "LXQt", "Budgie:GNOME",
                               "Pantheon", "COSMIC", "Unity", "", "i3wm", "swayfx-like", "hyprlandish", ":", "::"}) {
    assert(!corners::IsTilingDesktop(floating));
  }

  static_assert(corners::CompositorDecorates(DecorationAnswer::kServerSide, "ubuntu:GNOME"));
  static_assert(corners::CompositorDecorates(DecorationAnswer::kServerSide, ""));
  static_assert(corners::CompositorDecorates(DecorationAnswer::kNone, "Hyprland"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kClientSide, "sway"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kClientSide, "Hyprland"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kNone, "ubuntu:GNOME"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kClientSide, "KDE"));
  static_assert(!corners::CompositorDecorates(DecorationAnswer::kNone, ""));
  for (const char* desktop : {"KDE", "sway", "", "ubuntu:GNOME", "Hyprland"}) {
    const bool main_window = corners::CompositorDecorates(DecorationAnswer::kClientSide, desktop);
    const bool task_manager = corners::CompositorDecorates(DecorationAnswer::kServerSide, desktop);
    assert(!main_window && task_manager);
  }
  static_assert(corners::DecoratedByName(true) == "compositor" && corners::DecoratedByName(false) == "app");
  static_assert(corners::AnswerName(DecorationAnswer::kNone) == "none");
  static_assert(corners::AnswerName(DecorationAnswer::kClientSide) == "client");
  static_assert(corners::AnswerName(DecorationAnswer::kServerSide) == "server");

  static_assert(corners::ClipToWindow({.width = 900, .height = 700}, 900, 700, kFrame, 0) == kFrame);
  static_assert(corners::ClipToWindow({.width = 900, .height = 700}, 900, 700, kSquare, kCard) == kSquare);
  static_assert(corners::ClipToWindow({.x = -2, .y = -2, .width = 904, .height = 704}, 900, 700, kFrame, 0) == kFrame);
  static_assert(corners::ClipToWindow({.x = 8, .y = 8, .width = 884, .height = 684}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = kCard, .lower_right = kCard, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 240, .y = 0, .width = 660, .height = 700}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = 8, .lower_right = 0, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 0, .y = 0, .width = 240, .height = 700}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = 8, .upper_right = kCard, .lower_right = kCard, .lower_left = 0});
  static_assert(corners::ClipToWindow({.x = 240, .y = 40, .width = 660, .height = 660}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = kCard, .lower_right = 0, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 0, .y = 0, .width = 899, .height = 699}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = 8, .upper_right = kCard, .lower_right = kCard, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 1, .y = 0, .width = 899, .height = 700}, 900, 700, kFrame, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = 8, .lower_right = 0, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 240, .y = 0, .width = 660, .height = 700}, 900, 700, kSquare, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = 0, .lower_right = 0, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 240, .y = 0, .width = 660, .height = 700}, 1000, 700, kSquare, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = kCard, .lower_right = kCard, .lower_left = kCard});
  static_assert(corners::ClipToWindow({.x = 240, .y = 0, .width = 660, .height = 700}, 900, 800, kSquare, kCard) ==
                corners::Corners{.upper_left = kCard, .upper_right = 0, .lower_right = kCard, .lower_left = kCard});
  for (const float window_radius : {12.0f, 19.0f, 24.0f}) {
    const corners::Corners window{window_radius, window_radius, window_radius, window_radius};
    for (const int inset : {0, 1, 2, 3, 8}) {
      const corners::Corners page = corners::ClipToWindow(
          {.x = inset, .y = inset, .width = 900 - 2 * inset, .height = 700 - 2 * inset}, 900, 700, window, kCard);
      const float expected = inset == 0 ? window_radius
                             : inset < window_radius ? std::fmax(kCard, window_radius - static_cast<float>(inset))
                                                     : kCard;
      assert(page.upper_left == expected && page.upper_right == expected && page.lower_right == expected &&
             page.lower_left == expected);
      for (int y = inset; y < inset + 30; ++y) {
        for (int x = inset; x < inset + 30; ++x) {
          const float px = x + 0.5f;
          const float py = y + 0.5f;
          const float page_cx = static_cast<float>(inset) + page.upper_left;
          const float page_cy = static_cast<float>(inset) + page.upper_left;
          const bool in_page = !(px < page_cx && py < page_cy) || std::hypot(px - page_cx, py - page_cy) <= page.upper_left;
          const bool in_window = !(px < window_radius && py < window_radius) ||
                                 std::hypot(px - window_radius, py - window_radius) <= window_radius;
          assert(!in_page || in_window || inset == 0);
        }
      }
    }
    const corners::Corners lopsided = corners::ClipToWindow({.x = 0, .y = 5, .width = 900, .height = 695}, 900, 700, window, kCard);
    assert(lopsided.upper_left == std::fmax(kCard, window_radius));
  }
  for (const float window_radius : {8.0f, 12.0f, 15.0f, 19.0f, 24.0f}) {
    const corners::Corners window{window_radius, window_radius, window_radius, window_radius};
    for (const auto& [inset_x, inset_y] : {std::pair{0, 3}, std::pair{1, 5}, std::pair{2, 9}, std::pair{4, 1}, std::pair{7, 2},
                                           std::pair{3, 14}, std::pair{11, 6}}) {
      const corners::Corners page = corners::ClipToWindow(
          {.x = inset_x, .y = inset_y, .width = 900 - 2 * inset_x, .height = 700 - 2 * inset_y}, 900, 700, window, kCard);
      const float radius = page.upper_left;
      for (int y = inset_y; y < inset_y + 40; ++y) {
        for (int x = inset_x; x < inset_x + 40; ++x) {
          const float px = x + 0.5f;
          const float py = y + 0.5f;
          const float page_cx = static_cast<float>(inset_x) + radius;
          const float page_cy = static_cast<float>(inset_y) + radius;
          const bool in_page = !(px < page_cx && py < page_cy) || std::hypot(px - page_cx, py - page_cy) <= radius;
          const bool in_window = !(px < window_radius && py < window_radius) ||
                                 std::hypot(px - window_radius, py - window_radius) <= window_radius;
          assert(!in_page || in_window || (inset_x == 0 && inset_y == 0));
        }
      }
    }
  }
  {
    const corners::Box box = corners::EnclosingBox(0.75, 0.2, 998.25, 699.5);
    assert(box.x == 0 && box.y == 0 && box.width == 999 && box.height == 700);
    const corners::Box near_one = corners::EnclosingBox(0.99999999999, 0.0, 1000.00000000001, 700.0);
    assert(near_one.x == 0 && near_one.width == 1001);
    const corners::Box exact = corners::EnclosingBox(1.0, 2.0, 999.0, 698.0);
    assert(exact.x == 1 && exact.y == 2 && exact.width == 998 && exact.height == 696);
    const corners::Box empty = corners::EnclosingBox(10.5, 20.25, 10.5, 20.25);
    assert(empty.x == 10 && empty.y == 20 && empty.width == 0 && empty.height == 0);
    const corners::Box huge = corners::EnclosingBox(-1e300, 0.0, 1e300, std::nan(""));
    assert(huge.x == std::numeric_limits<int>::min() && huge.width == std::numeric_limits<int>::max() && huge.height == 0);
  }
  {
    constexpr corners::FrameInsets kShadow{.left = 10, .top = 10, .right = 10, .bottom = 10};
    constexpr corners::Box kDefault{.x = 0, .y = 0, .width = 945, .height = 1060};
    constexpr auto kept = corners::DefaultBoundsWithoutFrame(kDefault, 945, 1060, kShadow, true, true);
    static_assert(kept && kept->x == 10 && kept->y == 10 && kept->width == 925 && kept->height == 1040);
    static_assert(!corners::DefaultBoundsWithoutFrame(kDefault, 945, 1060, kShadow, false, true));
    static_assert(!corners::DefaultBoundsWithoutFrame(kDefault, 945, 1060, kShadow, true, false));
    static_assert(!corners::DefaultBoundsWithoutFrame({.width = 925, .height = 1040}, 945, 1060, kShadow, true, true));
    static_assert(!corners::DefaultBoundsWithoutFrame({.width = 945, .height = 1040}, 945, 1060, kShadow, true, true));
    static_assert(!corners::DefaultBoundsWithoutFrame(kDefault, 945, 1060, {}, true, true));
    static_assert(!corners::DefaultBoundsWithoutFrame({.width = 20, .height = 20}, 20, 20, kShadow, true, true));
    constexpr auto lopsided =
        corners::DefaultBoundsWithoutFrame({.x = 100, .y = 50, .width = 800, .height = 600}, 800, 600,
                                           {.left = 3, .top = 40, .right = 5, .bottom = -2}, true, true);
    static_assert(lopsided && lopsided->x == 103 && lopsided->y == 90 && lopsided->width == 792 &&
                  lopsided->height == 560);
    const auto far = corners::DefaultBoundsWithoutFrame(
        {.x = std::numeric_limits<int>::max() - 5, .y = 0, .width = 945, .height = 1060}, 945, 1060, kShadow, true, true);
    assert(!far);
    constexpr corners::Box kSavedAtDefaultSize{.x = 30, .y = 40, .width = 945, .height = 1060};
    static_assert(!corners::DefaultBoundsWithoutFrame(kSavedAtDefaultSize, 945, 1060, kShadow, true, false));
    corners::Box saved = *kept;
    for (int launch = 0; launch < 3; ++launch) {
      if (const auto next = corners::DefaultBoundsWithoutFrame(saved, 945, 1060, kShadow, true, false)) saved = *next;
    }
    assert(saved.width == 925 && saved.height == 1040);
  }
  {
    constexpr corners::Corners kNoCard{};
    constexpr corners::Corners kToolbarCard{.upper_left = 0, .upper_right = 0, .lower_right = 10, .lower_left = 10};
    constexpr corners::Corners kGtk{.upper_left = 15, .upper_right = 15};
    static_assert(corners::ClipToWindow({.x = 0, .y = 42, .width = 900, .height = 658}, 900, 700, kSquare, kNoCard) == kNoCard);
    static_assert(corners::ClipToWindow({.x = 0, .y = 42, .width = 900, .height = 658}, 900, 700, kGtk, kNoCard) == kNoCard);
    static_assert(corners::ClipToWindow({.x = 0, .y = 0, .width = 900, .height = 700}, 900, 700, kGtk, kNoCard) == kGtk);
    static_assert(corners::ClipToWindow({.x = 2, .y = 2, .width = 896, .height = 696}, 900, 700, kGtk, kNoCard) ==
                  corners::Corners{.upper_left = 13, .upper_right = 13, .lower_right = 0, .lower_left = 0});
    static_assert(corners::ClipToWindow({.x = 2, .y = 2, .width = 896, .height = 696}, 900, 700, kGtk, kPageCardCorners12()) ==
                  corners::Corners{.upper_left = 13, .upper_right = 13, .lower_right = 12, .lower_left = 12});
    static_assert(corners::ClipToWindow({.x = 240, .y = 50, .width = 652, .height = 642}, 900, 700, kGtk, kToolbarCard) == kToolbarCard);
    static_assert(corners::kPageCardCorners == kPageCardCorners12());
    const auto doubled = corners::PageRadiiInDip(0, 0, 10, 10.5, 2);
    assert(doubled && *doubled == (corners::Corners{.upper_left = 0, .upper_right = 0, .lower_right = 20, .lower_left = 21}));
    assert(corners::PageRadiiInDip(12, 12, 12, 12, 1) == corners::kPageCardCorners);
    assert(!corners::PageRadiiInDip(-1, 0, 0, 0, 1));
    assert(!corners::PageRadiiInDip(0, std::nan(""), 0, 0, 1));
    assert(!corners::PageRadiiInDip(0, 0, std::numeric_limits<double>::infinity(), 0, 1));
    const auto clamped = corners::PageRadiiInDip(0, 0, 0, 1e9, 2);
    assert(clamped && clamped->lower_left == 8192 && clamped->upper_left == 0);
    assert(!corners::PageRadiiInDip(0, 0, 0, 0, 0));
    assert(!corners::PageRadiiInDip(0, 0, 0, 0, std::nan("")));
  }
  {
    constexpr corners::Corners kPane{.upper_left = 0, .upper_right = 0, .lower_right = 10, .lower_left = 10};
    constexpr corners::Box kPaneBox{.x = 100, .y = 50, .width = 800, .height = 600};
    static_assert(corners::CornersSharedWithPane(kPaneBox, kPaneBox, kPane) == kPane);
    static_assert(corners::CornersSharedWithPane({.x = 100, .y = 50, .width = 500, .height = 600}, kPaneBox, kPane) ==
                  corners::Corners{.upper_left = 0, .upper_right = 0, .lower_right = 0, .lower_left = 10});
    static_assert(corners::CornersSharedWithPane({.x = 600, .y = 50, .width = 300, .height = 600}, kPaneBox, kPane) ==
                  corners::Corners{.upper_left = 0, .upper_right = 0, .lower_right = 10, .lower_left = 0});
    static_assert(corners::CornersSharedWithPane({.x = 100, .y = 50, .width = 800, .height = 400}, kPaneBox, kPane) ==
                  corners::Corners{});
    static_assert(corners::CornersSharedWithPane({.x = 100, .y = 450, .width = 800, .height = 200}, kPaneBox,
                                                 corners::kPageCardCorners) ==
                  corners::Corners{.upper_left = 0, .upper_right = 0, .lower_right = 12, .lower_left = 12});
  }
  {
    const corners::Box pane{.x = 240, .y = 32, .width = 752, .height = 660};
    const corners::BoxF visible_rect{.x = 240.0, .y = 32.0, .width = 752.0, .height = 660.0};
    const auto clipped = corners::ContentBoxInDip({.x = 240.0, .y = 32.0, .width = 752.0, .height = 680.0},
                                                  visible_rect, 1.0, pane);
    assert(clipped && *clipped == (corners::Box{.x = 240, .y = 32, .width = 752, .height = 680}));
    for (const double zoom : {1.0, 1.1, 1.25, 1.5}) {
      std::optional<corners::Box> prior = corners::EnclosingBox(240.0 * zoom, 29.0 * zoom, 992.0 * zoom, 691.0 * zoom);
      const int steady_height = prior->height;
      for (const double y : {29.01, 29.20, 30.0, 35.7, 41.2, 48.0}) {
        const corners::Box visible = corners::EnclosingBox(240.0 * zoom, y * zoom, 992.0 * zoom, 691.0 * zoom);
        const auto content = corners::ContentBoxInDip(
            {.x = 240.0, .y = y, .width = 752.0, .height = 662.0},
            {.x = 240.0, .y = y, .width = 752.0, .height = 691.0 - y}, zoom, visible, prior);
        assert(content.has_value());
        assert(content->x == visible.x && content->width == visible.width);
        assert(content->y <= visible.y);
        assert(content->y + content->height >= visible.y + visible.height);
        assert(content->height == steady_height);
        prior = content;
      }
      std::optional<corners::Box> collapse_prior;
      int collapse_changes = 0;
      for (const double y : {48.0, 41.2, 35.7, 30.0, 29.20, 29.01}) {
        const corners::Box visible = corners::EnclosingBox(240.0 * zoom, y * zoom, 992.0 * zoom, 691.0 * zoom);
        const auto content = corners::ContentBoxInDip(
            {.x = 240.0, .y = y, .width = 752.0, .height = 662.0},
            {.x = 240.0, .y = y, .width = 752.0, .height = 691.0 - y}, zoom, visible, collapse_prior);
        assert(content.has_value());
        assert(content->y <= visible.y && content->y + content->height >= visible.y + visible.height);
        if (collapse_prior && content->height != collapse_prior->height) {
          assert(content->height == collapse_prior->height + 1);
          collapse_changes++;
        }
        collapse_prior = content;
      }
      assert(collapse_changes <= (zoom == 1.0 ? 0 : 1));
      const corners::Box resized_pane = corners::EnclosingBox(240.0 * zoom, 48.0 * zoom, 992.0 * zoom, 750.0 * zoom);
      const auto resized = corners::ContentBoxInDip(
          {.x = 240.0, .y = 48.0, .width = 752.0, .height = 720.0},
          {.x = 240.0, .y = 48.0, .width = 752.0, .height = 702.0}, zoom, resized_pane, prior);
      assert(resized && resized->height > steady_height + 1);
    }
    const corners::Box narrowed_pane{.x = 240, .y = 32, .width = 751, .height = 660};
    const auto narrowed = corners::ContentBoxInDip(
        {.x = 240.0, .y = 32.0, .width = 751.0, .height = 680.0},
        {.x = 240.0, .y = 32.0, .width = 751.0, .height = 660.0}, 1.0, narrowed_pane,
        corners::Box{.x = 240, .y = 32, .width = 752, .height = 680});
    assert(narrowed && *narrowed == (corners::Box{.x = 240, .y = 32, .width = 751, .height = 680}));
    const corners::Box narrowed_zoomed_pane = corners::EnclosingBox(240.0 * 1.1, 32.0 * 1.1, 922.0 * 1.1, 691.0 * 1.1);
    const auto narrowed_zoomed = corners::ContentBoxInDip(
        {.x = 240.0, .y = 32.0, .width = 682.0, .height = 662.0},
        {.x = 240.0, .y = 32.0, .width = 682.0, .height = 659.0}, 1.1, narrowed_zoomed_pane,
        corners::Box{.x = narrowed_zoomed_pane.x,
                     .y = narrowed_zoomed_pane.y,
                     .width = narrowed_zoomed_pane.width + 1,
                     .height = 730});
    assert(narrowed_zoomed && narrowed_zoomed->width == narrowed_zoomed_pane.width && narrowed_zoomed->height == 730);
    const auto shrank_two = corners::ContentBoxInDip(
        {.x = 240.0, .y = 32.0, .width = 752.0, .height = 680.0},
        {.x = 240.0, .y = 32.0, .width = 752.0, .height = 660.0}, 1.0, pane,
        corners::Box{.x = 240, .y = 32, .width = 752, .height = 682});
    assert(shrank_two && shrank_two->height == 680);
    const auto encloses = corners::ContentBoxInDip(
        {.x = 250.0, .y = 40.0, .width = 700.0, .height = 600.0}, visible_rect, 1.0, pane);
    assert(encloses && *encloses == pane);
    const corners::Box tall_pane{.x = 240, .y = 35, .width = 752, .height = 1016};
    const corners::BoxF tall_visible{.x = 240.0, .y = 35.0, .width = 752.0, .height = 1016.0};
    const auto jitter_up = corners::ContentBoxInDip(
        {.x = 239.999985, .y = 35.0, .width = 752.000061, .height = 1022.000061}, tall_visible, 1.0, tall_pane);
    assert(jitter_up && *jitter_up == (corners::Box{.x = 240, .y = 35, .width = 752, .height = 1022}));
    const auto jitter_down = corners::ContentBoxInDip(
        {.x = 240.0, .y = 35.0, .width = 751.999939, .height = 1021.999939}, tall_visible, 1.0, tall_pane);
    assert(jitter_down && *jitter_down == (corners::Box{.x = 240, .y = 35, .width = 752, .height = 1022}));
    assert(!corners::ContentBoxInDip({.x = std::nan(""), .y = 0, .width = 100, .height = 100}, visible_rect, 1.0, pane));
    assert(!corners::ContentBoxInDip({.x = 0, .y = 0, .width = -1, .height = 100}, visible_rect, 1.0, pane));
    assert(!corners::ContentBoxInDip({.x = 0, .y = 0, .width = 100, .height = 100}, visible_rect, 0.0, pane));
    assert(!corners::ContentBoxInDip({.x = 0, .y = 0, .width = 50000.0, .height = 100}, visible_rect, 1.0, pane));
  }
  std::puts("ok");
  return 0;
}
