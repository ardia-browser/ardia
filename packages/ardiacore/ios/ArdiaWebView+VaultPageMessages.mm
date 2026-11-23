#import "ArdiaWebViewInternal.h"
#import "ArdiaWebView+VaultCodeSetup.h"
#import "ArdiaWebView+VaultContextMenu.h"
#import "ArdiaRuntime.h"
#import "ArdiaVaultCapture.h"

#import <objc/runtime.h>

using namespace ardia_web_view;
using namespace ardia_runtime;

static char kVaultCaptureKey;
static void (^gGeneratedVaultSubmitHandler)(NSString *password, NSString *username, NSString *origin);

ArdiaVaultCapture *ArdiaVaultCaptureOfTab(id tab) {
  if (!tab) return nil;
  ArdiaVaultCapture *capture = objc_getAssociatedObject(tab, &kVaultCaptureKey);
  if (!capture) {
    capture = [ArdiaVaultCapture new];
    objc_setAssociatedObject(tab, &kVaultCaptureKey, capture, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return capture;
}

static const NSUInteger kLongestVaultUsername = 1024;

static NSArray<NSString *> *VaultKeys() { return @[ @"ArrowDown", @"ArrowUp", @"Enter", @"Escape", @"Tab", @"Typed", @"Cleared" ]; }

static NSString *VaultUsernameSource(NSDictionary *d) {
  NSString *source = Text(d, @"usernameFrom", 16);
  return [@[ @"form", @"step", @"page", @"nearby" ] containsObject:source ?: @""] ? source : @"";
}

static BOOL VaultWebOrigin(NSString *origin) { return [origin hasPrefix:@"https://"] || [origin hasPrefix:@"http://"]; }

@implementation ArdiaWebView (VaultPageMessages)

- (void)receiveVaultMessage:(NSString *)kind
                       json:(NSString *)json
                       dict:(NSDictionary *)dict
                      frame:(NSString *)frameId
                       main:(BOOL)main
                     origin:(NSString *)verifiedOrigin
                        tab:(ArdiaCoreTab *)tab {
  NSString *origin = VerifiedOrigin(verifiedOrigin);
  const BOOL menuMode = FieldProviderFillsFromMenu(_profile);
  if ([kind isEqualToString:@"vaultField"] && dict) {
    [self noteVaultField:dict tab:tab frame:frameId main:main origin:origin];
  } else if ([kind isEqualToString:@"vaultKey"] && dict) {
    NSString *key = Text(dict, @"key", 16);
    if (menuMode && VaultWebOrigin(origin) && [VaultKeys() containsObject:key ?: @""])
      [self emit:@"vaultKey" payload:@{@"frameId" : frameId, @"key" : key}];
  } else if ([kind isEqualToString:@"vaultContext"] && dict) {
    if (menuMode && Flag(dict, @"field") && VaultWebOrigin(origin)) [ArdiaVaultCaptureOfTab(tab) noteFieldInFrame:frameId origin:origin main:main];
    [self noteVaultContext:dict frame:frameId main:main origin:origin];
  } else if ([kind isEqualToString:@"vaultCodeTarget"] && dict) {
    [self noteVaultCodeTarget:menuMode ? dict : @{} frame:frameId main:main origin:origin];
  } else if ([kind isEqualToString:@"vaultSubmit"] && dict && menuMode) {
    [self captureVaultSubmit:dict tab:tab frame:frameId origin:origin];
  } else if ([kind isEqualToString:@"vaultLoginPage"] && menuMode) {
    if (VaultWebOrigin(origin)) [self emit:@"vaultLoginPage" payload:@{@"frameId" : frameId, @"origin" : origin, @"main" : @(main)}];
  } else if ([kind isEqualToString:@"vaultLoginOutcome"] && dict && menuMode) {
    [self noteVaultLoginOutcome:dict tab:tab frame:frameId main:main origin:origin];
  } else if ([kind isEqualToString:@"vaultFilled"] && dict) {
    NSMutableArray<NSString *> *filled = [NSMutableArray array];
    for (id name in Field<NSArray>(dict, @"filled") ?: @[])
      if ([name isKindOfClass:NSString.class] && [ArdiaVaultFieldKinds() containsObject:name] && ![filled containsObject:name])
        [filled addObject:name];
    [ArdiaVaultCaptureOfTab(tab) finishFill:Text(dict, @"id", 64) ?: @"" frame:frameId filled:filled];
  }
}

- (void)noteVaultDocumentInFrame:(NSString *)frameId tab:(ArdiaCoreTab *)tab main:(BOOL)main origin:(NSString *)verifiedOrigin {
  [ArdiaVaultCaptureOfTab(tab) forgetFrame:frameId];
  [self answerLanding:[ArdiaVaultCaptureOfTab(tab) noteDocumentInFrame:frameId main:main origin:VerifiedOrigin(verifiedOrigin)]];
}

- (void)noteVaultLoginOutcome:(NSDictionary *)dict tab:(ArdiaCoreTab *)tab frame:(NSString *)frameId main:(BOOL)main origin:(NSString *)origin {
  ArdiaVaultCapture *capture = ArdiaVaultCaptureOfTab(tab);
  if (Flag(dict, @"checked")) {
    NSDictionary *outcome = [capture landingCheckedInFrame:frameId ok:Flag(dict, @"ok")];
    if (outcome) [self emit:@"vaultLoginOutcome" payload:outcome];
    return;
  }
  if (!VaultWebOrigin(origin)) return;
  if (Flag(dict, @"left")) {
    __weak ArdiaWebView *weakSelf = self;
    NSString *username = Text(dict, @"username", kLongestVaultUsername) ?: @"";
    [self answerLanding:[capture noteLoginLeftFrame:frameId main:main origin:origin username:username expired:^(NSDictionary *outcome) {
            [weakSelf emit:@"vaultLoginOutcome" payload:outcome];
          }]];
    return;
  }
  [self emit:@"vaultLoginOutcome" payload:@{@"frameId" : frameId, @"origin" : origin, @"ok" : @(Flag(dict, @"ok"))}];
}

- (void)answerLanding:(NSDictionary *)landing {
  if (NSDictionary *outcome = Field<NSDictionary>(landing, @"outcome")) return [self emit:@"vaultLoginOutcome" payload:outcome];
  NSString *frame = Field<NSString>(landing, @"frame");
  NSString *username = Field<NSString>(landing, @"check");
  if (frame.length && username) [self callFrame:frame kind:@"vaultLoginCheck" json:JSONText(@{@"username" : username})];
}

static id VaultFieldInset(NSDictionary *raw) {
  double top, bottom, trailing;
  if (!raw || !Finite(raw, @"top", &top) || !Finite(raw, @"bottom", &bottom) || !Finite(raw, @"trailing", &trailing)) return NSNull.null;
  const double most = 256;
  return @{@"top" : @(MIN(MAX(top, 0.0), most)), @"bottom" : @(MIN(MAX(bottom, 0.0), most)), @"trailing" : @(MIN(MAX(trailing, 0.0), most))};
}

- (void)noteVaultField:(NSDictionary *)dict tab:(ArdiaCoreTab *)tab frame:(NSString *)frameId main:(BOOL)main origin:(NSString *)origin {
  NSString *kind = Text(dict, @"kind", 16);
  if (!FieldProviderFor(_profile) || !VaultWebOrigin(origin) || ![ArdiaVaultFieldKinds() containsObject:kind ?: @""]) return;
  const BOOL focused = Flag(dict, @"focused");
  if (focused && FieldProviderFillsFromMenu(_profile)) [ArdiaVaultCaptureOfTab(tab) noteFieldInFrame:frameId origin:origin main:main];
  NSDictionary *rect = main ? ArdiaVaultRect(Field<NSDictionary>(dict, @"rect")) : nil;
  NSNumber *darkField = rect ? Field<NSNumber>(dict, @"darkField") : nil;
  NSString *brand = rect ? Text(dict, @"brandColor", 7) : nil;
  if (brand && [brand rangeOfString:@"^#[0-9a-f]{6}$" options:NSRegularExpressionSearch].location == NSNotFound) brand = nil;
  [self emit:@"vaultField"
      payload:@{
        @"frameId" : frameId,
        @"origin" : origin,
        @"main" : @(main),
        @"kind" : kind,
        @"focused" : @(focused),
        @"rect" : rect ?: NSNull.null,
        @"formHasPassword" : @(Flag(dict, @"formHasPassword")),
        @"clicked" : @(Flag(dict, @"clicked")),
        @"auto" : @(Flag(dict, @"auto")),
        @"email" : @(Flag(dict, @"email")),
        @"maxLength" : @(ArdiaVaultMaxLength(dict)),
        @"rtl" : @(rect && Flag(dict, @"rtl")),
        @"darkField" : darkField ? @(darkField.boolValue) : NSNull.null,
        @"brandColor" : brand ?: NSNull.null,
        @"trailingTaken" : @(rect && Flag(dict, @"trailingTaken")),
        @"inset" : rect ? VaultFieldInset(Field<NSDictionary>(dict, @"inset")) : NSNull.null,
        @"webauthn" : @(Flag(dict, @"webauthn"))
      }];
}

- (void)captureVaultSubmit:(NSDictionary *)dict tab:(ArdiaCoreTab *)tab frame:(NSString *)frameId origin:(NSString *)origin {
  NSString *password = Field<NSString>(dict, @"password");
  NSString *username = Text(dict, @"username", kLongestVaultUsername) ?: @"";
  if (!VaultWebOrigin(origin) || !password.length || password.length > kArdiaVaultLongestValue) return;
  ArdiaVaultCapture *capture = ArdiaVaultCaptureOfTab(tab);
  if (![capture keepLogin:username password:password origin:origin]) return;
  const BOOL generated = [capture isGeneratedPassword:password origin:origin];
  if (generated && gGeneratedVaultSubmitHandler) gGeneratedVaultSubmitHandler(password, username, origin);
  [self emit:@"vaultSubmitted"
      payload:@{
        @"frameId" : frameId,
        @"origin" : origin,
        @"username" : username,
        @"newPassword" : @(Flag(dict, @"newPassword")),
        @"generated" : @(generated),
        @"usernameFrom" : VaultUsernameSource(dict),
        @"trusted" : @(Flag(dict, @"trusted")),
        @"reportsOutcome" : @YES
      }];
}

- (NSString *)vaultOriginOfFrame:(NSString *)frameId {
  return [ArdiaVaultCaptureOfTab(_tab) originOfFrame:frameId];
}

- (void)fillVaultFrame:(NSString *)frameId
                origin:(NSString *)origin
                values:(NSDictionary<NSString *, NSString *> *)values
                submit:(BOOL)submit
           contextMenu:(BOOL)contextMenu
            completion:(void (^)(NSArray<NSString *> *filled))completion {
  ArdiaVaultCapture *capture = ArdiaVaultCaptureOfTab(_tab);
  if (!capture || !VaultWebOrigin(origin) || ![[capture originOfFrame:frameId] isEqualToString:origin]) return completion(@[]);
  NSMutableDictionary *message = [NSMutableDictionary dictionary];
  for (NSString *name in ArdiaVaultFieldKinds()) {
    NSString *value = Field<NSString>(values, name);
    if (value.length) message[name] = value;
  }
  if (!message.count) return completion(@[]);
  message[@"origin"] = origin;
  if (contextMenu) message[@"context"] = @YES;
  else if (submit) message[@"submit"] = @YES;
  message[@"id"] = [capture awaitFillInFrame:frameId reply:completion];
  [self callFrame:frameId kind:@"vaultFill" json:JSONText(message)];
}

- (void)setVaultMenuInFrame:(NSString *)frameId open:(BOOL)open highlighted:(BOOL)highlighted {
  if (!_tab) return;
  [self callFrame:frameId kind:@"vaultMenu" json:JSONText(@{@"open" : @(open), @"highlighted" : @(open && highlighted)})];
}

- (void)keepVaultLogin:(NSString *)username password:(NSString *)password origin:(NSString *)origin {
  [ArdiaVaultCaptureOfTab(_tab) keepLogin:username password:password origin:origin];
}

- (void)keepGeneratedVaultPassword:(NSString *)password origin:(NSString *)origin {
  [ArdiaVaultCaptureOfTab(_tab) keepGeneratedPassword:password origin:origin];
}

- (NSDictionary<NSString *, NSString *> *)takeVaultLogin:(NSString *)origin {
  return [ArdiaVaultCaptureOfTab(_tab) takeLogin:origin];
}

- (NSDictionary<NSString *, NSString *> *)peekVaultLogin:(NSString *)origin {
  return [ArdiaVaultCaptureOfTab(_tab) peekLogin:origin];
}

- (NSString *)generatedVaultPasswordFor:(NSString *)origin {
  return [ArdiaVaultCaptureOfTab(_tab) generatedPasswordFor:origin];
}

+ (void)setGeneratedVaultSubmitHandler:(void (^)(NSString *, NSString *, NSString *))handler {
  gGeneratedVaultSubmitHandler = [handler copy];
}

- (void)discardVaultLogin:(NSString *)origin {
  [ArdiaVaultCaptureOfTab(_tab) discardLogin:origin];
}

+ (void)wipeVaultCaptures {
  [ArdiaVaultCapture wipeAll];
}
@end
