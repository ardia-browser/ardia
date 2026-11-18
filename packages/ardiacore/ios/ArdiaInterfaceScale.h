#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

extern NSNotificationName const ArdiaInterfaceScaleDidChange;
extern NSNotificationName const ArdiaInterfaceScaleRootDidAttach;
extern NSNotificationName const ArdiaInterfaceScaleDidSettle;

NS_SWIFT_NAME(InterfaceScale)
@interface ArdiaInterfaceScale : NSObject

@property(class, nonatomic) CGFloat scale;
@property(class, nonatomic, readonly) CGFloat minimum;
@property(class, nonatomic, readonly) CGFloat maximum;
+ (CGFloat)clamped:(CGFloat)scale;

+ (void)follow:(NSView *)root;
+ (void)rootAttached:(NSView *)root;
+ (void)layoutSettled;
+ (void)fitPageHost:(NSView *)host;
+ (nullable NSView *)rootOfWindow:(nullable NSWindow *)window NS_SWIFT_NAME(root(of:));

+ (NSPoint)windowPointFromRoot:(NSPoint)point inWindow:(nullable NSWindow *)window NS_SWIFT_NAME(windowPoint(fromRoot:in:));
+ (NSRect)windowRectFromRoot:(NSRect)rect inWindow:(nullable NSWindow *)window NS_SWIFT_NAME(windowRect(fromRoot:in:));
+ (NSPoint)rootPointFromWindow:(NSPoint)point inWindow:(nullable NSWindow *)window NS_SWIFT_NAME(rootPoint(fromWindow:in:));
+ (NSRect)rootRectFromWindow:(NSRect)rect inWindow:(nullable NSWindow *)window NS_SWIFT_NAME(rootRect(fromWindow:in:));
+ (NSPoint)screenPointFromRoot:(NSPoint)point inWindow:(NSWindow *)window NS_SWIFT_NAME(screenPoint(fromRoot:in:));
+ (NSPoint)rootPointFromScreen:(NSPoint)point inWindow:(NSWindow *)window NS_SWIFT_NAME(rootPoint(fromScreen:in:));

+ (NSSize)windowSizeFromRoot:(NSSize)size NS_SWIFT_NAME(windowSize(fromRoot:));
+ (NSSize)rootSizeFromWindow:(NSSize)size NS_SWIFT_NAME(rootSize(fromWindow:));
+ (CGFloat)windowLengthFromRoot:(CGFloat)length NS_SWIFT_NAME(windowLength(fromRoot:));
+ (CGFloat)rootLengthFromWindow:(CGFloat)length NS_SWIFT_NAME(rootLength(fromWindow:));

@end

NS_ASSUME_NONNULL_END
