#import "ArdiaWebViewInternal.h"
#import "ArdiaInternal.h"
#import "ArdiaHost.h"

#include <map>
#include <string>

using namespace ardia_web_view;

namespace {

struct DropdownClaim {
  NSSet<NSString *> *kinds;
  NSSet<NSString *> *logins;
};

struct ShownDropdown {
  NSArray<NSString *> *kinds;
  NSArray<NSString *> *logins;
};

std::map<std::string, DropdownClaim> &DropdownClaims() {
  static std::map<std::string, DropdownClaim> claims;
  return claims;
}

std::map<std::string, ShownDropdown> &ShownDropdowns() {
  static std::map<std::string, ShownDropdown> shown;
  return shown;
}

std::string TabKey(NSString *tabId) { return tabId.UTF8String ?: ""; }

NSString *DropdownKindOf(NSString *type) {
  if ([type isEqualToString:@"kUndoOrClear"]) return nil;
  if ([type containsString:@"Webauthn"] || [type containsString:@"Passkey"]) return @"passkey";
  if ([type containsString:@"Password"]) return @"login";
  if ([type isEqualToString:@"kAutocompleteEntry"]) return @"history";
  if ([type containsString:@"CreditCard"] || [type containsString:@"Iban"]) return @"card";
  if ([type containsString:@"Address"]) return @"address";
  return @"other";
}

NSArray<NSString *> *DropdownKinds(NSArray<NSDictionary<NSString *, NSString *> *> *items) {
  NSMutableOrderedSet<NSString *> *kinds = [NSMutableOrderedSet orderedSet];
  for (NSDictionary<NSString *, NSString *> *item in items)
    if (NSString *kind = DropdownKindOf(Field<NSString>(item, @"type") ?: @"")) [kinds addObject:kind];
  return kinds.array;
}

BOOL IsSavedLogin(NSString *type) { return [type isEqualToString:@"kPasswordEntry"] || [type isEqualToString:@"kAccountStoragePasswordEntry"]; }

NSArray<NSString *> *DropdownLogins(NSArray<NSDictionary<NSString *, NSString *> *> *items) {
  NSMutableOrderedSet<NSString *> *logins = [NSMutableOrderedSet orderedSet];
  for (NSDictionary<NSString *, NSString *> *item in items)
    if (IsSavedLogin(Field<NSString>(item, @"type") ?: @"")) [logins addObject:(Field<NSString>(item, @"label") ?: @"").lowercaseString];
  return logins.array;
}

BOOL Claims(NSString *tabId, NSArray<NSString *> *kinds, NSArray<NSString *> *logins) {
  auto found = DropdownClaims().find(TabKey(tabId));
  if (found == DropdownClaims().end() || !kinds.count) return NO;
  const DropdownClaim &claim = found->second;
  if (![[NSSet setWithArray:kinds] isSubsetOfSet:claim.kinds]) return NO;
  return !claim.logins || [[NSSet setWithArray:logins] isSubsetOfSet:claim.logins];
}

void ApplyClaimToEngine(ArdiaCoreTab *tab, NSString *tabId) {
  if (!tab || ![tab respondsToSelector:NSSelectorFromString(@"setSuppressedAutofillLogins:")]) return;
  auto found = DropdownClaims().find(TabKey(tabId));
  BOOL claimed = found != DropdownClaims().end();
  [tab setValue:claimed ? found->second.logins : nil forKey:@"suppressedAutofillLogins"];
  [tab setValue:claimed ? found->second.kinds : [NSSet set] forKey:@"suppressedAutofillKinds"];
}

NSWindow *ChromeDropdownWindow(NSWindow *window) {
  for (NSWindow *child in window.childWindows)
    if (child.visible && [NSStringFromClass(child.class) hasPrefix:@"NativeWidgetMac"]) return child;
  return nil;
}

NSView *PageWidgetView(NSView *root) {
  static Class widgetClass = NSClassFromString(@"RenderWidgetHostViewCocoa");
  NSMutableArray<NSView *> *queue = [NSMutableArray arrayWithObject:root];
  while (queue.count) {
    NSView *view = queue.firstObject;
    [queue removeObjectAtIndex:0];
    if ([view isKindOfClass:widgetClass]) return view;
    [queue addObjectsFromArray:view.subviews];
  }
  return nil;
}

NSEvent *EscapeKey(NSWindow *window, NSEventType type) {
  return [NSEvent keyEventWithType:type location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
                      windowNumber:window.windowNumber context:nil characters:@"\x1b" charactersIgnoringModifiers:@"\x1b"
                         isARepeat:NO keyCode:53];
}

__weak NSWindow *gClosingDropdown;

BOOL CloseChromeDropdown(ArdiaCoreTab *tab) {
  NSWindow *window = tab.view.window;
  NSView *page = tab.view ? PageWidgetView(tab.view) : nil;
  NSWindow *dropdown = window ? ChromeDropdownWindow(window) : nil;
  if (!page || !dropdown) return NO;
  if (dropdown == gClosingDropdown) return YES;
  gClosingDropdown = dropdown;
  [page keyDown:EscapeKey(window, NSEventTypeKeyDown)];
  [page keyUp:EscapeKey(window, NSEventTypeKeyUp)];
  return YES;
}

}

namespace ardia_host {

void ApplyChromeDropdownClaim(ArdiaCoreTab *tab, NSString *tabId) {
  if (tabId.length) ApplyClaimToEngine(tab, tabId);
}

NSDictionary<NSString *, id> *NoteChromeDropdown(ArdiaCoreTab *tab, NSString *tabId, NSArray<NSDictionary<NSString *, NSString *> *> *items) {
  NSArray<NSString *> *kinds = DropdownKinds(items);
  NSArray<NSString *> *logins = DropdownLogins(items);
  ShownDropdowns()[TabKey(tabId)] = {kinds, logins};
  ApplyClaimToEngine(tab, tabId);
  BOOL hidden = Claims(tabId, kinds, logins) && CloseChromeDropdown(tab);
  return @{@"kinds" : kinds, @"logins" : logins, @"hidden" : @(hidden)};
}

}

@implementation ArdiaHost (ChromeDropdowns)

+ (NSDictionary<NSString *, id> *)claimChromeDropdowns:(NSArray<NSString *> *)kinds
                                            usernames:(NSArray<NSString *> *)usernames
                                                tabId:(NSString *)tabId {
  if (kinds.count) {
    NSMutableSet<NSString *> *names = nil;
    if (usernames) {
      names = [NSMutableSet set];
      for (NSString *name in usernames) [names addObject:name.lowercaseString];
    }
    DropdownClaims()[TabKey(tabId)] = {[NSSet setWithArray:kinds], names};
  } else {
    DropdownClaims().erase(TabKey(tabId));
    ShownDropdowns().erase(TabKey(tabId));
  }
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  ApplyClaimToEngine(tab, tabId);
  BOOL up = tab.view.window && ChromeDropdownWindow(tab.view.window);
  auto shown = ShownDropdowns().find(TabKey(tabId));
  NSArray<NSString *> *showing = up && shown != ShownDropdowns().end() ? shown->second.kinds : @[];
  NSArray<NSString *> *logins = up && shown != ShownDropdowns().end() ? shown->second.logins : @[];
  BOOL hidden = tab && Claims(tabId, showing, logins) && CloseChromeDropdown(tab);
  return @{@"hidden" : @(hidden), @"showing" : hidden ? @[] : showing, @"logins" : hidden ? @[] : logins};
}

@end
