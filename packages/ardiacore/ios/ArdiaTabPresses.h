#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

NSUInteger ArdiaTabPressBegan(NSString *key, double stamp);
NSUInteger ArdiaTabPressClaim(NSString *key, double stamp);
NSArray<NSNumber *> *ArdiaTabPressesTakeUnheard(NSUInteger upTo);
void ArdiaTabSwitchNote(NSString *key, NSUInteger press);
NSUInteger ArdiaTabSwitchTake(NSString *key);
void ArdiaTabSwitchesForget(NSUInteger press);
void ArdiaTabSplitsSet(NSArray<NSString *> *keys);
BOOL ArdiaTabInSplit(NSString *key);
void ArdiaTabPressesSetJavaScriptThread(void (^_Nullable run)(void (^block)(void)));
void ArdiaTabPressesOnJavaScriptThread(void (^block)(void));

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
