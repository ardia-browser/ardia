#import "ArdiaWebViewInternal.h"
#import "ArdiaRuntime.h"
#import "ArdiaLoginListReport.h"

using namespace ardia_web_view;
using namespace ardia_runtime;

@interface ApplePasswordsProfiles : NSObject
+ (BOOL)containsProfile:(NSString *)profile;
@end

@interface ArdiaWebView (LoginListTarget)
- (void)showLoginListFrom:(NSString *)origin screenRect:(NSRect)rect typing:(BOOL)typing typed:(NSString *)typed field:(NSString *)field rules:(NSDictionary *)rules;
- (void)keyLoginList:(NSString *)key;
- (void)closeLoginList;
- (void)loginListIgnoredOtherFrame;
@property (nonatomic, readonly) BOOL loginListShown;
@end

namespace {

const NSTimeInterval kFillSeconds = 3;

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

- (NSRect)loginListScreenRect:(NSRect)page {
  const double zoom = _tab.zoomFactor > 0 ? _tab.zoomFactor : 1;
  const NSRect local = NSMakeRect(NSMinX(self.bounds) + NSMinX(page) * zoom, NSMinY(self.bounds) + NSMinY(page) * zoom, NSWidth(page) * zoom, NSHeight(page) * zoom);
  NSWindow *window = self.window;
  return window ? [window convertRectToScreen:[self convertRect:local toView:nil]] : NSZeroRect;
}

- (void)loginFieldFromPage:(NSDictionary *)data frame:(NSString *)frameId main:(BOOL)main origin:(NSString *)sender {
  NSDictionary *report = ArdiaLoginListReport(data);
  NSString *event = report[@"event"];
  NSDictionary *current = _loginList.field;
  if (!report || [event isEqualToString:@"hide"]) {
    if (!current || [current[@"frame"] isEqualToString:frameId]) [self endLoginField];
    else if (report) [self loginListIgnoredOtherFrame];
    return;
  }
  NSString *origin = WebOrigin(sender);
  if (!self.loginListOn || !origin || ![self sameSiteFrame:main origin:origin]) return [self endLoginField];
  const BOOL sameField = [current[@"frame"] isEqualToString:frameId] && [current[@"token"] isEqualToString:report[@"token"]];
  if ([event isEqualToString:@"passwordInput"]) {
    if (!sameField || !self.loginListShown) [self endLoginField];
    return;
  }
  if ([event isEqualToString:@"key"]) {
    if (sameField) [self keyLoginList:report[@"key"]];
    else if (![current[@"frame"] isEqualToString:frameId]) [self loginListIgnoredOtherFrame];
    return;
  }
  const BOOL signIn = [report[@"signIn"] boolValue];
  const BOOL claimed = [_loginList.field[@"signIn"] boolValue];
  _loginList.field = @{@"frame" : frameId, @"token" : report[@"token"], @"origin" : origin, @"signIn" : @(signIn)};
  if (signIn != claimed) [self pushClaimedAutofillKinds];
  [self showLoginListFrom:origin
               screenRect:[self loginListScreenRect:[report[@"rect"] rectValue]]
                   typing:[event isEqualToString:@"input"]
                    typed:report[@"typed"]
                    field:report[@"field"]
                    rules:report];
}

- (void)endLoginField {
  if (!_loginList.field) return;
  const BOOL claimed = [_loginList.field[@"signIn"] boolValue];
  _loginList.field = nil;
  [self closeLoginList];
  if (claimed) [self pushClaimedAutofillKinds];
}

- (void)fillLoginList:(NSDictionary<NSString *, NSString *> *)values origin:(NSString *)origin completion:(void (^)(BOOL filled))completion {
  NSDictionary *field = _loginList.field;
  NSString *frame = field[@"frame"];
  if (!field || ![field[@"origin"] isEqualToString:origin ?: @""] || ![OriginOf(_tab.url) isEqualToString:origin] || ![_tab hasLiveFrame:frame])
    return completion(NO);
  NSString *ticket = [NSString stringWithFormat:@"%ld", (long)++_loginList.ticket];
  if (!_loginList.fills) _loginList.fills = [NSMutableDictionary dictionary];
  _loginList.fills[ticket] = @{@"frame" : frame, @"done" : [completion copy]};
  NSMutableDictionary *message = [@{@"ticket" : ticket, @"token" : field[@"token"], @"origin" : origin} mutableCopy];
  for (NSString *key in @[ @"username", @"password", @"code", @"newPassword" ])
    if ([values[key] isKindOfClass:NSString.class]) message[key] = values[key];
  [self callFrame:frame kind:@"loginFill" json:JSONText(message)];
  __weak ArdiaWebView *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kFillSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [weakSelf answerLoginFill:ticket frame:frame filled:NO];
  });
}

- (void)answerLoginFill:(NSString *)ticket frame:(NSString *)frame filled:(BOOL)filled {
  NSDictionary *fill = ticket ? _loginList.fills[ticket] : nil;
  if (!fill || ![fill[@"frame"] isEqualToString:frame ?: @""]) return;
  [_loginList.fills removeObjectForKey:ticket];
  ((void (^)(BOOL))fill[@"done"])(filled);
}

- (void)loginFilledFromPage:(NSDictionary *)d frame:(NSString *)frameId {
  [self answerLoginFill:ArdiaLoginListTicket(d[@"ticket"]) frame:frameId filled:Flag(d, @"filled")];
}

- (void)syncLoginListOpen:(BOOL)open picking:(BOOL)picking {
  NSString *frame = _loginList.field[@"frame"];
  if (frame) [self callFrame:frame kind:@"loginListState" json:JSONText(@{@"open" : @(open), @"picking" : @(picking)})];
}

- (void)connectApplePasswordsFromLoginList {
  [self emit:@"applePasswordsConnect" payload:@{}];
}

@end
