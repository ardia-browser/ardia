#import "ArdiaWebView+VaultContextMenu.h"
#import "ArdiaWebView+VaultCodeSetup.h"
#import "ArdiaWebViewInternal.h"
#import "ArdiaRuntime.h"

#import <objc/runtime.h>

#include <cmath>

using namespace ardia_web_view;

namespace {

constexpr CFTimeInterval kContextFieldFreshSeconds = 2;
constexpr NSUInteger kMaxMenuLogins = 12;
constexpr NSUInteger kMaxGenerators = 8;

NSString *const kAutofillTitle = @"Autofill";
NSString *const kGenerateTitle = @"Generate Password";
NSString *const kOtherTitle = @"Other Passwords…";
NSString *const kPathSeparator = @" › ";
NSString *const kSelectAllTitle = @"Select All";

BOOL gContextAutofill = NO;
BOOL gContextGenerateAnyField = NO;
NSArray<NSDictionary<NSString *, NSString *> *> *gContextGenerators = nil;
char kVaultContextKey;

NSArray<NSString *> *ContextChoices() { return @[ @"username", @"password", @"otp" ]; }

NSDictionary<NSString *, NSString *> *ContextChoiceTitles() {
  return @{@"username" : @"Username", @"password" : @"Password", @"otp" : @"Verification Code"};
}

NSArray<NSString *> *GeneratorStyles() { return @[ @"strong", @"alphanumeric", @"easyToType", @"passphrase" ]; }

NSDictionary *ContextLogin(NSDictionary *login) {
  NSString *key = Text(login, @"key", 512);
  NSString *title = Text(login, @"title", 200);
  if (!key.length || !title.length) return nil;
  NSMutableArray<NSString *> *fields = [NSMutableArray array];
  for (id field in Field<NSArray>(login, @"fields") ?: @[])
    if ([field isKindOfClass:NSString.class] && [ContextChoices() containsObject:field] && ![fields containsObject:field]) [fields addObject:field];
  return fields.count ? @{@"key" : key, @"title" : title, @"fields" : fields} : nil;
}

NSMenuItem *FindPath(NSArray<NSMenuItem *> *items, NSArray<NSString *> *path) {
  NSMenuItem *found = nil;
  for (NSString *title in path) {
    found = nil;
    for (NSMenuItem *item in items)
      if (!item.isSeparatorItem && [item.title isEqualToString:title]) {
        found = item;
        break;
      }
    if (!found) return nil;
    items = found.submenu.itemArray ?: @[];
  }
  return found;
}

NSMenuItem *FindTitle(NSArray<NSMenuItem *> *items, NSString *title) {
  for (NSMenuItem *item in items) {
    if (!item.isSeparatorItem && [item.title isEqualToString:title] && item.action) return item;
    if (NSMenuItem *inner = FindTitle(item.submenu.itemArray ?: @[], title)) return inner;
  }
  return nil;
}

}

@interface ArdiaVaultContext : NSObject
@property(nonatomic, copy) NSString *frameId;
@property(nonatomic, copy) NSString *origin;
@property(nonatomic) CFTimeInterval at;
@property(nonatomic) BOOL shown;
@property(nonatomic) BOOL secure;
@property(nonatomic) BOOL passwordField;
@property(nonatomic, copy) NSDictionary *model;
@property(nonatomic, weak) ArdiaWebView *view;
@property(nonatomic, strong) NSHashTable<NSMenu *> *autofillMenus;
@property(nonatomic, strong) NSArray<NSMenuItem *> *topItems;
@property(nonatomic, copy) NSArray<NSString *> *pendingPick;
@property(nonatomic, copy) void (^redump)(NSArray<NSDictionary *> *described);
@end

@implementation ArdiaVaultContext

- (instancetype)init {
  if ((self = [super init])) _autofillMenus = [NSHashTable weakObjectsHashTable];
  return self;
}

- (void)fillAutofillMenu:(NSMenu *)menu {
  [menu removeAllItems];
  NSDictionary *model = self.model;
  if (!model) {
    [menu addItem:ArdiaVaultMenuNote(ArdiaVaultLoadingTitle)];
    return;
  }
  for (NSDictionary *login in model[@"logins"]) {
    NSMenuItem *row = [[NSMenuItem alloc] initWithTitle:login[@"title"] action:nil keyEquivalent:@""];
    NSMenu *choices = ArdiaVaultSubmenu(login[@"title"]);
    for (NSString *field in ContextChoices())
      if ([login[@"fields"] containsObject:field])
        [choices addItem:ArdiaVaultMenuChoice(ContextChoiceTitles()[field], self, @{@"action" : @"fill", @"login" : login[@"key"], @"field" : field})];
    row.submenu = choices;
    [menu addItem:row];
  }
  if ([model[@"note"] isKindOfClass:NSString.class]) [menu addItem:ArdiaVaultMenuNote(model[@"note"])];
  const BOOL unlock = Flag(model, @"unlock"), other = Flag(model, @"other");
  if ((unlock || other) && menu.numberOfItems) [menu addItem:NSMenuItem.separatorItem];
  if (unlock) [menu addItem:ArdiaVaultMenuChoice(ArdiaVaultUnlockTitle, self, @{@"action" : @"unlock"})];
  if (other) [menu addItem:ArdiaVaultMenuChoice(kOtherTitle, self, @{@"action" : @"other"})];
  if (!menu.numberOfItems) [menu addItem:ArdiaVaultMenuNote(ArdiaVaultLoadingTitle)];
}

- (NSArray<NSMenuItem *> *)makeTopItems {
  NSMutableArray<NSMenuItem *> *items = [NSMutableArray array];
  if (gContextAutofill) {
    NSMenuItem *autofill = [[NSMenuItem alloc] initWithTitle:kAutofillTitle action:nil keyEquivalent:@""];
    NSMenu *menu = ArdiaVaultSubmenu(kAutofillTitle);
    [self fillAutofillMenu:menu];
    [self.autofillMenus addObject:menu];
    autofill.submenu = menu;
    [items addObject:autofill];
  }
  if (gContextGenerators.count && self.secure && (self.passwordField || gContextGenerateAnyField)) {
    NSMenuItem *generate = [[NSMenuItem alloc] initWithTitle:kGenerateTitle action:nil keyEquivalent:@""];
    NSMenu *menu = ArdiaVaultSubmenu(kGenerateTitle);
    for (NSDictionary<NSString *, NSString *> *style in gContextGenerators)
      [menu addItem:ArdiaVaultMenuChoice(style[@"title"], self, @{@"action" : @"generate", @"style" : style[@"style"]})];
    generate.submenu = menu;
    [items addObject:generate];
  }
  self.topItems = items;
  return items;
}

- (void)choose:(NSMenuItem *)sender {
  NSDictionary *action = [sender.representedObject isKindOfClass:NSDictionary.class] ? sender.representedObject : nil;
  ArdiaWebView *view = self.view;
  if (!action || !view) return;
  NSMutableDictionary *payload = [action mutableCopy];
  payload[@"frameId"] = self.frameId;
  payload[@"origin"] = self.origin;
  dispatch_async(dispatch_get_main_queue(), ^{
    [view emit:@"vaultContextAction" payload:payload];
  });
}

- (BOOL)pick:(NSArray<NSString *> *)path {
  NSMenuItem *item = path.count > 1 ? FindPath(self.topItems, path) : FindTitle(self.topItems, path.firstObject ?: @"");
  if (!item.action || !item.enabled) return NO;
  [self choose:item];
  return YES;
}

- (void)adoptModel:(NSDictionary *)model {
  self.model = model;
  for (NSMenu *menu in self.autofillMenus.allObjects) [self fillAutofillMenu:menu];
  if (self.redump) self.redump([self.view describeVaultContextItems:self.view.shownVaultContextItems]);
  NSArray<NSString *> *pending = self.pendingPick;
  self.pendingPick = nil;
  if (pending) [self pick:pending];
}

@end

namespace {

ArdiaWebView *WebViewAbove(NSView *view) {
  for (NSView *at = view; at; at = at.superview)
    if ([at isKindOfClass:ArdiaWebView.class]) return (ArdiaWebView *)at;
  return nil;
}

void AddVaultContextItems(NSMenu *menu, NSView *view) {
  NSArray<NSMenuItem *> *items = [WebViewAbove(view) takeVaultContextMenuItems];
  if (!items.count) return;
  NSMutableArray<NSString *> *titles = [NSMutableArray arrayWithCapacity:menu.numberOfItems];
  for (NSMenuItem *item in menu.itemArray) [titles addObject:item.isSeparatorItem ? @"" : item.title];
  NSInteger at = (NSInteger)ArdiaVaultContextIndex(titles);
  if (at > 0) [menu insertItem:NSMenuItem.separatorItem atIndex:at++];
  for (NSMenuItem *item in items) [menu insertItem:item atIndex:at++];
  if (menu.numberOfItems > at && ![menu itemAtIndex:at].isSeparatorItem) [menu insertItem:NSMenuItem.separatorItem atIndex:at];
}

BOOL gPoppingUpContextMenu = NO;

void PopUpWithVaultItems(NSMenu *menu, NSView *view, void (^popUp)(void)) {
  if (gPoppingUpContextMenu) return popUp();
  gPoppingUpContextMenu = YES;
  AddVaultContextItems(menu, view);
  popUp();
  gPoppingUpContextMenu = NO;
}

void InstallVaultContextMenuHook() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class menuClass = object_getClass(NSMenu.class);
    SEL selector = @selector(popUpContextMenu:withEvent:forView:);
    ardia_runtime::ReplaceMethod(menuClass, selector, ^id(IMP original) {
      return ^(id menus, NSMenu *menu, NSEvent *event, NSView *view) {
        PopUpWithVaultItems(menu, view, ^{
          ((void (*)(id, SEL, NSMenu *, NSEvent *, NSView *))original)(menus, selector, menu, event, view);
        });
      };
    });
    SEL withFont = @selector(popUpContextMenu:withEvent:forView:withFont:);
    ardia_runtime::ReplaceMethod(menuClass, withFont, ^id(IMP original) {
      return ^(id menus, NSMenu *menu, NSEvent *event, NSView *view, NSFont *font) {
        PopUpWithVaultItems(menu, view, ^{
          ((void (*)(id, SEL, NSMenu *, NSEvent *, NSView *, NSFont *))original)(menus, withFont, menu, event, view, font);
        });
      };
    });
  });
}

}

NSString *const ArdiaVaultLoadingTitle = @"Loading…";
NSString *const ArdiaVaultUnlockTitle = @"Unlock Passwords…";

NSUInteger ArdiaVaultContextIndex(NSArray<NSString *> *titles) {
  const NSUInteger selectAll = [titles indexOfObject:kSelectAllTitle];
  return selectAll == NSNotFound ? 0 : selectAll + 1;
}

NSArray<NSString *> *ArdiaVaultFieldKinds() { return @[ @"username", @"password", @"newPassword", @"otp" ]; }

bool ArdiaVaultSecureOrigin(NSString *origin) {
  if ([origin hasPrefix:@"https://"]) return true;
  for (NSString *local in @[ @"http://localhost", @"http://127.0.0.1", @"http://[::1]" ])
    if ([origin isEqualToString:local] || [origin hasPrefix:[local stringByAppendingString:@":"]]) return true;
  return false;
}

NSDictionary *ArdiaVaultRect(NSDictionary *rect) {
  double x, y, width, height;
  if (!Finite(rect, @"x", &x) || !Finite(rect, @"y", &y) || !Finite(rect, @"width", &width) || !Finite(rect, @"height", &height)) return nil;
  return @{@"x" : @(x), @"y" : @(y), @"width" : @(width), @"height" : @(height)};
}

NSInteger ArdiaVaultMaxLength(NSDictionary *d) {
  double value;
  if (!Finite(d, @"maxLength", &value) || value <= 0) return 0;
  return (NSInteger)floor(MIN(value, (double)kArdiaVaultLongestValue));
}

NSArray<NSString *> *ArdiaVaultMenuPath(NSString *pick) {
  NSMutableArray<NSString *> *path = [NSMutableArray array];
  for (NSString *part in [pick componentsSeparatedByString:kPathSeparator]) {
    NSString *trimmed = [part stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if (trimmed.length) [path addObject:trimmed];
  }
  return path;
}

NSDictionary *ArdiaVaultMenuModel(NSDictionary *menu, NSDictionary *(*login)(NSDictionary *value)) {
  NSMutableArray *logins = [NSMutableArray array];
  for (id value in Field<NSArray>(menu, @"logins") ?: @[]) {
    if (logins.count >= kMaxMenuLogins) break;
    if (NSDictionary *parsed = login([value isKindOfClass:NSDictionary.class] ? value : nil)) [logins addObject:parsed];
  }
  NSString *note = Text(menu, @"note", 200);
  return @{@"logins" : logins, @"unlock" : @(Flag(menu, @"unlock")), @"other" : @(Flag(menu, @"other")), @"note" : note.length ? note : NSNull.null};
}

NSMenu *ArdiaVaultSubmenu(NSString *title) {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:title];
  menu.autoenablesItems = NO;
  return menu;
}

NSMenuItem *ArdiaVaultMenuNote(NSString *title) {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
  item.enabled = NO;
  return item;
}

NSMenuItem *ArdiaVaultMenuChoice(NSString *title, id target, NSDictionary *action) {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(choose:) keyEquivalent:@""];
  item.target = target;
  item.representedObject = action;
  return item;
}

@implementation ArdiaWebView (VaultContextMenu)

+ (void)setVaultContextAutofill:(BOOL)autofill generators:(NSArray<NSDictionary<NSString *, id> *> *)generators anyField:(BOOL)anyField {
  NSMutableArray<NSDictionary<NSString *, NSString *> *> *kept = [NSMutableArray array];
  for (NSDictionary *generator in generators) {
    NSString *style = Text(generator, @"style", 32);
    NSString *title = Text(generator, @"title", 120);
    if (kept.count < kMaxGenerators && title.length && [GeneratorStyles() containsObject:style ?: @""]) [kept addObject:@{@"style" : style, @"title" : title}];
  }
  gContextAutofill = autofill;
  gContextGenerators = kept;
  gContextGenerateAnyField = anyField;
  if (autofill || kept.count) InstallVaultContextMenuHook();
}

+ (void)ensureVaultContextMenuHook {
  InstallVaultContextMenuHook();
}

- (ArdiaVaultContext *)vaultContext {
  return objc_getAssociatedObject(self, &kVaultContextKey);
}

- (void)noteVaultContext:(NSDictionary *)dict frame:(NSString *)frameId main:(BOOL)main origin:(NSString *)origin {
  const BOOL offered = gContextAutofill || gContextGenerators.count;
  if (!Flag(dict, @"field") || !offered || !frameId.length || !origin.length) {
    objc_setAssociatedObject(self, &kVaultContextKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return;
  }
  ArdiaVaultContext *context = [ArdiaVaultContext new];
  context.frameId = frameId;
  context.origin = origin;
  context.at = CACurrentMediaTime();
  context.view = self;
  context.secure = ArdiaVaultSecureOrigin(origin);
  NSString *kind = Text(dict, @"kind", 16);
  NSString *guess = Text(dict, @"guess", 16);
  if (![ContextChoices() containsObject:guess ?: @""]) guess = @"username";
  context.passwordField = [guess isEqualToString:@"password"];
  objc_setAssociatedObject(self, &kVaultContextKey, context, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  NSDictionary *rect = main ? ArdiaVaultRect(Field<NSDictionary>(dict, @"rect")) : nil;
  [self emit:@"vaultContext"
      payload:@{
        @"frameId" : frameId,
        @"origin" : origin,
        @"main" : @(main),
        @"kind" : [ArdiaVaultFieldKinds() containsObject:kind ?: @""] ? kind : NSNull.null,
        @"guess" : guess,
        @"rect" : rect ?: NSNull.null,
        @"maxLength" : @(ArdiaVaultMaxLength(dict)),
      }];
}

- (NSArray<NSMenuItem *> *)takeVaultContextMenuItems {
  NSArray<NSMenuItem *> *items = [[self takeVaultFillMenuItems] arrayByAddingObjectsFromArray:[self takeVaultCodeMenuItems]];
  [self noteShownVaultContextItems:items];
  return items;
}

- (NSArray<NSMenuItem *> *)takeVaultFillMenuItems {
  ArdiaVaultContext *context = self.vaultContext;
  if (!context || context.shown || CACurrentMediaTime() - context.at > kContextFieldFreshSeconds) return @[];
  context.shown = YES;
  return [context makeTopItems];
}

- (void)setVaultContextMenuInFrame:(NSString *)frameId origin:(NSString *)origin menu:(NSDictionary<NSString *, id> *)menu {
  ArdiaVaultContext *context = self.vaultContext;
  if (!context || ![context.frameId isEqualToString:frameId] || ![context.origin isEqualToString:origin]) return;
  [context adoptModel:ArdiaVaultMenuModel(menu, ContextLogin)];
}

- (BOOL)pickVaultContextMenu:(NSString *)pick redump:(void (^)(NSArray<NSDictionary *> *described))redump {
  if ([self pickVaultCodeMenu:pick redump:redump]) return YES;
  ArdiaVaultContext *context = self.vaultContext;
  if (!context.topItems.count) return NO;
  context.redump = redump;
  NSArray<NSString *> *path = ArdiaVaultMenuPath(pick ?: @"");
  if (!path.count) return NO;
  if ([context pick:path]) return YES;
  const BOOL autofillPath = path.count > 1 && [path.firstObject isEqualToString:kAutofillTitle];
  if (!autofillPath || context.model) return NO;
  context.pendingPick = path;
  return YES;
}

- (NSArray<NSDictionary *> *)describeVaultContextItems:(NSArray<NSMenuItem *> *)items {
  constexpr int kCommand = 0, kSeparator = 3, kSubmenu = 5;
  NSMutableArray<NSDictionary *> *described = [NSMutableArray array];
  for (NSMenuItem *item in items) {
    NSMutableDictionary *entry = [@{
      @"id" : @0,
      @"label" : item.isSeparatorItem ? @"" : [item.title stringByReplacingOccurrencesOfString:@"&" withString:@"&&"],
      @"enabled" : @(item.isSeparatorItem || item.enabled),
      @"visible" : @YES,
      @"type" : @(item.isSeparatorItem ? kSeparator : item.submenu ? kSubmenu : kCommand),
    } mutableCopy];
    if (item.submenu) entry[@"submenu"] = [self describeVaultContextItems:item.submenu.itemArray];
    [described addObject:entry];
  }
  return described;
}

@end
