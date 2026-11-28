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
  [self pushLoginList];
  NoteEvent(ardia_host::BrowserId(tab), @"chromeLists",
            @{@"profile" : _profile ?: @"", @"claimed" : @([ApplePasswordsProfiles containsProfile:_profile ?: @""]), @"engineHook" : @([tab respondsToSelector:@selector(setSuppressedAutofillKinds:)])});
  [self pushClaimedAutofillKinds];
}

- (void)pushClaimedAutofillKinds {
  ArdiaCoreTab *tab = _tab;
  if (![tab respondsToSelector:@selector(setSuppressedAutofillKinds:)]) return;
  const BOOL claims = [ApplePasswordsProfiles containsProfile:_profile ?: @""];
  const BOOL signIn = [_loginList.field[@"signIn"] boolValue];
  NSSet<NSString *> *kinds = !claims ? [NSSet set] : signIn ? [NSSet setWithObjects:@"login", @"address", @"history", nil] : [NSSet setWithObject:@"login"];
  if ([tab.suppressedAutofillKinds isEqualToSet:kinds] && !tab.suppressedAutofillLogins) return;
  tab.suppressedAutofillLogins = nil;
  tab.suppressedAutofillKinds = kinds;
}

@end
