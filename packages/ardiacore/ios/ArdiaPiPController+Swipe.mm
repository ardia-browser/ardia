#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaChromeWindowHost.h"
#import "ArdiaPiPSeekMath.h"

#import <objc/runtime.h>
#import <QuartzCore/QuartzCore.h>

using namespace ardia_pip;

@implementation ArdiaPiPController (Swipe)

static __weak NSWindow *gSwipeWindow;
static __weak NSWindow *gSwipeMomentum;

+ (void)abandonSwipeOn:(NSWindow *)window {
  if (!window) return;
  if (gSwipeWindow == window) gSwipeWindow = nil;
  [[self forWindow:window] abandonSwipe];
}

+ (ArdiaPiPController *)swipeTargetFor:(NSEvent *)event {
  NSWindow *window = event.window;
  if (!window) {
    const NSPoint point = PointerOf(event);
    for (NSWindow *candidate in NSApp.orderedWindows)
      if (candidate.visible && NSPointInRect(point, candidate.frame)) {
        window = candidate;
        break;
      }
  }
  ArdiaPiPController *controller = window ? [self forWindow:window] : nil;
  return controller && window.visible ? controller : nil;
}

+ (BOOL)handleSwipe:(NSEvent *)event {
  if (event.type != NSEventTypeScrollWheel) return NO;
  const NSEventPhase phase = event.phase, momentum = event.momentumPhase;
  if (momentum != NSEventPhaseNone) {
    const BOOL ours = gSwipeMomentum != nil;
    if (momentum & (NSEventPhaseEnded | NSEventPhaseCancelled)) gSwipeMomentum = nil;
    return ours;
  }
  if (phase == NSEventPhaseNone) return NO;
  if (phase & (NSEventPhaseBegan | NSEventPhaseMayBegin)) {
    gSwipeMomentum = nil;
    [self abandonSwipeOn:gSwipeWindow];
    if (phase != NSEventPhaseBegan || !ThrowEnabled() || !event.hasPreciseScrollingDeltas ||
        (event.modifierFlags & NSEventModifierFlagCommand))
      return NO;
    ArdiaPiPController *controller = [self swipeTargetFor:event];
    if (!controller) return NO;
    gSwipeWindow = controller.window;
    [controller swipeBegan:event];
    return YES;
  }
  NSWindow *window = gSwipeWindow;
  ArdiaPiPController *controller = window ? [self forWindow:window] : nil;
  if (!controller) return NO;
  if (phase & (NSEventPhaseEnded | NSEventPhaseCancelled)) {
    gSwipeWindow = nil;
    gSwipeMomentum = window;
    [controller swipeEnded:event cancelled:(phase & NSEventPhaseCancelled) != 0];
  } else {
    [controller swipeMoved:event];
  }
  return YES;
}

- (void)dragBegan:(NSEvent *)event {
  [ArdiaPiPController abandonSwipeOn:_window];
  [self stopMotion];
  const NSPoint pointer = PointerOf(event);
  const NSRect frame = _window.frame;
  _dragging = YES;
  _dragMoving = NO;
  _dragFrom = pointer;
  _dragGrab = NSMakePoint(pointer.x - NSMinX(frame), pointer.y - NSMinY(frame));
  _dragHome = [self gestureHome];
  _dragBeganAt = event.timestamp;
  _dragOffCursor = 0;
  _dragMaxOff = 0;
  _dragSlowestMove = 0;
  _dragTrace = [NSMutableArray array];
  _dragSamples.clear();
  _dragSamples.push_back({event.timestamp, pointer.x, pointer.y});
}

- (void)followPointer:(NSEvent *)event {
  const NSPoint pointer = PointerOf(event);
  _dragMoving = _dragMoving || !ardia_pip_seek::IsClick(ardia_pip_seek::Travel(pointer.x - _dragFrom.x, pointer.y - _dragFrom.y));
  if (!_dragMoving) return;
  if (_dragSamples.size() >= 64) _dragSamples.erase(_dragSamples.begin(), _dragSamples.begin() + 32);
  _dragSamples.push_back({event.timestamp, pointer.x, pointer.y});
  const NSRect frame = _window.frame;
  const auto screens = ThrowScreens();
  const ardia_pip_throw::Point at{pointer.x, pointer.y}, grab{_dragGrab.x, _dragGrab.y};
  const auto next = ardia_pip_throw::DragTo(ThrowRect(frame), at, grab, screens.data(), (int)screens.size(), ScreenIndex(_dragHome));
  const NSPoint origin = NSMakePoint(next.x, next.y);
  const CFTimeInterval before = CACurrentMediaTime();
  if (!NSEqualPoints(origin, frame.origin)) [_window setFrameOrigin:origin];
  const double moveMs = (CACurrentMediaTime() - before) * 1000;
  const NSRect placed = _window.frame;
  const BOOL held = ardia_pip_throw::HeldBack(next, at, grab);
  const double off = held ? 0 : MAX(fabs(NSMinX(placed) + _dragGrab.x - pointer.x), fabs(NSMinY(placed) + _dragGrab.y - pointer.y));
  if (off >= 1) _dragOffCursor++;
  _dragMaxOff = MAX(_dragMaxOff, off);
  _dragSlowestMove = MAX(_dragSlowestMove, moveMs);
  if (_dragTrace.count < 2400)
    [_dragTrace addObject:@[
      @(round((event.timestamp - _dragBeganAt) * 10000) / 10000), @(pointer.x), @(pointer.y), @(NSMinX(placed)), @(NSMinY(placed)),
      @(held), @(round(moveMs * 1000) / 1000), @(round((NSProcessInfo.processInfo.systemUptime - event.timestamp) * 1e6) / 1000)
    ]];
}

- (void)dragMoved:(NSEvent *)event {
  if (_dragging) [self followPointer:event];
}

- (void)dragEnded:(NSEvent *)event {
  if (!_dragging) return;
  [self followPointer:event];
  _dragging = NO;
  if (!_dragMoving) {
    _dragSamples.clear();
    _dragTrace = nil;
    return;
  }
  const NSRect frame = _window.frame;
  const NSPoint grabbed = NSMakePoint(NSMinX(frame) + _dragGrab.x, NSMinY(frame) + _dragGrab.y);
  const auto velocity = ardia_pip_throw::ReleaseVelocity(_dragSamples.data(), (int)_dragSamples.size(), event.timestamp);
  _dragSamples.clear();
  _lastDrag = @{
    @"grab" : NSStringFromPoint(_dragGrab),
    @"moves" : @(_dragTrace.count),
    @"offCursorMoves" : @(_dragOffCursor),
    @"maxOffCursor" : @(round(_dragMaxOff * 100) / 100),
    @"slowestMoveMs" : @(round(_dragSlowestMove * 1000) / 1000),
    @"trace" : _dragTrace ?: @[],
  };
  _dragTrace = nil;
  [self.view emit:@"pictureInPictureDragged" payload:@{@"offCursor" : @(_dragOffCursor > 0), @"slowMove" : @(_dragSlowestMove > 8)}];
  [self dragReleasedAt:grabbed velocity:NSMakePoint(velocity.x, velocity.y)];
}

- (void)devSwipe:(NSArray<NSString *> *)args {
  const double fx = args.count > 0 ? args[0].doubleValue : 0, fy = args.count > 1 ? args[1].doubleValue : 0;
  const int steps = MAX(1, args.count > 2 ? args[2].intValue : 10);
  NSString *mode = args.count > 3 ? args[3] : @"trackpad";
  const BOOL wheel = [mode isEqual:@"wheel"], command = [mode isEqual:@"command"];
  const double pause = [mode isEqual:@"pause"] ? 0.3 : 0;
  NSWindow *window = _window;
  NSEvent * (^make)(CGScrollPhase, CGMomentumScrollPhase, double, double) =
      ^NSEvent *(CGScrollPhase phase, CGMomentumScrollPhase momentum, double fdx, double fdy) {
        CGEventRef cg = CGEventCreateScrollWheelEvent2(nullptr, kCGScrollEventUnitPixel, 2, 0, 0, 0);
        const NSRect f = window.frame;
        CGEventSetLocation(cg, CGPointMake(NSMidX(f), NSMaxY(NSScreen.screens.firstObject.frame) - NSMidY(f)));
        CGEventSetIntegerValueField(cg, kCGScrollWheelEventIsContinuous, wheel ? 0 : 1);
        CGEventSetIntegerValueField(cg, kCGScrollWheelEventScrollPhase, wheel ? 0 : phase);
        CGEventSetIntegerValueField(cg, kCGScrollWheelEventMomentumPhase, momentum);
        CGEventSetFlags(cg, command ? kCGEventFlagMaskCommand : 0);
        const BOOL inverted = [NSEvent eventWithCGEvent:cg].isDirectionInvertedFromDevice;
        const double sdx = inverted ? fdx : -fdx, sdy = inverted ? -fdy : fdy;
        if (wheel) {
          CGEventSetIntegerValueField(cg, kCGScrollWheelEventDeltaAxis1, lround(sdy / 10));
          CGEventSetIntegerValueField(cg, kCGScrollWheelEventDeltaAxis2, lround(sdx / 10));
        } else {
          CGEventSetIntegerValueField(cg, kCGScrollWheelEventPointDeltaAxis1, lround(sdy));
          CGEventSetIntegerValueField(cg, kCGScrollWheelEventPointDeltaAxis2, lround(sdx));
          CGEventSetDoubleValueField(cg, kCGScrollWheelEventFixedPtDeltaAxis1, sdy);
          CGEventSetDoubleValueField(cg, kCGScrollWheelEventFixedPtDeltaAxis2, sdx);
        }
        NSEvent *event = [NSEvent eventWithCGEvent:cg];
        CFRelease(cg);
        return event;
      };
  auto post = [=](double seconds, CGScrollPhase phase, CGMomentumScrollPhase momentum, double fdx, double fdy) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      [NSApp postEvent:make(phase, momentum, fdx, fdy) atStart:NO];
    });
  };
  const double interval = 1.0 / 120;
  post(0, kCGScrollPhaseBegan, kCGMomentumScrollPhaseNone, 0, 0);
  for (int i = 1; i <= steps; i++) post(i * interval, kCGScrollPhaseChanged, kCGMomentumScrollPhaseNone, fx / steps, fy / steps);
  const double end = (steps + 1) * interval + pause;
  post(end, kCGScrollPhaseEnded, kCGMomentumScrollPhaseNone, 0, 0);
  if ([mode isEqual:@"momentum"]) {
    post(end + interval, (CGScrollPhase)0, kCGMomentumScrollPhaseBegin, fx / steps, fy / steps);
    for (int i = 2; i <= 6; i++) post(end + i * interval, (CGScrollPhase)0, kCGMomentumScrollPhaseContinue, fx / steps / i, fy / steps / i);
    post(end + 7 * interval, (CGScrollPhase)0, kCGMomentumScrollPhaseEnd, 0, 0);
  }
}

- (void)devDrag:(NSArray<NSString *> *)args {
  const double interval = (args.count > 3 ? args[3].doubleValue : 8) / 1000, pause = (args.count > 4 ? args[4].doubleValue : 0) / 1000;
  NSWindow *window = _window;
  const NSRect frame = window.frame;
  const NSTimeInterval began = NSProcessInfo.processInfo.systemUptime;
  const NSPoint grab = NSMakePoint(NSWidth(frame) * 0.5, NSHeight(frame) * 0.3);
  const NSPoint start = NSMakePoint(NSMinX(frame) + grab.x, NSMinY(frame) + grab.y);
  auto post = [=](double seconds, NSEventType type, NSPoint screen) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      const NSPoint local = NSMakePoint(screen.x - NSMinX(window.frame), screen.y - NSMinY(window.frame));
      [NSApp postEvent:[NSEvent mouseEventWithType:type location:local modifierFlags:0 timestamp:began + seconds
                                      windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1
                                          pressure:type == NSEventTypeLeftMouseUp ? 0 : 1]
               atStart:NO];
    });
  };
  post(0, NSEventTypeLeftMouseDown, start);
  auto number = [=](NSUInteger i, double fallback) { return i < args.count ? args[i].doubleValue : fallback; };
  std::vector<NSUInteger> legs{0};
  for (NSUInteger i = 5; i + 2 < args.count; i += 3) legs.push_back(i);
  NSPoint at = start;
  double t = 0;
  for (NSUInteger i : legs) {
    const double fx = number(i, 0), fy = number(i + 1, 0);
    const int steps = MAX(1, (int)number(i + 2, 10));
    const NSPoint from = at;
    for (int step = 1; step <= steps; step++)
      post(t + step * interval, NSEventTypeLeftMouseDragged, NSMakePoint(from.x + fx * step / steps, from.y + fy * step / steps));
    t += steps * interval;
    at = NSMakePoint(from.x + fx, from.y + fy);
  }
  post(t + pause + 0.004, NSEventTypeLeftMouseUp, at);
}

@end
