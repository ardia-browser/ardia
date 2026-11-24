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
    NSWindow *coasting = gSwipeMomentum;
    if (momentum & (NSEventPhaseEnded | NSEventPhaseCancelled)) gSwipeMomentum = nil;
    if (momentum & NSEventPhaseBegan) [[self forWindow:coasting] swipeCoasted:event];
    return coasting != nil;
  }
  if (phase == NSEventPhaseNone) return NO;
  if (phase & (NSEventPhaseBegan | NSEventPhaseMayBegin)) {
    if (NSWindow *waiting = gSwipeMomentum) [[self forWindow:waiting] swipeInterrupted];
    gSwipeMomentum = nil;
    [self abandonSwipeOn:gSwipeWindow];
    if (phase != NSEventPhaseBegan || !ThrowEnabled() || !event.hasPreciseScrollingDeltas ||
        (event.modifierFlags & NSEventModifierFlagCommand))
      return NO;
    ArdiaPiPController *controller = [self swipeTargetFor:event];
    if (!controller) return NO;
    gSwipeWindow = controller.window;
    ActivateWithOnlyPictureInPicture(controller, YES);
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

- (void)swipeEnded:(NSEvent *)event cancelled:(BOOL)cancelled {
  [self moveBy:ardia_pip_throw::FingerDelta(event.scrollingDeltaX, event.scrollingDeltaY, event.isDirectionInvertedFromDevice)];
  _swiping = NO;
  const ardia_pip_throw::Point last{_swipeLastDelta.x, _swipeLastDelta.y};
  const BOOL fresh = NSProcessInfo.processInfo.systemUptime - _swipeLastAt <= ardia_pip_throw::kVelocityWindow;
  const auto lastVelocity = ardia_pip_throw::SwipeVelocity(last);
  if (cancelled) {
    if (_stashedEdge != ArdiaPiPEdgeNone && [self edgeBeyond] == ArdiaPiPEdgeNone) [self setStashedEdge:ArdiaPiPEdgeNone];
    return [self swipeSettledAt:_window.frame thrown:NO how:@"cancelled" stashed:ArdiaPiPEdgeNone velocity:NSZeroPoint];
  }
  const NSRect out = [self leaveTuckIfPulledOut:fresh ? NSMakePoint(lastVelocity.x, lastVelocity.y) : NSZeroPoint];
  if (!NSIsEmptyRect(out)) return [self swipeSettledAt:out thrown:YES how:@"cameOut" stashed:ArdiaPiPEdgeNone velocity:NSZeroPoint];
  const ArdiaPiPEdge edge = [self edgeBeyond];
  if (edge != ArdiaPiPEdgeNone) {
    [self stashAt:edge];
    return [self swipeSettledAt:[self frameStashedAt:edge] thrown:NO how:@"tucked" stashed:edge velocity:NSZeroPoint];
  }
  if (_stashedEdge != ArdiaPiPEdgeNone) [self setStashedEdge:ArdiaPiPEdgeNone];
  if (NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return [self swipeReleased:NSZeroPoint how:@"reduceMotion"];
  if (fresh && ardia_pip_throw::SwipeSurelyFlings(last))
    return [self swipeReleased:NSMakePoint(lastVelocity.x, lastVelocity.y) how:@"lastEvent"];
  _awaitingMomentum = YES;
  [self performSelector:@selector(swipeDidNotCoast) withObject:nil afterDelay:ardia_pip_throw::kMomentumWait];
}

- (void)forgetMomentum {
  if (!_awaitingMomentum) return;
  _awaitingMomentum = NO;
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(swipeDidNotCoast) object:nil];
}

- (void)swipeDidNotCoast {
  if (!_awaitingMomentum) return;
  _awaitingMomentum = NO;
  _swipePlaced = _window.frame;
  [self swipeReleased:NSZeroPoint how:@"placed"];
}

- (void)reportPlacement {
  if (!_placementStamp) return;
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(reportPlacement) object:nil];
  [self reportRelease:@"placed" stamp:_placementStamp];
  _placementStamp = nil;
}

- (void)endMomentumWait {
  [self reportPlacement];
  if (!_awaitingMomentum) return;
  [self forgetMomentum];
  if (!ardia_host::Background()) [NSCursor setHiddenUntilMouseMoves:NO];
  [self reportRelease:@"placed" stamp:_swipeStamp];
}

- (void)swipeInterrupted {
  [self reportPlacement];
  if (!_awaitingMomentum) return;
  [self forgetMomentum];
  [self swipeSettledAt:_window.frame thrown:NO how:@"interrupted" stashed:ArdiaPiPEdgeNone velocity:NSZeroPoint];
}

- (void)swipeCoasted:(NSEvent *)event {
  const BOOL late = !_awaitingMomentum && _placementStamp && !_swiping && !_dragging && !_animating && NSEqualRects(_window.frame, _swipePlaced);
  if (!_awaitingMomentum && !late) return;
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(reportPlacement) object:nil];
  _placementStamp = nil;
  [self forgetMomentum];
  const auto delta = ardia_pip_throw::FingerDelta(event.scrollingDeltaX, event.scrollingDeltaY, event.isDirectionInvertedFromDevice);
  const auto velocity = ardia_pip_throw::SwipeVelocity(delta);
  const BOOL flings = ardia_pip_throw::DragFlings(velocity);
  [self swipeReleased:flings ? NSMakePoint(velocity.x, velocity.y) : NSZeroPoint how:flings ? @"flicked" : @"coastedSlowly"];
}

- (ArdiaPiPEdge)edgeFlickedPast:(NSPoint)velocity {
  const NSRect frame = _window.frame;
  const auto landing = ardia_pip_throw::FlickLanding(ThrowRect(frame), {velocity.x, velocity.y});
  const NSRect visible = [self homeScreen].visibleFrame;
  const ArdiaPiPEdge aimedAt = [self edgeBeyondFor:NSMakeRect(landing.x, landing.y, landing.w, landing.h)];
  const BOOL alreadyPast = aimedAt == ArdiaPiPEdgeRight ? NSMaxX(frame) > NSMaxX(visible) : NSMinX(frame) < NSMinX(visible);
  return alreadyPast ? aimedAt : ArdiaPiPEdgeNone;
}

- (void)reportRelease:(NSString *)outcome stamp:(ArdiaConsentStamp *)stamp {
  if (stamp) [self.view emit:@"pictureInPictureReleased" payload:[stamp onto:@{@"outcome" : outcome}]];
}

- (void)swipeReleased:(NSPoint)velocity how:(NSString *)how {
  const NSRect frame = _window.frame;
  const NSPoint grab = NSMakePoint(NSMinX(frame) + _swipeGrab.x, NSMinY(frame) + _swipeGrab.y);
  ArdiaPiPEdge edge = ArdiaPiPEdgeNone;
  NSRect destination = frame;
  BOOL thrown = NO;
  if (velocity.x != 0 || velocity.y != 0) {
    edge = [self edgeFlickedPast:velocity];
    if (edge != ArdiaPiPEdgeNone) {
      [self stashAt:edge];
      destination = [self frameStashedAt:edge];
      how = @"flickedAway";
    } else if ([self throwFrom:grab velocity:velocity]) {
      thrown = YES;
    }
  } else if ([self settleIntoCornerPulledInto:NSZeroPoint]) {
    thrown = YES;
    how = @"settledInCorner";
  }
  if (thrown) destination = NSRectFromString(_lastThrow[@"target"]);
  [self swipeSettledAt:destination thrown:thrown how:how stashed:edge velocity:velocity];
}

- (void)swipeSettledAt:(NSRect)destination thrown:(BOOL)thrown how:(NSString *)how stashed:(ArdiaPiPEdge)edge velocity:(NSPoint)velocity {
  const NSPoint landing = NSMakePoint(NSMinX(destination) + _swipeGrab.x, NSMinY(destination) + _swipeGrab.y);
  const BOOL unmoved = NSEqualPoints(NSEvent.mouseLocation, _swipePointer);
  const BOOL warp = edge == ArdiaPiPEdgeNone && unmoved && (!thrown || CACurrentMediaTime() - _swipeBeganAt >= 0.15);
  if (!ardia_host::Background()) {
    if (warp) {
      CGWarpMouseCursorPosition(CGPointMake(landing.x, NSMaxY(NSScreen.screens.firstObject.frame) - landing.y));
      [NSCursor setHiddenUntilMouseMoves:YES];
    } else {
      [NSCursor setHiddenUntilMouseMoves:NO];
    }
  }
  NSString *outcome = [how isEqual:@"cameOut"] ? @"pullOut" : [how isEqual:@"settledInCorner"] ? @"cornerPull" : [how isEqual:@"flickedAway"] ? @"flickTuck" : edge != ArdiaPiPEdgeNone ? @"tuck" : thrown ? @"corner" : @"placed";
  if ([how isEqual:@"placed"]) {
    _placementStamp = _swipeStamp;
    [self performSelector:@selector(reportPlacement) withObject:nil afterDelay:ardia_pip_throw::kMomentumLate];
  } else {
    [self reportRelease:outcome stamp:_swipeStamp];
  }
  _lastSwipe = @{
    @"outcome" : outcome,
    @"start" : NSStringFromRect(_swipeStart),
    @"released" : NSStringFromRect(_window.frame),
    @"lastDelta" : NSStringFromPoint(_swipeLastDelta),
    @"velocity" : NSStringFromPoint(velocity),
    @"how" : how,
    @"flings" : @(velocity.x != 0 || velocity.y != 0),
    @"thrown" : @(thrown),
    @"stashed" : @(edge),
    @"warp" : warp ? NSStringFromPoint(landing) : @"",
  };
  [self rescueIfLost];
}

- (BOOL)settleIntoCornerPulledInto:(NSPoint)velocity {
  const NSRect frame = _window.frame;
  const auto visible = ThrowRect([self homeScreen].visibleFrame);
  const auto corner = ardia_pip_throw::CornerPulledInto(ThrowRect(_pullStart), ThrowRect(frame), visible);
  if (corner == ardia_pip_throw::kNoCorner || !ThrowEnabled() || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return NO;
  const auto target = ardia_pip_throw::CornerFrame(corner, NSWidth(frame), NSHeight(frame), visible);
  [self throwTo:NSMakeRect(target.x, target.y, target.w, target.h) velocity:velocity corner:corner];
  return YES;
}

- (NSRect)leaveTuckIfPulledOut:(NSPoint)velocity {
  const ArdiaPiPEdge from = _pulledFrom;
  _pulledFrom = ArdiaPiPEdgeNone;
  if (from == ArdiaPiPEdgeNone) return NSZeroRect;
  const NSRect frame = _window.frame;
  NSScreen *tuckedOn = _pulledFromScreen;
  const NSRect visible = (tuckedOn ?: [self homeScreen]).visibleFrame;
  const CGFloat fromTucked = from == ArdiaPiPEdgeRight ? NSMaxX(visible) - kPeek - NSMinX(frame) : NSMaxX(frame) - (NSMinX(visible) + kPeek);
  if ([self edgeBeyond] != ArdiaPiPEdgeNone && !ardia_pip_throw::PulledOutOfTuck(fromTucked)) return NSZeroRect;
  if (ardia_pip_throw::PulledPastHalf(ThrowRect(frame), ThrowRect(visible), from == ArdiaPiPEdgeRight)) return NSZeroRect;
  return [self leaveTuckAt:from on:visible velocity:velocity];
}

- (void)dragBegan:(NSEvent *)event {
  [ArdiaPiPController abandonSwipeOn:_window];
  [self stopMotion];
  _pulledFrom = _stashedEdge;
  _pulledFromScreen = [self gestureHome];
  _pullStart = _window.frame;
  const NSPoint pointer = PointerOf(event);
  const NSRect frame = _window.frame;
  _dragging = YES;
  _dragMoving = NO;
  _dragFrom = pointer;
  _dragGrab = NSMakePoint(pointer.x - NSMinX(frame), pointer.y - NSMinY(frame));
  _dragHome = [self gestureHome];
  _dragBeganAt = event.timestamp;
  _dragStamp = ArdiaConsentStamp.begin;
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

- (void)unstashFromHandle {
  if (_stashedEdge == ArdiaPiPEdgeNone) return;
  [self unstash];
  [self.view emit:@"pictureInPictureUnstashed" payload:[(_dragStamp ?: ArdiaConsentStamp.begin) onto:@{}]];
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
  [self.view emit:@"pictureInPictureDragged" payload:[_dragStamp onto:@{@"offCursor" : @(_dragOffCursor > 0), @"slowMove" : @(_dragSlowestMove > 8)}]];
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
