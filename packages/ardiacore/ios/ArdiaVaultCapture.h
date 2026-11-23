#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT const NSTimeInterval kArdiaVaultLandingWait;

@interface ArdiaVaultCapture : NSObject

- (void)noteFieldInFrame:(NSString *)frameId origin:(NSString *)origin main:(BOOL)main;
- (nullable NSString *)originOfFrame:(NSString *)frameId;
- (void)forgetFrame:(NSString *)frameId;

- (BOOL)keepLogin:(NSString *)username password:(NSString *)password origin:(NSString *)origin;
- (nullable NSDictionary<NSString *, NSString *> *)takeLogin:(NSString *)origin;
- (void)discardLogin:(NSString *)origin;

- (void)keepGeneratedPassword:(NSString *)password origin:(NSString *)origin;
- (BOOL)isGeneratedPassword:(NSString *)password origin:(NSString *)origin;
- (nullable NSString *)generatedPasswordFor:(NSString *)origin;
- (nullable NSDictionary<NSString *, NSString *> *)peekLogin:(NSString *)origin;

- (void)noteAutofillFieldInFrame:(nullable NSString *)frameId origin:(nullable NSString *)origin top:(nullable NSString *)topOrigin focused:(BOOL)focused;
- (nullable NSString *)autofillFieldPinAt:(nullable NSString *)currentTopOrigin;

- (nullable NSDictionary<NSString *, id> *)noteLoginLeftFrame:(NSString *)frameId
                      main:(BOOL)main
                    origin:(NSString *)origin
                  username:(NSString *)username
                   expired:(void (^)(NSDictionary<NSString *, id> *outcome))expired;
- (nullable NSDictionary<NSString *, id> *)noteDocumentInFrame:(NSString *)frameId main:(BOOL)main origin:(nullable NSString *)origin;
- (nullable NSDictionary<NSString *, id> *)landingCheckedInFrame:(NSString *)frameId ok:(BOOL)ok;

- (NSString *)awaitFillInFrame:(NSString *)frameId reply:(void (^)(NSArray<NSString *> *filled))reply;
- (void)finishFill:(NSString *)fillId frame:(NSString *)frameId filled:(NSArray<NSString *> *)filled;

+ (void)wipeAll;

@end

FOUNDATION_EXPORT ArdiaVaultCapture *_Nullable ArdiaVaultCaptureOfTab(id _Nullable tab);

NS_ASSUME_NONNULL_END
