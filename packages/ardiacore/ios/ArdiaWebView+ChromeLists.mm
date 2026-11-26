#import "ArdiaWebViewInternal.h"

using namespace ardia_web_view;

namespace {

NSMutableSet<NSString *> *ChromeListsHiddenProfiles() {
  static NSMutableSet<NSString *> *profiles = [NSMutableSet set];
  return profiles;
}

BOOL ChromeListsHiddenFor(NSString *profile) {
  return [ChromeListsHiddenProfiles() containsObject:ardia_host::OriginalProfileName(profile ?: @"")];
}

}

@implementation ArdiaWebView (ChromeLists)

+ (void)hideChromeListsInProfiles:(NSArray<NSString *> *)profiles {
  NSMutableSet<NSString *> *next = [NSMutableSet set];
  for (id profile in profiles)
    if ([profile isKindOfClass:NSString.class]) [next addObject:ardia_host::OriginalProfileName(profile)];
  if ([next isEqualToSet:ChromeListsHiddenProfiles()]) return;
  [ChromeListsHiddenProfiles() setSet:next];
  for (ArdiaWebView *view in LiveViews().allObjects) [view pushChromeLists];
}

- (void)pushChromeLists {
  ArdiaCoreTab *tab = _tab;
  if (!tab || ![tab respondsToSelector:@selector(setSuppressedAutofillKinds:)]) return;
  NSSet<NSString *> *kinds = ChromeListsHiddenFor(_profile) ? [NSSet setWithObject:@"login"] : [NSSet set];
  if ([tab.suppressedAutofillKinds isEqualToSet:kinds] && !tab.suppressedAutofillLogins) return;
  tab.suppressedAutofillLogins = nil;
  tab.suppressedAutofillKinds = kinds;
}

@end
