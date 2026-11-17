#import "ArdiaHoverProbeInternal.h"
#import "ArdiaInternal.h"
#import "ArdiaContentBlockerInternal.h"
#import "ArdiaWindowController.h"
#import "ArdiaInterfaceScale.h"

#import <objc/runtime.h>

namespace ardia_host {

using namespace hover_probe;

namespace {

NSPoint TopLeftPoint(NSWindow *window, NSString *spec) {
  NSArray<NSString *> *n = [spec componentsSeparatedByString:@","];
  if (n.count < 2) return NSMakePoint(-1, -1);
  return [ArdiaInterfaceScale windowPointFromRoot:NSMakePoint(n[0].doubleValue, n[1].doubleValue) inWindow:window];
}

NSMutableArray<NSView *> *gDevCovers = [NSMutableArray array];

NSString *DevCover(NSWindow *window, NSString *how, NSString *at) {
  for (NSView *cover in gDevCovers) [cover removeFromSuperview];
  [gDevCovers removeAllObjects];
  if ([how isEqualToString:@"off"]) return @"uncovered";
  NSView *page = PageAt(window, TopLeftPoint(window, at));
  if (!page) return @"no page there";
  NSView *host = [how isEqualToString:@"rn"] ? [ArdiaWindowController forNSWindow:window].root : page.superview;
  if (!host) return @"no host";
  NSView *cover = [[([how isEqualToString:@"rn"] ? NSClassFromString(@"RCTView") : NSView.class) alloc]
      initWithFrame:[host convertRect:[page convertRect:page.bounds toView:nil] fromView:nil]];
  if ([how isEqualToString:@"rn"]) cover.alphaValue = 0;
  [host addSubview:cover];
  [gDevCovers addObject:cover];
  return NSStringFromClass(HitAt(window, TopLeftPoint(window, at)).class);
}

NSString *DevHoverState() {
  NSData *json = [NSJSONSerialization dataWithJSONObject:@{
    @"verdict" : gLastHoverVerdict ?: @"",
    @"open" : @(gEpisode.open),
    @"episodeReason" : gEpisode.open ? ReasonName(gEpisode.first.reason) : @"",
    @"healed" : @(gEpisode.healed),
    @"healWorked" : @(gEpisode.healWorked),
    @"pending" : ReasonName(gPendingReason),
    @"watching" : @(gHoverMonitor != nil),
    @"emitted" : gDevHoverEvents ?: @[],
  } options:0 error:nil];
  return [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
}

NSString *DevMakeKey(NSWindow *browser, NSString *command, NSString *mode) {
  const bool panel = [command isEqualToString:@"panelKey"];
  static NSMutableDictionary<NSString *, NSWindow *> *made = [NSMutableDictionary dictionary];
  NSWindow *other = made[command] ?: (made[command] = [[(panel ? NSPanel.class : NSWindow.class) alloc]
      initWithContentRect:NSMakeRect(0, 0, 40, 40) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES]);
  other.releasedWhenClosed = NO;
  if (panel) [other orderFront:nil];
  if ([mode isEqualToString:@"main"]) {
    other.alphaValue = 0;
    other.ignoresMouseEvents = YES;
    [other orderBack:nil];
    [other makeMainWindow];
  }
  [other makeKeyWindow];
  return [NSString stringWithFormat:@"key %@, main %@, browser %@", DescribeFocusWindow(NSApp.keyWindow),
                                    DescribeFocusWindow(NSApp.mainWindow), DescribeFocusWindow(browser)];
}

__weak NSWindow *gDevNotMainWindow;

NSString *DevNotMain(NSWindow *window, bool on) {
  static IMP original;
  Class cls = window.class;
  SEL selector = @selector(isMainWindow);
  if (!original) {
    original = method_getImplementation(class_getInstanceMethod(cls, selector));
    IMP fake = imp_implementationWithBlock(^BOOL(NSWindow *w) {
      return w != gDevNotMainWindow && ((BOOL(*)(id, SEL))original)(w, selector);
    });
    class_replaceMethod(cls, selector, fake, method_getTypeEncoding(class_getInstanceMethod(cls, selector)));
  }
  gDevNotMainWindow = on ? window : nil;
  return DescribeFocusWindow(window);
}

NSString *DevInvisibleCover(NSWindow *browser, NSString *how) {
  static NSWindow *cover;
  if (!cover) {
    cover = [[NSWindow alloc] initWithContentRect:browser.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    cover.releasedWhenClosed = NO;
    cover.alphaValue = 0;
  }
  if ([how isEqualToString:@"off"]) {
    [cover orderOut:nil];
    return @"removed";
  }
  if ([how isEqualToString:@"click"]) {
    const NSRect frame = cover.frame;
    const NSPoint inside = NSMakePoint(NSWidth(frame) / 2, NSHeight(frame) / 2);
    const NSEventType presses[] = {NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp};
    for (NSEventType type : presses)
      [NSApp sendEvent:[NSEvent mouseEventWithType:type location:inside modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
                                      windowNumber:cover.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1]];
    return DevHoverState();
  }
  cover.ignoresMouseEvents = NO;
  [cover setFrame:browser.frame display:NO];
  [cover orderWindow:NSWindowAbove relativeTo:browser.windowNumber];
  return [NSString stringWithFormat:@"cover #%ld visible %d", (long)cover.windowNumber, cover.isVisible];
}

NSString *DevSeeThroughCovers(NSWindow *window) {
  NSMutableArray<NSString *> *found = [NSMutableArray array];
  NSView *frame = window.contentView.superview;
  const NSRect bounds = frame.bounds;
  for (CGFloat y = 8; y < NSHeight(bounds); y += 16)
    for (CGFloat x = 8; x < NSWidth(bounds); x += 16) {
      const NSPoint point = NSMakePoint(x, y);
      if (!PageAt(window, point)) continue;
      NSView *hit = HitAt(window, point);
      if (!hit || EnclosingPage(hit) || !SeeThrough(hit)) continue;
      NSMutableArray<NSString *> *chain = [NSMutableArray array];
      for (NSView *v = hit; v && chain.count < 6; v = v.superview)
        [chain addObject:[NSString stringWithFormat:@"%@(%.2f)%@", v.className, v.alphaValue, NSStringFromRect([v convertRect:v.bounds toView:nil])]];
      NSString *line = [chain componentsJoinedByString:@" < "];
      if (![found containsObject:line]) [found addObject:line];
    }
  return [found componentsJoinedByString:@"\n"];
}

NSString *DevBlockerKey() {
  for (NSWindow *w in NSApp.windows)
    if (ardia_content_blocker::IsHiddenPageWindow(w)) {
      [w makeKeyWindow];
      return [NSString stringWithFormat:@"blocker %@, key %@", DescribeFocusWindow(w), DescribeFocusWindow(NSApp.keyWindow)];
    }
  return @"no blocker-page window";
}

}

NSString *HoverProbeDev(NSWindow *window, NSString *argument) {
  NSArray<NSString *> *parts = [argument ?: @"" componentsSeparatedByString:@":"];
  NSString *command = parts[0], *rest = parts.count > 1 ? parts[1] : @"";
  if ([command isEqualToString:@"watch"]) {
    gHoverWatchInBackground = [rest isEqualToString:@"1"];
    if (gHoverWatchInBackground) StartHoverWatch();
    else if (Background()) StopHoverWatch();
  } else if ([command isEqualToString:@"check"]) {
    HandleHoverCheck(window, TopLeftPoint(window, rest), [rest hasSuffix:@",click"] ? HoverTrigger::click : HoverTrigger::move);
  } else if ([command isEqualToString:@"preventKey"]) {
    [window setValue:@([rest isEqualToString:@"1"]) forKey:@"preventKeyWindow"];
    return DescribeFocusWindow(window);
  } else if ([command isEqualToString:@"halfActive"]) {
    gDevHalfActive = [rest isEqualToString:@"1"];
    return HoverProbeLine();
  } else if ([command isEqualToString:@"menuActive"]) {
    gDevMenuActive = [rest isEqualToString:@"1"];
    return [NSString stringWithFormat:@"menuActive %d, real %d, menu shown %d", MenuActive(window),
                                      WindowFlag(window, @"hasViewsMenuActive"), MenuShown(window)];
  } else if ([command isEqualToString:@"hiddenKey"] || [command isEqualToString:@"panelKey"]) {
    return DevMakeKey(window, command, rest);
  } else if ([command isEqualToString:@"notMain"]) {
    return DevNotMain(window, [rest isEqualToString:@"1"]);
  } else if ([command isEqualToString:@"invisibleCover"]) {
    return DevInvisibleCover(window, rest);
  } else if ([command isEqualToString:@"responderNil"]) {
    if ([rest isEqualToString:@"1"]) [window makeFirstResponder:nil];
    const FocusHolder holder = HolderOf(window);
    return [NSString stringWithFormat:@"responder %@, lost %d", HolderName(holder), ResponderLost(holder, true)];
  } else if ([command isEqualToString:@"seeThrough"]) {
    return DevSeeThroughCovers(window);
  } else if ([command isEqualToString:@"blockerKey"]) {
    return DevBlockerKey();
  } else if ([command isEqualToString:@"cover"]) {
    return DevCover(window, rest, parts.count > 2 ? parts[2] : @"");
  }
  return DevHoverState();
}

}
