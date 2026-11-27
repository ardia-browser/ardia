#ifndef ARDIA_MAC_AC_MAC_MENU_MODEL_H_
#define ARDIA_MAC_AC_MAC_MENU_MODEL_H_

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ardia_mac::menu {

inline constexpr std::size_t kMaxDepth = 4;
inline constexpr std::size_t kMaxItems = 400;
inline constexpr std::size_t kMaxTitle = 200;
inline constexpr std::size_t kMaxCommand = 96;
inline constexpr std::size_t kMaxArgument = 2048;

enum class Role {
  kNone,
  kSeparator,
  kAbout,
  kServices,
  kHide,
  kHideOthers,
  kShowAll,
  kQuit,
  kUndo,
  kRedo,
  kCut,
  kCopy,
  kPaste,
  kPasteAndMatchStyle,
  kDelete,
  kSelectAll,
  kMinimize,
  kZoom,
  kFullScreen,
  kBringAllToFront,
  kWindowMenu,
  kHelpMenu,
  kBookmarksMenu,
  kClose,
  kShareServices,
};

inline constexpr std::uint32_t kShift = 1;
inline constexpr std::uint32_t kControl = 2;
inline constexpr std::uint32_t kOption = 4;
inline constexpr std::uint32_t kCommand = 8;

struct Item {
  std::string title;
  std::string default_title;
  std::string command;
  std::string argument;
  std::string key;
  std::string state_id;
  std::uint32_t modifiers = 0;
  Role role = Role::kNone;
  bool enabled = true;
  bool checked = false;
  bool fixed_check = false;
  std::vector<Item> children;
};

struct Problem {
  std::string path;
  std::string reason;
};

struct RoleName {
  std::string_view name;
  Role role;
};

inline constexpr std::array<RoleName, 24> kRoles = {{
    {"separator", Role::kSeparator},
    {"about", Role::kAbout},
    {"services", Role::kServices},
    {"hide", Role::kHide},
    {"hideOthers", Role::kHideOthers},
    {"showAll", Role::kShowAll},
    {"quit", Role::kQuit},
    {"undo", Role::kUndo},
    {"redo", Role::kRedo},
    {"cut", Role::kCut},
    {"copy", Role::kCopy},
    {"paste", Role::kPaste},
    {"pasteAndMatchStyle", Role::kPasteAndMatchStyle},
    {"delete", Role::kDelete},
    {"selectAll", Role::kSelectAll},
    {"minimize", Role::kMinimize},
    {"zoom", Role::kZoom},
    {"toggleFullScreen", Role::kFullScreen},
    {"front", Role::kBringAllToFront},
    {"windowMenu", Role::kWindowMenu},
    {"helpMenu", Role::kHelpMenu},
    {"bookmarksMenu", Role::kBookmarksMenu},
    {"close", Role::kClose},
    {"shareServices", Role::kShareServices},
}};

inline std::optional<Role> RoleNamed(std::string_view name) {
  if (name.empty()) return Role::kNone;
  for (const RoleName& entry : kRoles) {
    if (entry.name == name) return entry.role;
  }
  return std::nullopt;
}

inline std::string_view SelectorFor(Role role) {
  switch (role) {
    case Role::kAbout:
      return "orderFrontStandardAboutPanel:";
    case Role::kHide:
      return "hide:";
    case Role::kHideOthers:
      return "hideOtherApplications:";
    case Role::kShowAll:
      return "unhideAllApplications:";
    case Role::kQuit:
      return "terminate:";
    case Role::kUndo:
      return "undo:";
    case Role::kRedo:
      return "redo:";
    case Role::kCut:
      return "cut:";
    case Role::kCopy:
      return "copy:";
    case Role::kPaste:
      return "paste:";
    case Role::kPasteAndMatchStyle:
      return "pasteAndMatchStyle:";
    case Role::kDelete:
      return "delete:";
    case Role::kSelectAll:
      return "selectAll:";
    case Role::kMinimize:
      return "performMiniaturize:";
    case Role::kClose:
      return "performClose:";
    case Role::kZoom:
      return "performZoom:";
    case Role::kFullScreen:
      return "toggleFullScreen:";
    case Role::kBringAllToFront:
      return "arrangeInFront:";
    case Role::kNone:
    case Role::kSeparator:
    case Role::kServices:
    case Role::kWindowMenu:
    case Role::kHelpMenu:
    case Role::kBookmarksMenu:
    case Role::kShareServices:
      return {};
  }
  return {};
}

inline constexpr std::string_view kShareCommand = "share";
inline constexpr std::string_view kShareViaPrefix = "via:";
inline constexpr std::string_view kShareMoreService = "ardia.more";

inline bool FillsShareServices(Role role, bool main_menu) {
  return main_menu && role == Role::kShareServices;
}

inline std::string ShareArgument(std::string_view service) {
  return std::string(kShareViaPrefix) + std::string(service);
}

inline bool InstallsAppMenu(Role role, bool main_menu) {
  return main_menu && (role == Role::kServices || role == Role::kWindowMenu || role == Role::kHelpMenu);
}

inline bool ContextMenuLive(bool host_alive,
                            std::uint64_t requested_generation,
                            std::uint64_t live_generation,
                            bool document_current) {
  return host_alive && requested_generation != 0 && requested_generation == live_generation && document_current;
}

inline bool HoldsSubmenu(Role role) {
  return role == Role::kServices || role == Role::kWindowMenu || role == Role::kHelpMenu || role == Role::kBookmarksMenu ||
         role == Role::kShareServices;
}

inline bool ValidCommand(std::string_view command) {
  if (command.size() > kMaxCommand) return false;
  return std::all_of(command.begin(), command.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' ||
           c == '-' || c == ':';
  });
}

inline bool ValidTitle(std::string_view title) {
  if (title.size() > kMaxTitle) return false;
  return std::none_of(title.begin(), title.end(), [](char c) {
    const auto byte = static_cast<unsigned char>(c);
    return byte < 0x20 || byte == 0x7f;
  });
}

inline bool ValidKey(std::string_view key) {
  if (key.empty()) return true;
  if (key.size() == 1) {
    const auto byte = static_cast<unsigned char>(key[0]);
    return byte >= 0x20 && byte < 0x7f;
  }
  static constexpr std::array<std::string_view, 12> kNamed = {"Enter", "Escape", "Backspace", "Delete", "Tab",
                                                              "Space",  "Up",     "Down",      "Left",   "Right",
                                                              "Home",   "End"};
  if (std::find(kNamed.begin(), kNamed.end(), key) != kNamed.end()) return true;
  if (key.size() >= 2 && key.size() <= 3 && key[0] == 'F') {
    int number = 0;
    for (std::size_t index = 1; index < key.size(); ++index) {
      if (key[index] < '0' || key[index] > '9') return false;
      number = number * 10 + (key[index] - '0');
    }
    return number >= 1 && number <= 20;
  }
  return false;
}

inline void Check(const Item& item,
                  std::size_t depth,
                  const std::string& path,
                  std::size_t& count,
                  std::vector<Problem>& problems) {
  ++count;
  if (count > kMaxItems) {
    problems.push_back({path, "too many items"});
    return;
  }
  if (depth > kMaxDepth) {
    problems.push_back({path, "too deep"});
    return;
  }
  if (!ValidTitle(item.title) || !ValidTitle(item.default_title)) problems.push_back({path, "title"});
  if (!ValidCommand(item.command)) problems.push_back({path, "command"});
  if (item.argument.size() > kMaxArgument) problems.push_back({path, "argument"});
  if (!item.state_id.empty() &&
      (item.state_id.size() > kMaxCommand + 1 + kMaxArgument ||
       std::any_of(item.state_id.begin(), item.state_id.end(), [](char c) {
         const auto byte = static_cast<unsigned char>(c);
         return byte < 0x20 || byte == 0x7f;
       })))
    problems.push_back({path, "id"});
  if (!ValidKey(item.key)) problems.push_back({path, "key"});
  if (item.modifiers & ~(kShift | kControl | kOption | kCommand)) problems.push_back({path, "modifiers"});
  if (item.role == Role::kSeparator && (!item.children.empty() || !item.command.empty()))
    problems.push_back({path, "separator"});
  if (item.role != Role::kSeparator && item.role != Role::kServices && item.title.empty() && depth > 0)
    problems.push_back({path, "untitled"});
  if ((!item.children.empty() || item.role == Role::kBookmarksMenu) && !item.command.empty())
    problems.push_back({path, "submenu with command"});
  for (std::size_t index = 0; index < item.children.size(); ++index) {
    Check(item.children[index], depth + 1, path + "/" + std::to_string(index), count, problems);
    if (count > kMaxItems) return;
  }
}

inline std::vector<Problem> Validate(const Item& root) {
  std::vector<Problem> problems;
  std::size_t count = 0;
  for (std::size_t index = 0; index < root.children.size(); ++index) {
    Check(root.children[index], 1, "/" + std::to_string(index), count, problems);
    if (count > kMaxItems) break;
  }
  return problems;
}

inline bool Selectable(const Item& item) {
  return item.enabled && item.children.empty() && item.role != Role::kSeparator &&
         (!item.command.empty() || !SelectorFor(item.role).empty());
}

inline std::vector<std::string> Describe(const Item& item, std::size_t depth = 0) {
  std::vector<std::string> lines;
  if (depth > 0) {
    std::string line(2 * (depth - 1), ' ');
    line += item.role == Role::kSeparator ? std::string("---") : item.title;
    if (!item.command.empty()) line += " [" + item.command + "]";
    if (!item.enabled) line += " (disabled)";
    if (item.checked) line += " (checked)";
    lines.push_back(std::move(line));
  }
  for (const Item& child : item.children) {
    std::vector<std::string> nested = Describe(child, depth + 1);
    lines.insert(lines.end(), nested.begin(), nested.end());
  }
  return lines;
}

inline Item MinimalMainMenu(std::string_view app_name) {
  const std::string app(app_name);
  const auto role = [](std::string title, Role role, std::string key = {}, std::uint32_t modifiers = 0) {
    Item item;
    item.title = std::move(title);
    item.role = role;
    item.key = std::move(key);
    item.modifiers = modifiers;
    return item;
  };
  const auto command = [](std::string title, std::string name, std::string key, std::uint32_t modifiers) {
    Item item;
    item.title = std::move(title);
    item.command = std::move(name);
    item.key = std::move(key);
    item.modifiers = modifiers;
    return item;
  };
  const auto separator = []() {
    Item item;
    item.role = Role::kSeparator;
    return item;
  };
  const auto submenu = [](std::string title, std::vector<Item> children, Role role = Role::kNone) {
    Item item;
    item.title = std::move(title);
    item.role = role;
    item.children = std::move(children);
    return item;
  };
  Item root;
  root.children = {
      submenu(app,
              {role("About " + app, Role::kAbout), separator(), submenu("Services", {}, Role::kServices), separator(),
               role("Hide " + app, Role::kHide, "h", kCommand),
               role("Hide Others", Role::kHideOthers, "h", kCommand | kOption), role("Show All", Role::kShowAll),
               separator(), command("Quit " + app, "quit", "q", kCommand)}),
      submenu("Edit",
              {role("Undo", Role::kUndo, "z", kCommand), role("Redo", Role::kRedo, "z", kCommand | kShift),
               separator(), role("Cut", Role::kCut, "x", kCommand), role("Copy", Role::kCopy, "c", kCommand),
               role("Paste", Role::kPaste, "v", kCommand), role("Select All", Role::kSelectAll, "a", kCommand)}),
      submenu("Window",
              {role("Minimize", Role::kMinimize, "m", kCommand), role("Zoom", Role::kZoom),
               role("Close Window", Role::kClose, "w", kCommand | kShift), separator(),
               role("Bring All to Front", Role::kBringAllToFront)},
              Role::kWindowMenu),
      submenu("Help", {}, Role::kHelpMenu),
  };
  return root;
}

inline Item DefaultMainMenu(std::string_view app_name) {
  const std::string app(app_name);
  const auto role = [](std::string title, Role role, std::string key = {}, std::uint32_t modifiers = 0) {
    Item item;
    item.title = std::move(title);
    item.role = role;
    item.key = std::move(key);
    item.modifiers = modifiers;
    return item;
  };
  const auto command = [](std::string title, std::string name, std::string key, std::uint32_t modifiers) {
    Item item;
    item.title = std::move(title);
    item.command = std::move(name);
    item.key = std::move(key);
    item.modifiers = modifiers;
    return item;
  };
  const auto share = [](std::string title, std::string_view service) {
    Item item;
    item.title = std::move(title);
    item.command = std::string(kShareCommand);
    item.argument = ShareArgument(service);
    return item;
  };
  const auto separator = []() {
    Item item;
    item.role = Role::kSeparator;
    return item;
  };
  const auto submenu = [](std::string title, std::vector<Item> children, Role role = Role::kNone) {
    Item item;
    item.title = std::move(title);
    item.role = role;
    item.children = std::move(children);
    return item;
  };
  Item root;
  root.children = {
      submenu(app,
              {role("About " + app, Role::kAbout), separator(),
               command("Settings…", "openSettings", ",", kCommand), separator(),
               submenu("Services", {}, Role::kServices), separator(),
               role("Hide " + app, Role::kHide, "h", kCommand),
               role("Hide Others", Role::kHideOthers, "h", kCommand | kOption),
               role("Show All", Role::kShowAll), separator(),
               command("Quit " + app, "quit", "q", kCommand)}),
      submenu("File",
              {command("New Tab", "newTab", "t", kCommand), command("New Window", "newWindow", "n", kCommand),
               separator(), command("Close Tab", "closeTab", "w", kCommand), separator(),
               submenu("Share", {share("Copy Link", "copy"), share("Email Link", "email")}, Role::kShareServices)}),
      submenu("Edit",
              {role("Undo", Role::kUndo, "z", kCommand), role("Redo", Role::kRedo, "z", kCommand | kShift),
               separator(), role("Cut", Role::kCut, "x", kCommand), role("Copy", Role::kCopy, "c", kCommand),
               role("Paste", Role::kPaste, "v", kCommand),
               role("Paste and Match Style", Role::kPasteAndMatchStyle, "v", kCommand | kOption | kShift),
               role("Delete", Role::kDelete), role("Select All", Role::kSelectAll, "a", kCommand)}),
      submenu("View",
              {command("Toggle Sidebar", "toggleSidebar", "s", kCommand), separator(),
               role("Enter Full Screen", Role::kFullScreen, "f", kCommand | kControl)}),
      submenu("Window",
              {role("Minimize", Role::kMinimize, "m", kCommand), role("Zoom", Role::kZoom), separator(),
               role("Bring All to Front", Role::kBringAllToFront)},
              Role::kWindowMenu),
      submenu("Help", {command("Show Onboarding", "showOnboarding", "", 0)}, Role::kHelpMenu),
  };
  return root;
}

}

#endif
