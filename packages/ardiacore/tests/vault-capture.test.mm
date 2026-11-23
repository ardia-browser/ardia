#import "../ios/ArdiaVaultCapture.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

static NSString *Frame(int i) { return [NSString stringWithFormat:@"frame-%d", i]; }
static NSString *Origin(int i) { return [NSString stringWithFormat:@"https://site%d.example", i]; }

static void MainFrameSurvivesAFloodOfSubframes() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture noteFieldInFrame:@"main" origin:@"https://bank.example" main:YES];
  for (int i = 0; i < 500; i++) [capture noteFieldInFrame:Frame(i) origin:Origin(i) main:NO];
  CHECK([[capture originOfFrame:@"main"] isEqualToString:@"https://bank.example"]);
  CHECK([[capture originOfFrame:Frame(499)] isEqualToString:Origin(499)]);
  CHECK([capture originOfFrame:Frame(0)] == nil);
}

static void SubframesEvictTheLeastRecentlyFocused() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  for (int i = 0; i < 64; i++) [capture noteFieldInFrame:Frame(i) origin:Origin(i) main:NO];
  [capture noteFieldInFrame:Frame(0) origin:Origin(0) main:NO];
  [capture noteFieldInFrame:Frame(64) origin:Origin(64) main:NO];
  CHECK([[capture originOfFrame:Frame(0)] isEqualToString:Origin(0)]);
  CHECK([capture originOfFrame:Frame(1)] == nil);
  CHECK([[capture originOfFrame:Frame(2)] isEqualToString:Origin(2)]);
  CHECK([[capture originOfFrame:Frame(64)] isEqualToString:Origin(64)]);
}

static void AForgottenFrameIsGone() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture noteFieldInFrame:@"main" origin:@"https://bank.example" main:YES];
  [capture noteFieldInFrame:@"sub" origin:@"https://ads.example" main:NO];
  [capture forgetFrame:@"main"];
  [capture forgetFrame:@"sub"];
  CHECK([capture originOfFrame:@"main"] == nil);
  CHECK([capture originOfFrame:@"sub"] == nil);
}

static void ManyOriginsDropOnlyTheOldestLogin() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  CHECK([capture keepLogin:@"me" password:@"first" origin:@"https://bank.example"]);
  for (int i = 0; i < 15; i++) [capture keepLogin:@"x" password:@"p" origin:Origin(i)];
  CHECK([[capture peekLogin:@"https://bank.example"][@"password"] isEqualToString:@"first"]);
  [capture keepLogin:@"x" password:@"p" origin:Origin(15)];
  CHECK([capture peekLogin:@"https://bank.example"] == nil);
  CHECK([capture peekLogin:Origin(1)] != nil);
  CHECK([capture peekLogin:Origin(15)] != nil);
}

static void TheSameSubmitTwiceIsKeptOnce() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  CHECK([capture keepLogin:@"me" password:@"pw" origin:@"https://bank.example"]);
  CHECK(![capture keepLogin:@"me" password:@"pw" origin:@"https://bank.example"]);
  CHECK([capture keepLogin:@"me" password:@"other" origin:@"https://bank.example"]);
  NSDictionary *taken = [capture takeLogin:@"https://bank.example"];
  CHECK([taken[@"password"] isEqualToString:@"other"]);
  CHECK([capture takeLogin:@"https://bank.example"] == nil);
}

static void ManyOriginsDropOnlyTheOldestGeneratedPassword() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture keepGeneratedPassword:@"gen-bank" origin:@"https://bank.example"];
  for (int i = 0; i < 16; i++) [capture keepGeneratedPassword:@"gen" origin:Origin(i)];
  CHECK([capture generatedPasswordFor:@"https://bank.example"] == nil);
  CHECK([[capture generatedPasswordFor:Origin(0)] isEqualToString:@"gen"]);
  CHECK([capture isGeneratedPassword:@"gen" origin:Origin(15)]);
}

static void AFillAnswersOnceForItsOwnFrame() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  __block int replies = 0;
  __block NSArray<NSString *> *got = nil;
  NSString *fill = [capture awaitFillInFrame:@"main" reply:^(NSArray<NSString *> *filled) {
    replies++;
    got = filled;
  }];
  [capture finishFill:fill frame:@"other" filled:@[ @"password" ]];
  CHECK(replies == 0);
  [capture finishFill:fill frame:@"main" filled:@[ @"username" ]];
  [capture finishFill:fill frame:@"main" filled:@[ @"password" ]];
  CHECK(replies == 1);
  CHECK([got isEqualToArray:@[ @"username" ]]);
}

static void WipingEndsEveryPendingFillEmpty() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  __block NSArray<NSString *> *got = nil;
  [capture awaitFillInFrame:@"main" reply:^(NSArray<NSString *> *filled) {
    got = filled;
  }];
  [capture keepLogin:@"me" password:@"pw" origin:@"https://bank.example"];
  [capture noteFieldInFrame:@"main" origin:@"https://bank.example" main:YES];
  [ArdiaVaultCapture wipeAll];
  CHECK(got != nil && got.count == 0);
  CHECK([capture peekLogin:@"https://bank.example"] == nil);
  CHECK([capture originOfFrame:@"main"] == nil);
}

static void ACardFillIsPinnedToTheFieldItStartedOn() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  CHECK([capture autofillFieldPinAt:@"https://shop.example"] == nil);
  [capture noteAutofillFieldInFrame:@"main" origin:@"https://shop.example" top:@"https://shop.example" focused:YES];
  NSString *pin = [capture autofillFieldPinAt:@"https://shop.example"];
  CHECK(pin != nil);
  CHECK([[capture autofillFieldPinAt:@"https://shop.example"] isEqualToString:pin]);
  CHECK([capture autofillFieldPinAt:@"https://evil.example"] == nil);
  [capture noteAutofillFieldInFrame:@"main" origin:@"https://shop.example" top:@"https://shop.example" focused:YES];
  CHECK(![[capture autofillFieldPinAt:@"https://shop.example"] isEqualToString:pin]);
  NSString *again = [capture autofillFieldPinAt:@"https://shop.example"];
  [capture noteAutofillFieldInFrame:@"pay" origin:@"https://pay.example" top:@"https://shop.example" focused:YES];
  CHECK(![[capture autofillFieldPinAt:@"https://shop.example"] isEqualToString:again]);
  [capture noteAutofillFieldInFrame:nil origin:nil top:@"https://shop.example" focused:NO];
  CHECK([capture autofillFieldPinAt:@"https://shop.example"] == nil);
}

static void ACardFieldInAPaymentFrameKeepsItsPinUntilThePageLeaves() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture noteAutofillFieldInFrame:@"pay" origin:@"https://js.stripe.com" top:@"https://shop.example" focused:YES];
  NSString *pin = [capture autofillFieldPinAt:@"https://shop.example"];
  CHECK(pin != nil);
  CHECK([[capture autofillFieldPinAt:@"https://shop.example"] isEqualToString:pin]);
  CHECK([pin containsString:@"https://js.stripe.com"]);
  CHECK([capture autofillFieldPinAt:@"https://js.stripe.com"] == nil);
  CHECK([capture autofillFieldPinAt:@"https://evil.example"] == nil);
  [capture noteAutofillFieldInFrame:@"pay" origin:@"https://evil.example" top:@"https://shop.example" focused:YES];
  CHECK(![[capture autofillFieldPinAt:@"https://shop.example"] isEqualToString:pin]);
}

static void ACardFieldWithNoFrameOriginIsPinnedToTheTopOrigin() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture noteAutofillFieldInFrame:@"main" origin:nil top:@"https://shop.example" focused:YES];
  NSString *pin = [capture autofillFieldPinAt:@"https://shop.example"];
  CHECK([pin containsString:@"https://shop.example"]);
  CHECK([capture autofillFieldPinAt:@"https://evil.example"] == nil);
  [capture noteAutofillFieldInFrame:@"main" origin:nil top:nil focused:YES];
  CHECK([capture autofillFieldPinAt:@"https://shop.example"] == nil);
}

static void ASignInThatLandsOnItsFormAgainFails() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  __block int expired = 0;
  [capture noteLoginLeftFrame:@"old" main:YES origin:@"https://bank.example" username:@"me" expired:^(NSDictionary *outcome) {
    expired++;
  }];
  CHECK([capture noteDocumentInFrame:@"ad" main:NO origin:@"https://bank.example"] == nil);
  NSDictionary *landing = [capture noteDocumentInFrame:@"new" main:YES origin:@"https://bank.example"];
  CHECK([landing[@"check"] isEqualToString:@"me"]);
  CHECK([capture landingCheckedInFrame:@"other" ok:NO] == nil);
  NSDictionary *outcome = [capture landingCheckedInFrame:@"new" ok:NO];
  CHECK([outcome isEqualToDictionary:(@{@"frameId" : @"old", @"origin" : @"https://bank.example", @"ok" : @NO})]);
  CHECK([capture landingCheckedInFrame:@"new" ok:YES] == nil);
  CHECK(expired == 0);
}

static void ASignInThatLandsOnAnotherSiteSucceeds() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture noteLoginLeftFrame:@"old" main:YES origin:@"https://bank.example" username:@"me" expired:^(NSDictionary *outcome){}];
  NSDictionary *landing = [capture noteDocumentInFrame:@"new" main:YES origin:@"https://sso.example"];
  CHECK([landing[@"outcome"] isEqualToDictionary:(@{@"frameId" : @"old", @"origin" : @"https://bank.example", @"ok" : @YES})]);
  CHECK([capture noteDocumentInFrame:@"new" main:YES origin:@"https://bank.example"] == nil);
}

static void ASubframeSignInWaitsForItsOwnFrame() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture noteLoginLeftFrame:@"login-frame" main:NO origin:@"https://idp.example" username:@"me" expired:^(NSDictionary *outcome){}];
  CHECK([capture noteDocumentInFrame:@"top" main:YES origin:@"https://idp.example"] == nil);
  CHECK([[capture noteDocumentInFrame:@"login-frame" main:NO origin:@"https://idp.example"][@"check"] isEqualToString:@"me"]);
}

static void ASignInWithNoAnswerFromItsLandingSucceedsAfterTheWait() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  __block NSDictionary *got = nil;
  [capture noteLoginLeftFrame:@"old" main:YES origin:@"https://bank.example" username:@"me" expired:^(NSDictionary *outcome) {
    got = outcome;
  }];
  CHECK([capture noteDocumentInFrame:@"new" main:YES origin:@"https://bank.example"] != nil);
  NSDate *until = [NSDate dateWithTimeIntervalSinceNow:kArdiaVaultLandingWait + 1];
  while (!got && [until timeIntervalSinceNow] > 0) [NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
  CHECK([got isEqualToDictionary:(@{@"frameId" : @"old", @"origin" : @"https://bank.example", @"ok" : @YES})]);
  CHECK([capture landingCheckedInFrame:@"new" ok:NO] == nil);
}

static void ALandingThatSaysHelloBeforeTheOldPageUnloadsIsStillChecked() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture noteDocumentInFrame:@"old" main:YES origin:@"https://bank.example"];
  [capture noteDocumentInFrame:@"new" main:YES origin:@"https://bank.example"];
  NSDictionary *landing = [capture noteLoginLeftFrame:@"old" main:YES origin:@"https://bank.example" username:@"me" expired:^(NSDictionary *outcome){}];
  CHECK([landing[@"check"] isEqualToString:@"me"]);
  CHECK([landing[@"frame"] isEqualToString:@"new"]);
  CHECK([[capture landingCheckedInFrame:@"new" ok:NO][@"ok"] isEqual:@NO]);
  ArdiaVaultCapture *same = [ArdiaVaultCapture new];
  [same noteDocumentInFrame:@"old" main:YES origin:@"https://bank.example"];
  CHECK([same noteLoginLeftFrame:@"old" main:YES origin:@"https://bank.example" username:@"me" expired:^(NSDictionary *outcome){}] == nil);
}

static void ASubframeLoadingBetweenTheLandingAndTheUnloadDoesNotHideTheLanding() {
  ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
  [capture noteDocumentInFrame:@"old" main:YES origin:@"https://bank.example"];
  [capture noteDocumentInFrame:@"new" main:YES origin:@"https://bank.example"];
  [capture noteDocumentInFrame:@"ad" main:NO origin:@"https://ads.example"];
  NSDictionary *landing = [capture noteLoginLeftFrame:@"old" main:YES origin:@"https://bank.example" username:@"me" expired:^(NSDictionary *outcome){}];
  CHECK([landing[@"frame"] isEqualToString:@"new"]);
}

static void ATabClosedMidFillStillAnswersTheFill() {
  __block NSArray *answered = nil;
  @autoreleasepool {
    ArdiaVaultCapture *capture = [ArdiaVaultCapture new];
    [capture awaitFillInFrame:@"main" reply:^(NSArray<NSString *> *filled) {
      answered = filled;
    }];
    capture = nil;
  }
  CHECK([answered isEqualToArray:@[]]);
}

int main() {
  @autoreleasepool {
    MainFrameSurvivesAFloodOfSubframes();
    SubframesEvictTheLeastRecentlyFocused();
    AForgottenFrameIsGone();
    ManyOriginsDropOnlyTheOldestLogin();
    TheSameSubmitTwiceIsKeptOnce();
    ManyOriginsDropOnlyTheOldestGeneratedPassword();
    AFillAnswersOnceForItsOwnFrame();
    WipingEndsEveryPendingFillEmpty();
    ACardFillIsPinnedToTheFieldItStartedOn();
    ACardFieldInAPaymentFrameKeepsItsPinUntilThePageLeaves();
    ACardFieldWithNoFrameOriginIsPinnedToTheTopOrigin();
    ASignInThatLandsOnItsFormAgainFails();
    ALandingThatSaysHelloBeforeTheOldPageUnloadsIsStillChecked();
    ASignInThatLandsOnAnotherSiteSucceeds();
    ASubframeSignInWaitsForItsOwnFrame();
    ASignInWithNoAnswerFromItsLandingSucceedsAfterTheWait();
    ASubframeLoadingBetweenTheLandingAndTheUnloadDoesNotHideTheLanding();
    ATabClosedMidFillStillAnswersTheFill();
  }
  if (failures) {
    std::printf("%d vault capture check(s) failed\n", failures);
    return 1;
  }
  std::printf("vault capture checks passed\n");
  return 0;
}
