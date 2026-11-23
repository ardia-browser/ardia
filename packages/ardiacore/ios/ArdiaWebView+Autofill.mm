#import "ArdiaWebViewInternal.h"
#import "ArdiaInternal.h"
#import "ArdiaVaultCapture.h"

using namespace ardia_web_view;

@implementation ArdiaWebView (Autofill)

- (void)tab:(ArdiaCoreTab *)tab didFocusAutofillField:(NSDictionary<NSString *, id> *)field {
  NSString *tabId = ardia_host::AppTabIdOf(tab);
  if (!tabId.length || ![field isKindOfClass:NSDictionary.class]) return;
  const BOOL focused = ![field[@"focused"] isEqual:@NO];
  [ArdiaVaultCaptureOfTab(tab) noteAutofillFieldInFrame:Field<NSString>(field, @"frame")
                                                  origin:VerifiedOrigin(Field<NSString>(field, @"origin"))
                                                     top:OriginOf(tab.url)
                                                 focused:focused];
  NSMutableDictionary *payload = [field mutableCopy];
  payload[@"tabId"] = tabId;
  [ArdiaEvents emit:@"autofill.field" data:[[ArdiaConsentStamp begin] onto:payload]];
}

- (void)tab:(ArdiaCoreTab *)tab didPressAutofillMenuKey:(NSString *)key {
  NSString *tabId = ardia_host::AppTabIdOf(tab);
  if (tabId.length && key.length) [ArdiaEvents emit:@"autofill.menuKey" data:[[ArdiaConsentStamp begin] onto:@{@"tabId" : tabId, @"key" : key}]];
}

+ (NSString *)autofillFieldPinOfTab:(NSString *)tabId {
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  if (!tab || tab.closed) return nil;
  return [ArdiaVaultCaptureOfTab(tab) autofillFieldPinAt:OriginOf(tab.url)];
}

@end
