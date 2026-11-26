#include "ardia/mac/ac_mac_menu.h"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <map>
#include <memory>
#include <set>
#include <utility>

#include "ardia/mac/ac_mac_share.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/current_thread.h"
#include "base/task/sequenced_task_runner.h"

@interface ArdiaMacMainMenu : NSMenu
@end

@interface ArdiaMacMenuTarget : NSObject
@property(nonatomic, nullable) NSDictionary* chosen;
@property(nonatomic) BOOL forContextMenu;
- (void)perform:(NSMenuItem*)item;
@end

@interface ArdiaMacShareMenuFiller : NSObject <NSMenuDelegate>
- (void)openSharingSettings:(id)sender;
@end

namespace ardia_mac {

namespace {

ArdiaMacMenuTarget* MainTarget() {
  static ArdiaMacMenuTarget* target = [[ArdiaMacMenuTarget alloc] init];
  return target;
}

constexpr NSInteger kShareServiceTag = 0x41534853;

ArdiaMacShareMenuFiller* ShareMenuFiller() {
  static ArdiaMacShareMenuFiller* filler = [[ArdiaMacShareMenuFiller alloc] init];
  return filler;
}

MenuCommandHandler& MainHandler() {
  static base::NoDestructor<MenuCommandHandler> handler;
  return *handler;
}

struct WindowMenu {
  std::optional<menu::Item> root;
  std::optional<menu::State> state;
  std::optional<menu::Bookmarks> bookmarks;
};

std::map<std::string, WindowMenu>& WindowMenus() {
  static base::NoDestructor<std::map<std::string, WindowMenu>> menus;
  return *menus;
}

menu::MenuOwner& Owner() {
  static base::NoDestructor<menu::MenuOwner> owner;
  return *owner;
}

menu::KeySuppression& Suppression() {
  static base::NoDestructor<menu::KeySuppression> suppression;
  return *suppression;
}

MenuWindowResolver& Resolver() {
  static base::NoDestructor<MenuWindowResolver> resolver;
  return *resolver;
}

std::optional<std::string> WindowIdOf(NSWindow* window) {
  if (!window || !Resolver()) return std::nullopt;
  if (std::optional<std::string> id = Resolver().Run(gfx::NativeWindow(window))) return id;
  NSWindow* parent = window.parentWindow;
  return parent ? Resolver().Run(gfx::NativeWindow(parent)) : std::nullopt;
}

std::optional<std::string> KeyWindowId() {
  return WindowIdOf(NSApp.keyWindow ?: NSApp.mainWindow);
}

struct BookmarksSlot {
  NSMenu* menu = nil;
  NSInteger fixed = 0;
};

BookmarksSlot& MainBookmarks() {
  static base::NoDestructor<BookmarksSlot> slot;
  return *slot;
}

std::string StringOf(const base::DictValue& dict, std::string_view key) {
  const std::string* found = dict.FindString(key);
  return found ? *found : std::string();
}

menu::Item ItemOf(const base::Value& value,
                  std::size_t depth,
                  std::vector<menu::Problem>& problems,
                  const std::string& path) {
  menu::Item item;
  const base::DictValue* dict = value.GetIfDict();
  if (!dict) {
    problems.push_back({path, "not an object"});
    return item;
  }
  item.title = StringOf(*dict, "title");
  item.default_title = StringOf(*dict, "defaultTitle");
  item.command = StringOf(*dict, "command");
  item.key = StringOf(*dict, "key");
  item.state_id = StringOf(*dict, "id");
  item.fixed_check = dict->FindBool("fixedCheck").value_or(false);
  if (const base::Value* argument = dict->Find("arg")) {
    if (argument->is_string()) {
      item.argument = argument->GetString();
    } else if (!argument->is_none()) {
      problems.push_back({path, "argument"});
    }
  }
  const std::optional<menu::Role> role = menu::RoleNamed(StringOf(*dict, "role"));
  if (!role) {
    problems.push_back({path, "role"});
  }
  item.role = role.value_or(menu::Role::kNone);
  if (dict->FindBool("separator").value_or(false)) {
    item.role = menu::Role::kSeparator;
  }
  item.enabled = dict->FindBool("enabled").value_or(true);
  item.checked = dict->FindBool("checked").value_or(false);
  const std::optional<int> modifiers = dict->FindInt("modifiers");
  if (modifiers && *modifiers >= 0) {
    item.modifiers = static_cast<std::uint32_t>(*modifiers);
  } else if (modifiers) {
    problems.push_back({path, "modifiers"});
  }
  if (const base::ListValue* children = dict->FindList("children")) {
    if (depth >= menu::kMaxDepth || children->size() > menu::kMaxItems) {
      problems.push_back({path, "too deep"});
      return item;
    }
    for (std::size_t index = 0; index < children->size(); ++index) {
      item.children.push_back(ItemOf((*children)[index], depth + 1, problems,
                                     path + "/" + std::to_string(index)));
    }
  }
  return item;
}

NSString* KeyEquivalent(const std::string& key) {
  if (key.empty()) return @"";
  if (key.size() == 1) {
    return [base::SysUTF8ToNSString(key) lowercaseString];
  }
  const auto character = [](unichar c) { return [NSString stringWithCharacters:&c length:1]; };
  if (key == "Enter") return @"\r";
  if (key == "Escape") return @"\e";
  if (key == "Backspace") return @"\b";
  if (key == "Tab") return @"\t";
  if (key == "Space") return @" ";
  if (key == "Delete") return character(NSDeleteFunctionKey);
  if (key == "Up") return character(NSUpArrowFunctionKey);
  if (key == "Down") return character(NSDownArrowFunctionKey);
  if (key == "Left") return character(NSLeftArrowFunctionKey);
  if (key == "Right") return character(NSRightArrowFunctionKey);
  if (key == "Home") return character(NSHomeFunctionKey);
  if (key == "End") return character(NSEndFunctionKey);
  if (key.size() >= 2 && key[0] == 'F') {
    const int number = std::atoi(key.c_str() + 1);
    if (number >= 1 && number <= 20) {
      return character(static_cast<unichar>(NSF1FunctionKey + number - 1));
    }
  }
  return @"";
}

NSEventModifierFlags Modifiers(std::uint32_t modifiers) {
  NSEventModifierFlags flags = 0;
  if (modifiers & menu::kShift) flags |= NSEventModifierFlagShift;
  if (modifiers & menu::kControl) flags |= NSEventModifierFlagControl;
  if (modifiers & menu::kOption) flags |= NSEventModifierFlagOption;
  if (modifiers & menu::kCommand) flags |= NSEventModifierFlagCommand;
  return flags;
}

NSMenu* BuildMenu(const menu::Item& item, ArdiaMacMenuTarget* target, bool app_menus);

NSMenuItem* BuildItem(const menu::Item& item, ArdiaMacMenuTarget* target, bool app_menus) {
  if (item.role == menu::Role::kSeparator) {
    return [NSMenuItem separatorItem];
  }
  NSMenuItem* entry = [[NSMenuItem alloc] initWithTitle:base::SysUTF8ToNSString(item.title)
                                                 action:nil
                                          keyEquivalent:KeyEquivalent(item.key)];
  entry.keyEquivalentModifierMask = item.key.empty() ? 0 : Modifiers(item.modifiers);
  entry.state = item.checked ? NSControlStateValueOn : NSControlStateValueOff;
  entry.enabled = item.enabled;
  if (!item.children.empty() || menu::HoldsSubmenu(item.role)) {
    NSMenu* submenu = BuildMenu(item, target, app_menus);
    entry.submenu = submenu;
    if (menu::FillsShareServices(item.role, app_menus)) {
      submenu.delegate = ShareMenuFiller();
    }
    if (menu::InstallsAppMenu(item.role, app_menus)) {
      if (item.role == menu::Role::kServices) NSApp.servicesMenu = submenu;
      if (item.role == menu::Role::kWindowMenu) NSApp.windowsMenu = submenu;
      if (item.role == menu::Role::kHelpMenu) NSApp.helpMenu = submenu;
    }
    if (app_menus && item.role == menu::Role::kBookmarksMenu) {
      MainBookmarks().menu = submenu;
      MainBookmarks().fixed = submenu.numberOfItems;
    }
    return entry;
  }
  const std::string_view selector = menu::SelectorFor(item.role);
  if (!selector.empty()) {
    entry.action = NSSelectorFromString(base::SysUTF8ToNSString(std::string(selector)));
    entry.target = nil;
    return entry;
  }
  if (!item.command.empty()) {
    entry.action = @selector(perform:);
    entry.target = target;
    NSMutableDictionary* represented = [@{
      @"command" : base::SysUTF8ToNSString(item.command),
      @"arg" : base::SysUTF8ToNSString(item.argument),
    } mutableCopy];
    if (!item.state_id.empty()) {
      represented[@"state"] = base::SysUTF8ToNSString(item.state_id);
      represented[@"title"] =
          base::SysUTF8ToNSString(item.default_title.empty() ? item.title : item.default_title);
      represented[@"fixed"] = @(item.fixed_check);
      represented[@"checked"] = @(item.checked);
    }
    entry.representedObject = represented;
  }
  return entry;
}

void ApplyState(NSMenu* built, const menu::State& state, std::size_t depth) {
  if (!built || depth > menu::kMaxBookmarkDepth + menu::kMaxDepth) return;
  for (NSMenuItem* item in built.itemArray) {
    if (item.submenu) {
      ApplyState(item.submenu, state, depth + 1);
    }
    NSDictionary* represented = item.representedObject;
    if (![represented isKindOfClass:NSDictionary.class]) continue;
    NSString* state_id = represented[@"state"];
    NSString* title = represented[@"title"];
    if (![state_id isKindOfClass:NSString.class] || ![title isKindOfClass:NSString.class]) continue;
    const menu::Shown shown =
        menu::Resolve(base::SysNSStringToUTF8(state_id), [represented[@"fixed"] boolValue],
                      [represented[@"checked"] boolValue], base::SysNSStringToUTF8(title), state);
    item.enabled = shown.enabled;
    item.state = shown.checked ? NSControlStateValueOn : NSControlStateValueOff;
    NSString* shown_title = base::SysUTF8ToNSString(shown.title);
    if (![item.title isEqualToString:shown_title]) {
      item.title = shown_title;
    }
  }
}

void FillBookmarks(const std::optional<menu::Bookmarks>& known) {
  NSMenu* bookmarks = MainBookmarks().menu;
  if (!bookmarks || !known) return;
  const NSInteger fixed = std::min(MainBookmarks().fixed, bookmarks.numberOfItems);
  while (bookmarks.numberOfItems > fixed) {
    [bookmarks removeItemAtIndex:bookmarks.numberOfItems - 1];
  }
  const std::vector<menu::Item> items = menu::BookmarkMenuItems(*known);
  if (!items.empty() && fixed > 0) {
    [bookmarks addItem:[NSMenuItem separatorItem]];
  }
  for (const menu::Item& item : items) {
    [bookmarks addItem:BuildItem(item, MainTarget(), false)];
  }
}

std::optional<menu::Bookmark> BookmarkOf(const base::Value& value, std::size_t depth, std::size_t& nodes) {
  const base::DictValue* dict = value.GetIfDict();
  if (!dict || depth > menu::kMaxBookmarkDepth + 1 || nodes >= menu::kMaxBookmarkNodes) return std::nullopt;
  ++nodes;
  menu::Bookmark node;
  node.id = StringOf(*dict, "id");
  node.title = StringOf(*dict, "title");
  node.url = StringOf(*dict, "url");
  if (node.url.size() > menu::kMaxUrl) node.url.clear();
  if (const base::ListValue* children = dict->FindList("children")) {
    node.folder = true;
    for (const base::Value& child : *children) {
      if (nodes >= menu::kMaxBookmarkNodes) break;
      if (std::optional<menu::Bookmark> parsed = BookmarkOf(child, depth + 1, nodes)) {
        node.children.push_back(std::move(*parsed));
      }
    }
  }
  return node;
}

std::vector<menu::Bookmark> BookmarkList(const base::DictValue& dict, std::string_view key, std::size_t& nodes) {
  std::vector<menu::Bookmark> list;
  const base::ListValue* values = dict.FindList(key);
  if (!values) return list;
  for (const base::Value& value : *values) {
    if (nodes >= menu::kMaxBookmarkNodes) break;
    if (std::optional<menu::Bookmark> node = BookmarkOf(value, 1, nodes)) {
      list.push_back(std::move(*node));
    }
  }
  return list;
}

NSMenu* BuildMenu(const menu::Item& item, ArdiaMacMenuTarget* target, bool app_menus) {
  NSMenu* built = [[NSMenu alloc] initWithTitle:base::SysUTF8ToNSString(item.title)];
  built.autoenablesItems = NO;
  for (const menu::Item& child : item.children) {
    [built addItem:BuildItem(child, target, app_menus)];
  }
  return built;
}

void BuildBar(const menu::Item& root) {
  MainBookmarks() = BookmarksSlot();
  NSMenu* bar = [[ArdiaMacMainMenu alloc] initWithTitle:@""];
  for (const menu::Item& top : root.children) {
    NSMenuItem* entry = BuildItem(top, MainTarget(), true);
    if (!entry.submenu) {
      entry.submenu = [[NSMenu alloc] initWithTitle:entry.title];
    }
    [bar addItem:entry];
  }
  NSApp.mainMenu = bar;
}

bool ClaimsBar(const std::string& window_id) {
  const std::optional<std::string> key = KeyWindowId();
  return Owner().Claims(window_id, key == window_id, key.has_value());
}

void Present(const WindowMenu& record, bool rebuild) {
  if (rebuild && record.root) {
    BuildBar(*record.root);
  }
  FillBookmarks(record.bookmarks);
  if (record.state) {
    ApplyState(NSApp.mainMenu, *record.state, 0);
  }
}

void ActivateKeyWindow(NSWindow* window) {
  const std::optional<std::string> id = WindowIdOf(window);
  if (!id) return;
  if (!Owner().Activate(*id)) return;
  auto found = WindowMenus().find(*id);
  if (found != WindowMenus().end() && found->second.root) {
    Present(found->second, true);
    return;
  }
  NSString* name = NSRunningApplication.currentApplication.localizedName ?: @"Ardia";
  BuildBar(menu::MinimalMainMenu(base::SysNSStringToUTF8(name)));
}

void WatchKeyWindows() {
  static bool watching = false;
  if (watching) return;
  watching = true;
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  [center addObserverForName:NSWindowDidBecomeKeyNotification
                      object:nil
                       queue:nil
                  usingBlock:^(NSNotification* note) {
                    ActivateKeyWindow(note.object);
                  }];
  [center addObserverForName:NSWindowDidResignKeyNotification
                      object:nil
                       queue:nil
                  usingBlock:^(NSNotification* note) {
                    if (std::optional<std::string> id = WindowIdOf(note.object)) {
                      Suppression().Set(*id, false);
                    }
                  }];
}

void LogMenu(const std::string& what, const menu::Item& root) {
  LOG(WARNING) << "Ardia Mac WebUI: " << what;
  for (const std::string& line : menu::Describe(root)) {
    LOG(WARNING) << "Ardia Mac WebUI:   " << line;
  }
}

}

ParsedMenu ParseMenu(const base::Value& spec) {
  ParsedMenu parsed;
  const base::ListValue* items = spec.GetIfList();
  if (!items) {
    if (const base::DictValue* dict = spec.GetIfDict()) {
      items = dict->FindList("items");
    }
  }
  if (!items) {
    parsed.problems.push_back({"", "items must be a list"});
    return parsed;
  }
  if (items->size() > menu::kMaxItems) {
    parsed.problems.push_back({"", "too many items"});
    return parsed;
  }
  for (std::size_t index = 0; index < items->size(); ++index) {
    parsed.root.children.push_back(
        ItemOf((*items)[index], 1, parsed.problems, "/" + std::to_string(index)));
  }
  std::vector<menu::Problem> more = menu::Validate(parsed.root);
  parsed.problems.insert(parsed.problems.end(), more.begin(), more.end());
  return parsed;
}

std::optional<menu::State> ParseMenuState(const base::Value& update) {
  const base::DictValue* dict = update.GetIfDict();
  if (!dict) return std::nullopt;
  menu::State state;
  const auto read = [dict](std::string_view key, std::set<std::string>& into) {
    const base::ListValue* list = dict->FindList(key);
    if (!list) return;
    for (const base::Value& value : *list) {
      if (value.is_string()) menu::AddStateEntry(into, value.GetString());
    }
  };
  read("disabled", state.disabled);
  read("checked", state.checked);
  if (const base::DictValue* titles = dict->FindDict("titles")) {
    for (const auto [state_id, title] : *titles) {
      if (title.is_string()) menu::AddStateTitle(state, state_id, title.GetString());
    }
  }
  return state;
}

std::optional<menu::Bookmarks> ParseMenuBookmarks(const base::Value& update) {
  const base::DictValue* dict = update.GetIfDict();
  if (!dict) return std::nullopt;
  menu::Bookmarks bookmarks;
  std::size_t nodes = 0;
  bookmarks.recent = BookmarkList(*dict, "recentBookmarks", nodes);
  bookmarks.bar = BookmarkList(*dict, "bookmarksBar", nodes);
  bookmarks.other = BookmarkList(*dict, "otherBookmarks", nodes);
  for (menu::Bookmark& recent : bookmarks.recent) {
    recent.folder = false;
    recent.children.clear();
  }
  return bookmarks;
}

void SetMenuWindowResolver(MenuWindowResolver resolver) {
  Resolver() = std::move(resolver);
  WatchKeyWindows();
}

void SetWindowMainMenu(const std::string& window_id, menu::Item root, MenuCommandHandler handler) {
  MainHandler() = std::move(handler);
  WindowMenu& record = WindowMenus()[window_id];
  record.root = std::move(root);
  if (ClaimsBar(window_id)) {
    Present(record, true);
  }
}

std::optional<std::string> SetWindowMenuState(const std::string& window_id, const base::Value& update) {
  std::optional<menu::State> state = ParseMenuState(update);
  if (!state) return "Menu state must be an object";
  WindowMenu& record = WindowMenus()[window_id];
  record.state = std::move(*state);
  if (ClaimsBar(window_id)) {
    ApplyState(NSApp.mainMenu, *record.state, 0);
  }
  return std::nullopt;
}

std::optional<std::string> SetWindowMenuBookmarks(const std::string& window_id, const base::Value& update) {
  std::optional<menu::Bookmarks> bookmarks = ParseMenuBookmarks(update);
  if (!bookmarks) return "Menu bookmarks must be an object";
  WindowMenu& record = WindowMenus()[window_id];
  record.bookmarks = std::move(*bookmarks);
  if (ClaimsBar(window_id)) {
    Present(record, false);
  }
  return std::nullopt;
}

void ForgetWindowMenu(const std::string& window_id) {
  WindowMenus().erase(window_id);
  Suppression().Set(window_id, false);
  Owner().Forget(window_id);
}

void SetMenuKeysSuppressed(const std::string& window_id, bool suppressed) {
  Suppression().Set(window_id, suppressed);
}

std::optional<std::string> KeyMenuWindowId() {
  return KeyWindowId();
}

bool MenuKeysSuppressed() {
  return !Suppression().empty() && Suppression().Suppresses(KeyWindowId());
}

void InstallMainMenu(const menu::Item& root, MenuCommandHandler handler) {
  MainHandler() = std::move(handler);
  BuildBar(root);
}

void InstallDefaultMainMenu(MenuCommandHandler handler) {
  NSString* name = NSRunningApplication.currentApplication.localizedName ?: @"Ardia";
  InstallMainMenu(menu::DefaultMainMenu(base::SysNSStringToUTF8(name)), std::move(handler));
}

void PopUpContextMenu(LiveMenuView live_view,
                      gfx::Point point,
                      NSMenu* built,
                      ArdiaMacMenuTarget* target,
                      ContextMenuDone done) {
  NSView* view = std::move(live_view).Run().GetNativeNSView();
  if (!view || !view.window) {
    std::move(done).Run(std::nullopt);
    return;
  }
  const NSPoint location =
      NSMakePoint(point.x(), view.isFlipped ? point.y() : NSHeight(view.bounds) - point.y());
  {
    base::CurrentThread::ScopedAllowApplicationTasksInNativeNestedLoop allow;
    [built popUpMenuPositioningItem:nil atLocation:location inView:view];
  }
  NSDictionary* chosen = target.chosen;
  if (!chosen) {
    std::move(done).Run(std::nullopt);
    return;
  }
  std::move(done).Run(MenuChoice{base::SysNSStringToUTF8(chosen[@"command"]),
                                 base::SysNSStringToUTF8(chosen[@"arg"])});
}

void ShowContextMenu(LiveMenuView live_view,
                     const gfx::Point& point,
                     const menu::Item& root,
                     bool background_instance,
                     ContextMenuDone done) {
  if (background_instance) {
    LogMenu("context menu (background, not shown)", root);
    std::move(done).Run(std::nullopt);
    return;
  }
  ArdiaMacMenuTarget* target = [[ArdiaMacMenuTarget alloc] init];
  target.forContextMenu = YES;
  NSMenu* built = BuildMenu(root, target, false);
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&PopUpContextMenu, std::move(live_view), point,
                                built, target, std::move(done)));
}

}

@implementation ArdiaMacShareMenuFiller

- (NSMenuItem*)shareItem:(NSString*)title service:(std::string_view)service {
  NSMenuItem* item = [[NSMenuItem alloc] initWithTitle:title action:@selector(perform:) keyEquivalent:@""];
  item.target = ardia_mac::MainTarget();
  item.tag = ardia_mac::kShareServiceTag;
  item.representedObject = @{
    @"command" : base::SysUTF8ToNSString(std::string(ardia_mac::menu::kShareCommand)),
    @"arg" : base::SysUTF8ToNSString(ardia_mac::menu::ShareArgument(service)),
  };
  return item;
}

- (void)openSharingSettings:(id)sender {
  ardia_mac::share::OpenSharingSettingsFromMenu();
}

- (void)menuNeedsUpdate:(NSMenu*)menu {
  for (NSInteger index = menu.numberOfItems - 1; index >= 0; --index) {
    if ([menu itemAtIndex:index].tag == ardia_mac::kShareServiceTag) {
      [menu removeItemAtIndex:index];
    }
  }
  const std::vector<ardia_mac::share::Service> services = ardia_mac::share::LinkServices();
  NSInteger at = 0;
  for (const ardia_mac::share::Service& service : services) {
    [menu insertItem:[self shareItem:base::SysUTF8ToNSString(service.menu_title) service:service.title] atIndex:at++];
  }
  if (!services.empty()) {
    NSMenuItem* gap = [NSMenuItem separatorItem];
    gap.tag = ardia_mac::kShareServiceTag;
    [menu insertItem:gap atIndex:at];
  }
  NSMenuItem* more = [[NSMenuItem alloc] initWithTitle:@"More\u2026" action:@selector(openSharingSettings:) keyEquivalent:@""];
  more.target = self;
  more.tag = ardia_mac::kShareServiceTag;
  more.image = [NSImage imageWithSystemSymbolName:@"ellipsis.circle" accessibilityDescription:nil];
  [menu addItem:more];
}

@end

@implementation ArdiaMacMainMenu

- (BOOL)performKeyEquivalent:(NSEvent*)event {
  if (ardia_mac::MenuKeysSuppressed()) {
    return NO;
  }
  return [super performKeyEquivalent:event];
}

@end

@implementation ArdiaMacMenuTarget

@synthesize chosen = _chosen;
@synthesize forContextMenu = _forContextMenu;

- (void)perform:(NSMenuItem*)item {
  NSDictionary* represented = item.representedObject;
  if (![represented isKindOfClass:NSDictionary.class]) {
    return;
  }
  if (self.forContextMenu) {
    self.chosen = represented;
    return;
  }
  const ardia_mac::MenuCommandHandler& handler = ardia_mac::MainHandler();
  if (handler) {
    handler.Run(ardia_mac::MenuChoice{base::SysNSStringToUTF8(represented[@"command"]),
                                      base::SysNSStringToUTF8(represented[@"arg"])});
  }
}

@end
