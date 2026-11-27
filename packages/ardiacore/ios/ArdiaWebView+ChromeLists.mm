#import "ArdiaWebViewInternal.h"

using namespace ardia_web_view;

@interface ApplePasswordsProfiles : NSObject
+ (BOOL)containsProfile:(NSString *)profile;
@end

@implementation ArdiaWebView (ChromeLists)

+ (void)applePasswordsProfilesChanged {
  for (ArdiaWebView *view in LiveViews().allObjects) [view pushChromeLists];
}

- (void)pushChromeLists {
  ArdiaCoreTab *tab = _tab;
  if (!tab || ![tab respondsToSelector:@selector(setSuppressedAutofillKinds:)]) return;
  NSSet<NSString *> *kinds = [ApplePasswordsProfiles containsProfile:_profile ?: @""] ? [NSSet setWithObject:@"login"] : [NSSet set];
  if ([tab.suppressedAutofillKinds isEqualToSet:kinds] && !tab.suppressedAutofillLogins) return;
  tab.suppressedAutofillLogins = nil;
  tab.suppressedAutofillKinds = kinds;
}

@end
