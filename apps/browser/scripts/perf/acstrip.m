#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <dlfcn.h>
#import <mach/mach.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <pthread.h>

static NSString *gDir;
static mach_port_t gMainThread, gJSThread;

static double ThreadCpuMs(mach_port_t t) {
  if (!t) return -1;
  thread_basic_info_data_t i;
  mach_msg_type_number_t n = THREAD_BASIC_INFO_COUNT;
  if (thread_info(t, THREAD_BASIC_INFO, (thread_info_t)&i, &n) != KERN_SUCCESS) return -1;
  return (i.user_time.seconds + i.system_time.seconds) * 1e3 + (i.user_time.microseconds + i.system_time.microseconds) / 1e3;
}

static void FindJSThread(void) {
  if (gJSThread) return;
  thread_act_array_t threads;
  mach_msg_type_number_t n;
  if (task_threads(mach_task_self(), &threads, &n) != KERN_SUCCESS) return;
  for (mach_msg_type_number_t i = 0; i < n; i++) {
    pthread_t p = pthread_from_mach_thread_np(threads[i]);
    char name[64] = {0};
    if (!gJSThread && p && pthread_getname_np(p, name, sizeof name) == 0 && strcmp(name, "com.facebook.react.JavaScript") == 0) gJSThread = threads[i];
    else mach_port_deallocate(mach_task_self(), threads[i]);
  }
  vm_deallocate(mach_task_self(), (vm_address_t)threads, n * sizeof *threads);
}

static NSDictionary *ScreenRect(NSView *v, NSRect r) {
  NSRect inWindow = [v convertRect:r toView:nil];
  NSRect screen = [v.window convertRectToScreen:inWindow];
  CGFloat top = NSScreen.screens.firstObject.frame.size.height;
  return @{@"x": @(screen.origin.x), @"y": @(top - NSMaxY(screen)), @"w": @(screen.size.width), @"h": @(screen.size.height)};
}

static BOOL Shown(NSView *v) {
  for (NSView *a = v; a; a = a.superview)
    if (a.isHidden || a.alphaValue <= 0.01) return NO;
  return YES;
}

static NSArray<NSScrollView *> *StripScrollers(void) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSWindow *w in NSApp.windows) {
    if (!w.isVisible || !w.contentView || w.frame.size.width < 300) continue;
    NSMutableArray<NSView *> *todo = [NSMutableArray arrayWithObject:w.contentView];
    while (todo.count) {
      NSView *v = todo.lastObject;
      [todo removeLastObject];
      if ([v isKindOfClass:NSScrollView.class]) {
        NSScrollView *sv = (NSScrollView *)v;
        if (sv.frame.size.height > 0 && sv.frame.size.height < 80 && sv.documentView) [out addObject:sv];
      }
      [todo addObjectsFromArray:v.subviews];
    }
  }
  return out;
}

static NSDictionary *Describe(NSScrollView *sv, NSUInteger index) {
  NSClipView *clip = sv.contentView;
  return @{
    @"index": @(index),
    @"window": @(sv.window.windowNumber),
    @"shown": @(Shown(sv)),
    @"offset": @(clip.bounds.origin.x),
    @"doc": @(sv.documentView.frame.size.width),
    @"clip": @(clip.bounds.size.width),
    @"rect": ScreenRect(sv, sv.bounds),
  };
}

static void Answer(NSString *cid, NSDictionary *body) {
  NSMutableDictionary *d = [body mutableCopy];
  d[@"id"] = cid;
  NSData *json = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  NSString *tmp = [gDir stringByAppendingPathComponent:@"bench-strip-result.tmp"];
  [json writeToFile:tmp atomically:NO];
  rename(tmp.UTF8String, [gDir stringByAppendingPathComponent:@"bench-strip-result.json"].UTF8String);
}

static long gScrollSeen, gScrollReached;
static NSString *gLastHit = @"", *gLastReceiver = @"";

static NSString *Chain(NSView *v) {
  NSMutableArray *names = [NSMutableArray array];
  for (NSView *a = v; a && names.count < 10; a = a.superview) [names addObject:NSStringFromClass(a.class)];
  return [names componentsJoinedByString:@" < "];
}

static void WatchScrolls(void) {
  static BOOL watching;
  if (watching) return;
  watching = YES;
  [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent *(NSEvent *event) {
    gScrollSeen++;
    gLastHit = Chain([event.window.contentView hitTest:[event.window.contentView convertPoint:event.locationInWindow fromView:nil]]);
    return event;
  }];
  Method m = class_getInstanceMethod(NSScrollView.class, @selector(scrollWheel:));
  IMP original = method_getImplementation(m);
  method_setImplementation(m, imp_implementationWithBlock(^(NSScrollView *sv, NSEvent *event) {
    if (sv.frame.size.height < 80) {
      gScrollReached++;
      gLastReceiver = Chain(sv);
    }
    ((void (*)(id, SEL, NSEvent *))original)(sv, @selector(scrollWheel:), event);
  }));
}

typedef struct {
  double raw;
  int64_t phase, momentum;
  BOOL continuous;
  double gapMs;
} Step;

static NSArray<NSValue *> *GestureSteps(NSString *kind, double rate) {
  NSMutableArray *steps = [NSMutableArray array];
  void (^add)(Step) = ^(Step st) { [steps addObject:[NSValue valueWithBytes:&st objCType:@encode(Step)]]; };
  double tick = 1000 / rate;
  if ([kind isEqualToString:@"wheel"]) {
    for (int i = 0; i < 12; i++) add((Step){-1, 0, 0, NO, 90});
    return steps;
  }
  BOOL phased = ![kind isEqualToString:@"glide"];
  if (phased) add((Step){0, 128, 0, YES, tick});
  int fingers = (int)round(0.3 * rate);
  for (int i = 0; i < fingers; i++) add((Step){-(4 + 22 * sin((double)i / fingers * M_PI * 0.85)) * 120 / rate, phased ? (i == 0 ? 1 : 2) : 0, 0, YES, tick});
  if (phased) add((Step){0, 4, 0, YES, tick});
  if ([kind isEqualToString:@"fingers"]) return steps;
  double velocity = -24.0 * 120 / rate;
  BOOL first = YES;
  while (fabs(velocity) > 0.4 * 120 / rate) {
    add((Step){velocity, 0, phased ? (first ? 1 : 2) : 0, YES, tick});
    first = NO;
    velocity *= pow(0.972, 120 / rate);
  }
  if (phased) add((Step){0, 0, 3, YES, tick});
  return steps;
}

static void SendScroll(NSWindow *w, NSPoint local, Step st, BOOL horizontal, double sign) {
  double d = st.raw * sign;
  int32_t step = st.continuous ? (int32_t)round(d) : (d < 0 ? -1 : 1);
  CGEventRef e = CGEventCreateScrollWheelEvent2(NULL, st.continuous ? kCGScrollEventUnitPixel : kCGScrollEventUnitLine, 2, horizontal ? 0 : step, horizontal ? step : 0, 0);
  if (!e) return;
  NSRect frame = w.frame;
  CGFloat top = NSScreen.screens.firstObject.frame.size.height;
  CGPoint global = CGPointMake(frame.origin.x + local.x, top - NSMaxY(frame) + local.y);
  CGEventSetLocation(e, global);
  CGEventSetTimestamp(e, clock_gettime_nsec_np(CLOCK_UPTIME_RAW));
  CGEventSetIntegerValueField(e, kCGScrollWheelEventIsContinuous, st.continuous);
  if (st.continuous) {
    CGEventSetIntegerValueField(e, horizontal ? kCGScrollWheelEventPointDeltaAxis2 : kCGScrollWheelEventPointDeltaAxis1, (int64_t)round(d));
    CGEventSetDoubleValueField(e, horizontal ? kCGScrollWheelEventFixedPtDeltaAxis2 : kCGScrollWheelEventFixedPtDeltaAxis1, d);
    CGEventSetIntegerValueField(e, horizontal ? kCGScrollWheelEventDeltaAxis2 : kCGScrollWheelEventDeltaAxis1, MAX(-10, MIN(10, (int64_t)round(d / 10))));
    CGEventSetIntegerValueField(e, kCGScrollWheelEventScrollPhase, st.phase);
    CGEventSetIntegerValueField(e, kCGScrollWheelEventMomentumPhase, st.momentum);
  }
  CGEventSetIntegerValueField(e, (CGEventField)51, w.windowNumber);
  void (*setWindowLocation)(CGEventRef, CGPoint) = dlsym(RTLD_DEFAULT, "CGEventSetWindowLocation");
  if (setWindowLocation) setWindowLocation(e, CGPointMake(local.x, local.y));
  NSEvent *event = [NSEvent eventWithCGEvent:e];
  CFRelease(e);
  if (event) [NSApp sendEvent:event];
}

static dispatch_source_t gGesture;

static void RunGesture(NSDictionary *cmd, NSString *cid) {
  NSWindow *w = nil;
  for (NSWindow *x in NSApp.windows)
    if (x.windowNumber == [cmd[@"window"] integerValue]) w = x;
  if (!w) return Answer(cid, @{@"ok": @NO, @"error": @"no such window"});
  NSString *gesture = cmd[@"gesture"];
  BOOL horizontal = [gesture hasSuffix:@"-x"];
  NSString *kind = horizontal ? [gesture substringToIndex:gesture.length - 2] : gesture;
  double rate = [cmd[@"rate"] doubleValue] ?: 120;
  double sign = [cmd[@"reverse"] boolValue] ? -1 : 1;
  NSPoint local = NSMakePoint([cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue]);
  NSArray<NSValue *> *steps = GestureSteps(kind, rate);
  __block NSUInteger next = 0;
  __block double due = 0;
  double start = CACurrentMediaTime() * 1000;
  if (gGesture) dispatch_source_cancel(gGesture);
  gGesture = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(gGesture, DISPATCH_TIME_NOW, NSEC_PER_MSEC, 0);
  dispatch_source_set_event_handler(gGesture, ^{
    double now = CACurrentMediaTime() * 1000 - start;
    while (next < steps.count && now >= due) {
      Step st;
      [steps[next++] getValue:&st];
      SendScroll(w, local, st, horizontal, sign);
      due += st.gapMs;
    }
    if (next >= steps.count) {
      dispatch_source_cancel(gGesture);
      gGesture = nil;
      double travel = 0;
      for (NSValue *v in steps) {
        Step st;
        [v getValue:&st];
        if (st.continuous) travel += st.raw;
      }
      Answer(cid, @{@"ok": @YES, @"events": @(steps.count), @"ms": @(CACurrentMediaTime() * 1000 - start), @"travel": @(fabs(travel))});
    }
  });
  dispatch_resume(gGesture);
}

static void HandleCommand(NSDictionary *cmd) {
  NSString *cid = cmd[@"id"], *op = cmd[@"op"];
  if ([op isEqualToString:@"events"]) {
    WatchScrolls();
    NSDictionary *body = @{@"ok": @YES, @"seen": @(gScrollSeen), @"reached": @(gScrollReached), @"hit": gLastHit, @"receiver": gLastReceiver};
    gScrollSeen = gScrollReached = 0;
    return Answer(cid, body);
  }
  NSArray<NSScrollView *> *scrollers = StripScrollers();
  if ([op isEqualToString:@"info"]) {
    NSMutableArray *list = [NSMutableArray array];
    [scrollers enumerateObjectsUsingBlock:^(NSScrollView *sv, NSUInteger i, BOOL *stop) { [list addObject:Describe(sv, i)]; }];
    NSMutableArray *windows = [NSMutableArray array];
    for (NSWindow *w in NSApp.windows)
      if (w.isVisible && w.frame.size.width >= 300) [windows addObject:@{@"number": @(w.windowNumber), @"rect": ScreenRect(w.contentView, w.contentView.bounds)}];
    return Answer(cid, @{@"ok": @YES, @"scrollers": list, @"windows": windows});
  }
  if ([op isEqualToString:@"set"]) {
    NSUInteger i = [cmd[@"index"] unsignedIntegerValue];
    if (i >= scrollers.count) return Answer(cid, @{@"ok": @NO, @"error": @"no such scroller"});
    NSScrollView *sv = scrollers[i];
    NSClipView *clip = sv.contentView;
    CGFloat max = MAX(0, sv.documentView.frame.size.width - clip.bounds.size.width);
    CGFloat x = MAX(0, MIN(max, [cmd[@"x"] doubleValue]));
    [clip scrollToPoint:NSMakePoint(x, clip.bounds.origin.y)];
    [sv reflectScrolledClipView:clip];
    return Answer(cid, @{@"ok": @YES, @"scroller": Describe(sv, i)});
  }
  if ([op isEqualToString:@"gesture"]) return RunGesture(cmd, cid);
  if ([op isEqualToString:@"snapshot"]) {
    NSWindow *w = nil;
    for (NSWindow *x in NSApp.windows)
      if (x.isVisible && x.frame.size.width >= 300) w = w ?: x;
    NSView *content = w.contentView;
    CGFloat height = [cmd[@"height"] doubleValue] ?: 48, scale = 2;
    size_t pw = (size_t)(NSWidth(content.bounds) * scale), ph = (size_t)(height * scale);
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(NULL, pw, ph, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    CGContextTranslateCTM(ctx, 0, ph);
    CGContextScaleCTM(ctx, scale, -scale);
    if (!content.layer.isGeometryFlipped && !content.isFlipped) {
      CGContextTranslateCTM(ctx, 0, NSHeight(content.bounds));
      CGContextScaleCTM(ctx, 1, -1);
    }
    [content.layer renderInContext:ctx];
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
    CGImageRelease(image);
    BOOL ok = [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:cmd[@"path"] atomically:YES];
    return Answer(cid, @{@"ok": @(ok), @"width": @(pw), @"height": @(ph)});
  }
  if ([op isEqualToString:@"views"]) {
    NSUInteger i = [cmd[@"index"] unsignedIntegerValue];
    if (i >= scrollers.count) return Answer(cid, @{@"ok": @NO, @"error": @"no such scroller"});
    NSScrollView *sv = scrollers[i];
    NSMutableArray<NSView *> *todo = [NSMutableArray arrayWithObject:sv.documentView];
    NSUInteger views = 0, clipped = 0, none = 0;
    while (todo.count) {
      NSView *v = todo.lastObject;
      [todo removeLastObject];
      views++;
      if ([v respondsToSelector:@selector(clipsToBounds)] && ((BOOL (*)(id, SEL))objc_msgSend)(v, @selector(clipsToBounds))) clipped++;
      [todo addObjectsFromArray:v.subviews];
    }
    NSPoint at = NSMakePoint([cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue]);
    NSView *content = sv.window.contentView;
    NSPoint p = content.isFlipped ? at : NSMakePoint(at.x, NSHeight(content.bounds) - at.y);
    NSView *hit = [content hitTest:p];
    NSUInteger depth = 0;
    for (NSView *a = hit; a && a != sv; a = a.superview) depth++;
    return Answer(cid, @{@"ok": @YES, @"views": @(views), @"clipped": @(clipped), @"chips": @(sv.documentView.subviews.count), @"hitDepth": @(depth), @"hit": Chain(hit)});
  }
  Answer(cid, @{@"ok": @NO, @"error": @"unknown op"});
}

__attribute__((constructor)) static void Start(void) {
  const char *dir = getenv("ARDIA_DATA_DIR");
  if (!dir || !getenv("AC_BENCH_STRIP")) return;
  if (![NSBundle.mainBundle.bundlePath hasSuffix:@".app"] || [NSBundle.mainBundle.bundlePath containsString:@"Helper"]) return;
  gMainThread = mach_thread_self();
  gDir = [NSString stringWithUTF8String:dir];
  static dispatch_queue_t q;
  static dispatch_source_t timer;
  q = dispatch_queue_create("acstrip.commands", DISPATCH_QUEUE_SERIAL);
  timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, q);
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), 10 * NSEC_PER_MSEC, 2 * NSEC_PER_MSEC);
  __block NSData *last = nil;
  NSString *cmdPath = [gDir stringByAppendingPathComponent:@"bench-strip-cmd.json"];
  dispatch_source_set_event_handler(timer, ^{
    NSData *data = [NSData dataWithContentsOfFile:cmdPath];
    if (!data.length || [data isEqualToData:last]) return;
    NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (!cmd) return;
    last = data;
    if ([cmd[@"op"] isEqualToString:@"cpu"]) {
      FindJSThread();
      return Answer(cmd[@"id"], @{@"ok": @YES, @"main": @(ThreadCpuMs(gMainThread)), @"js": @(ThreadCpuMs(gJSThread))});
    }
    dispatch_async(dispatch_get_main_queue(), ^{ HandleCommand(cmd); });
  });
  dispatch_resume(timer);
}
