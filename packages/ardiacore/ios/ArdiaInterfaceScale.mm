#import "ArdiaInterfaceScale.h"

#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

NSNotificationName const ArdiaInterfaceScaleDidChange = @"ArdiaInterfaceScaleDidChange";
NSNotificationName const ArdiaInterfaceScaleRootDidAttach = @"ArdiaInterfaceScaleRootDidAttach";
NSNotificationName const ArdiaInterfaceScaleDidSettle = @"ArdiaInterfaceScaleDidSettle";

namespace {

NSString *const kScaleDefault = @"interfaceScale";
const CGFloat kMinimum = 0.8;
const CGFloat kMaximum = 1.5;
const NSTimeInterval kSettleFallbackSeconds = 0.35;

CGFloat gScale = 0;
NSUInteger gChange = 0;
NSUInteger gSettledChange = 0;
const void *const kFrameWatchKey = &kFrameWatchKey;

NSHashTable<NSView *> *Roots() {
  static NSHashTable<NSView *> *roots = [NSHashTable weakObjectsHashTable];
  return roots;
}

CGFloat Clamped(CGFloat scale) {
  if (!(scale > 0)) return 1;
  return MIN(kMaximum, MAX(kMinimum, round(scale * 100) / 100));
}

void FitRoot(NSView *root) {
  const CGFloat scale = ArdiaInterfaceScale.scale;
  const NSSize frame = root.frame.size;
  const NSSize want = NSMakeSize(frame.width / scale, frame.height / scale);
  if (NSEqualSizes(root.bounds.size, want)) return;
  [root setBoundsSize:want];
  root.needsLayout = YES;
}

BOOL DrawsItsOwnPixels(NSView *view) {
  static NSArray<Class> *classes;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSMutableArray<Class> *found = [NSMutableArray array];
    for (NSString *name in @[@"ArdiaWebView", @"WKWebView", @"MTKView"])
      if (Class cls = NSClassFromString(name)) [found addObject:cls];
    classes = found;
  });
  for (Class cls in classes)
    if ([view isKindOfClass:cls]) return YES;
  return [view.layer isKindOfClass:CAMetalLayer.class];
}

void RedrawAtDensity(NSView *view) {
  if (DrawsItsOwnPixels(view)) return;
  CALayer *layer = view.layer;
  if (layer.contents && view.window) {
    const CGFloat density = [view convertSizeToBacking:NSMakeSize(1, 1)].width;
    if (density > 0 && fabs(layer.contentsScale - density) > density * 0.001) layer.contentsScale = density;
  }
  view.needsDisplay = YES;
  for (NSView *subview in view.subviews) RedrawAtDensity(subview);
}

CGFloat ContentTop(NSWindow *window) {
  return NSHeight(window.contentView.frame);
}

}

@interface ArdiaRootFrameWatch : NSObject
- (instancetype)initWithRoot:(NSView *)root;
@end

@implementation ArdiaRootFrameWatch {
  id _observer;
}

- (instancetype)initWithRoot:(NSView *)root {
  if ((self = [super init])) {
    __weak NSView *weakRoot = root;
    _observer = [NSNotificationCenter.defaultCenter addObserverForName:NSViewFrameDidChangeNotification
                                                                object:root
                                                                 queue:nil
                                                            usingBlock:^(NSNotification *) {
                                                              NSView *followed = weakRoot;
                                                              if (followed) FitRoot(followed);
                                                            }];
  }
  return self;
}

- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:_observer];
}

@end

@implementation ArdiaInterfaceScale

+ (CGFloat)minimum {
  return kMinimum;
}

+ (CGFloat)maximum {
  return kMaximum;
}

+ (CGFloat)clamped:(CGFloat)scale {
  return Clamped(scale);
}

+ (CGFloat)scale {
  if (gScale <= 0) gScale = Clamped([NSUserDefaults.standardUserDefaults doubleForKey:kScaleDefault]);
  return gScale;
}

+ (void)setScale:(CGFloat)asked {
  const CGFloat scale = Clamped(asked);
  if (scale == self.scale) return;
  gScale = scale;
  [NSUserDefaults.standardUserDefaults setDouble:scale forKey:kScaleDefault];
  for (NSView *root in Roots().allObjects) FitRoot(root);
  [NSNotificationCenter.defaultCenter postNotificationName:ArdiaInterfaceScaleDidChange object:nil];
  for (NSView *root in Roots().allObjects) RedrawAtDensity(root);
  const NSUInteger change = ++gChange;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kSettleFallbackSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (gSettledChange < change && gChange == change) [self layoutSettled];
  });
}

+ (void)layoutSettled {
  gSettledChange = gChange;
  for (NSView *root in Roots().allObjects) RedrawAtDensity(root);
  [NSNotificationCenter.defaultCenter postNotificationName:ArdiaInterfaceScaleDidSettle object:nil];
}

+ (void)follow:(NSView *)root {
  if ([Roots() containsObject:root]) return;
  [Roots() addObject:root];
  root.postsFrameChangedNotifications = YES;
  objc_setAssociatedObject(root, kFrameWatchKey, [[ArdiaRootFrameWatch alloc] initWithRoot:root], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  FitRoot(root);
}

+ (void)rootAttached:(NSView *)root {
  [self follow:root];
  FitRoot(root);
  [NSNotificationCenter.defaultCenter postNotificationName:ArdiaInterfaceScaleRootDidAttach object:root];
}

+ (void)fitPageHost:(NSView *)host {
  const CGFloat scale = self.scale;
  const NSSize frame = host.frame.size;
  const NSSize want = NSMakeSize(frame.width * scale, frame.height * scale);
  if (!NSEqualSizes(host.bounds.size, want)) [host setBoundsSize:want];
}

+ (NSView *)rootOfWindow:(NSWindow *)window {
  if (!window) return nil;
  for (NSView *root in Roots().allObjects)
    if (root.window == window) return root;
  return nil;
}

+ (NSPoint)windowPointFromRoot:(NSPoint)point inWindow:(NSWindow *)window {
  if (NSView *root = [self rootOfWindow:window]) return [root convertPoint:point toView:nil];
  const CGFloat scale = self.scale;
  return NSMakePoint(point.x * scale, ContentTop(window) - point.y * scale);
}

+ (NSRect)windowRectFromRoot:(NSRect)rect inWindow:(NSWindow *)window {
  if (NSView *root = [self rootOfWindow:window]) return [root convertRect:rect toView:nil];
  const CGFloat scale = self.scale;
  return NSMakeRect(NSMinX(rect) * scale, ContentTop(window) - NSMaxY(rect) * scale, NSWidth(rect) * scale, NSHeight(rect) * scale);
}

+ (NSPoint)rootPointFromWindow:(NSPoint)point inWindow:(NSWindow *)window {
  if (NSView *root = [self rootOfWindow:window]) return [root convertPoint:point fromView:nil];
  const CGFloat scale = self.scale;
  return NSMakePoint(point.x / scale, (ContentTop(window) - point.y) / scale);
}

+ (NSRect)rootRectFromWindow:(NSRect)rect inWindow:(NSWindow *)window {
  if (NSView *root = [self rootOfWindow:window]) return [root convertRect:rect fromView:nil];
  const CGFloat scale = self.scale;
  return NSMakeRect(NSMinX(rect) / scale, (ContentTop(window) - NSMaxY(rect)) / scale, NSWidth(rect) / scale, NSHeight(rect) / scale);
}

+ (NSPoint)screenPointFromRoot:(NSPoint)point inWindow:(NSWindow *)window {
  return [window convertPointToScreen:[self windowPointFromRoot:point inWindow:window]];
}

+ (NSPoint)rootPointFromScreen:(NSPoint)point inWindow:(NSWindow *)window {
  return [self rootPointFromWindow:[window convertPointFromScreen:point] inWindow:window];
}

+ (NSSize)windowSizeFromRoot:(NSSize)size {
  const CGFloat scale = self.scale;
  return NSMakeSize(size.width * scale, size.height * scale);
}

+ (NSSize)rootSizeFromWindow:(NSSize)size {
  const CGFloat scale = self.scale;
  return NSMakeSize(size.width / scale, size.height / scale);
}

+ (CGFloat)windowLengthFromRoot:(CGFloat)length {
  return length * self.scale;
}

+ (CGFloat)rootLengthFromWindow:(CGFloat)length {
  return length / self.scale;
}

@end
