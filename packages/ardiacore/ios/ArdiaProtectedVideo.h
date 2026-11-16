#import "ArdiaCore.h"

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaProtectedVideo : NSObject
@property(class) BOOL enabled;
+ (BOOL)servesOrigin:(nullable NSString *)origin;
+ (NSString *)pageScriptFrom:(NSString *)script;
+ (void)loadIntoProfile:(nullable ArdiaCoreProfile *)profile;
+ (void)helloFromTab:(ArdiaCoreTab *)tab origin:(nullable NSString *)origin bridged:(BOOL)bridged started:(NSTimeInterval)started;
+ (void)tab:(ArdiaCoreTab *)tab frame:(NSString *)frameId message:(NSDictionary *)message;
+ (void)pageGoneFromTab:(nullable ArdiaCoreTab *)tab;
+ (void)muteChangedInTab:(nullable ArdiaCoreTab *)tab;
+ (BOOL)activeInTab:(nullable ArdiaCoreTab *)tab;
+ (BOOL)playsInTab:(nullable ArdiaCoreTab *)tab;
+ (BOOL)startPictureInPictureInTab:(ArdiaCoreTab *)tab;
+ (void)exitPictureInPictureInTab:(nullable ArdiaCoreTab *)tab;
@end

NS_ASSUME_NONNULL_END
