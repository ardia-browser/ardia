#import "ArdiaCore.h"

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaVideoMirror : NSObject
+ (BOOL)acceptsOrigin:(nullable NSString *)origin;
+ (void)helloFromTab:(ArdiaCoreTab *)tab frame:(NSString *)frameId;
+ (void)tab:(ArdiaCoreTab *)tab frame:(NSString *)frameId message:(NSDictionary *)message;
+ (void)pageGoneFromTab:(nullable ArdiaCoreTab *)tab;
@end

NS_ASSUME_NONNULL_END
