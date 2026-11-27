#include <cmath>
#include <functional>
#include <limits>
#include <string>
#include <vector>

#include "ardia/mac/ac_mac_menu_model.h"
#include "ardia/mac/ac_mac_menu_state.h"
#include "ardia/mac/ac_mac_window_layout.h"
#include "check.h"

namespace menu = ardia_mac::menu;
namespace window = ardia_mac::window;

TEST(default_menu_is_valid_and_has_standard_roles) {
  const menu::Item root = menu::DefaultMainMenu("Ardia");
  CHECK(menu::Validate(root).empty());
  CHECK(root.children.size() == 6);
  CHECK(root.children[0].title == "Ardia");
  CHECK(root.children[4].role == menu::Role::kWindowMenu);
  bool quit = false;
  for (const menu::Item& item : root.children[0].children) {
    quit |= item.role == menu::Role::kNone && item.command == "quit" && item.key == "q" &&
            item.modifiers == menu::kCommand;
    CHECK(item.role != menu::Role::kQuit);
  }
  CHECK(quit);
  const menu::Item& help = root.children[5];
  CHECK(help.role == menu::Role::kHelpMenu);
  CHECK(help.children.size() == 1);
  CHECK(help.children[0].title == "Show Onboarding");
  CHECK(help.children[0].command == "showOnboarding");
  const menu::Item& file = root.children[1];
  CHECK(file.title == "File");
  const menu::Item& share = file.children.back();
  CHECK(share.title == "Share" && share.role == menu::Role::kShareServices);
  CHECK(share.children.size() == 2);
  CHECK(share.children[0].command == "share" && share.children[0].argument == "via:copy");
  CHECK(share.children[1].command == "share" && share.children[1].argument == "via:email");
  CHECK(menu::FillsShareServices(menu::Role::kShareServices, true));
  CHECK(!menu::FillsShareServices(menu::Role::kShareServices, false));
  CHECK(menu::ShareArgument(menu::kShareMoreService) == "via:ardia.more");
}

TEST(validation_finds_problems) {
  menu::Item root;
  menu::Item bad;
  bad.title = "Bad\nTitle";
  bad.command = "rm -rf";
  bad.key = "Hyper";
  bad.modifiers = 64;
  root.children.push_back(bad);
  menu::Item separator;
  separator.role = menu::Role::kSeparator;
  separator.command = "x";
  root.children.push_back(separator);
  menu::Item untitled;
  untitled.command = "go";
  root.children.push_back(untitled);
  menu::Item both;
  both.title = "Both";
  both.command = "go";
  both.children.push_back(untitled);
  root.children.push_back(both);
  const auto problems = menu::Validate(root);
  int title = 0, command = 0, key = 0, modifiers = 0, sep = 0, nameless = 0, mixed = 0;
  for (const auto& problem : problems) {
    title += problem.reason == "title";
    command += problem.reason == "command";
    key += problem.reason == "key";
    modifiers += problem.reason == "modifiers";
    sep += problem.reason == "separator";
    nameless += problem.reason == "untitled";
    mixed += problem.reason == "submenu with command";
  }
  CHECK(title == 1 && command == 1 && key == 1 && modifiers == 1 && sep == 1 && nameless == 2 && mixed == 1);
}

TEST(validation_caps_depth_and_size) {
  menu::Item root;
  menu::Item* cursor = &root;
  for (int depth = 0; depth < 8; ++depth) {
    cursor->children.push_back(menu::Item{});
    cursor = &cursor->children.back();
    cursor->title = "level";
  }
  bool deep = false;
  for (const auto& problem : menu::Validate(root)) deep |= problem.reason == "too deep";
  CHECK(deep);
  menu::Item wide;
  for (int index = 0; index < 500; ++index) {
    menu::Item child;
    child.title = "x";
    wide.children.push_back(child);
  }
  bool many = false;
  for (const auto& problem : menu::Validate(wide)) many |= problem.reason == "too many items";
  CHECK(many);
}

TEST(keys) {
  CHECK(menu::ValidKey(""));
  CHECK(menu::ValidKey("t"));
  CHECK(menu::ValidKey(","));
  CHECK(menu::ValidKey("F12"));
  CHECK(menu::ValidKey("Escape"));
  CHECK(!menu::ValidKey("F0"));
  CHECK(!menu::ValidKey("F21"));
  CHECK(!menu::ValidKey("Fx"));
  CHECK(!menu::ValidKey("\x01"));
  CHECK(!menu::ValidKey("ab"));
}

TEST(roles_and_selectors) {
  CHECK(menu::RoleNamed("copy") == menu::Role::kCopy);
  CHECK(menu::RoleNamed("") == menu::Role::kNone);
  CHECK(!menu::RoleNamed("format_disk"));
  CHECK(menu::SelectorFor(menu::Role::kQuit) == "terminate:");
  CHECK(menu::SelectorFor(menu::Role::kWindowMenu).empty());
  for (const auto& entry : menu::kRoles) CHECK(menu::RoleNamed(entry.name) == entry.role);
}

TEST(selectable_items) {
  menu::Item item;
  item.title = "Go";
  CHECK(!menu::Selectable(item));
  item.command = "go";
  CHECK(menu::Selectable(item));
  item.enabled = false;
  CHECK(!menu::Selectable(item));
  menu::Item copy;
  copy.title = "Copy";
  copy.role = menu::Role::kCopy;
  CHECK(menu::Selectable(copy));
}

TEST(describe_for_background_logs) {
  menu::Item root;
  menu::Item open;
  open.title = "Open Link";
  open.command = "openLink";
  root.children.push_back(open);
  menu::Item separator;
  separator.role = menu::Role::kSeparator;
  root.children.push_back(separator);
  menu::Item off;
  off.title = "Off";
  off.command = "off";
  off.enabled = false;
  off.checked = true;
  root.children.push_back(off);
  const auto lines = menu::Describe(root);
  CHECK(lines.size() == 3);
  CHECK(lines[0] == "Open Link [openLink]");
  CHECK(lines[1] == "---");
  CHECK(lines[2] == "Off [off] (disabled) (checked)");
}

TEST(traffic_lights_default_to_ardia_geometry) {
  const auto lights = window::LightsFrom(std::nullopt, std::nullopt, false, {1280, 800});
  CHECK(lights && lights->center == (window::Point{25, 20}));
  const window::Point close = window::CloseButtonOrigin(*lights, {14, 14}, 800);
  CHECK(close == (window::Point{18, 773}));
  const window::Point zoom = window::ButtonOrigin(*lights, {14, 14}, 800, 2);
  CHECK(zoom == (window::Point{58, 773}));
}

TEST(titlebar_metrics_center_the_lights_where_ardia_puts_them) {
  const auto lights = window::LightsFrom(std::nullopt, std::nullopt, false, {1280, 800});
  CHECK(window::TitlebarFor(*lights, {14, 14}) == (window::TitlebarMetrics{18, 40}));
  const auto moved = window::LightsFrom(40, 30, false, {1280, 800});
  CHECK(window::TitlebarFor(*moved, {16, 16}) == (window::TitlebarMetrics{32, 60}));
  CHECK(window::TitlebarFor(*moved, {0, 0}) == (window::TitlebarMetrics{33, 60}));
}

TEST(traffic_lights_clamp_and_refuse_nan) {
  const auto far = window::LightsFrom(5000, -40, false, {1280, 800});
  CHECK(far && far->center == (window::Point{1226, 14}));
  const window::Point zoom = window::ButtonOrigin(*far, {14, 14}, 800, 2);
  CHECK(zoom.x + window::kButtonSide <= 1280);
  CHECK(!window::LightsFrom(std::nan(""), 10, false, {1280, 800}));
  const auto inf = std::numeric_limits<double>::infinity();
  CHECK(!window::LightsFrom(10, inf, false, {1280, 800}));
  const auto hidden = window::LightsFrom(std::nullopt, std::nullopt, true, {1280, 800});
  CHECK(hidden && hidden->hidden);
}

TEST(translucency_only_for_the_webui_shell) {
  const auto off = window::TranslucencyFor(false);
  CHECK(off.opaque && !off.clear_background && !off.full_size_content);
  const auto on = window::TranslucencyFor(true);
  CHECK(!on.opaque && on.clear_background && on.full_size_content && on.transparent_titlebar && on.hide_title);
}

TEST(app_menus_only_from_the_main_menu) {
  for (menu::Role role : {menu::Role::kServices, menu::Role::kWindowMenu, menu::Role::kHelpMenu}) {
    CHECK(menu::InstallsAppMenu(role, true));
    CHECK(!menu::InstallsAppMenu(role, false));
  }
  CHECK(!menu::InstallsAppMenu(menu::Role::kCopy, true));
}

TEST(hostile_sinks) {
  menu::Item root;
  for (const std::string& text : {std::string("\x1b[31m"), std::string("a\0b", 3), std::string(5000, 'x'),
                                  std::string("rm -rf /"), std::string("../../x"), std::string("\x7f")}) {
    menu::Item item;
    item.title = text;
    item.command = text;
    item.key = text;
    item.argument = std::string(5000, 'a');
    item.modifiers = 0xffffffffu;
    root.children.push_back(item);
  }
  const auto problems = menu::Validate(root);
  CHECK(problems.size() >= 6 * 4);
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  for (double value : {nan, inf, -inf, 1e20, -1e20}) {
    const auto lights = window::LightsFrom(value, value, false, {1280, 800});
    if (lights) {
      CHECK(std::isfinite(lights->center.x) && lights->center.x <= 1280);
      CHECK(std::isfinite(lights->center.y) && lights->center.y <= 800);
    }
  }
  menu::Item control;
  menu::Item ok;
  ok.title = "Open";
  ok.command = "open";
  control.children.push_back(ok);
  CHECK(menu::Validate(control).empty());
}

TEST(background_never_orders_the_window_onscreen) {
  const auto background = window::PresentationFor(true);
  CHECK(!background.show && background.order_out && background.lowest_level);
  const auto normal = window::PresentationFor(false);
  CHECK(normal.show && !normal.order_out && !normal.lowest_level);
}

TEST(queued_context_menu_dies_with_its_document) {
  CHECK(menu::ContextMenuLive(true, 3, 3, true));
  CHECK(!menu::ContextMenuLive(false, 3, 3, true));
  CHECK(!menu::ContextMenuLive(true, 3, 4, true));
  CHECK(!menu::ContextMenuLive(true, 3, 3, false));
  CHECK(!menu::ContextMenuLive(true, 0, 0, true));
}

TEST(caption_double_click_follows_the_system_setting) {
  using window::CaptionAction;
  CHECK(window::CaptionActionFor(std::nullopt, std::nullopt, false) == CaptionAction::kZoom);
  CHECK(window::CaptionActionFor("Maximize", std::nullopt, false) == CaptionAction::kZoom);
  CHECK(window::CaptionActionFor("Fill", std::nullopt, false) == CaptionAction::kZoom);
  CHECK(window::CaptionActionFor("Minimize", std::nullopt, false) == CaptionAction::kMinimize);
  CHECK(window::CaptionActionFor("None", true, false) == CaptionAction::kNone);
  CHECK(window::CaptionActionFor(std::nullopt, true, false) == CaptionAction::kMinimize);
  CHECK(window::CaptionActionFor("Bogus", std::nullopt, false) == CaptionAction::kZoom);
  CHECK(window::CaptionActionFor("Minimize", true, true) == CaptionAction::kNone);
  CHECK(window::CaptionActionName(CaptionAction::kMinimize) == "minimize");
}

TEST(window_drag_starts_on_a_left_press_or_a_left_drag) {
  using window::DragStart;
  using window::MouseEvent;
  CHECK(window::WindowDragFor(MouseEvent::kLeftDown, true, true, false) == (DragStart{true, false}));
  CHECK(window::WindowDragFor(MouseEvent::kLeftDragged, true, true, false) == (DragStart{true, false}));
  CHECK(window::WindowDragFor(MouseEvent::kLeftDragged, true, true, true) == (DragStart{true, true}));
  CHECK(window::WindowDragFor(MouseEvent::kOther, false, true, true) == (DragStart{true, true}));
}

TEST(window_drag_refuses_a_released_button_or_another_window) {
  using window::DragStart;
  using window::MouseEvent;
  CHECK(window::WindowDragFor(MouseEvent::kLeftDown, true, false, false) == DragStart{});
  CHECK(window::WindowDragFor(MouseEvent::kLeftDown, true, false, true) == DragStart{});
  CHECK(window::WindowDragFor(MouseEvent::kLeftDragged, false, true, false) == DragStart{});
  CHECK(window::WindowDragFor(MouseEvent::kLeftDown, false, true, false) == DragStart{});
  CHECK(window::WindowDragFor(MouseEvent::kOther, true, true, false) == DragStart{});
}

TEST(the_whole_traffic_light_group_stays_inside_the_window) {
  for (double width : {60.0, 200.0, 1280.0, 3000.0}) {
    const auto lights = window::LightsFrom(1e9, 20, false, {width, 800});
    CHECK(lights.has_value());
    if (!lights) continue;
    const window::Point zoom = window::ButtonOrigin(*lights, {14, 14}, 800, 2);
    CHECK(zoom.x + window::kButtonSide <= width ||
          width < 3 * window::kButtonSide + 2 * window::kTrafficLightSpacing + 2 * window::kLightsEdgeMargin);
    CHECK(lights->center.x >= window::kMinLightsCenter);
  }
  const auto defaults = window::LightsFrom(std::nullopt, std::nullopt, false, {1280, 800});
  CHECK(defaults && defaults->center == (window::Point{25, 20}));
}

TEST(menu_state_resolves_enabled_checked_and_title_by_id_and_command) {
  menu::State state;
  CHECK(menu::AddStateEntry(state.disabled, "back"));
  CHECK(menu::AddStateEntry(state.disabled, "setTabLayout:top"));
  CHECK(menu::AddStateEntry(state.checked, "setAppearance:dark"));
  CHECK(menu::AddStateTitle(state, "bookmarkPage", "Edit Bookmark\xE2\x80\xA6"));
  CHECK(!menu::Resolve("back", false, false, "Back", state).enabled);
  CHECK(!menu::Resolve("setTabLayout:top", false, false, "Top", state).enabled);
  CHECK(menu::Resolve("setTabLayout:sidebarLeft", false, false, "Left", state).enabled);
  CHECK(menu::Resolve("setAppearance:dark", false, false, "Dark", state).checked);
  CHECK(!menu::Resolve("setAppearance:light", false, false, "Light", state).checked);
  CHECK(menu::Resolve("bookmarkPage", false, false, "Bookmark This Page", state).title == "Edit Bookmark\xE2\x80\xA6");
  CHECK(menu::Resolve("bookmarkAllTabs", false, false, "Bookmark All Tabs", state).title == "Bookmark All Tabs");
  menu::State commandOff;
  CHECK(menu::AddStateEntry(commandOff.disabled, "moveTabToProfile"));
  CHECK(!menu::Resolve("moveTabToProfile:work", false, false, "Work", commandOff).enabled);
}

TEST(fixed_checks_keep_the_current_entry_checked) {
  const menu::State empty;
  CHECK(menu::Resolve("switchProfile:p1", true, true, "Personal", empty).checked);
  CHECK(!menu::Resolve("switchProfile:p2", true, false, "Work", empty).checked);
  CHECK(!menu::Resolve("switchProfile:p1", false, true, "Personal", empty).checked);
}

TEST(menu_state_refuses_bad_entries_and_caps_its_size) {
  menu::State state;
  CHECK(!menu::AddStateEntry(state.disabled, ""));
  CHECK(!menu::AddStateEntry(state.disabled, "bad\nid"));
  CHECK(!menu::AddStateEntry(state.disabled, std::string(menu::kMaxStateId + 1, 'a')));
  CHECK(!menu::AddStateTitle(state, "ok", "two\nlines"));
  CHECK(!menu::AddStateTitle(state, "ok", std::string(menu::kMaxTitle + 1, 't')));
  CHECK(!menu::AddStateTitle(state, "ok", ""));
  for (std::size_t index = 0; index < menu::kMaxStateEntries + 10; ++index) {
    menu::AddStateEntry(state.checked, "c" + std::to_string(index));
  }
  CHECK(state.checked.size() == menu::kMaxStateEntries);
  CHECK(state.disabled.empty() && state.titles.empty());
}

TEST(state_ids_are_validated_with_the_menu) {
  menu::Item root;
  menu::Item item;
  item.title = "Back";
  item.command = "back";
  item.state_id = "back";
  item.default_title = "Back";
  root.children.push_back(item);
  CHECK(menu::Validate(root).empty());
  root.children[0].state_id = "bad\x01";
  CHECK(!menu::Validate(root).empty());
  root.children[0].state_id = "back";
  root.children[0].default_title = "bad\ntitle";
  CHECK(!menu::Validate(root).empty());
}

TEST(bookmarks_menu_role_holds_a_submenu_without_a_command) {
  CHECK(menu::RoleNamed("bookmarksMenu") == menu::Role::kBookmarksMenu);
  CHECK(menu::HoldsSubmenu(menu::Role::kBookmarksMenu));
  CHECK(!menu::InstallsAppMenu(menu::Role::kBookmarksMenu, true));
  CHECK(menu::SelectorFor(menu::Role::kBookmarksMenu).empty());
  menu::Item root;
  menu::Item bookmarks;
  bookmarks.title = "Bookmarks";
  bookmarks.role = menu::Role::kBookmarksMenu;
  root.children.push_back(bookmarks);
  CHECK(menu::Validate(root).empty());
  root.children[0].command = "openBookmark";
  CHECK(!menu::Validate(root).empty());
}

TEST(bookmark_menu_matches_the_desktop_app_menu) {
  menu::Bookmarks bookmarks;
  bookmarks.recent.push_back({"b1", "Example", "https://example.com", false, {}});
  menu::Bookmark work{"f1", "Work", "", true, {}};
  work.children.push_back({"b2", "", "https://ardia.dev", false, {}});
  bookmarks.bar.push_back(work);
  const std::vector<menu::Item> items = menu::BookmarkMenuItems(bookmarks);
  CHECK(items.size() == 5);
  CHECK(items[0].title == "Recent Bookmarks" && !items[0].enabled);
  CHECK(items[1].command == "openBookmark" && items[1].argument == "b1" && items[1].state_id == "openBookmark:b1");
  CHECK(items[2].role == menu::Role::kSeparator);
  CHECK(items[3].title == "Bookmarks Bar" && items[3].children.size() == 1);
  const menu::Item& folder = items[3].children[0];
  CHECK(folder.title == "Work" && folder.children.size() == 3);
  CHECK(folder.children[0].title == "https://ardia.dev");
  CHECK(folder.children[1].role == menu::Role::kSeparator);
  CHECK(folder.children[2].command == "addFolderToSidebar" && folder.children[2].argument == "f1");
  CHECK(items[4].title == "Other Bookmarks" && items[4].children.size() == 1);
  CHECK(items[4].children[0].title == "Empty" && !items[4].children[0].enabled);
}

TEST(arc_holders_offer_restoring_their_folders) {
  menu::Bookmarks bookmarks;
  menu::Bookmark inner{"f2", "Space", "", true, {}};
  inner.children.push_back({"b3", "Site", "https://example.com", false, {}});
  menu::Bookmark holder{"f1", "Personal (Arc)", "", true, {}};
  holder.children.push_back(inner);
  bookmarks.bar.push_back(holder);
  const std::vector<menu::Item> items = menu::BookmarkMenuItems(bookmarks);
  const menu::Item& arc = items[0].children[0];
  CHECK(arc.children.back().command == "restoreArcFolders" && arc.children.back().argument == "f1");
  bookmarks.other = bookmarks.bar;
  const std::vector<menu::Item> other = menu::BookmarkMenuItems(bookmarks);
  CHECK(other[1].children[0].children.back().command == "addFolderToSidebar");
}

TEST(bookmark_titles_are_cleaned_and_menus_stay_bounded) {
  CHECK(menu::CleanTitle("  a\tb\nc  ") == "a b c");
  CHECK(menu::CleanTitle("\x01\x02") == "");
  const std::string long_title = std::string(menu::kMaxTitle - 1, 'x') + "\xE2\x80\xA6";
  const std::string cut = menu::CleanTitle(long_title);
  CHECK(cut.size() <= menu::kMaxTitle && menu::ValidTitle(cut) && cut == std::string(menu::kMaxTitle - 1, 'x'));
  menu::Bookmarks many;
  for (int index = 0; index < 5000; ++index) many.other.push_back({"b" + std::to_string(index), "t", "https://a", false, {}});
  std::size_t count = 0;
  std::function<void(const std::vector<menu::Item>&)> walk = [&](const std::vector<menu::Item>& items) {
    for (const menu::Item& item : items) {
      ++count;
      walk(item.children);
    }
  };
  walk(menu::BookmarkMenuItems(many));
  CHECK(count <= menu::kMaxBookmarkItems + 2);
  menu::Bookmark deep{"d0", "d", "", true, {}};
  menu::Bookmark* cursor = &deep;
  for (int depth = 1; depth < 20; ++depth) {
    cursor->children.push_back({"d" + std::to_string(depth), "d", "", true, {}});
    cursor = &cursor->children.back();
  }
  menu::Bookmarks nested;
  nested.bar.push_back(deep);
  std::size_t levels = 0;
  const menu::Item* at = nullptr;
  const std::vector<menu::Item> built = menu::BookmarkMenuItems(nested);
  at = &built[0];
  while (!at->children.empty() && !at->children[0].children.empty()) {
    at = &at->children[0];
    ++levels;
  }
  CHECK(levels <= menu::kMaxBookmarkDepth);
  menu::Bookmarks nameless;
  nameless.other.push_back({"b", "", "", false, {}});
  nameless.other.push_back({"", "No id", "https://a", false, {}});
  nameless.other.push_back({std::string(menu::kMaxArgument + 1, 'i'), "Long id", "https://a", false, {}});
  const std::vector<menu::Item> cleaned = menu::BookmarkMenuItems(nameless);
  CHECK(cleaned[1].children.size() == 1 && cleaned[1].children[0].title == "Untitled");
}

TEST(group_links_need_web_or_file_urls) {
  CHECK(menu::GroupLink("https://a") && menu::GroupLink("HTTP://a") && menu::GroupLink("file:///x"));
  CHECK(!menu::GroupLink("javascript:alert(1)") && !menu::GroupLink("chrome://settings") && !menu::GroupLink(""));
}

TEST(a_menu_of_exactly_400_items_is_valid_and_401_is_not) {
  const auto bar = [](std::size_t count) {
    menu::Item root;
    menu::Item top;
    top.title = "File";
    for (std::size_t index = 1; index < count; ++index) {
      menu::Item item;
      item.title = "Item";
      item.command = "go";
      top.children.push_back(item);
    }
    root.children.push_back(top);
    return root;
  };
  CHECK(menu::Validate(bar(menu::kMaxItems)).empty());
  const auto problems = menu::Validate(bar(menu::kMaxItems + 1));
  CHECK(problems.size() == 1 && problems[0].reason == "too many items");
}

TEST(the_key_window_owns_the_shared_menu_bar) {
  menu::MenuOwner owner;
  CHECK(owner.Claims("w1", false, false));
  CHECK(!owner.Claims("w2", false, false));
  CHECK(owner.active() == "w1");
  CHECK(owner.Claims("w2", true, true));
  CHECK(!owner.Claims("w1", false, true));
  CHECK(owner.Activate("settings") && owner.active() == "settings");
  CHECK(!owner.Claims("w2", false, true));
  CHECK(!owner.Activate("settings"));
  owner.Forget("w2");
  CHECK(owner.active() == "settings");
  owner.Forget("settings");
  CHECK(owner.active().empty());
  CHECK(!owner.Claims("w1", false, true));
  CHECK(owner.active().empty());
  CHECK(owner.Claims("w3", false, false));
  CHECK(!owner.Claims("", true, true));
}

TEST(close_window_maps_to_appkit_perform_close) {
  CHECK(menu::RoleNamed("close") == menu::Role::kClose);
  CHECK(menu::SelectorFor(menu::Role::kClose) == "performClose:");
  menu::Item item;
  item.title = "Close Window";
  item.role = menu::Role::kClose;
  item.key = "w";
  item.modifiers = menu::kCommand | menu::kShift;
  CHECK(menu::Selectable(item));
}

TEST(shortcut_recording_suppresses_menu_keys_only_in_its_key_window) {
  menu::KeySuppression keys;
  CHECK(keys.empty() && !keys.Suppresses(std::string("settings")));
  keys.Set("settings", true);
  CHECK(keys.Suppresses(std::string("settings")));
  CHECK(!keys.Suppresses(std::string("main")));
  CHECK(!keys.Suppresses(std::nullopt));
  keys.Set("settings", false);
  CHECK(keys.empty());
  keys.Set("", true);
  CHECK(keys.empty());
}

TEST(a_key_window_without_its_own_menu_gets_a_minimal_system_bar) {
  const menu::Item root = menu::MinimalMainMenu("Ardia");
  CHECK(menu::Validate(root).empty());
  CHECK(root.children.size() == 4);
  CHECK(root.children[0].title == "Ardia" && root.children[1].title == "Edit");
  CHECK(root.children[2].role == menu::Role::kWindowMenu && root.children[3].role == menu::Role::kHelpMenu);
  std::function<bool(const menu::Item&)> commandFree = [&](const menu::Item& item) {
    if (!item.command.empty() && item.command != "quit") return false;
    for (const menu::Item& child : item.children) {
      if (!commandFree(child)) return false;
    }
    return true;
  };
  CHECK(commandFree(root));
  CHECK(root.children[0].children.back().command == "quit" && root.children[0].children.back().key == "q");
  bool closes = false;
  for (const menu::Item& item : root.children[2].children) closes |= item.role == menu::Role::kClose;
  CHECK(closes);
}

TEST(new_windows_cascade_and_utility_windows_center_over_their_opener) {
  const window::Frame opener{100, 80, 1280, 800};
  CHECK(window::CascadedFrom(opener) == (window::Frame{122, 102, 1280, 800}));
  CHECK(window::CascadedFrom(window::Frame{0, 0, 0, 0}) == (window::Frame{22, 22, 1, 1}));
  CHECK(window::UtilityFrameOver(opener, "settings") == (window::Frame{330, 160, 820, 640}));
  CHECK(window::UtilityFrameOver(opener, "import") == (window::Frame{420, 180, 640, 600}));
}

TEST(traffic_lights_scale_by_the_shell_zoom_before_they_clamp_to_the_window) {
  const window::Size window{1280, 800};
  CHECK(window::LightsFrom(25, 27, false, window, 1)->center == (window::Point{25, 27}));
  CHECK(window::LightsFrom(25, 27, false, window, 1.25)->center == (window::Point{31.25, 33.75}));
  CHECK(window::LightsFrom(25, 27, false, window, 0.8)->center == (window::Point{20, 21.6}));
  CHECK(window::LightsFrom(1500, 27, false, window, 0.8)->center.x == 1200);
  CHECK(window::LightsFrom(1200, 27, false, window, 1.25)->center.x == 1226);
  CHECK(window::LightsFrom(1240, 27, false, window, 0.5)->center.x == 620);
  CHECK(window::LightsFrom(25, 27, false, window, std::numeric_limits<double>::quiet_NaN())->center == (window::Point{25, 27}));
  CHECK(window::LightsFrom(25, 27, false, window, 0)->center == (window::Point{25, 27}));
  CHECK(window::LightsFrom(25, 27, true, window, 2)->hidden);
}

TEST(the_close_button_never_leaves_the_window_edge_or_the_top) {
  const window::Size window{1280, 800};
  for (double x : {-400.0, -7.0, 0.0, 3.0, 7.0, 13.9}) {
    const auto lights = window::LightsFrom(x, 27, false, window);
    CHECK(lights && lights->center.x - window::kButtonSide / 2 >= window::kLightsEdgeMargin);
    CHECK(window::TitlebarFor(*lights, {14, 14}).min_x_inset >= window::kLightsEdgeMargin);
  }
  for (double y : {-50.0, 0.0, 4.0, 13.0}) {
    const auto lights = window::LightsFrom(25, y, false, window);
    CHECK(lights && lights->center.y - window::kButtonSide / 2 >= window::kLightsEdgeMargin);
  }
  const auto tiny = window::LightsFrom(25, 27, false, {10, 10});
  CHECK(tiny && tiny->center == (window::Point{window::kMinLightsCenter, window::kMinLightsCenter}));
}

TEST(settings_windows_center_their_lights_in_the_settings_toolbar_as_the_mac_app_does) {
  const auto settings = window::LightsFrom(25, 26, false, {820, 640});
  CHECK(settings && settings->center == (window::Point{25, 26}));
  CHECK(window::TitlebarFor(*settings, {14, 14}) == (window::TitlebarMetrics{18, 52}));
  CHECK(settings->center.y - window::kButtonSide / 2 == 19);
}

TEST(a_requested_frame_lands_on_the_screen_it_overlaps_most_and_stays_inside_it) {
  const std::vector<window::Frame> screens{{0, 0, 1512, 982}, {1512, 0, 2560, 1440}};
  CHECK(window::PlacedOnScreens({100, 80, 1280, 800}, screens) == (window::Frame{100, 80, 1280, 800}));
  CHECK(window::PlacedOnScreens({1400, 100, 1280, 800}, screens) == (window::Frame{1512, 100, 1280, 800}));
  CHECK(window::PlacedOnScreens({1000, 600, 1280, 800}, screens) == (window::Frame{1512, 600, 1280, 800}));
  CHECK(window::PlacedOnScreens({1000, 600, 400, 600}, screens) == (window::Frame{1000, 382, 400, 600}));
  CHECK(window::PlacedOnScreens({100, 80, 4000, 3000}, screens) == (window::Frame{1512, 0, 2560, 1440}));
  CHECK(window::PlacedOnScreens({100, 80, 1400, 3000}, screens) == (window::Frame{100, 0, 1400, 982}));
  CHECK(!window::PlacedOnScreens({9000, 9000, 800, 600}, screens));
  CHECK(!window::PlacedOnScreens({100, 80, 800, 600}, {}));
}

TEST(new_windows_honor_focus_behind_and_maximized_and_background_shows_nothing) {
  CHECK(window::PresentationForOpen(false, true, false, false) == (window::OpenPresentation{true, true, false, false}));
  CHECK(window::PresentationForOpen(false, false, false, false) == (window::OpenPresentation{true, false, false, false}));
  CHECK(window::PresentationForOpen(false, true, true, false) == (window::OpenPresentation{true, false, true, false}));
  CHECK(window::PresentationForOpen(false, true, false, true) == (window::OpenPresentation{true, true, false, true}));
  CHECK(window::PresentationForOpen(true, true, true, true) == window::OpenPresentation{});
}

TEST(settings_lights_sit_centered_inside_a_tall_titlebar) {
  const auto lights = window::LightsFrom(25, 26, false, {760, 640});
  CHECK(lights && lights->center == (window::Point{25, 26}));
  const window::TitlebarMetrics metrics = window::TitlebarFor(*lights, {14, 14});
  CHECK(metrics == (window::TitlebarMetrics{18, 52}));
  const window::TitlebarLayout layout = window::TitlebarLayoutFor(metrics, {14, 14}, 20, 640);
  CHECK(layout.container_height == 52);
  CHECK(layout.container_y == 588);
  CHECK(layout.button_y == 19);
  CHECK(layout.container_y + layout.button_y + 14 <= 640);
  CHECK(layout.container_y + layout.button_y + 7 == 640 - 26);
  CHECK(layout.button_x[0] == 18 && layout.button_x[1] == 38 && layout.button_x[2] == 58);
}

TEST(titlebar_layout_survives_unmeasured_buttons) {
  const window::TitlebarLayout layout = window::TitlebarLayoutFor({18, 40}, {0, 0}, 0, 800);
  CHECK(layout.container_height == 40 && layout.container_y == 760 && layout.button_y == 13);
  CHECK(layout.button_x[1] - layout.button_x[0] == window::kButtonSide + window::kTrafficLightSpacing);
  const window::TitlebarLayout tiny = window::TitlebarLayoutFor({18, 1}, {14, 14}, 20, 800);
  CHECK(tiny.container_height == 14 && tiny.button_y == 0);
  const window::TitlebarLayout broken = window::TitlebarLayoutFor({18, 40}, {14, 14}, std::nan(""), std::nan(""));
  CHECK(broken.container_y == 0 && broken.button_x[1] == 38);
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
