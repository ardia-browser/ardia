#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <stdatomic.h>
#include <time.h>

@interface CATransaction (ACTabsPrivate)
+ (void)addCommitHandler:(void (^)(void))block forPhase:(unsigned int)phase;
@end

static FILE *gOut;
static NSString *gDir;
static dispatch_queue_t gWriter;

static double EpochMs(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static double UptimeToEpoch(NSTimeInterval uptime) {
  return EpochMs() - (NSProcessInfo.processInfo.systemUptime - uptime) * 1000;
}

static void Record(NSString *line) {
  dispatch_async(gWriter, ^{
    fprintf(gOut, "%s\n", line.UTF8String);
    fflush(gOut);
  });
}

static _Atomic long gFlushSeq;
static _Atomic long gReAdds, gNewAdds;
static double gReAddMs, gNewAddMs;

static void SwizzleUIManager(void) {
  Class cls = NSClassFromString(@"RCTUIManager");
  SEL sel = NSSelectorFromString(@"flushUIBlocksWithCompletion:");
  Method m = cls ? class_getInstanceMethod(cls, sel) : NULL;
  if (!m) return;
  IMP orig = method_getImplementation(m);
  method_setImplementation(m, imp_implementationWithBlock(^(id self, id completion) {
    NSMutableArray *pending = [self valueForKey:@"_pendingUIBlocks"];
    if ([pending isKindOfClass:NSMutableArray.class] && pending.count) {
      long seq = atomic_fetch_add(&gFlushSeq, 1);
      double queued = EpochMs();
      unsigned long blocks = pending.count;
      __block double start = 0;
      [pending insertObject:[^(id manager, NSDictionary *registry) { start = EpochMs(); } copy] atIndex:0];
      [pending addObject:[^(id manager, NSDictionary *registry) {
        double end = EpochMs();
        [CATransaction addCommitHandler:^{
          Record([NSString stringWithFormat:@"{\"k\":\"u\",\"seq\":%ld,\"q\":%.3f,\"a\":%.3f,\"b\":%.3f,\"c\":%.3f,\"n\":%lu}", seq, queued, start, end, EpochMs(), blocks]);
        } forPhase:2];
      } copy]];
    }
    ((void (*)(id, SEL, id))orig)(self, sel, completion);
  }));
}

static NSWindow *WindowNumbered(NSInteger number) {
  for (NSWindow *w in NSApp.windows)
    if (w.windowNumber == number) return w;
  return nil;
}

static NSPoint WindowPoint(NSWindow *w, double x, double y) {
  NSView *content = w.contentView;
  NSPoint inContent = content.isFlipped ? NSMakePoint(x, y) : NSMakePoint(x, content.bounds.size.height - y);
  return [content convertPoint:inContent toView:nil];
}

static void CollectClass(NSView *root, NSString *name, NSMutableArray<NSView *> *out) {
  for (NSView *v in root.subviews) {
    if ([NSStringFromClass(v.class) isEqualToString:name]) [out addObject:v];
    CollectClass(v, name, out);
  }
}

static NSEventModifierFlags Mods(NSArray *names) {
  NSEventModifierFlags f = 0;
  for (NSString *n in names) {
    if ([n isEqualToString:@"cmd"]) f |= NSEventModifierFlagCommand;
    if ([n isEqualToString:@"shift"]) f |= NSEventModifierFlagShift;
    if ([n isEqualToString:@"opt"]) f |= NSEventModifierFlagOption;
    if ([n isEqualToString:@"ctrl"]) f |= NSEventModifierFlagControl;
  }
  return f;
}

static unsigned short ModKeyCode(NSEventModifierFlags f) {
  if (f & NSEventModifierFlagCommand) return 55;
  if (f & NSEventModifierFlagControl) return 59;
  if (f & NSEventModifierFlagOption) return 58;
  return 56;
}

@interface ACTabsProbe : NSObject
@end

@implementation ACTabsProbe

+ (void)answer:(NSString *)cid with:(NSDictionary *)body {
  NSMutableDictionary *d = [body mutableCopy];
  d[@"id"] = cid;
  NSData *json = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  NSString *tmp = [gDir stringByAppendingPathComponent:@"bench-tabs-result.tmp"];
  [json writeToFile:tmp atomically:NO];
  rename(tmp.UTF8String, [gDir stringByAppendingPathComponent:@"bench-tabs-result.json"].UTF8String);
}

+ (void)post:(NSEvent *)e {
  [NSApp postEvent:e atStart:NO];
}

+ (NSEvent *)flags:(NSEventModifierFlags)flags key:(unsigned short)code window:(NSInteger)wn {
  return [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime
                      windowNumber:wn context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:code];
}

+ (void)key:(NSDictionary *)cmd id:(NSString *)cid {
  NSInteger wn = [cmd[@"window"] integerValue];
  NSEventModifierFlags flags = Mods(cmd[@"mods"] ?: @[]);
  NSString *chars = cmd[@"chars"] ?: @"";
  NSString *plain = cmd[@"plain"] ?: chars;
  unsigned short code = [cmd[@"keyCode"] unsignedShortValue];
  double holdMs = [cmd[@"holdMs"] doubleValue] ?: 40;
  double releaseMs = [cmd[@"releaseMs"] doubleValue] ?: 30;
  NSEventModifierFlags held = 0;
  for (NSString *n in cmd[@"mods"] ?: @[]) {
    NSEventModifierFlags one = Mods(@[ n ]);
    held |= one;
    [self post:[self flags:held key:ModKeyCode(one) window:wn]];
  }
  NSTimeInterval at = NSProcessInfo.processInfo.systemUptime;
  NSEvent *down = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:at windowNumber:wn context:nil
                                 characters:chars charactersIgnoringModifiers:plain isARepeat:NO keyCode:code];
  double made = UptimeToEpoch(at);
  [self post:down];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(holdMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    [self post:[NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime
                            windowNumber:wn context:nil characters:chars charactersIgnoringModifiers:plain isARepeat:NO keyCode:code]];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(releaseMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
      double released = EpochMs();
      [self post:[self flags:0 key:ModKeyCode(flags) window:wn]];
      [self answer:cid with:@{@"ok": @YES, @"down": @(made), @"released": @(released)}];
    });
  });
}

+ (void)click:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  if (!w) return [self answer:cid with:@{@"ok": @NO, @"error": @"no window"}];
  NSPoint p = WindowPoint(w, [cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue]);
  NSEventModifierFlags flags = Mods(cmd[@"mods"] ?: @[]);
  double holdMs = [cmd[@"holdMs"] doubleValue] ?: 70;
  NSTimeInterval at = NSProcessInfo.processInfo.systemUptime;
  NSEvent *down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:p modifierFlags:flags timestamp:at windowNumber:w.windowNumber
                                      context:nil eventNumber:0 clickCount:1 pressure:1];
  double made = UptimeToEpoch(at);
  [self post:down];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(holdMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    NSTimeInterval upAt = NSProcessInfo.processInfo.systemUptime;
    [self post:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:p modifierFlags:flags timestamp:upAt windowNumber:w.windowNumber
                                   context:nil eventNumber:0 clickCount:1 pressure:0]];
    [self answer:cid with:@{@"ok": @YES, @"down": @(made), @"up": @(UptimeToEpoch(upAt))}];
  });
}

+ (void)drag:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  if (!w) return [self answer:cid with:@{@"ok": @NO, @"error": @"no window"}];
  double x0 = [cmd[@"x"] doubleValue], y0 = [cmd[@"y"] doubleValue], x1 = [cmd[@"toX"] doubleValue], y1 = [cmd[@"toY"] doubleValue];
  NSInteger steps = [cmd[@"steps"] integerValue] ?: 12;
  double stepMs = [cmd[@"stepMs"] doubleValue] ?: 16;
  NSInteger wn = w.windowNumber;
  NSTimeInterval at = NSProcessInfo.processInfo.systemUptime;
  double made = UptimeToEpoch(at);
  [self post:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:WindowPoint(w, x0, y0) modifierFlags:0 timestamp:at windowNumber:wn
                                 context:nil eventNumber:0 clickCount:1 pressure:1]];
  for (NSInteger i = 1; i <= steps + 1; i++) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(i * stepMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
      NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
      if (i <= steps) {
        double f = (double)i / steps;
        NSPoint p = WindowPoint(w, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
        [self post:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:p modifierFlags:0 timestamp:now windowNumber:wn context:nil
                                   eventNumber:0 clickCount:1 pressure:1]];
      } else {
        [self post:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:WindowPoint(w, x1, y1) modifierFlags:0 timestamp:now windowNumber:wn
                                       context:nil eventNumber:0 clickCount:1 pressure:0]];
        [self answer:cid with:@{@"ok": @YES, @"down": @(made), @"up": @(UptimeToEpoch(now))}];
      }
    });
  }
}

+ (void)hover:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  if (!w) return [self answer:cid with:@{@"ok": @NO, @"error": @"no window"}];
  NSPoint p = WindowPoint(w, [cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue]);
  NSView *hit = [w.contentView hitTest:[w.contentView.superview convertPoint:p fromView:nil]];
  SEL sel = NSSelectorFromString(@"onMouseEnter");
  NSInteger entered = 0;
  NSEvent *e = [NSEvent enterExitEventWithType:NSEventTypeMouseEntered location:p modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:w.windowNumber context:nil eventNumber:0 trackingNumber:0 userData:NULL];
  for (NSView *v = hit; v; v = v.superview)
    if ([v respondsToSelector:sel] && ((id (*)(id, SEL))objc_msgSend)(v, sel) != nil) {
      [v mouseEntered:e];
      entered++;
    }
  [self answer:cid with:@{@"ok": @YES, @"entered": @(entered), @"hit": hit ? NSStringFromClass(hit.class) : @""}];
}

+ (void)menu:(NSDictionary *)cmd id:(NSString *)cid {
  NSMenu *menu = NSApp.mainMenu;
  NSArray<NSString *> *path = cmd[@"path"];
  for (NSUInteger i = 0; i < path.count; i++) {
    NSInteger index = -1;
    for (NSString *title in [path[i] componentsSeparatedByString:@"|"])
      if (index < 0) index = [menu indexOfItemWithTitle:title];
    if (index < 0) return [self answer:cid with:@{@"ok": @NO, @"error": [NSString stringWithFormat:@"no menu item %@", path[i]]}];
    if (i + 1 == path.count) {
      [menu update];
      double made = EpochMs();
      [menu performActionForItemAtIndex:index];
      return [self answer:cid with:@{@"ok": @YES, @"down": @(made)}];
    }
    menu = [menu itemAtIndex:index].submenu;
  }
  [self answer:cid with:@{@"ok": @NO, @"error": @"empty path"}];
}

+ (void)windows:(NSString *)cid {
  NSMutableArray *list = [NSMutableArray array];
  for (NSWindow *w in NSApp.windows) {
    if (!w.isVisible || w.frame.size.width < 300) continue;
    NSMutableArray *webs = [NSMutableArray array];
    NSMutableArray<NSView *> *found = [NSMutableArray array];
    CollectClass(w.contentView, @"ArdiaWebView", found);
    NSView *content = w.contentView;
    for (NSView *v in found) {
      if (v.isHiddenOrHasHiddenAncestor || v.frame.size.width < 50) continue;
      NSRect r = [v convertRect:v.bounds toView:content];
      double top = content.isFlipped ? r.origin.y : content.bounds.size.height - NSMaxY(r);
      id key = [v valueForKey:@"transferKey"];
      [webs addObject:@{@"x": @(r.origin.x), @"y": @(top), @"w": @(r.size.width), @"h": @(r.size.height), @"z": @(v.layer.zPosition),
                        @"key": [key isKindOfClass:NSString.class] ? key : @""}];
    }
    NSMutableArray *children = [NSMutableArray array];
    for (NSWindow *child in w.childWindows)
      [children addObject:[NSString stringWithFormat:@"%@ visible=%d %@", NSStringFromClass(child.class), child.visible, NSStringFromRect(child.frame)]];
    [list addObject:@{@"number": @(w.windowNumber), @"key": @(w.isKeyWindow), @"main": @(w.isMainWindow), @"w": @(content.bounds.size.width),
                      @"h": @(content.bounds.size.height), @"webs": webs, @"title": w.title ?: @"", @"children": children,
                      @"sheet": @(w.attachedSheet != nil), @"frame": NSStringFromRect(w.frame)}];
  }
  [self answer:cid with:@{@"ok": @YES, @"windows": list}];
}

static NSView *ChildToward(NSView *ancestor, NSView *view) {
  for (NSView *v = view; v; v = v.superview)
    if (v.superview == ancestor) return v;
  return nil;
}

static BOOL InFrontOf(NSView *a, NSView *b) {
  for (NSView *shared = a.superview; shared; shared = shared.superview) {
    if (![b isDescendantOf:shared]) continue;
    NSView *pa = ChildToward(shared, a), *pb = ChildToward(shared, b);
    if (pa.layer.zPosition != pb.layer.zPosition) return pa.layer.zPosition > pb.layer.zPosition;
    return [shared.subviews indexOfObject:pa] > [shared.subviews indexOfObject:pb];
  }
  return NO;
}

static NSString *FrontPageKey(NSWindow *w, NSPoint inContent) {
  NSMutableArray<NSView *> *found = [NSMutableArray array];
  CollectClass(w.contentView, @"ArdiaWebView", found);
  NSView *front = nil;
  for (NSView *v in found) {
    if (v.isHiddenOrHasHiddenAncestor || v.alphaValue < 1 || !NSPointInRect([v convertPoint:inContent fromView:w.contentView], v.bounds)) continue;
    BOOL paints = NO;
    for (NSView *sub in v.subviews) paints = paints || !sub.hidden;
    if (paints && (!front || InFrontOf(v, front))) front = v;
  }
  id key = front ? [front valueForKey:@"transferKey"] : nil;
  return [key isKindOfClass:NSString.class] ? key : @"";
}

+ (void)front:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  if (!w) return [self answer:cid with:@{@"ok": @NO, @"error": @"no window"}];
  NSView *content = w.contentView;
  double x = [cmd[@"x"] doubleValue], y = [cmd[@"y"] doubleValue];
  NSPoint p = content.isFlipped ? NSMakePoint(x, y) : NSMakePoint(x, content.bounds.size.height - y);
  double until = EpochMs() + [cmd[@"ms"] doubleValue];
  __block NSString *last = nil;
  CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent(), 0.002, 0, 0, ^(CFRunLoopTimerRef t) {
    NSString *key = FrontPageKey(w, p);
    if (![key isEqualToString:last]) Record([NSString stringWithFormat:@"{\"k\":\"f\",\"t\":%.3f,\"key\":\"%@\"}", EpochMs(), key]);
    last = key;
    if (EpochMs() > until) CFRunLoopTimerInvalidate(t);
  });
  CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
  CFRelease(timer);
  [self answer:cid with:@{@"ok": @YES, @"now": @(EpochMs())}];
}

static NSString *PageKeyHolding(NSView *view) {
  for (NSView *v = view; v; v = v.superview) {
    if (![NSStringFromClass(v.class) isEqualToString:@"ArdiaWebView"]) continue;
    id key = [v valueForKey:@"transferKey"];
    return [key isKindOfClass:NSString.class] ? key : @"";
  }
  return @"";
}

static double ShownAlpha(NSView *view) {
  double alpha = 1;
  for (NSView *v = view; v; v = v.superview) {
    if (v.hidden) return 0;
    alpha *= v.alphaValue;
  }
  return alpha;
}

static void CollectAddresses(NSView *root, NSMutableArray<NSString *> *out) {
  for (NSView *v in root.subviews) {
    if (v.hidden || v.alphaValue < 0.01) continue;
    if ([NSStringFromClass(v.class) isEqualToString:@"RCTTextView"]) {
      NSString *text = nil;
      @try {
        id storage = [v valueForKey:@"textStorage"];
        if ([storage isKindOfClass:NSAttributedString.class]) text = [storage string];
      } @catch (NSException *e) {
      }
      if (([text containsString:@"localhost"] || [text containsString:@"127.0.0.1"] || [text hasPrefix:@"/p/"]) && ShownAlpha(v) > 0.01) [out addObject:text];
      continue;
    }
    CollectAddresses(v, out);
  }
}

static NSString *TopPage(NSWindow *w, NSPoint inContent) {
  NSMutableArray<NSView *> *found = [NSMutableArray array];
  CollectClass(w.contentView, @"ArdiaWebView", found);
  NSView *top = nil;
  for (NSView *v in found) {
    if (v.isHiddenOrHasHiddenAncestor || !NSPointInRect([v convertPoint:inContent fromView:w.contentView], v.bounds)) continue;
    BOOL paints = NO;
    for (NSView *sub in v.subviews) paints = paints || !sub.hidden;
    if (paints && (!top || InFrontOf(v, top))) top = v;
  }
  return top ? [NSString stringWithFormat:@"%@@%d", PageKeyHolding(top), (int)lround(top.alphaValue * 100)] : @"";
}

+ (void)watch:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  if (!w) return [self answer:cid with:@{@"ok": @NO, @"error": @"no window"}];
  NSView *content = w.contentView;
  double x = [cmd[@"x"] doubleValue], y = [cmd[@"y"] doubleValue];
  NSPoint p = content.isFlipped ? NSMakePoint(x, y) : NSMakePoint(x, content.bounds.size.height - y);
  double until = EpochMs() + [cmd[@"ms"] doubleValue];
  __block NSString *last = nil;
  CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent(), 0.003, 0, 0, ^(CFRunLoopTimerRef t) {
    NSResponder *responder = w.firstResponder;
    NSString *focus = [responder isKindOfClass:NSView.class] ? PageKeyHolding((NSView *)responder) : @"";
    NSString *resp = responder == w ? @"window" : responder ? [NSString stringWithFormat:@"%@:%p", NSStringFromClass(responder.class), responder] : @"nil";
    NSView *hit = [content hitTest:[content.superview convertPoint:[content convertPoint:p toView:nil] fromView:nil]];
    NSMutableArray<NSString *> *addresses = [NSMutableArray array];
    CollectAddresses(content, addresses);
    NSString *state = [NSString stringWithFormat:@"\"front\":\"%@\",\"top\":\"%@\",\"focus\":\"%@\",\"hit\":\"%@\",\"addr\":\"%@\",\"resp\":\"%@\"", FrontPageKey(w, p), TopPage(w, p), focus,
                                                 PageKeyHolding(hit), [addresses componentsJoinedByString:@" | "], resp];
    if (![state isEqualToString:last]) Record([NSString stringWithFormat:@"{\"k\":\"w\",\"t\":%.3f,%@}", EpochMs(), state]);
    last = state;
    if (EpochMs() > until) CFRunLoopTimerInvalidate(t);
  });
  CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
  CFRelease(timer);
  [self answer:cid with:@{@"ok": @YES, @"now": @(EpochMs())}];
}

+ (void)phantom:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  if (!w) return [self answer:cid with:@{@"ok": @NO, @"error": @"no window"}];
  NSPoint p = WindowPoint(w, [cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue]);
  NSTimeInterval at = NSProcessInfo.processInfo.systemUptime;
  NSEvent *down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:p modifierFlags:0 timestamp:at windowNumber:w.windowNumber
                                      context:nil eventNumber:0 clickCount:1 pressure:1];
  double made = UptimeToEpoch(at);
  BOOL revealed = ((BOOL (*)(id, SEL, id))objc_msgSend)(NSClassFromString(@"ArdiaWebView"), NSSelectorFromString(@"revealForPress:"), down);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(40 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    NSTimeInterval upAt = NSProcessInfo.processInfo.systemUptime;
    if ([cmd[@"up"] boolValue])
      [self post:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:p modifierFlags:0 timestamp:upAt windowNumber:w.windowNumber context:nil
                                 eventNumber:0 clickCount:1 pressure:0]];
    [self answer:cid with:@{@"ok": @YES, @"down": @(made), @"revealed": @(revealed)}];
  });
}

+ (void)button:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  if (!w) return [self answer:cid with:@{@"ok": @NO, @"error": @"no window"}];
  NSPoint p = WindowPoint(w, [cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue]);
  NSEventType downType = [cmd[@"button"] integerValue] == 1 ? NSEventTypeRightMouseDown : NSEventTypeOtherMouseDown;
  NSEventType upType = [cmd[@"button"] integerValue] == 1 ? NSEventTypeRightMouseUp : NSEventTypeOtherMouseUp;
  NSTimeInterval at = NSProcessInfo.processInfo.systemUptime;
  [self post:[NSEvent mouseEventWithType:downType location:p modifierFlags:0 timestamp:at windowNumber:w.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1]];
  double made = UptimeToEpoch(at);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(40 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    [self post:[NSEvent mouseEventWithType:upType location:p modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:w.windowNumber context:nil eventNumber:0 clickCount:1 pressure:0]];
    [self answer:cid with:@{@"ok": @YES, @"down": @(made)}];
  });
}

+ (void)responder:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  if (!w) return [self answer:cid with:@{@"ok": @NO, @"error": @"no window"}];
  static NSButton *button;
  if ([cmd[@"kind"] isEqualToString:@"button"]) {
    if (!button) {
      button = [NSButton buttonWithTitle:@"probe" target:nil action:nil];
      button.frame = NSMakeRect(2, 2, 40, 16);
      button.refusesFirstResponder = NO;
    }
    if (button.window != w) [w.contentView addSubview:button];
    BOOL made = [w makeFirstResponder:button];
    return [self answer:cid with:@{@"ok": @(made), @"responder": [NSString stringWithFormat:@"%@:%p", NSStringFromClass(w.firstResponder.class), w.firstResponder]}];
  }
  BOOL made = [w makeFirstResponder:nil];
  [self answer:cid with:@{@"ok": @(made), @"responder": w.firstResponder == w ? @"window" : NSStringFromClass(w.firstResponder.class)}];
}

+ (void)notify:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  NSString *name = cmd[@"name"];
  double at = EpochMs();
  if ([cmd[@"on"] isEqualToString:@"workspace"]) [NSWorkspace.sharedWorkspace.notificationCenter postNotificationName:name object:NSWorkspace.sharedWorkspace];
  else if ([cmd[@"on"] isEqualToString:@"app"]) [NSNotificationCenter.defaultCenter postNotificationName:name object:NSApp];
  else [NSNotificationCenter.defaultCenter postNotificationName:name object:w];
  [self answer:cid with:@{@"ok": @YES, @"at": @(at)}];
}

+ (void)unhost:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  NSMutableArray<NSView *> *found = [NSMutableArray array];
  CollectClass(w.contentView, @"ArdiaWebView", found);
  double at = EpochMs();
  for (NSView *v in found) {
    id key = [v valueForKey:@"transferKey"];
    if (![key isEqual:cmd[@"key"]]) continue;
    NSView *parent = v.superview;
    [v removeFromSuperview];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(600 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{ [parent addSubview:v]; });
    return [self answer:cid with:@{@"ok": @YES, @"at": @(at)}];
  }
  [self answer:cid with:@{@"ok": @NO, @"error": @"no such view"}];
}

static NSView *FindView(NSView *root, BOOL (^match)(NSView *)) {
  for (NSView *sub in root.subviews) {
    if (match(sub)) return sub;
    NSView *found = FindView(sub, match);
    if (found) return found;
  }
  return nil;
}

+ (void)find:(NSDictionary *)cmd id:(NSString *)cid {
  NSWindow *w = WindowNumbered([cmd[@"window"] integerValue]);
  NSView *content = w.contentView;
  NSString *tab = cmd[@"tab"], *tip = cmd[@"tooltip"];
  NSView *v = FindView(content, ^BOOL(NSView *view) {
    if (view.isHiddenOrHasHiddenAncestor) return NO;
    if (tip) return [view.toolTip hasPrefix:tip];
    id tag = [view respondsToSelector:NSSelectorFromString(@"nativeID")] ? [view valueForKey:@"nativeID"] : nil;
    return [tag isKindOfClass:NSString.class] && ([tag isEqualToString:[@"tab-switch:" stringByAppendingString:tab]] || [tag isEqualToString:[@"tab-selected:" stringByAppendingString:tab]]);
  });
  if (!v) return [self answer:cid with:@{@"ok": @YES, @"found": @NO}];
  NSRect r = [v convertRect:v.bounds toView:content];
  double top = content.isFlipped ? r.origin.y : content.bounds.size.height - NSMaxY(r);
  [self answer:cid with:@{@"ok": @YES, @"found": @YES, @"x": @(r.origin.x), @"y": @(top), @"width": @(r.size.width), @"height": @(r.size.height), @"alpha": @(ShownAlpha(v))}];
}

+ (void)reload:(NSString *)cid {
  void (*trigger)(NSString *) = dlsym(RTLD_DEFAULT, "RCTTriggerReloadCommandListeners");
  double at = EpochMs();
  if (trigger) trigger(@"proof");
  [self answer:cid with:@{@"ok": @(trigger != NULL), @"at": @(at)}];
}

+ (void)handle:(NSDictionary *)cmd {
  NSString *cid = cmd[@"id"], *op = cmd[@"op"];
  if ([op isEqualToString:@"button"]) return [self button:cmd id:cid];
  if ([op isEqualToString:@"responder"]) return [self responder:cmd id:cid];
  if ([op isEqualToString:@"notify"]) return [self notify:cmd id:cid];
  if ([op isEqualToString:@"unhost"]) return [self unhost:cmd id:cid];
  if ([op isEqualToString:@"reload"]) return [self reload:cid];
  if ([op isEqualToString:@"find"]) return [self find:cmd id:cid];
  if ([op isEqualToString:@"front"]) return [self front:cmd id:cid];
  if ([op isEqualToString:@"watch"]) return [self watch:cmd id:cid];
  if ([op isEqualToString:@"phantom"]) return [self phantom:cmd id:cid];
  if ([op isEqualToString:@"key"]) return [self key:cmd id:cid];
  if ([op isEqualToString:@"click"]) return [self click:cmd id:cid];
  if ([op isEqualToString:@"drag"]) return [self drag:cmd id:cid];
  if ([op isEqualToString:@"hover"]) return [self hover:cmd id:cid];
  if ([op isEqualToString:@"menu"]) return [self menu:cmd id:cid];
  if ([op isEqualToString:@"windows"]) return [self windows:cid];
  if ([op isEqualToString:@"adds"]) {
    NSDictionary *r = @{@"ok": @YES, @"reAdds": @(gReAdds), @"reAddMs": @(gReAddMs), @"newAdds": @(gNewAdds), @"newAddMs": @(gNewAddMs)};
    if ([cmd[@"reset"] boolValue]) { gReAdds = 0; gNewAdds = 0; gReAddMs = 0; gNewAddMs = 0; }
    return [self answer:cid with:r];
  }
  if ([op isEqualToString:@"ping"]) return [self answer:cid with:@{@"ok": @YES, @"now": @(EpochMs())}];
  [self answer:cid with:@{@"ok": @NO, @"error": @"unknown op"}];
}

@end

static void CountAdds(void) {
  SEL sel = @selector(addSubview:);
  Method m = class_getInstanceMethod(NSView.class, sel);
  IMP orig = method_getImplementation(m);
  method_setImplementation(m, imp_implementationWithBlock(^(NSView *self, NSView *view) {
    BOOL again = view.superview == self;
    double a = EpochMs();
    ((void (*)(id, SEL, id))orig)(self, sel, view);
    double d = EpochMs() - a;
    if (again) { atomic_fetch_add(&gReAdds, 1); gReAddMs += d; } else { atomic_fetch_add(&gNewAdds, 1); gNewAddMs += d; }
  }));
}

__attribute__((constructor)) static void Start(void) {
  const char *dir = getenv("ARDIA_DATA_DIR");
  if (!dir || !getenv("AC_BENCH_TABS")) return;
  if (![NSBundle.mainBundle.bundlePath hasSuffix:@".app"] || [NSBundle.mainBundle.bundlePath containsString:@"Helper"]) return;
  gDir = [NSString stringWithUTF8String:dir];
  gOut = fopen([gDir stringByAppendingPathComponent:@"bench-tabs.jsonl"].UTF8String, "a");
  if (!gOut) return;
  gWriter = dispatch_queue_create("actabs.writer", DISPATCH_QUEUE_SERIAL);
  static dispatch_source_t timer;
  timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gWriter);
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), 5 * NSEC_PER_MSEC, 1 * NSEC_PER_MSEC);
  __block NSData *last = nil;
  NSString *cmdPath = [gDir stringByAppendingPathComponent:@"bench-tabs-cmd.json"];
  dispatch_source_set_event_handler(timer, ^{
    NSData *data = [NSData dataWithContentsOfFile:cmdPath];
    if (data.length && ![data isEqualToData:last]) {
      NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      if (cmd) {
        last = data;
        dispatch_async(dispatch_get_main_queue(), ^{ [ACTabsProbe handle:cmd]; });
      }
    }
  });
  dispatch_resume(timer);
  CFRunLoopTimerRef boot = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 0.1, 0.1, 0, 0, ^(CFRunLoopTimerRef t) {
    if (!NSClassFromString(@"RCTUIManager")) return;
    SwizzleUIManager();
    if (getenv("AC_BENCH_COUNT_ADDS")) CountAdds();
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown | NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
                                          handler:^NSEvent *(NSEvent *event) {
      Record([NSString stringWithFormat:@"{\"k\":\"e\",\"t\":%lu,\"made\":%.3f,\"seen\":%.3f}", (unsigned long)event.type, UptimeToEpoch(event.timestamp), EpochMs()]);
      return event;
    }];
    CFRunLoopTimerInvalidate(t);
  });
  CFRunLoopAddTimer(CFRunLoopGetMain(), boot, kCFRunLoopCommonModes);
}
