#import <QuartzCore/QuartzCore.h>

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  double fromX;
  double fromY;
  double toX;
  double toY;
} ArdiaPeekMeshPoint;

typedef NS_ENUM(NSInteger, ArdiaPeekMeshTestMode) {
  ArdiaPeekMeshTestModeNone = 0,
  ArdiaPeekMeshTestModeUnavailable = 1,
  ArdiaPeekMeshTestModeThrows = 2,
};

@interface ArdiaPeekMesh : NSObject

@property (class, nonatomic) ArdiaPeekMeshTestMode testMode;

@property (class, nonatomic, readonly) BOOL inspected;

+ (nullable NSString *)unavailableReason;

+ (nullable NSString *)applyToLayer:(CALayer *)layer
                             points:(const ArdiaPeekMeshPoint *)points
                               rows:(NSUInteger)rows
                            columns:(NSUInteger)columns NS_SWIFT_NAME(apply(to:points:rows:columns:));

+ (void)clearLayer:(CALayer *)layer NS_SWIFT_NAME(clear(_:));

+ (BOOL)layerHasMesh:(CALayer *)layer NS_SWIFT_NAME(hasMesh(_:));

@end

NS_ASSUME_NONNULL_END
