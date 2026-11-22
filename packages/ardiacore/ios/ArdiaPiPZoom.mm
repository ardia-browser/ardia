#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaChromeWindowHost.h"
#import "ArdiaPiPZoomMath.h"

#import <objc/runtime.h>
#import <QuartzCore/QuartzCore.h>

#include <vector>

using namespace ardia_pip;

@implementation ArdiaPiPZoom {
  __weak NSWindow *_window;
  NSRect _last;
  double _width;
  double _aspect;
  double _target;
  NSPoint _pointer;
  NSTimer *_ease;
  NSPanel *_standIn;
  CALayer *_card;
  CALayer *_clip;
  CALayer *_mirror;
  CALayer *_outer;
  CALayer *_inner;
  CALayer *_host;
  __weak CALayer *_source;
  BOOL _handingOff;
  ArdiaConsentStamp *_standInStamp;
  BOOL _standInPinch;
  double _follow;
  NSRect _resizeStart;
  NSPoint _resizeFrom;
  NSInteger _resizeDirection;
  CFTimeInterval _releasedAt;
  CADisplayLink *_link;
  NSRect _stage;
  NSRect _pinchTarget;
  NSRect _shown;
  CFTimeInterval _tickedAt;
  double _standInWidth;
  CGFloat _hiddenAlpha;
  std::vector<double> _appliedAt;
}

static CALayer *LayerHostIn(CALayer *layer) {
  if ([layer isKindOfClass:NSClassFromString(@"CALayerHost")]) return layer;
  for (CALayer *sublayer in layer.sublayers)
    if (CALayer *found = LayerHostIn(sublayer)) return found;
  return nil;
}

static CALayer *CopyGeometry(CALayer *source) {
  CALayer *layer = [CALayer layer];
  layer.anchorPoint = source.anchorPoint;
  layer.bounds = source.bounds;
  layer.position = source.position;
  layer.transform = source.transform;
  layer.sublayerTransform = source.sublayerTransform;
  layer.geometryFlipped = source.geometryFlipped;
  return layer;
}

+ (BOOL)zooms:(NSWindow *)window {
  if (!window.visible || !(window.styleMask & NSWindowStyleMaskResizable)) return NO;
  ArdiaPiPController *controller = [ArdiaPiPController forWindow:window];
  if (controller) return controller.stashedEdge == ArdiaPiPEdgeNone;
  return IsChromeDocumentPictureInPicture(window) && IsChromeFloatingWindow(window);
}

+ (instancetype)forWindow:(NSWindow *)window {
  ArdiaPiPZoom *zoom = objc_getAssociatedObject(window, kZoomKey);
  if (!zoom) {
    zoom = [[ArdiaPiPZoom alloc] init];
    zoom->_window = window;
    objc_setAssociatedObject(window, kZoomKey, zoom, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return zoom;
}

static __weak NSWindow *gZoomGesture;

+ (BOOL)handle:(NSEvent *)event {
  BOOL handled = [self route:event];
  static BOOL trace = [ArdiaLaunchConfig.shared traced:@"pipZoom"];
  if (trace)
    NSLog(@"[pip-zoom] type %lu window %ld (%@) cmd %d phase %lu/%lu dy %.2f precise %d mag %.3f -> %@ %@", (unsigned long)event.type,
          (long)event.windowNumber, event.window.className, (event.modifierFlags & NSEventModifierFlagCommand) != 0,
          (unsigned long)(event.type == NSEventTypeScrollWheel ? event.phase : 0),
          (unsigned long)(event.type == NSEventTypeScrollWheel ? event.momentumPhase : 0),
          event.type == NSEventTypeScrollWheel ? event.scrollingDeltaY : 0,
          event.type == NSEventTypeScrollWheel ? event.hasPreciseScrollingDeltas : 0,
          event.type == NSEventTypeMagnify ? event.magnification : 0, handled ? @"zoomed" : @"passed",
          NSStringFromRect(event.window.frame));
  return handled;
}

+ (NSWindow *)windowFor:(NSEvent *)event {
  if (event.window) return event.window;
  NSPoint point = event.locationInWindow;
  for (NSWindow *window in NSApp.orderedWindows)
    if (NSPointInRect(point, window.frame) && [self zooms:window]) return window;
  return nil;
}

+ (BOOL)route:(NSEvent *)event {
  NSWindow *window = [self windowFor:event];
  BOOL command = (event.modifierFlags & NSEventModifierFlagCommand) != 0;
  BOOL scroll = event.type == NSEventTypeScrollWheel;
  if (scroll) {
    NSEventPhase phase = event.phase, momentum = event.momentumPhase;
    BOOL wheel = phase == NSEventPhaseNone && momentum == NSEventPhaseNone;
    if (wheel || (phase & (NSEventPhaseBegan | NSEventPhaseMayBegin))) gZoomGesture = nil;
    if (gZoomGesture) window = gZoomGesture;
    if (!window || (!command && gZoomGesture != window)) return NO;
    if (![self zooms:window] || ![self enabled]) return NO;
    if (!wheel) gZoomGesture = window;
    if (momentum & (NSEventPhaseEnded | NSEventPhaseCancelled)) gZoomGesture = nil;
    double dy = event.scrollingDeltaY;
    if (dy == 0) return YES;
    [[self forWindow:window] zoomBy:ardia_pip_zoom::ScrollFactor(dy, event.hasPreciseScrollingDeltas)
                                 at:[self screenPoint:event]
                               ease:!event.hasPreciseScrollingDeltas];
    return YES;
  }
  if (!window || ![self zooms:window] || ![self enabled]) return NO;
  ArdiaPiPZoom *zoom = [self forWindow:window];
  if (event.phase & NSEventPhaseBegan) [zoom pinchBegan];
  [zoom pinchBy:ardia_pip_zoom::MagnifyFactor(event.magnification) at:[self screenPoint:event]];
  if (event.phase & (NSEventPhaseEnded | NSEventPhaseCancelled)) [zoom pinchEnded];
  return YES;
}

+ (void)devPinch:(NSWindow *)window args:(NSArray<NSString *> *)args {
  if (args.count != 3 || ![self zooms:window]) return;
  const double total = args[0].doubleValue;
  const int steps = MAX(1, args[1].intValue);
  const double hz = MAX(1.0, args[2].doubleValue);
  ArdiaPiPZoom *zoom = [self forWindow:window];
  zoom->_appliedAt.clear();
  const NSPoint centre = NSMakePoint(NSMidX(window.frame), NSMidY(window.frame));
  const double factor = std::pow(total, 1.0 / steps);
  __block int left = steps;
  [zoom pinchBegan];
  [NSTimer scheduledTimerWithTimeInterval:1.0 / hz repeats:YES block:^(NSTimer *timer) {
    if (!window.visible) return [timer invalidate];
    if (left-- <= 0) {
      [zoom pinchEnded];
      return [timer invalidate];
    }
    [zoom pinchBy:factor at:centre];
  }];
}

+ (NSDictionary *)devPinchStats:(NSWindow *)window {
  ArdiaPiPZoom *zoom = [self forWindow:window];
  std::vector<double> gaps;
  for (size_t i = 1; i < zoom->_appliedAt.size(); i++) gaps.push_back((zoom->_appliedAt[i] - zoom->_appliedAt[i - 1]) * 1000);
  std::sort(gaps.begin(), gaps.end());
  auto at = [&](double q) { return gaps.empty() ? 0.0 : std::round(gaps[std::min(gaps.size() - 1, (size_t)(q * (gaps.size() - 1)))] * 100) / 100; };
  return @{
    @"fps" : @(window.screen.maximumFramesPerSecond),
    @"applied" : @(zoom->_appliedAt.size()),
    @"gapMsMedian" : @(at(0.5)),
    @"gapMsP90" : @(at(0.9)),
    @"gapMsMax" : @(at(1)),
    @"standIn" : @(zoom->_standIn != nil),
    @"alpha" : @(window.alphaValue),
    @"restingAlpha" : @(zoom->_standIn ? zoom->_hiddenAlpha : window.alphaValue),
    @"frame" : NSStringFromRect(window.frame),
    @"shown" : NSStringFromRect(zoom->_shown),
  };
}

+ (NSString *)devStandInWindow:(NSWindow *)window {
  ArdiaPiPZoom *zoom = [self forWindow:window];
  return zoom->_standIn ? [NSString stringWithFormat:@"%ld", (long)zoom->_standIn.windowNumber] : @"";
}

static __weak ArdiaPiPZoom *gEdgeResizing;

+ (BOOL)beginEdgeResize:(NSWindow *)window event:(NSEvent *)event {
  ArdiaPiPController *controller = window ? [ArdiaPiPController forWindow:window] : nil;
  if (!controller || controller.stashedEdge != ArdiaPiPEdgeNone || (event.modifierFlags & NSEventModifierFlagControl) || !window.visible ||
      !(window.styleMask & NSWindowStyleMaskResizable) || ![window respondsToSelector:@selector(_resizeDirectionForMouseLocation:)])
    return NO;
  const NSInteger direction = [window _resizeDirectionForMouseLocation:event.locationInWindow];
  if (direction < 0 || direction > 7) return NO;
  ArdiaPiPZoom *zoom = [self forWindow:window];
  [zoom pinchBegan];
  if (!zoom->_standIn) return NO;
  zoom->_follow = 0;
  zoom->_standInPinch = NO;
  zoom->_resizeStart = zoom->_pinchTarget;
  zoom->_resizeFrom = PointerOf(event);
  zoom->_resizeDirection = direction;
  gEdgeResizing = zoom;
  [controller resizeStarted];
  return YES;
}

+ (BOOL)continueEdgeResize:(NSEvent *)event {
  ArdiaPiPZoom *zoom = gEdgeResizing;
  if (!zoom) return NO;
  if (event.type == NSEventTypeLeftMouseDown) {
    gEdgeResizing = nil;
    [zoom pinchEnded];
    return NO;
  }
  [zoom edgeResizeTo:PointerOf(event)];
  if (event.type == NSEventTypeLeftMouseUp) {
    gEdgeResizing = nil;
    [zoom pinchEnded];
  }
  return YES;
}

- (void)edgeResizeTo:(NSPoint)pointer {
  const NSRect start = _resizeStart;
  static const int kSides[8][2] = {{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}};
  const int sx = kSides[_resizeDirection][0], sy = kSides[_resizeDirection][1];
  const double aspect = NSWidth(start) / MAX(NSHeight(start), 1);
  const double byX = sx * (pointer.x - _resizeFrom.x), byY = sy * (pointer.y - _resizeFrom.y) * aspect;
  double low, high;
  ardia_pip_zoom::WidthLimits(aspect, [self minSize], [self maxSize], [self visible], &low, &high);
  const double width = std::round(std::clamp(NSWidth(start) + (sx && sy ? ardia_pip_zoom::CornerGrowth(byX, byY, aspect) : sx ? byX : byY), low, high));
  const double height = std::round(width / aspect);
  double x = sx > 0 ? NSMinX(start) : sx < 0 ? NSMaxX(start) - width : NSMidX(start) - width / 2;
  double y = sy > 0 ? NSMinY(start) : sy < 0 ? NSMaxY(start) - height : NSMidY(start) - height / 2;
  const ardia_pip_zoom::Rect visible = [self visible];
  x = ardia_pip_zoom::KeptWithin(x, width, NSMinX(start), NSWidth(start), visible.x, visible.maxX());
  y = ardia_pip_zoom::KeptWithin(y, height, NSMinY(start), NSHeight(start), visible.y, visible.maxY());
  const NSRect next = NSMakeRect(std::round(x), std::round(y), width, height);
  if (!ardia_pip_zoom::Finite({NSMinX(next), NSMinY(next), NSWidth(next), NSHeight(next)})) return;
  _width = width;
  _aspect = aspect;
  _pinchTarget = next;
}

- (void)pinchBegan {
  _follow = ardia_pip_zoom::kPinchFollow;
  [_ease invalidate], _ease = nil, _target = 0;
  if (_standIn && _handingOff) {
    [self gestureEnded:NO];
    _handingOff = NO;
    _standInStamp = ArdiaConsentStamp.begin;
    _standInPinch = YES;
    return;
  }
  [self finishHandOff:NO];
  NSWindow *window = _window;
  ArdiaPiPController *controller = [ArdiaPiPController forWindow:window];
  CALayer *source = LayerHostIn(window.contentView.layer);
  Class hostClass = NSClassFromString(@"CALayerHost");
  id context = [source valueForKey:@"contextId"];
  if (!controller || !source || !hostClass || ![context unsignedIntValue] || !source.superlayer.superlayer) return;
  [controller stopMotion];
  const NSRect stage = NSUnionRect(ScreenFor(window.frame).visibleFrame, window.frame);
  NSPanel *panel = [[NSPanel alloc] initWithContentRect:stage
                                              styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
  panel.releasedWhenClosed = NO;
  panel.opaque = NO;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = NO;
  panel.ignoresMouseEvents = YES;
  panel.level = window.level;
  panel.collectionBehavior = window.collectionBehavior;
  panel.animationBehavior = NSWindowAnimationBehaviorNone;
  NSView *content = panel.contentView;
  content.wantsLayer = YES;
  const CGFloat radius = [controller cornerRadius];
  CALayer *card = [CALayer layer];
  card.anchorPoint = CGPointZero;
  card.shadowColor = NSColor.blackColor.CGColor;
  card.shadowOpacity = 0.32;
  card.shadowRadius = 14;
  card.shadowOffset = CGSizeMake(0, -6);
  CALayer *clip = [CALayer layer];
  clip.anchorPoint = CGPointZero;
  clip.cornerRadius = radius;
  clip.cornerCurve = kCACornerCurveCircular;
  clip.masksToBounds = YES;
  clip.borderWidth = 1;
  clip.borderColor = [NSColor colorWithWhite:1 alpha:kRimAlpha].CGColor;
  CALayer *outer = CopyGeometry(source.superlayer.superlayer), *inner = CopyGeometry(source.superlayer);
  CALayer *host = [[hostClass alloc] init];
  [host setValue:context forKey:@"contextId"];
  host.anchorPoint = source.anchorPoint;
  host.bounds = source.bounds;
  host.position = source.position;
  [inner addSublayer:host];
  [outer addSublayer:inner];
  CALayer *mirror = [CALayer layer];
  mirror.anchorPoint = CGPointZero;
  mirror.frame = CGRectMake(0, 0, NSWidth(window.frame), NSHeight(window.frame));
  mirror.zPosition = -1;
  [mirror addSublayer:outer];
  [clip addSublayer:mirror];
  [card addSublayer:clip];
  [content.layer addSublayer:card];
  _standIn = panel;
  _standInStamp = ArdiaConsentStamp.begin;
  _standInPinch = YES;
  _outer = outer;
  _inner = inner;
  _host = host;
  _source = source;
  _handingOff = NO;
  _card = card;
  _clip = clip;
  _mirror = mirror;
  _stage = stage;
  _standInWidth = NSWidth(window.frame);
  _pinchTarget = window.frame;
  _shown = window.frame;
  [self place:_shown];
  [panel orderWindow:NSWindowAbove relativeTo:window.windowNumber];
  _hiddenAlpha = window.alphaValue;
  window.alphaValue = MIN(_hiddenAlpha, ardia_pip_zoom::kHittableHiddenAlpha);
  _tickedAt = 0;
  _link = [content displayLinkWithTarget:self selector:@selector(tick:)];
  [_link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}

- (void)place:(NSRect)frame {
  if (!ardia_pip_zoom::Finite({NSMinX(frame), NSMinY(frame), NSWidth(frame), NSHeight(frame)}) || NSWidth(frame) < 1) return;
  const CGRect local = CGRectMake(NSMinX(frame) - NSMinX(_stage), NSMinY(frame) - NSMinY(_stage), NSWidth(frame), NSHeight(frame));
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  _card.frame = local;
  _clip.frame = CGRectMake(0, 0, local.size.width, local.size.height);
  CGPathRef outline = CGPathCreateWithRoundedRect(_clip.bounds, _clip.cornerRadius, _clip.cornerRadius, nullptr);
  _card.shadowPath = outline;
  CGPathRelease(outline);
  CALayer *source = _source;
  if (source.superlayer.superlayer) {
    for (auto [copy, from] : {std::pair{_outer, source.superlayer.superlayer}, std::pair{_inner, source.superlayer}, std::pair{_host, source}}) {
      copy.bounds = from.bounds;
      copy.position = from.position;
      copy.transform = from.transform;
    }
  }
  const double drawn = source.superlayer.superlayer.bounds.size.width > 1 ? source.superlayer.superlayer.bounds.size.width : _standInWidth;
  const double scale = local.size.width / drawn;
  _mirror.transform = CATransform3DMakeScale(scale, scale, 1);
  [CATransaction commit];
}

- (void)tick:(CADisplayLink *)link {
  NSWindow *window = _window;
  if (!window || !window.visible) return [self cancelStandIn];
  const CFTimeInterval now = link.timestamp;
  const double dt = _tickedAt > 0 ? MIN(now - _tickedAt, 0.05) : 1.0 / 120;
  _tickedAt = now;
  if (_handingOff) {
    [self place:_shown];
    const double drawn = _source.superlayer.superlayer.bounds.size.width;
    const double since = now - _releasedAt;
    const BOOL caughtUp = fabs(drawn - NSWidth(_pinchTarget)) < 1;
    if ((caughtUp && since > ardia_pip_zoom::kHandOffLinger) || since > ardia_pip_zoom::kHandOffTimeout) [self finishHandOff:!caughtUp];
    return;
  }
  if (NSEqualRects(_shown, _pinchTarget)) return;
  const double follow = _follow > 0 ? 1 - std::exp(-dt / _follow) : 1;
  NSRect next = NSMakeRect(NSMinX(_shown) + (NSMinX(_pinchTarget) - NSMinX(_shown)) * follow,
                           NSMinY(_shown) + (NSMinY(_pinchTarget) - NSMinY(_shown)) * follow,
                           NSWidth(_shown) + (NSWidth(_pinchTarget) - NSWidth(_shown)) * follow,
                           NSHeight(_shown) + (NSHeight(_pinchTarget) - NSHeight(_shown)) * follow);
  if (fabs(NSWidth(next) - NSWidth(_pinchTarget)) < 0.5 && fabs(NSMinX(next) - NSMinX(_pinchTarget)) < 0.5 && fabs(NSMinY(next) - NSMinY(_pinchTarget)) < 0.5)
    next = _pinchTarget;
  _shown = next;
  [self place:next];
  if (_appliedAt.size() < 4096) _appliedAt.push_back(CACurrentMediaTime());
}

- (void)pinchBy:(double)factor at:(NSPoint)pointer {
  if (!_standIn) return [self zoomBy:factor at:pointer ease:NO];
  const NSRect frame = _pinchTarget, live = _window.frame;
  if (_width <= 0 || fabs(_width - NSWidth(frame)) > 1 || !(_aspect > 0) || !std::isfinite(_aspect) || fabs(NSWidth(live) / _aspect - NSHeight(live)) > 1) {
    _aspect = NSWidth(live) / MAX(NSHeight(live), 1);
    _width = NSWidth(frame);
  }
  _pointer = pointer;
  ardia_pip_zoom::Result result = ardia_pip_zoom::Zoom(
      {NSMinX(frame), NSMinY(frame), NSWidth(frame), NSHeight(frame)}, _width, _aspect, factor, {_pointer.x, _pointer.y},
      [self visible], [self minSize], [self maxSize]);
  const NSRect next = NSMakeRect(result.frame.x, result.frame.y, result.frame.w, result.frame.h);
  if (!ardia_pip_zoom::Finite({NSMinX(next), NSMinY(next), NSWidth(next), NSHeight(next)})) return;
  _width = result.width;
  _pinchTarget = next;
}

- (void)pinchEnded {
  if (!_standIn || _handingOff) return;
  NSWindow *window = _window;
  const NSRect target = _pinchTarget;
  _shown = target;
  [self place:target];
  if (!NSEqualRects(window.frame, target)) [window setFrame:target display:YES];
  _last = window.frame;
  _width = NSWidth(target);
  _handingOff = YES;
  _releasedAt = _tickedAt > 0 ? _tickedAt : CACurrentMediaTime();
}

- (void)gestureEnded:(BOOL)timedOut {
  ArdiaConsentStamp *stamp = _standInStamp;
  _standInStamp = nil;
  if (!stamp) return;
  [[ArdiaPiPController forWindow:_window].view emit:@"pictureInPictureStandIn"
                                            payload:[stamp onto:@{@"pinch" : @(_standInPinch), @"timedOut" : @(timedOut)}]];
}

- (void)cancelStandIn {
  _standInStamp = nil;
  if (gEdgeResizing == self) gEdgeResizing = nil;
  _handingOff = NO;
  [self finishHandOff:NO];
}

- (void)finishHandOff:(BOOL)timedOut {
  NSPanel *panel = _standIn;
  if (!panel) return;
  if (_handingOff) [self gestureEnded:timedOut];
  _standInStamp = nil;
  _standIn = nil;
  _handingOff = NO;
  [_link invalidate];
  _link = nil;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  _window.alphaValue = _hiddenAlpha;
  [panel orderOut:nil];
  [CATransaction commit];
  _card = nil;
  _clip = nil;
  _mirror = nil;
  _outer = nil;
  _inner = nil;
  _host = nil;
}

+ (NSPoint)screenPoint:(NSEvent *)event {
  return event.window ? [event.window convertPointToScreen:event.locationInWindow] : event.locationInWindow;
}

+ (BOOL)enabled {
  id value = [NSUserDefaults.standardUserDefaults objectForKey:kZoomDefault];
  return value ? [value boolValue] : YES;
}

- (void)zoomBy:(double)factor at:(NSPoint)pointer ease:(BOOL)ease {
  NSWindow *window = _window;
  [[ArdiaPiPController forWindow:window] stopMotion];
  NSRect frame = window.frame;
  if (!NSEqualRects(frame, _last) || _width <= 0) {
    double aspect = NSWidth(frame) / MAX(NSHeight(frame), 1);
    if (!(_aspect > 0 && fabs(NSWidth(frame) / _aspect - NSHeight(frame)) <= 1)) _aspect = aspect;
    _width = NSWidth(frame), _target = 0;
    [_ease invalidate], _ease = nil;
  }
  _pointer = pointer;
  if (!ease) {
    [_ease invalidate], _ease = nil, _target = 0;
    return [self step:factor];
  }
  double low, high;
  ardia_pip_zoom::WidthLimits(_aspect, [self minSize], [self maxSize], [self visible], &low, &high);
  _target = MIN(MAX((_target > 0 ? _target : _width) * factor, low), high);
  if (_ease) return;
  __weak ArdiaPiPZoom *weakSelf = self;
  _ease = [NSTimer timerWithTimeInterval:1.0 / 120 repeats:YES block:^(NSTimer *timer) {
    ArdiaPiPZoom *strongSelf = weakSelf;
    if (!strongSelf || !strongSelf->_window.visible || !NSEqualRects(strongSelf->_window.frame, strongSelf->_last)) {
      if (strongSelf) strongSelf->_ease = nil, strongSelf->_target = 0;
      return [timer invalidate];
    }
    double width = strongSelf->_width, target = strongSelf->_target;
    BOOL done = fabs(target - width) < 0.25;
    [strongSelf step:(done ? target : width + (target - width) * 0.25) / width];
    if (!done) return;
    strongSelf->_ease = nil, strongSelf->_target = 0;
    [timer invalidate];
  }];
  [NSRunLoop.currentRunLoop addTimer:_ease forMode:NSRunLoopCommonModes];
  _last = frame;
}

- (ardia_pip_zoom::Size)minSize {
  NSSize size = _window.contentMinSize;
  return {size.width, size.height};
}

- (ardia_pip_zoom::Size)maxSize {
  NSSize size = _window.contentMaxSize;
  return {size.width > 0 ? size.width : CGFLOAT_MAX, size.height > 0 ? size.height : CGFLOAT_MAX};
}

- (ardia_pip_zoom::Rect)visible {
  NSRect visible = ScreenFor(_window.frame).visibleFrame;
  return {NSMinX(visible), NSMinY(visible), NSWidth(visible), NSHeight(visible)};
}

- (void)step:(double)factor {
  NSWindow *window = _window;
  NSRect frame = window.frame;
  ardia_pip_zoom::Result result = ardia_pip_zoom::Zoom(
      {NSMinX(frame), NSMinY(frame), NSWidth(frame), NSHeight(frame)}, _width, _aspect, factor, {_pointer.x, _pointer.y},
      [self visible], [self minSize], [self maxSize]);
  _width = result.width;
  NSRect next = NSMakeRect(result.frame.x, result.frame.y, result.frame.w, result.frame.h);
  if (!NSEqualRects(next, frame)) [window setFrame:next display:YES];
  _last = window.frame;
}

@end
