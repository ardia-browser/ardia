#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern NSNotificationName const ArdiaConsentEpochDidChangeNotification;

@interface ArdiaEvents : NSObject

+ (void)setSender:(nullable void (^)(NSString *name, NSDictionary<NSString *, id> *data))sender
        forDomain:(NSString *)domain NS_SWIFT_NAME(setSender(_:forDomain:));
+ (BOOL)listens:(NSString *)domain;
+ (void)emit:(NSString *)name data:(NSDictionary<NSString *, id> *)data NS_SWIFT_NAME(emit(_:data:));
@property(class, nonatomic, copy) NSString *consentEpoch;

@end

@interface ArdiaConsentStamp : NSObject

+ (instancetype)begin NS_SWIFT_NAME(begin());
- (instancetype)initWithEpoch:(NSString *)epoch NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;
@property(nonatomic, readonly, copy) NSString *epoch;
- (NSDictionary<NSString *, id> *)onto:(NSDictionary<NSString *, id> *)payload NS_SWIFT_NAME(onto(_:));

@end

NS_ASSUME_NONNULL_END
