#import "ArdiaWebViewInternal.h"

@implementation ArdiaWebView (Vault)

- (void)tab:(ArdiaCoreTab *)tab loginFormSeen:(NSDictionary<NSString *, id> *)form {
  NSString *tabId = ardia_host::AppTabIdOf(tab);
  NSString *origin = [form[@"origin"] isKindOfClass:NSString.class] ? form[@"origin"] : nil;
  if (!tabId || !origin.length) return;
  BOOL (^flag)(NSString *) = ^BOOL(NSString *key) { return [form[key] isKindOfClass:NSNumber.class] && [form[key] boolValue]; };
  NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithDictionary:@{
    @"tab" : tabId,
    @"origin" : origin,
    @"hasUsername" : @(flag(@"hasUsername")),
    @"hasPassword" : @(flag(@"hasPassword")),
    @"hasOneTimeCode" : @(flag(@"hasOneTimeCode")),
    @"mainFrame" : @(form[@"mainFrame"] == nil || flag(@"mainFrame")),
    @"at" : @([NSProcessInfo processInfo].systemUptime * 1000),
  }];
  id document = form[@"document"];
  if ([document isKindOfClass:NSString.class] || [document isKindOfClass:NSNumber.class]) payload[@"document"] = document;
  [ArdiaEvents emit:@"vault.loginFormSeen" data:[[ArdiaConsentStamp begin] onto:payload]];
}

@end
