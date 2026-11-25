#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#include <time.h>
#include <mach/mach.h>
#include <pthread.h>

static NSString *gDir;
static long gScrollEvents;
static double gScrollMs, gScrollMaxMs;
static NSMutableArray *gSamples;
static NSArray<NSView *> *gChain;
static CFRunLoopTimerRef gTraceTimer;
static dispatch_source_t gGesture;

static double NowMs(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static void Answer(NSString *cid, NSDictionary *body) {
  NSMutableDictionary *d = [body mutableCopy];
  d[@"id"] = cid;
  NSData *json = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  NSString *tmp = [gDir stringByAppendingPathComponent:@"bench-swipe-result.tmp"];
  [json writeToFile:tmp atomically:NO];
  rename(tmp.UTF8String, [gDir stringByAppendingPathComponent:@"bench-swipe-result.json"].UTF8String);
}

static void TimeScrollEvents(void) {
  Class cls = object_getClass(NSApp);
  SEL sel = @selector(sendEvent:);
  Method m = class_getInstanceMethod(cls, sel);
  if (!m) return;
  IMP orig = method_getImplementation(m);
  method_setImplementation(m, imp_implementationWithBlock(^(id app, NSEvent *event) {
    if (event.type != NSEventTypeScrollWheel) return ((void (*)(id, SEL, NSEvent *))orig)(app, sel, event);
    double a = NowMs();
    ((void (*)(id, SEL, NSEvent *))orig)(app, sel, event);
    double d = NowMs() - a;
    gScrollEvents++;
    gScrollMs += d;
    if (d > gScrollMaxMs) gScrollMaxMs = d;
  }));
}

static NSWindow *AppWindow(NSInteger number) {
  if (number > 0)
    for (NSWindow *w in NSApp.windows)
      if (w.windowNumber == number) return w;
  NSWindow *best = nil;
  for (NSWindow *w in NSApp.windows)
    if (w.isVisible && w.frame.size.width >= 600 && (!best || w.frame.size.width * w.frame.size.height > best.frame.size.width * best.frame.size.height)) best = w;
  return best;
}

typedef struct {
  double raw;
  int64_t phase, momentum;
} Step;

static NSData *GestureSteps(NSString *kind, double rate) {
  NSMutableData *steps = [NSMutableData data];
  void (^add)(Step) = ^(Step st) { [steps appendBytes:&st length:sizeof st]; };
  add((Step){0, 128, 0});
  int fingers = (int)round(0.3 * rate);
  for (int i = 0; i < fingers; i++) add((Step){-(4 + 22 * sin((double)i / fingers * M_PI * 0.85)) * 120 / rate, i == 0 ? 1 : 2, 0});
  add((Step){0, 4, 0});
  if ([kind isEqualToString:@"fingers"]) return steps;
  double velocity = -24.0 * 120 / rate;
  BOOL first = YES;
  while (fabs(velocity) > 0.4 * 120 / rate) {
    add((Step){velocity, 0, first ? 1 : 2});
    first = NO;
    velocity *= pow(0.972, 120 / rate);
  }
  add((Step){0, 0, 3});
  return steps;
}

static void SendScroll(NSWindow *w, NSPoint local, Step st, double sign) {
  double d = st.raw * sign;
  CGEventRef e = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2, 0, (int32_t)round(d), 0);
  if (!e) return;
  NSRect frame = w.frame;
  CGFloat top = NSScreen.screens.firstObject.frame.size.height;
  CGEventSetLocation(e, CGPointMake(frame.origin.x + local.x, top - NSMaxY(frame) + local.y));
  CGEventSetTimestamp(e, clock_gettime_nsec_np(CLOCK_UPTIME_RAW));
  CGEventSetIntegerValueField(e, kCGScrollWheelEventIsContinuous, 1);
  CGEventSetIntegerValueField(e, kCGScrollWheelEventPointDeltaAxis2, (int64_t)round(d));
  CGEventSetDoubleValueField(e, kCGScrollWheelEventFixedPtDeltaAxis2, d);
  CGEventSetIntegerValueField(e, kCGScrollWheelEventDeltaAxis2, MAX(-10, MIN(10, (int64_t)round(d / 10))));
  CGEventSetIntegerValueField(e, kCGScrollWheelEventScrollPhase, st.phase);
  CGEventSetIntegerValueField(e, kCGScrollWheelEventMomentumPhase, st.momentum);
  CGEventSetIntegerValueField(e, (CGEventField)51, w.windowNumber);
  void (*setWindowLocation)(CGEventRef, CGPoint) = dlsym(RTLD_DEFAULT, "CGEventSetWindowLocation");
  if (setWindowLocation) setWindowLocation(e, CGPointMake(local.x, local.y));
  NSEvent *event = [NSEvent eventWithCGEvent:e];
  CFRelease(e);
  if (event) [NSApp sendEvent:event];
}

static void RunGesture(NSDictionary *cmd, NSString *cid) {
  NSWindow *w = AppWindow([cmd[@"window"] integerValue]);
  if (!w) return Answer(cid, @{@"ok" : @NO, @"error" : @"no such window"});
  double rate = [cmd[@"rate"] doubleValue] ?: 120;
  double sign = [cmd[@"reverse"] boolValue] ? -1 : 1;
  NSPoint local = NSMakePoint([cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue]);
  NSData *steps = GestureSteps(cmd[@"gesture"] ?: @"trackpad", rate);
  NSUInteger count = steps.length / sizeof(Step);
  const Step *list = steps.bytes;
  __block NSUInteger next = 0;
  double tick = 1000 / rate;
  double start = NowMs();
  if (gGesture) dispatch_source_cancel(gGesture);
  gGesture = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(gGesture, DISPATCH_TIME_NOW, NSEC_PER_MSEC, 0);
  dispatch_source_set_event_handler(gGesture, ^{
    double now = NowMs() - start;
    while (next < count && now >= next * tick) SendScroll(w, local, list[next++], sign);
    if (next >= count) {
      (void)steps;
      dispatch_source_cancel(gGesture);
      gGesture = nil;
      Answer(cid, @{@"ok" : @YES, @"events" : @(count), @"ms" : @(NowMs() - start)});
    }
  });
  dispatch_resume(gGesture);
}

static void Sample(void) {
  double scrolled = 0, moved = 0;
  for (NSView *v in gChain) {
    CALayer *layer = v.layer.presentationLayer ?: v.layer;
    moved += v.frame.origin.x + (layer ? layer.transform.m41 : 0);
    if ([v isKindOfClass:NSClipView.class]) scrolled += v.bounds.origin.x;
  }
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  double epoch = ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
  [gSamples addObject:@[ @(round(epoch * 100) / 100), @(round(moved * 100) / 100), @(round(scrolled * 100) / 100) ]];
}

static NSDictionary *StartTrace(NSDictionary *cmd) {
  NSWindow *w = AppWindow([cmd[@"window"] integerValue]);
  if (!w) return @{@"ok" : @NO, @"error" : @"no window"};
  NSView *frame = w.contentView.superview ?: w.contentView;
  NSPoint at = NSMakePoint([cmd[@"x"] doubleValue], NSHeight(frame.bounds) - [cmd[@"y"] doubleValue]);
  NSView *hit = [frame hitTest:at];
  NSMutableArray *chain = [NSMutableArray array];
  NSMutableArray *names = [NSMutableArray array];
  NSMutableArray *scrollers = [NSMutableArray array];
  for (NSView *v = hit; v && v != frame; v = v.superview) {
    [chain addObject:v];
    [names addObject:NSStringFromClass(v.class)];
    if ([v isKindOfClass:NSScrollView.class]) {
      NSScrollView *sv = (NSScrollView *)v;
      [scrollers addObject:@{@"visible" : @(NSWidth(sv.contentView.bounds)), @"document" : @(NSWidth(sv.documentView.frame)), @"x" : @(sv.contentView.bounds.origin.x)}];
    }
  }
  gChain = chain;
  gSamples = [NSMutableArray array];
  if (gTraceTimer) CFRunLoopTimerInvalidate(gTraceTimer);
  gTraceTimer = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent(), 0.004, 0, 0, ^(CFRunLoopTimerRef t) { Sample(); });
  CFRunLoopAddTimer(CFRunLoopGetMain(), gTraceTimer, kCFRunLoopCommonModes);
  return @{@"ok" : @YES, @"chain" : names, @"scrollers" : scrollers};
}

static NSDictionary *ScrollUnder(NSDictionary *cmd) {
  NSWindow *w = AppWindow([cmd[@"window"] integerValue]);
  if (!w) return @{@"ok" : @NO, @"error" : @"no window"};
  NSView *frame = w.contentView.superview ?: w.contentView;
  NSView *hit = [frame hitTest:NSMakePoint([cmd[@"x"] doubleValue], NSHeight(frame.bounds) - [cmd[@"y"] doubleValue])];
  for (NSView *v = hit; v; v = v.superview) {
    if (![v isKindOfClass:NSScrollView.class]) continue;
    NSScrollView *sv = (NSScrollView *)v;
    NSClipView *clip = sv.contentView;
    CGFloat max = MAX(0, NSWidth(sv.documentView.frame) - NSWidth(clip.bounds));
    CGFloat x = [cmd[@"to"] isEqualToString:@"end"] ? max : 0;
    [clip scrollToPoint:NSMakePoint(x, clip.bounds.origin.y)];
    [sv reflectScrolledClipView:clip];
    return @{@"ok" : @YES, @"x" : @(x), @"max" : @(max)};
  }
  return @{@"ok" : @NO, @"error" : @"no scroll view under the point"};
}

static NSDictionary *StopTrace(void) {
  if (gTraceTimer) CFRunLoopTimerInvalidate(gTraceTimer);
  gTraceTimer = NULL;
  NSArray *samples = gSamples ?: @[];
  gSamples = nil;
  gChain = nil;
  return @{@"ok" : @YES, @"samples" : samples};
}

#define SAMPLE_MAX 6000
#define SAMPLE_DEPTH 128
static thread_t gMainThread;
static double gSampleAt[SAMPLE_MAX];
static int gSampleDepth[SAMPLE_MAX];
static uint64_t gSampleFrames[SAMPLE_MAX][SAMPLE_DEPTH];
static int gSampleCount;
static _Atomic int gSampling;

static int ReadWord(uint64_t addr, uint64_t *out) {
  mach_vm_size_t got = 0;
  extern kern_return_t mach_vm_read_overwrite(vm_map_t, mach_vm_address_t, mach_vm_size_t, mach_vm_address_t, mach_vm_size_t *);
  return mach_vm_read_overwrite(mach_task_self(), addr, 8, (mach_vm_address_t)out, &got) == KERN_SUCCESS && got == 8;
}

static double EpochMs(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static void *SampleMain(void *arg) {
  double until = NowMs() + (double)(intptr_t)arg;
  gSampleCount = 0;
  while (NowMs() < until && gSampleCount < SAMPLE_MAX) {
    int i = gSampleCount, n = 0;
    if (thread_suspend(gMainThread) != KERN_SUCCESS) break;
    arm_thread_state64_t st;
    mach_msg_type_number_t cnt = ARM_THREAD_STATE64_COUNT;
    if (thread_get_state(gMainThread, ARM_THREAD_STATE64, (thread_state_t)&st, &cnt) == KERN_SUCCESS) {
      gSampleFrames[i][n++] = __darwin_arm_thread_state64_get_pc(st) & 0x0000000fffffffffull;
      gSampleFrames[i][n++] = __darwin_arm_thread_state64_get_lr(st) & 0x0000000fffffffffull;
      uint64_t fp = __darwin_arm_thread_state64_get_fp(st);
      while (fp && n < SAMPLE_DEPTH) {
        uint64_t next, ret;
        if (!ReadWord(fp, &next) || !ReadWord(fp + 8, &ret)) break;
        ret &= 0x0000000fffffffffull;
        if (!ret) break;
        gSampleFrames[i][n++] = ret;
        if (next <= fp) break;
        fp = next;
      }
    }
    thread_resume(gMainThread);
    gSampleDepth[i] = n;
    gSampleAt[i] = EpochMs();
    gSampleCount++;
    usleep(500);
  }
  NSMutableDictionary<NSNumber *, NSString *> *names = [NSMutableDictionary dictionary];
  NSMutableString *out = [NSMutableString string];
  for (int i = 0; i < gSampleCount; i++) {
    [out appendFormat:@"s %.2f", gSampleAt[i]];
    for (int k = 0; k < gSampleDepth[i]; k++) {
      uint64_t pc = gSampleFrames[i][k];
      [out appendFormat:@" %llx", pc];
      if (names[@(pc)]) continue;
      Dl_info info;
      if (dladdr((void *)(uintptr_t)(k ? pc - 1 : pc), &info) && info.dli_fname)
        names[@(pc)] = [NSString stringWithFormat:@"%s\t%llx\t%s", info.dli_fname, (unsigned long long)(uintptr_t)info.dli_fbase, info.dli_sname ?: "?"];
      else names[@(pc)] = @"?\t0\t?";
    }
    [out appendString:@"\n"];
  }
  for (NSNumber *pc in names) [out appendFormat:@"sym %llx\t%@\n", pc.unsignedLongLongValue, names[pc]];
  NSString *path = [gDir stringByAppendingPathComponent:[NSString stringWithFormat:@"main-sample-%.0f.txt", EpochMs()]];
  [out writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
  gSampling = 0;
  return NULL;
}

static NSDictionary *StartSampling(NSDictionary *cmd) {
  if (gSampling) return @{@"ok" : @NO, @"error" : @"already sampling"};
  gSampling = 1;
  pthread_t t;
  if (pthread_create(&t, NULL, SampleMain, (void *)(intptr_t)([cmd[@"ms"] intValue] ?: 1500)) != 0) {
    gSampling = 0;
    return @{@"ok" : @NO, @"error" : @"no sampler thread"};
  }
  pthread_detach(t);
  return @{@"ok" : @YES};
}

static BOOL gPointerSet;
static NSPoint gPointer;
static NSInteger gPointerWindow;

static void SwizzleClass(Class cls, SEL sel, id block) {
  Method m = class_getClassMethod(cls, sel);
  if (m) method_setImplementation(m, imp_implementationWithBlock(block));
}

static NSDictionary *PlacePointer(NSDictionary *cmd) {
  NSWindow *w = AppWindow([cmd[@"window"] integerValue]);
  if (!w) return @{@"ok" : @NO, @"error" : @"no window"};
  NSRect frame = w.frame;
  gPointer = NSMakePoint(frame.origin.x + [cmd[@"x"] doubleValue], NSMaxY(frame) - [cmd[@"y"] doubleValue]);
  gPointerWindow = w.windowNumber;
  if (!gPointerSet) {
    gPointerSet = YES;
    Class meta = NSEvent.class;
    Method loc = class_getClassMethod(meta, @selector(mouseLocation));
    IMP origLoc = method_getImplementation(loc);
    SwizzleClass(meta, @selector(mouseLocation), ^NSPoint(id self) {
      return gPointerSet ? gPointer : ((NSPoint(*)(id, SEL))origLoc)(self, @selector(mouseLocation));
    });
    SwizzleClass(meta, @selector(pressedMouseButtons), ^NSUInteger(id self) { return 0; });
    Method at = class_getClassMethod(NSWindow.class, @selector(windowNumberAtPoint:belowWindowWithWindowNumber:));
    IMP origAt = method_getImplementation(at);
    SwizzleClass(NSWindow.class, @selector(windowNumberAtPoint:belowWindowWithWindowNumber:), ^NSInteger(id self, NSPoint p, NSInteger below) {
      for (NSWindow *win in NSApp.windows)
        if (win.windowNumber == gPointerWindow && NSPointInRect(p, win.frame)) return gPointerWindow;
      return ((NSInteger(*)(id, SEL, NSPoint, NSInteger))origAt)(self, @selector(windowNumberAtPoint:belowWindowWithWindowNumber:), p, below);
    });
  }
  Class view = NSClassFromString(@"RCTView");
  if ([view respondsToSelector:@selector(ardia_markHoverDirty)]) [view performSelector:@selector(ardia_markHoverDirty)];
  return @{@"ok" : @YES, @"screen" : @[ @(gPointer.x), @(gPointer.y) ]};
}

static void Command(NSDictionary *cmd) {
  NSString *op = cmd[@"op"], *cid = cmd[@"id"];
  if ([op isEqualToString:@"gesture"]) return RunGesture(cmd, cid);
  if ([op isEqualToString:@"counters"]) return Answer(cid, @{@"ok" : @YES, @"scrollEvents" : @(gScrollEvents), @"scrollMs" : @(gScrollMs), @"scrollMaxMs" : @(gScrollMaxMs)});
  if ([op isEqualToString:@"resetMax"]) {
    gScrollMaxMs = 0;
    return Answer(cid, @{@"ok" : @YES});
  }
  if ([op isEqualToString:@"trace"]) return Answer(cid, StartTrace(cmd));
  if ([op isEqualToString:@"scroll"]) return Answer(cid, ScrollUnder(cmd));
  if ([op isEqualToString:@"untrace"]) return Answer(cid, StopTrace());
  if ([op isEqualToString:@"pointer"]) return Answer(cid, PlacePointer(cmd));
  if ([op isEqualToString:@"sample"]) return Answer(cid, StartSampling(cmd));
  if ([op isEqualToString:@"sampling"]) return Answer(cid, @{@"ok" : @YES, @"busy" : @(gSampling)});
  Answer(cid, @{@"ok" : @NO, @"error" : @"unknown op"});
}

__attribute__((constructor)) static void Start(void) {
  const char *dir = getenv("ARDIA_DATA_DIR");
  if (!dir || !getenv("AC_BENCH_SWIPE")) return;
  if (![NSBundle.mainBundle.bundlePath hasSuffix:@".app"] || [NSBundle.mainBundle.bundlePath containsString:@"Helper"]) return;
  gDir = [NSString stringWithUTF8String:dir];
  static dispatch_source_t timer;
  static NSData *last;
  NSString *cmdPath = [gDir stringByAppendingPathComponent:@"bench-swipe-cmd.json"];
  timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_queue_create("acswipe.cmd", DISPATCH_QUEUE_SERIAL));
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), 10 * NSEC_PER_MSEC, 2 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{
    NSData *data = [NSData dataWithContentsOfFile:cmdPath];
    if (!data.length || [data isEqualToData:last]) return;
    NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (!cmd) return;
    last = data;
    dispatch_async(dispatch_get_main_queue(), ^{ Command(cmd); });
  });
  dispatch_resume(timer);
  dispatch_async(dispatch_get_main_queue(), ^{ gMainThread = mach_thread_self(); });
  CFRunLoopTimerRef boot = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 0.1, 0.1, 0, 0, ^(CFRunLoopTimerRef t) {
    if (!NSApp) return;
    TimeScrollEvents();
    CFRunLoopTimerInvalidate(t);
  });
  CFRunLoopAddTimer(CFRunLoopGetMain(), boot, kCFRunLoopCommonModes);
}
