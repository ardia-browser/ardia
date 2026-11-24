#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaRuntime.h"

#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

#include <optional>

using namespace ardia_pip;

namespace {

enum class ResizePosition { kRight, kTopRight, kTop, kTopLeft, kLeft, kBottomLeft, kBottom, kBottomRight };

BOOL Resizes(NSWindow *window) {
  ArdiaPiPController *controller = [ArdiaPiPController forWindow:window];
  return controller && controller.stashedEdge == ArdiaPiPEdgeNone && window.visible && (window.styleMask & NSWindowStyleMaskResizable) &&
         !(window.styleMask & NSWindowStyleMaskFullScreen) && [window respondsToSelector:@selector(_resizeDirectionForMouseLocation:)];
}

std::optional<ResizePosition> PositionAt(NSWindow *window, NSPoint point) {
  if (!Resizes(window)) return std::nullopt;
  const NSInteger direction = [window _resizeDirectionForMouseLocation:point];
  if (direction < 0 || direction > 7) return std::nullopt;
  return static_cast<ResizePosition>(direction);
}

NSCursor *CursorFor(ResizePosition position) API_AVAILABLE(macos(15.0)) {
  NSCursorFrameResizePosition frame;
  switch (position) {
    case ResizePosition::kTop: frame = NSCursorFrameResizePositionTop; break;
    case ResizePosition::kLeft: frame = NSCursorFrameResizePositionLeft; break;
    case ResizePosition::kBottom: frame = NSCursorFrameResizePositionBottom; break;
    case ResizePosition::kRight: frame = NSCursorFrameResizePositionRight; break;
    case ResizePosition::kTopLeft: frame = NSCursorFrameResizePositionTopLeft; break;
    case ResizePosition::kTopRight: frame = NSCursorFrameResizePositionTopRight; break;
    case ResizePosition::kBottomLeft: frame = NSCursorFrameResizePositionBottomLeft; break;
    case ResizePosition::kBottomRight: frame = NSCursorFrameResizePositionBottomRight; break;
  }
  return [NSCursor frameResizeCursorFromPosition:frame inDirections:NSCursorFrameResizeDirectionsAll];
}

NSCursor *AppKitCursor(NSString *name, NSCursor *fallback) {
  SEL selector = NSSelectorFromString(name);
  if (![NSCursor respondsToSelector:selector]) return fallback;
  id cursor = ((id (*)(id, SEL))objc_msgSend)(NSCursor.class, selector);
  return [cursor isKindOfClass:NSCursor.class] ? cursor : fallback;
}

NSCursor *LegacyCursorFor(ResizePosition position) {
  switch (position) {
    case ResizePosition::kTop:
    case ResizePosition::kBottom: return NSCursor.resizeUpDownCursor;
    case ResizePosition::kLeft:
    case ResizePosition::kRight: return NSCursor.resizeLeftRightCursor;
    case ResizePosition::kTopLeft:
    case ResizePosition::kBottomRight: return AppKitCursor(@"_windowResizeNorthWestSouthEastCursor", NSCursor.crosshairCursor);
    case ResizePosition::kTopRight:
    case ResizePosition::kBottomLeft: return AppKitCursor(@"_windowResizeNorthEastSouthWestCursor", NSCursor.crosshairCursor);
  }
}

NSString *PositionName(ResizePosition position) {
  switch (position) {
    case ResizePosition::kTop: return @"top";
    case ResizePosition::kLeft: return @"left";
    case ResizePosition::kBottom: return @"bottom";
    case ResizePosition::kRight: return @"right";
    case ResizePosition::kTopLeft: return @"topLeft";
    case ResizePosition::kTopRight: return @"topRight";
    case ResizePosition::kBottomLeft: return @"bottomLeft";
    case ResizePosition::kBottomRight: return @"bottomRight";
  }
}

NSCursor *ResizeCursorAt(NSWindow *window, NSPoint point) {
  const std::optional<ResizePosition> position = PositionAt(window, point);
  if (!position) return nil;
  if (@available(macOS 15.0, *)) return CursorFor(*position);
  return LegacyCursorFor(*position);
}

int gBackgroundCursorResult = -100;

void SetCursorInBackground(BOOL allowed) {
  using DefaultConnection = int (*)(void);
  using SetConnectionProperty = int (*)(int, int, CFStringRef, CFTypeRef);
  static const auto connection = (DefaultConnection)dlsym(RTLD_DEFAULT, "_CGSDefaultConnection");
  static const auto set = (SetConnectionProperty)dlsym(RTLD_DEFAULT, "CGSSetConnectionProperty");
  if (!connection || !set) {
    gBackgroundCursorResult = -99;
    return;
  }
  const int cid = connection();
  gBackgroundCursorResult = set(cid, cid, CFSTR("SetsCursorInBackground"), allowed ? kCFBooleanTrue : kCFBooleanFalse);
}

NSCursor *ChromeCursor(NSWindow *window) {
  id delegate = window.delegate;
  NSCursor *cursor = [delegate respondsToSelector:@selector(cursor)] ? [delegate performSelector:@selector(cursor)] : nil;
  return [cursor isKindOfClass:NSCursor.class] ? cursor : NSCursor.arrowCursor;
}

void KeepResizeCursorOnChromeCursorUpdates(Class windowClass) {
  static NSMutableSet<Class> *done = [NSMutableSet set];
  if (!windowClass || [done containsObject:windowClass]) return;
  [done addObject:windowClass];
  SEL update = @selector(cursorUpdate:);
  ardia_runtime::ReplaceMethod(windowClass, update, ^id(IMP original) {
    return ^(NSWindow *window, NSEvent *event) {
      ArdiaPiPResizeCursor *resize = [ArdiaPiPController forWindow:window].resizeCursor;
      if (resize && [resize follow:event.locationInWindow]) return;
      ((void (*)(id, SEL, NSEvent *))original)(window, update, event);
    };
  });
}

}

@implementation ArdiaPiPResizeCursor {
  __weak NSWindow *_window;
  __weak NSView *_view;
  NSTrackingArea *_tracking;
  BOOL _showing;
  BOOL _inBackground;
  NSInteger _shown;
  NSInteger _resizes;
  NSInteger _resizesWithoutCursor;
}

- (instancetype)initWithWindow:(NSWindow *)window view:(NSView *)view {
  if ((self = [super init])) {
    _window = window;
    _view = view;
    _enabled = YES;
    _tracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect
                                             options:NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways |
                                                     NSTrackingInVisibleRect
                                               owner:self
                                            userInfo:nil];
    [view addTrackingArea:_tracking];
    KeepResizeCursorOnChromeCursorUpdates(window.class);
  }
  return self;
}

- (void)detach {
  [_view removeTrackingArea:_tracking];
  [self stopShowing:nil];
}

- (void)stopShowing:(NSCursor *)cursor {
  if (_showing) [cursor set];
  _showing = NO;
  if (_inBackground) SetCursorInBackground(NO);
  _inBackground = NO;
}

- (BOOL)showing { return _showing; }

- (void)setEnabled:(BOOL)enabled {
  _enabled = enabled;
  if (!enabled) [self stopShowing:NSCursor.arrowCursor];
}

- (BOOL)follow:(NSPoint)pointInWindow {
  NSWindow *window = _window;
  if (!_enabled) return NO;
  if (NSEvent.pressedMouseButtons) return _showing;
  if (NSCursor *resize = window ? ResizeCursorAt(window, pointInWindow) : nil) {
    if (!_inBackground) {
      SetCursorInBackground(YES);
      _inBackground = YES;
    }
    [resize set];
    if (!_showing) _shown++;
    _showing = YES;
    return YES;
  }
  [self stopShowing:ChromeCursor(window)];
  return NO;
}

- (void)mouseEntered:(NSEvent *)event { [self follow:event.locationInWindow]; }
- (void)mouseMoved:(NSEvent *)event { [self follow:event.locationInWindow]; }
- (void)mouseExited:(NSEvent *)event { [self stopShowing:NSCursor.arrowCursor]; }

- (NSDictionary *)resizeStarted {
  NSWindow *window = _window;
  const NSPoint pointer = window ? [window convertPointFromScreen:NSEvent.mouseLocation] : NSZeroPoint;
  const BOOL inside = window && NSPointInRect(pointer, NSMakeRect(0, 0, NSWidth(window.frame), NSHeight(window.frame)));
  const BOOL cursorShown = !inside || _showing;
  _resizes++;
  if (!cursorShown) _resizesWithoutCursor++;
  return @{@"inside" : @(inside), @"cursorShown" : @(cursorShown)};
}

- (NSDictionary *)probe {
  NSWindow *window = _window;
  if (!window) return @{};
  const NSSize size = window.frame.size;
  NSMutableArray *edges = [NSMutableArray array];
  const CGFloat offsets[] = {-6, -3, -1, 0, 1, 2, 3, 4, 5, 6, 8, 10, 14};
  NSDictionary<NSString *, NSValue *> *anchors = @{
    @"left" : [NSValue valueWithPoint:NSMakePoint(0, size.height / 2)],
    @"right" : [NSValue valueWithPoint:NSMakePoint(size.width, size.height / 2)],
    @"top" : [NSValue valueWithPoint:NSMakePoint(size.width / 2, size.height)],
    @"bottom" : [NSValue valueWithPoint:NSMakePoint(size.width / 2, 0)],
    @"topLeft" : [NSValue valueWithPoint:NSMakePoint(0, size.height)],
    @"bottomRight" : [NSValue valueWithPoint:NSMakePoint(size.width, 0)],
  };
  for (NSString *name in anchors) {
    const NSPoint anchor = anchors[name].pointValue;
    const CGFloat inX = anchor.x == 0 ? 1 : anchor.x == size.width ? -1 : 0;
    const CGFloat inY = anchor.y == 0 ? 1 : anchor.y == size.height ? -1 : 0;
    NSMutableArray *row = [NSMutableArray array];
    for (CGFloat offset : offsets) {
      const NSPoint point = NSMakePoint(anchor.x + inX * offset, anchor.y + inY * offset);
      const std::optional<ResizePosition> position = PositionAt(window, point);
      [row addObject:@{
        @"in" : @(offset),
        @"direction" : @([window _resizeDirectionForMouseLocation:point]),
        @"cursor" : position ? PositionName(*position) : @"",
      }];
    }
    [edges addObject:@{@"edge" : name, @"points" : row}];
  }
  return @{
    @"size" : NSStringFromSize(size),
    @"resizes" : @(Resizes(window)),
    @"enabled" : @(_enabled),
    @"backgroundCursorResult" : @(gBackgroundCursorResult),
    @"appActive" : @(NSApp.isActive),
    @"showing" : @(_showing),
    @"shown" : @(_shown),
    @"resizeStarts" : @(_resizes),
    @"resizeStartsWithoutCursor" : @(_resizesWithoutCursor),
    @"edges" : edges,
  };
}

@end
