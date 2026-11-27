#ifndef ARDIA_MAC_AC_MAC_MENU_STATE_H_
#define ARDIA_MAC_AC_MAC_MENU_STATE_H_

#include <algorithm>
#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_menu_model.h"

namespace ardia_mac::menu {

inline constexpr std::size_t kMaxStateEntries = 4096;
inline constexpr std::size_t kMaxStateId = kMaxCommand + 1 + kMaxArgument;
inline constexpr std::size_t kMaxBookmarkItems = 2000;
inline constexpr std::size_t kMaxBookmarkDepth = 8;
inline constexpr std::size_t kMaxBookmarkNodes = 20000;
inline constexpr std::size_t kMaxUrl = 8192;

struct State {
  std::set<std::string> disabled;
  std::set<std::string> checked;
  std::map<std::string, std::string> titles;
};

struct Shown {
  bool enabled = true;
  bool checked = false;
  std::string title;
};

inline bool NoControls(std::string_view text) {
  return std::none_of(text.begin(), text.end(), [](char c) {
    const auto byte = static_cast<unsigned char>(c);
    return byte < 0x20 || byte == 0x7f;
  });
}

inline bool ValidStateId(std::string_view id) {
  return !id.empty() && id.size() <= kMaxStateId && NoControls(id);
}

inline std::string_view CommandOf(std::string_view id) {
  const std::size_t colon = id.find(':');
  return colon == std::string_view::npos ? id : id.substr(0, colon);
}

inline bool AddStateEntry(std::set<std::string>& into, std::string_view id) {
  if (into.size() >= kMaxStateEntries || !ValidStateId(id)) return false;
  into.emplace(id);
  return true;
}

inline bool AddStateTitle(State& state, std::string_view id, std::string_view title) {
  if (state.titles.size() >= kMaxStateEntries || !ValidStateId(id) || title.empty() || !ValidTitle(title)) return false;
  state.titles.emplace(std::string(id), std::string(title));
  return true;
}

inline Shown Resolve(const std::string& id,
                     bool fixed_check,
                     bool initially_checked,
                     const std::string& default_title,
                     const State& state) {
  Shown shown;
  shown.enabled = !state.disabled.contains(id) && !state.disabled.contains(std::string(CommandOf(id)));
  shown.checked = fixed_check ? initially_checked : state.checked.contains(id);
  const auto title = state.titles.find(id);
  shown.title = title != state.titles.end() ? title->second : default_title;
  return shown;
}

struct Bookmark {
  std::string id;
  std::string title;
  std::string url;
  bool folder = false;
  std::vector<Bookmark> children;
};

struct Bookmarks {
  std::vector<Bookmark> recent;
  std::vector<Bookmark> bar;
  std::vector<Bookmark> other;
};

inline std::string CleanTitle(std::string_view raw) {
  std::string clean;
  clean.reserve(std::min(raw.size(), kMaxTitle));
  for (const char c : raw) {
    const auto byte = static_cast<unsigned char>(c);
    clean.push_back(byte < 0x20 || byte == 0x7f ? ' ' : c);
  }
  if (clean.size() > kMaxTitle) {
    std::size_t cut = kMaxTitle;
    while (cut > 0 && (static_cast<unsigned char>(clean[cut]) & 0xC0) == 0x80) --cut;
    clean.resize(cut);
  }
  const std::size_t first = clean.find_first_not_of(' ');
  if (first == std::string::npos) return std::string();
  const std::size_t last = clean.find_last_not_of(' ');
  return clean.substr(first, last - first + 1);
}

inline bool GroupLink(std::string_view url) {
  std::string lower(url.substr(0, 8));
  std::transform(lower.begin(), lower.end(), lower.begin(),
                 [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; });
  return lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("file:");
}

inline bool HasGroupLinks(const std::vector<Bookmark>& nodes, std::size_t depth = 0) {
  if (depth > kMaxBookmarkDepth) return false;
  return std::any_of(nodes.begin(), nodes.end(), [depth](const Bookmark& node) {
    return node.folder ? HasGroupLinks(node.children, depth + 1) : GroupLink(node.url);
  });
}

class BookmarkMenu {
 public:
  explicit BookmarkMenu(std::size_t budget = kMaxBookmarkItems) : left_(budget) {}

  std::vector<Item> Build(const Bookmarks& bookmarks) {
    std::vector<Item> items;
    if (!bookmarks.recent.empty()) {
      if (Take()) items.push_back(Header("Recent Bookmarks"));
      for (const Bookmark& node : bookmarks.recent) {
        if (std::optional<Item> item = Node(node, 1, false)) items.push_back(std::move(*item));
      }
      if (Take()) items.push_back(Separator());
    }
    if (std::optional<Item> bar = Folder("Bookmarks Bar", bookmarks.bar, std::string(), 1, true, false)) {
      items.push_back(std::move(*bar));
    }
    if (std::optional<Item> other = Folder("Other Bookmarks", bookmarks.other, std::string(), 1, false, false)) {
      items.push_back(std::move(*other));
    }
    return items;
  }

  bool exhausted() const { return left_ == 0; }

 private:
  bool Take() {
    if (left_ == 0) return false;
    --left_;
    return true;
  }

  static Item Separator() {
    Item item;
    item.role = Role::kSeparator;
    return item;
  }

  static Item Header(std::string title) {
    Item item;
    item.title = std::move(title);
    item.enabled = false;
    return item;
  }

  static Item Command(std::string title, std::string command, const std::string& argument) {
    Item item;
    item.title = std::move(title);
    item.state_id = command + ":" + argument;
    item.command = std::move(command);
    item.argument = argument;
    return item;
  }

  std::optional<Item> Node(const Bookmark& node, std::size_t depth, bool holds_arc_holders) {
    if (node.folder) {
      const bool arc_holder = holds_arc_holders && node.title.ends_with(" (Arc)");
      return Folder(node.title, node.children, node.id, depth, false, arc_holder);
    }
    if (node.id.empty() || node.id.size() > kMaxArgument || !NoControls(node.id) || !Take()) return std::nullopt;
    std::string title = CleanTitle(node.title.empty() ? node.url : node.title);
    if (title.empty()) title = "Untitled";
    return Command(std::move(title), "openBookmark", node.id);
  }

  std::optional<Item> Folder(const std::string& title,
                             const std::vector<Bookmark>& children,
                             const std::string& id,
                             std::size_t depth,
                             bool holds_arc_holders,
                             bool arc_holder) {
    if (depth > kMaxBookmarkDepth || !Take()) return std::nullopt;
    const bool identified = !id.empty() && id.size() <= kMaxArgument && NoControls(id);
    Item folder;
    folder.title = CleanTitle(title);
    if (folder.title.empty()) folder.title = "Untitled";
    for (const Bookmark& child : children) {
      if (left_ == 0) break;
      if (std::optional<Item> item = Node(child, depth + 1, holds_arc_holders)) folder.children.push_back(std::move(*item));
    }
    if (folder.children.empty() && Take()) folder.children.push_back(Header("Empty"));
    if (identified && HasGroupLinks(children) && left_ >= 2) {
      Take();
      folder.children.push_back(Separator());
      Take();
      folder.children.push_back(Command("Add to Sidebar as Group", "addFolderToSidebar", id));
      const bool nested_groups = std::any_of(children.begin(), children.end(), [](const Bookmark& child) {
        return child.folder && HasGroupLinks(child.children);
      });
      if (arc_holder && nested_groups && Take()) {
        folder.children.push_back(Command("Restore Arc Folders as Groups", "restoreArcFolders", id));
      }
    }
    if (folder.children.empty()) folder.children.push_back(Header("Empty"));
    return folder;
  }

  std::size_t left_;
};

class MenuOwner {
 public:
  bool Claims(const std::string& window, bool key_window, bool any_key_window) {
    if (window.empty()) return false;
    if (key_window || (active_.empty() && !any_key_window)) active_ = window;
    return active_ == window;
  }

  bool Activate(const std::string& window) {
    if (window.empty() || window == active_) return false;
    active_ = window;
    return true;
  }

  void Forget(const std::string& window) {
    if (window == active_) active_.clear();
  }

  const std::string& active() const { return active_; }

 private:
  std::string active_;
};

class KeySuppression {
 public:
  void Set(const std::string& window, bool suppressed) {
    if (window.empty()) return;
    if (suppressed) {
      windows_.insert(window);
    } else {
      windows_.erase(window);
    }
  }

  bool Suppresses(const std::optional<std::string>& key_window) const {
    return key_window && windows_.contains(*key_window);
  }

  bool empty() const { return windows_.empty(); }

 private:
  std::set<std::string> windows_;
};

inline std::vector<Item> BookmarkMenuItems(const Bookmarks& bookmarks, std::size_t budget = kMaxBookmarkItems) {
  return BookmarkMenu(budget).Build(bookmarks);
}

}

#endif
