#import "ArdiaWebViewInternal.h"
#import "ArdiaRuntime.h"

using namespace ardia_web_view;
using namespace ardia_runtime;

@interface ApplePasswordsProfiles : NSObject
+ (BOOL)containsProfile:(NSString *)profile;
@end

@interface ArdiaWebView (LoginListTarget)
- (void)showLoginListFrom:(NSString *)origin screenRect:(NSRect)rect typing:(BOOL)typing typed:(NSString *)typed;
- (void)keyLoginList:(NSString *)key;
- (void)closeLoginList;
@end

namespace {

const NSUInteger kTypedMax = 200;
const NSUInteger kTokenMax = 16;
const NSTimeInterval kFillSeconds = 3;

NSString *LoginFieldToken(NSDictionary *d) {
  NSString *token = Text(d, @"token", kTokenMax);
  if (!token.length) return nil;
  for (NSUInteger i = 0; i < token.length; i++)
    if (![NSCharacterSet.decimalDigitCharacterSet characterIsMember:[token characterAtIndex:i]]) return nil;
  return token;
}

NSString *WebOrigin(NSString *origin) {
  NSURL *url = origin.length ? [NSURL URLWithString:origin] : nil;
  NSString *scheme = url.scheme.lowercaseString;
  return url.host.length && ([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"]) ? origin : nil;
}

}

namespace ardia_web_view {

NSDictionary *LoginListConfig(NSString *profile) {
  return @{@"on" : @([ApplePasswordsProfiles containsProfile:profile ?: @""])};
}

}

@implementation ArdiaWebView (LoginList)

- (BOOL)loginListOn {
  return _tab && [ApplePasswordsProfiles containsProfile:_profile ?: @""];
}

- (void)pushLoginList {
  if (!_tab) return;
  [self callFramesWithSameSite:JSONText(LoginListConfig(_profile)) kind:@"loginList" otherwise:JSONText(@{@"on" : @NO})];
  if (!self.loginListOn) [self endLoginField];
}

- (NSURL *)loginListPageURL {
  NSString *url = _tab.url;
  return url.length ? [NSURL URLWithString:url] : nil;
}

- (NSRect)loginListScreenRect:(NSDictionary *)d {
  double x = 0, y = 0, width = 0, height = 0;
  Finite(d, @"x", &x);
  Finite(d, @"y", &y);
  Finite(d, @"width", &width);
  Finite(d, @"height", &height);
  const double zoom = _tab.zoomFactor > 0 ? _tab.zoomFactor : 1;
  const NSRect local = NSMakeRect(NSMinX(self.bounds) + x * zoom, NSMinY(self.bounds) + y * zoom, MAX(1, width * zoom), MAX(1, height * zoom));
  NSWindow *window = self.window;
  return window ? [window convertRectToScreen:[self convertRect:local toView:nil]] : NSZeroRect;
}

- (void)loginFieldFromPage:(NSDictionary *)d frame:(NSString *)frameId main:(BOOL)main origin:(NSString *)sender {
  NSString *event = Text(d, @"event", 8);
  NSString *origin = WebOrigin(sender);
  NSString *token = LoginFieldToken(d);
  NSDictionary *current = _loginList.field;
  const BOOL same = current && [current[@"frame"] isEqualToString:frameId] && [current[@"token"] isEqualToString:token ?: @""];
  if ([event isEqualToString:@"hide"]) {
    if (!current || [current[@"frame"] isEqualToString:frameId]) [self endLoginField];
    return;
  }
  if (!self.loginListOn || !origin || ![self sameSiteFrame:main origin:origin] || !token) return [self endLoginField];
  if ([event isEqualToString:@"key"]) {
    NSString *key = Text(d, @"key", 8);
    if (same && [@[ @"down", @"up", @"enter", @"escape", @"tab" ] containsObject:key ?: @""]) [self keyLoginList:key];
    return;
  }
  NSString *field = Text(d, @"field", 16);
  if (![@[ @"show", @"input" ] containsObject:event ?: @""] || ![@[ @"username", @"password" ] containsObject:field ?: @""]) return [self endLoginField];
  NSString *typed = [field isEqualToString:@"password"] ? @"" : Text(d, @"typed", kTypedMax) ?: @"";
  _loginList.field = @{@"frame" : frameId, @"token" : token, @"origin" : origin};
  [self showLoginListFrom:origin screenRect:[self loginListScreenRect:d] typing:[event isEqualToString:@"input"] typed:typed];
}

- (void)endLoginField {
  if (!_loginList.field) return;
  _loginList.field = nil;
  [self closeLoginList];
}

- (void)syncLoginListOpen:(BOOL)open picking:(BOOL)picking {
  NSString *frame = _loginList.field[@"frame"];
  if (frame) [self callFrame:frame kind:@"loginListState" json:JSONText(@{@"open" : @(open), @"picking" : @(picking)})];
}

- (void)connectApplePasswordsFromLoginList {
  [self emit:@"applePasswordsConnect" payload:@{}];
}

@end
