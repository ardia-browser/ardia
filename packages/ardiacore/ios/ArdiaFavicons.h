#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaFavicons : NSObject
+ (void)fetch:(NSString *)url
       profile:(NSString *)profile
          page:(nullable NSString *)page
    completion:(void (^)(NSDictionary<NSString *, id> *_Nullable result))completion
    NS_SWIFT_NAME(fetch(_:profile:page:completion:));
+ (void)fetchImage:(NSString *)url
           profile:(NSString *)profile
        completion:(void (^)(NSDictionary<NSString *, id> *_Nullable result))completion
    NS_SWIFT_NAME(fetchImage(_:profile:completion:));
@end

NS_ASSUME_NONNULL_END
