#import "ArdiaMorphLayout.h"

#import <React/RCTShadowView.h>
#import <React/RCTUIManager.h>
#import <React/RCTUIManagerUtils.h>
#import <React/RCTView.h>
#import <QuartzCore/QuartzCore.h>
#import <os/lock.h>

static NSString *const kMorphMask = @"ardia.morph.mask";

@implementation ArdiaMorphLayout {
  os_unfair_lock _lock;
  NSMutableDictionary<NSNumber *, NSNumber *> *_pending;
  NSMutableDictionary<NSNumber *, NSArray<NSNumber *> *> *_pendingClips;
  BOOL _scheduled;
}

static void ClipView(NSView *view, CGFloat width, BOOL right) {
  CALayer *layer = view.layer;
  if (!layer) return;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  if (width < 0) {
    if ([layer.mask.name isEqualToString:kMorphMask]) layer.mask = nil;
  } else {
    CALayer *mask = [layer.mask.name isEqualToString:kMorphMask] ? layer.mask : nil;
    if (!mask) {
      mask = [CALayer layer];
      mask.name = kMorphMask;
      mask.backgroundColor = NSColor.blackColor.CGColor;
      layer.mask = mask;
    }
    const CGRect bounds = layer.bounds;
    const CGFloat shown = MAX(width, 0);
    mask.frame = CGRectMake(right ? bounds.size.width - shown : 0, 0, shown, bounds.size.height);
  }
  [CATransaction commit];
}

- (instancetype)initWithUIManager:(nullable id)uiManager {
  if ((self = [super init])) {
    _uiManager = [uiManager isKindOfClass:RCTUIManager.class] ? uiManager : nil;
    _lock = OS_UNFAIR_LOCK_INIT;
    _pending = [NSMutableDictionary new];
    _pendingClips = [NSMutableDictionary new];
  }
  return self;
}

- (void)setWidth:(CGFloat)width ofTag:(NSNumber *)tag {
  os_unfair_lock_lock(&_lock);
  _pending[tag] = @(width);
  os_unfair_lock_unlock(&_lock);
  [self schedule];
}

- (void)clipTag:(NSNumber *)tag toWidth:(CGFloat)width fromRight:(BOOL)right {
  os_unfair_lock_lock(&_lock);
  _pendingClips[tag] = @[ @(width), @(right) ];
  os_unfair_lock_unlock(&_lock);
  [self schedule];
}

- (void)schedule {
  RCTUIManager *uiManager = _uiManager;
  if (!uiManager) return;
  os_unfair_lock_lock(&_lock);
  const BOOL schedule = !_scheduled;
  _scheduled = YES;
  os_unfair_lock_unlock(&_lock);
  if (!schedule) return;
  __weak ArdiaMorphLayout *weakSelf = self;
  dispatch_async(RCTGetUIManagerQueue(), ^{
    [weakSelf commitOnShadowQueue];
  });
}

- (void)commitOnShadowQueue {
  RCTUIManager *uiManager = _uiManager;
  os_unfair_lock_lock(&_lock);
  NSDictionary<NSNumber *, NSNumber *> *widths = [_pending copy];
  NSDictionary<NSNumber *, NSArray<NSNumber *> *> *clips = [_pendingClips copy];
  [_pending removeAllObjects];
  [_pendingClips removeAllObjects];
  _scheduled = NO;
  os_unfair_lock_unlock(&_lock);
  if (!uiManager) return;
  NSMutableArray<NSNumber *> *missing = [NSMutableArray new];
  __block BOOL changed = NO;
  [widths enumerateKeysAndObjectsUsingBlock:^(NSNumber *tag, NSNumber *width, BOOL *stop) {
    RCTShadowView *shadow = [uiManager shadowViewForReactTag:tag];
    if (!shadow) {
      [missing addObject:tag];
      return;
    }
    const YGValue next = {width.floatValue, YGUnitPoint};
    const YGValue now = shadow.width;
    if (now.unit == YGUnitPoint && now.value == next.value) return;
    shadow.width = next;
    changed = YES;
  }];
  if (clips.count) {
    [uiManager addUIBlock:^(__unused RCTUIManager *manager, NSDictionary<NSNumber *, RCTPlatformView *> *viewRegistry) {
      [clips enumerateKeysAndObjectsUsingBlock:^(NSNumber *tag, NSArray<NSNumber *> *clip, BOOL *stop) {
        ClipView(viewRegistry[tag], clip[0].doubleValue, clip[1].boolValue);
      }];
    }];
  }
  if (changed || clips.count) [uiManager setNeedsLayout];
  if (!missing.count) return;
  __weak ArdiaMorphLayout *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    ArdiaMorphLayout *strongSelf = weakSelf;
    if (strongSelf.onMissing) strongSelf.onMissing(missing);
  });
}

#if DEBUG
+ (double)hoverCheckMilliseconds:(NSInteger)passes {
  SEL check = NSSelectorFromString(@"ardia_checkHover");
  if (![RCTView respondsToSelector:check] || passes <= 0) return -1;
  const CFTimeInterval start = CACurrentMediaTime();
  for (NSInteger i = 0; i < passes; i++) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    [RCTView performSelector:check];
#pragma clang diagnostic pop
  }
  return (CACurrentMediaTime() - start) * 1000 / passes;
}

+ (CGFloat)shownWidthOfTag:(NSNumber *)tag in:(id)manager {
  RCTUIManager *uiManager = [manager isKindOfClass:RCTUIManager.class] ? manager : nil;
  NSView *view = [uiManager viewForReactTag:tag];
  return view ? view.frame.size.width : -1;
}

+ (CGFloat)maskWidthOfTag:(NSNumber *)tag in:(id)manager {
  RCTUIManager *uiManager = [manager isKindOfClass:RCTUIManager.class] ? manager : nil;
  CALayer *mask = [uiManager viewForReactTag:tag].layer.mask;
  return [mask.name isEqualToString:kMorphMask] ? mask.frame.size.width : -1;
}
#endif

@end
