#import "ArdiaInternal.h"
#import "ArdiaContentBlockerInternal.h"
#import "ArdiaRuntime.h"

#import <React/RCTCursor.h>
#import <React/RCTView.h>

namespace ardia_host {

namespace {

id gCursorMonitor;
__weak NSCursor *gLastPageCursor;
NSUInteger gRestores = 0;
NSUInteger gHiddenRestores = 0;
NSUInteger gCoveredPageCursorsHeld = 0;
NSString *gLastRestore;

Class PageViewClass() {
  static Class page = NSClassFromString(@"RenderWidgetHostViewCocoa");
  return page;
}

NSView *ViewAt(NSWindow *window, NSPoint pointInWindow) {
  NSView *content = window.contentView;
  if (!content.superview) return nil;
  return [content hitTest:[content.superview convertPoint:pointInWindow fromView:nil]];
}

NSView *EnclosingPageView(NSView *view) {
  Class page = PageViewClass();
  if (!page) return nil;
  for (NSView *v = view; v; v = v.superview)
    if ([v isKindOfClass:page]) return v;
  return nil;
}

bool IsArdiaSurface(NSWindow *window, NSView *hit) {
  if ([ArdiaWindowController forNSWindow:window]) return true;
  for (NSView *v = hit; v; v = v.superview)
    if ([NSBundle bundleForClass:v.class] == NSBundle.mainBundle) return true;
  return false;
}

bool ImageIsInvisible(NSImage *image) {
  if (!image || image.size.width < 1 || image.size.height < 1 || !image.representations.count) return true;
  const NSInteger side = 64;
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr pixelsWide:side pixelsHigh:side bitsPerSample:8
                                                                samplesPerPixel:4 hasAlpha:YES isPlanar:NO
                                                                 colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:side * 4 bitsPerPixel:32];
  NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
  if (!context) return false;
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = context;
  [image drawInRect:NSMakeRect(0, 0, side, side) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
  [NSGraphicsContext restoreGraphicsState];
  const unsigned char *bytes = bitmap.bitmapData;
  for (NSInteger i = 3; i < side * side * 4; i += 4)
    if (bytes[i]) return false;
  return true;
}

bool IsInvisible(NSCursor *cursor) {
  if (!cursor) return false;
  static NSMapTable<NSCursor *, NSNumber *> *known = [NSMapTable weakToStrongObjectsMapTable];
  if (NSNumber *seen = [known objectForKey:cursor]) return seen.boolValue;
  const bool invisible = ImageIsInvisible(cursor.image);
  [known setObject:@(invisible) forKey:cursor];
  return invisible;
}

bool OverridesCursorHandling(Class cls) {
  static NSMutableDictionary<NSString *, NSNumber *> *known = [NSMutableDictionary dictionary];
  NSString *name = NSStringFromClass(cls);
  if (NSNumber *seen = known[name]) return seen.boolValue;
  const bool overrides =
      class_getMethodImplementation(cls, @selector(resetCursorRects)) != class_getMethodImplementation(NSView.class, @selector(resetCursorRects)) ||
      class_getMethodImplementation(cls, @selector(cursorUpdate:)) != class_getMethodImplementation(NSView.class, @selector(cursorUpdate:));
  known[name] = @(overrides);
  return overrides;
}

NSCursor *CursorOfAppView(NSView *hit, NSView *content, bool *ownsCursor) {
  *ownsCursor = false;
  for (NSView *v = hit; v && v != content; v = v.superview) {
    if ([v isKindOfClass:RCTView.class]) {
      const RCTCursor cursor = ((RCTView *)v).cursor;
      if (cursor != RCTCursorAuto) return NSCursorFromRCTCursor(cursor);
      continue;
    }
    if ([v isKindOfClass:NSTextView.class]) {
      if (((NSTextView *)v).isSelectable) return NSCursor.IBeamCursor;
      continue;
    }
    if ([v isKindOfClass:NSTextField.class]) {
      NSTextField *field = (NSTextField *)v;
      if (field.isEditable || field.isSelectable) return NSCursor.IBeamCursor;
      continue;
    }
    if ([v isKindOfClass:NSClipView.class]) {
      if (NSCursor *document = ((NSClipView *)v).documentCursor) return document;
      continue;
    }
    if ([v isKindOfClass:NSScrollView.class]) {
      if (NSCursor *document = ((NSScrollView *)v).documentCursor) return document;
      continue;
    }
    if (OverridesCursorHandling(v.class)) {
      *ownsCursor = true;
      return nil;
    }
  }
  return nil;
}

NSString *CursorName(NSCursor *cursor) {
  if (!cursor) return @"none set";
  NSDictionary<NSString *, NSCursor *> *named = @{
    @"arrow" : NSCursor.arrowCursor,
    @"iBeam" : NSCursor.IBeamCursor,
    @"pointingHand" : NSCursor.pointingHandCursor,
    @"crosshair" : NSCursor.crosshairCursor,
    @"resizeLeftRight" : NSCursor.resizeLeftRightCursor,
    @"resizeUpDown" : NSCursor.resizeUpDownCursor,
    @"openHand" : NSCursor.openHandCursor,
    @"closedHand" : NSCursor.closedHandCursor,
    @"operationNotAllowed" : NSCursor.operationNotAllowedCursor,
  };
  for (NSString *name in named)
    if (named[name] == cursor) return name;
  if (IsInvisible(cursor)) return @"hidden";
  return [NSString stringWithFormat:@"other %.0fx%.0f", cursor.image.size.width, cursor.image.size.height];
}

NSWindow *WindowUnderPointer(NSEvent *event) {
  NSWindow *window = event.window;
  if (!window || ardia_content_blocker::IsHiddenPageWindow(window)) return nil;
  if (Background()) return window;
  const NSInteger under = [NSWindow windowNumberAtPoint:NSEvent.mouseLocation belowWindowWithWindowNumber:0];
  return under == window.windowNumber ? window : nil;
}

void RestoreCursorOverAppView(NSEvent *event) {
  NSCursor *current = NSCursor.currentCursor;
  if (!current || current == NSCursor.arrowCursor) return;
  NSWindow *window = WindowUnderPointer(event);
  NSView *content = window.contentView;
  if (!content) return;
  const NSPoint point = event.locationInWindow;
  if (!NSPointInRect(point, [content convertRect:content.bounds toView:nil])) return;
  NSView *hit = ViewAt(window, point);
  if (!hit) return;
  if (EnclosingPageView(hit)) return;
  if (!IsArdiaSurface(window, hit)) return;
  const bool hidden = IsInvisible(current);
  if (!hidden && current != gLastPageCursor) return;
  bool ownsCursor = false;
  NSCursor *wanted = CursorOfAppView(hit, content, &ownsCursor);
  if (!wanted && ownsCursor && !hidden) return;
  if (!wanted) wanted = NSCursor.arrowCursor;
  if (wanted == current) return;
  [wanted set];
  gRestores++;
  if (hidden) gHiddenRestores++;
  gLastRestore = [NSString stringWithFormat:@"%@ -> %@ over %@", CursorName(current), CursorName(wanted), NSStringFromClass(hit.class)];
  [ArdiaEvents emit:@"engine.cursorRestored" data:[ArdiaConsentStamp.begin onto:@{@"hidden" : @(hidden)}]];
}

void RecordPageCursors() {
  SEL update = NSSelectorFromString(@"updateCursor:");
  ardia_runtime::ReplaceMethod(PageViewClass(), update, ^id(IMP original) {
    return ^(NSView *page, NSCursor *cursor) {
      ((void (*)(id, SEL, NSCursor *))original)(page, update, cursor);
      if (cursor && NSCursor.currentCursor == cursor) gLastPageCursor = cursor;
    };
  });
}

void HoldCursorsOfCoveredPages() {
  SEL shouldChange = NSSelectorFromString(@"shouldChangeCurrentCursor");
  ardia_runtime::ReplaceMethod(PageViewClass(), shouldChange, ^id(IMP original) {
    return ^BOOL(NSView *page) {
      if (!((BOOL(*)(id, SEL))original)(page, shouldChange)) return NO;
      NSWindow *window = page.window;
      if (!window) return YES;
      NSView *hit = ViewAt(window, [window convertPointFromScreen:NSEvent.mouseLocation]);
      if (!hit || [hit isDescendantOf:page] || !IsArdiaSurface(window, hit)) return YES;
      gCoveredPageCursorsHeld++;
      return NO;
    };
  });
}

NSCursor *InvisibleCursorForTests() {
  static NSCursor *cursor = [[NSCursor alloc] initWithImage:[[NSImage alloc] initWithSize:NSMakeSize(1, 1)] hotSpot:NSZeroPoint];
  return cursor;
}

}

void WatchPageCursor() {
  if (gCursorMonitor) return;
  RecordPageCursors();
  HoldCursorsOfCoveredPages();
  gCursorMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved
                                                         handler:^NSEvent *(NSEvent *event) {
    RestoreCursorOverAppView(event);
    return event;
  }];
}

NSString *PageCursorDev(NSWindow *, NSString *argument) {
  if ([argument isEqualToString:@"hide"]) {
    [InvisibleCursorForTests() set];
  } else if ([argument isEqualToString:@"reset"]) {
    gRestores = gHiddenRestores = gCoveredPageCursorsHeld = 0;
    gLastRestore = nil;
  }
  return [NSString stringWithFormat:@"cursor %@, restores %lu (hidden %lu), covered page cursors held %lu, last restore %@",
                                    CursorName(NSCursor.currentCursor), (unsigned long)gRestores, (unsigned long)gHiddenRestores,
                                    (unsigned long)gCoveredPageCursorsHeld, gLastRestore ?: @"none"];
}

}
