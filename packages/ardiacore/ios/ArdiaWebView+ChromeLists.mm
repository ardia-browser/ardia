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
  if (!tab) return;
  const BOOL claims = [ApplePasswordsProfiles containsProfile:_profile ?: @""];
  const BOOL engineHasHook = [tab respondsToSelector:@selector(setSuppressedAutofillKinds:)];
  NoteEvent(ardia_host::BrowserId(tab), @"chromeLists", @{@"profile" : _profile ?: @"", @"claimed" : @(claims), @"engineHook" : @(engineHasHook)});
  if (!engineHasHook) return;
  NSSet<NSString *> *kinds = claims ? [NSSet setWithObject:@"login"] : [NSSet set];
  if ([tab.suppressedAutofillKinds isEqualToSet:kinds] && !tab.suppressedAutofillLogins) return;
  tab.suppressedAutofillLogins = nil;
  tab.suppressedAutofillKinds = kinds;
}

@end
