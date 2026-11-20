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

@implementation ArdiaWebView (VaultPageMessages)

- (NSString *)vaultOriginOfFrame:(NSString *)frameId {
  return [ArdiaVaultCaptureOfTab(_tab) originOfFrame:frameId];
}

- (void)fillVaultFrame:(NSString *)frameId
                origin:(NSString *)origin
                values:(NSDictionary<NSString *, NSString *> *)values
                submit:(BOOL)submit
           contextMenu:(BOOL)contextMenu
            completion:(void (^)(NSArray<NSString *> *filled))completion {
  completion(@[]);
}

- (void)setVaultMenuInFrame:(NSString *)frameId open:(BOOL)open highlighted:(BOOL)highlighted {
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
