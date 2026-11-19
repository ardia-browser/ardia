#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^ArdiaFaviconReply)(NSDictionary<NSString *, id> *_Nullable reply, NSString *_Nullable error);

@interface ArdiaFaviconStore : NSObject
+ (BOOL)holdsURI:(nullable NSString *)uri NS_SWIFT_NAME(holds(_:));
+ (nullable NSString *)tokenForProfile:(nullable NSString *)profile NS_SWIFT_NAME(token(_:));
+ (void)fetchIcon:(NSString *)url
          profile:(nullable NSString *)profile
             page:(nullable NSString *)page
       completion:(void (^)(NSString *_Nullable uri, NSData *_Nullable png))completion;
+ (void)noteTab:(id)tab profile:(nullable NSString *)profile;
+ (void)lookUp:(NSString *)args profile:(NSString *)profile completion:(ArdiaFaviconReply)completion NS_SWIFT_NAME(lookUp(_:profile:completion:));
+ (void)set:(NSString *)args profile:(NSString *)profile completion:(ArdiaFaviconReply)completion NS_SWIFT_NAME(set(_:profile:completion:));
+ (void)loadPNGForURI:(nullable NSString *)uri completion:(void (^)(NSData *_Nullable png))completion NS_SWIFT_NAME(load(_:completion:));
+ (nullable NSData *)heldPNGForURI:(nullable NSString *)uri NS_SWIFT_NAME(heldPNG(_:));
+ (nullable id)derivedForURI:(nullable NSString *)uri kind:(NSString *)kind NS_SWIFT_NAME(derived(_:kind:));
+ (void)setDerived:(id)object forURI:(nullable NSString *)uri kind:(NSString *)kind NS_SWIFT_NAME(setDerived(_:for:kind:));
+ (void)forgetProfile:(nullable NSString *)profile NS_SWIFT_NAME(forget(_:));
+ (NSArray<NSString *> *)saveLaunchIcons:(NSArray<NSString *> *)uris profile:(nullable NSString *)profile NS_SWIFT_NAME(saveLaunchIcons(_:profile:));
+ (void)retireProfile:(nullable NSString *)profile;
+ (void)restoreProfile:(nullable NSString *)profile;
+ (NSDictionary<NSString *, NSNumber *> *)takeCounts;
@end

NS_ASSUME_NONNULL_END
