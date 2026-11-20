#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaMorphLayout : NSObject
- (instancetype)initWithUIManager:(nullable id)uiManager NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;
@property (nonatomic, readonly, weak, nullable) id uiManager;
@property (nonatomic, copy, nullable) void (^onMissing)(NSArray<NSNumber *> *tags);
- (void)setWidth:(CGFloat)width ofTag:(NSNumber *)tag NS_SWIFT_NAME(set(width:of:));
- (void)clipTag:(NSNumber *)tag toWidth:(CGFloat)width fromRight:(BOOL)right NS_SWIFT_NAME(clip(_:to:fromRight:));
#if DEBUG
+ (double)hoverCheckMilliseconds:(NSInteger)passes;
+ (CGFloat)shownWidthOfTag:(NSNumber *)tag in:(nullable id)uiManager NS_SWIFT_NAME(shownWidth(of:in:));
+ (CGFloat)maskWidthOfTag:(NSNumber *)tag in:(nullable id)uiManager NS_SWIFT_NAME(maskWidth(of:in:));
#endif
@end

NS_ASSUME_NONNULL_END
