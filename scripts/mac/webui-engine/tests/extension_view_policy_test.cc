#include "ardia/mac/ac_mac_extension_view_policy.h"

#include <limits>
#include <string>

#include "check.h"

namespace ext = ardia_mac::extension_policy;

namespace {

constexpr char kId[] = "abcdefghijklmnopabcdefghijklmnop";

}

TEST(extension_ids_are_32_letters_a_to_p) {
  CHECK(ext::ValidExtensionId(kId));
  CHECK(!ext::ValidExtensionId("abcdefghijklmnopabcdefghijklmnoq"));
  CHECK(!ext::ValidExtensionId("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"));
  CHECK(!ext::ValidExtensionId(""));
  CHECK(!ext::ValidExtensionId(std::string(kId) + "a"));
}

TEST(surfaces_load_only_their_own_extension_pages) {
  CHECK(ext::ExtensionUrlHost(std::string("chrome-extension://") + kId + "/popup.html") == std::string(kId));
  CHECK(ext::ExtensionUrlHost(std::string("chrome-extension://") + kId) == std::string(kId));
  CHECK(ext::ExtensionUrlHost(std::string("chrome-extension://") + kId + "?x") == std::nullopt);
  CHECK(!ext::ExtensionUrlHost(std::string("chrome-extension://") + kId + "@evil.com/"));
  CHECK(!ext::ExtensionUrlHost("https://example.com/popup.html"));
  CHECK(!ext::ExtensionUrlHost("chrome-extension://short/popup.html"));
  CHECK(!ext::ExtensionUrlHost(std::string("chrome-extension://") + kId + "/a\nb"));
  CHECK(!ext::ExtensionUrlHost(std::string("chrome-extension://") + kId + "/" + std::string(ext::kMaxSurfaceUrl, 'a')));
  CHECK(ext::SurfaceKindFor("popup") == ext::SurfaceKind::kPopup);
  CHECK(ext::SurfaceKindFor("sidePanel") == ext::SurfaceKind::kSidePanel);
  CHECK(!ext::SurfaceKindFor("window"));
}

TEST(surface_book_caps_windows_and_retires_old_renderers) {
  ext::SurfaceBook book;
  const auto first = book.Open(ext::SurfaceKind::kPopup, kId, 1);
  CHECK(first && *first == 1);
  CHECK(book.Owns(*first, 1));
  CHECK(!book.Owns(*first, 2));
  CHECK(!book.Open(ext::SurfaceKind::kPopup, "bad", 1));
  for (size_t index = 1; index < ext::kMaxSurfacesPerWindow; ++index) CHECK(book.Open(ext::SurfaceKind::kSidePanel, kId, 2));
  CHECK(!book.Open(ext::SurfaceKind::kPopup, kId, 2));
  const auto closed = book.CloseOlderThan(2);
  CHECK(closed.size() == 1 && closed[0] == *first);
  CHECK(!book.Owns(*first, 1));
  CHECK(book.size() == ext::kMaxSurfacesPerWindow - 1);
  CHECK(book.CloseAll().size() == ext::kMaxSurfacesPerWindow - 1);
  CHECK(book.size() == 0);
  CHECK(!ext::SurfaceIdFrom(true, 0));
  CHECK(!ext::SurfaceIdFrom(true, -3));
  CHECK(!ext::SurfaceIdFrom(false, 3));
  CHECK(ext::SurfaceIdFrom(true, 3) == 3);
}

TEST(popups_fit_their_room_and_clamp_to_chrome_limits) {
  const ext::PopupPlacement placement{.anchor_right = 900, .anchor_top = 40, .room_left = 0, .room_right = 1000,
                                      .room_bottom = 800};
  const auto limits = ext::PopupLimitsFor(placement, 1);
  CHECK(limits && limits->max_width == ext::kPopupMaxWidth && limits->max_height == ext::kPopupMaxHeight);
  const auto box = ext::PopupBoxFor(placement, 1, 300, 200, 0, 0, 2);
  CHECK(box && box->width == 300 && box->height == 200 && box->x == 600 && box->y == 40);
  const auto tiny = ext::PopupBoxFor(placement, 1, 5000, 5000, 0, 0, 2);
  CHECK(tiny && tiny->width == ext::kPopupMaxWidth && tiny->height == ext::kPopupMaxHeight);
  const ext::PopupPlacement cramped{.anchor_right = 50, .anchor_top = 0, .room_left = 0, .room_right = 60,
                                    .room_bottom = 10};
  const auto small = ext::PopupBoxFor(cramped, 1, 300, 300, 0, 0, 1);
  CHECK(small && small->width == 60 && small->height == 10 && small->x == 0);
  const ext::PopupPlacement none{.anchor_right = 0, .anchor_top = 100, .room_left = 0, .room_right = 0,
                                 .room_bottom = 50};
  CHECK(!ext::PopupLimitsFor(none, 1));
  const double nan = std::numeric_limits<double>::quiet_NaN();
  CHECK(!ext::PopupLimitsFor({.anchor_right = nan}, 1));
  CHECK(!ext::PopupLimitsFor(placement, 0));
  CHECK(!ext::PopupLimitsFor(placement, 1e9));
  CHECK(!ext::PopupLimitsFor({.anchor_right = 1e20, .room_right = 1e20, .room_bottom = 1e20}, 1));
}

TEST(viewports_clip_to_the_window) {
  const auto inside = ext::ViewportBox(10, 20, 300, 400, 1, 1000, 800);
  CHECK(inside && *inside == (ext::Box{10, 20, 300, 400}));
  const auto clipped = ext::ViewportBox(-50, -50, 2000, 2000, 1, 1000, 800);
  CHECK(clipped && *clipped == (ext::Box{0, 0, 1000, 800}));
  const auto zoomed = ext::ViewportBox(10, 10, 100, 100, 2, 1000, 800);
  CHECK(zoomed && *zoomed == (ext::Box{20, 20, 200, 200}));
  CHECK(!ext::ViewportBox(0, 0, -1, 10, 1, 100, 100));
  CHECK(!ext::ViewportBox(std::numeric_limits<double>::infinity(), 0, 1, 1, 1, 100, 100));
  CHECK(!ext::ViewportBox(0, 0, 1, 1, 0, 100, 100));
  CHECK(ext::CornerRadius(100, 1) == ext::kMaxCornerRadius);
  CHECK(ext::CornerRadius(-1, 1) == 0);
  CHECK(ext::CornerRadius(std::numeric_limits<double>::quiet_NaN(), 1) == 0);
  CHECK(ext::ValidFade(0) && ext::ValidFade(ext::kMaxFadeMs) && !ext::ValidFade(-1) && !ext::ValidFade(1001));
}

TEST(focus_follows_the_window) {
  CHECK(ext::SurfaceFocusFor(false, true) == ext::SurfaceFocus::kNone);
  CHECK(ext::SurfaceFocusFor(true, false) == ext::SurfaceFocus::kStored);
  CHECK(ext::SurfaceFocusFor(true, true) == ext::SurfaceFocus::kTaken);
}

TEST(action_badges_and_colors) {
  CHECK(ext::HexColor(0xff336699u) == std::string("#336699"));
  CHECK(!ext::HexColor(0x00336699u));
  CHECK(ext::DisplayBadge("<<ToolbarActionView>>").empty());
  CHECK(ext::DisplayBadge("12") == "12");
  CHECK(ext::PromptTypeName(ext::kPromptInstall) == "install");
  CHECK(ext::PromptTypeName(ext::kPromptPermissions) == "permissions");
  CHECK(ext::PromptTypeName(77) == "other");
}

TEST(icon_resources_stay_inside_the_extension) {
  CHECK(ext::ResourcePath("icons/128.png") == std::string("icons/128.png"));
  CHECK(ext::ResourcePath("/icons/128.png") == std::string("icons/128.png"));
  CHECK(!ext::ResourcePath("../secret.png"));
  CHECK(!ext::ResourcePath("icons/../../x.png"));
  CHECK(!ext::ResourcePath("icons\\x.png"));
  CHECK(!ext::ResourcePath(""));
  CHECK(ext::ImageMimeType("a.PNG") == "image/png");
  CHECK(ext::ImageMimeType("a.svg") == "image/svg+xml");
  CHECK(ext::ImageMimeType("a.exe").empty());
  CHECK(ext::ImageMimeType("noext").empty());
}

TEST(install_prompts_resolve_only_in_their_window_and_profile) {
  ext::PromptLedger<int> ledger;
  const auto id = ledger.Add("default", "window-1", 7);
  CHECK(id && *id == "install1");
  CHECK(ledger.Check(*id, "window-1", "default") == ext::PromptResolve::kResolved);
  CHECK(ledger.Check(*id, "window-2", "default") == ext::PromptResolve::kWrongWindow);
  CHECK(ledger.Check(*id, "window-1", "work") == ext::PromptResolve::kWrongProfile);
  CHECK(ledger.Check("install9", "window-1", "default") == ext::PromptResolve::kUnknown);
  CHECK(ledger.OfWindow("window-1").size() == 1);
  CHECK(ledger.Take(*id) == 7);
  CHECK(!ledger.Take(*id));
  CHECK(!ledger.full());
  for (size_t index = 0; index < ext::kMaxPendingPrompts; ++index) CHECK(ledger.Add("default", "w", 1));
  CHECK(ledger.full());
  CHECK(!ledger.Add("default", "w", 1));
  CHECK(ext::ValidRequestId("install1"));
  CHECK(!ext::ValidRequestId(""));
  CHECK(!ext::ValidRequestId(std::string(ext::kMaxRequestId + 1, 'a')));
  CHECK(ext::ValidTabKey("tab-1"));
  CHECK(!ext::ValidTabKey(std::string("tab\0", 4)));
  CHECK(!ext::ValidTabKey(std::string(ext::kMaxTabKey + 1, 'a')));
}

TEST(folders_are_absolute_normalized_and_never_the_root) {
  CHECK(ext::ValidFolderPath("/Users/me/dev/extension"));
  CHECK(!ext::ValidFolderPath("/"));
  CHECK(!ext::ValidFolderPath("/Users/me/../x"));
  CHECK(!ext::ValidFolderPath("dev/extension"));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
