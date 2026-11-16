#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <mach/mach_time.h>

static NSString *gInbox;
static NSString *gOutbox;
typedef void (*SetWindowLocation)(CGEventRef, CGPoint);
static SetWindowLocation gSetWindowLocation;
static BOOL gSend;

static double NowMs(void) { return NSDate.date.timeIntervalSince1970 * 1000; }

static NSWindow *MainWindow(void) {
  NSWindow *best = nil;
  for (NSWindow *w in NSApp.windows) {
    if (!w.isVisible || w.frame.size.width < 300) continue;
    if (!best || w.frame.size.width * w.frame.size.height > best.frame.size.width * best.frame.size.height) best = w;
  }
  return best;
}

typedef struct {
  NSInteger window;
  CGPoint global;
  CGPoint local;
  BOOL horizontal;
  double sign;
} Target;

static void Post(Target t, double raw, int64_t phase, int64_t momentum, BOOL continuous) {
  double d = raw * t.sign;
  int32_t step = continuous ? (int32_t)lround(d) : (d < 0 ? -1 : 1);
  CGEventRef cg = CGEventCreateScrollWheelEvent2(NULL, continuous ? kCGScrollEventUnitPixel : kCGScrollEventUnitLine, 2, t.horizontal ? 0 : step, t.horizontal ? step : 0, 0);
  if (!cg) return;
  CGEventSetLocation(cg, t.global);
  CGEventSetIntegerValueField(cg, kCGScrollWheelEventIsContinuous, continuous ? 1 : 0);
  if (continuous) {
    CGEventSetIntegerValueField(cg, t.horizontal ? kCGScrollWheelEventDeltaAxis2 : kCGScrollWheelEventDeltaAxis1, MAX(-10, MIN(10, lround(d / 10))));
    CGEventSetIntegerValueField(cg, t.horizontal ? kCGScrollWheelEventPointDeltaAxis2 : kCGScrollWheelEventPointDeltaAxis1, lround(d));
    CGEventSetDoubleValueField(cg, t.horizontal ? kCGScrollWheelEventFixedPtDeltaAxis2 : kCGScrollWheelEventFixedPtDeltaAxis1, d);
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventScrollPhase, phase);
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventMomentumPhase, momentum);
  }
  CGEventSetTimestamp(cg, clock_gettime_nsec_np(CLOCK_UPTIME_RAW));
  CGEventSetIntegerValueField(cg, (CGEventField)51, t.window);
  if (gSetWindowLocation) gSetWindowLocation(cg, t.local);
  NSEvent *event = [NSEvent eventWithCGEvent:cg];
  CFRelease(cg);
  if (!event) return;
  if (gSend) dispatch_async(dispatch_get_main_queue(), ^{ [NSApp sendEvent:event]; });
  else [NSApp postEvent:event atStart:NO];
}

static void Gesture(NSDictionary *cmd, Target t) {
  NSString *gesture = cmd[@"gesture"];
  double rate = [cmd[@"rate"] doubleValue] ?: 120;
  double tick = 1 / rate;
  double start = NSDate.date.timeIntervalSince1970;
  __block double elapsed = 0;
  void (^wait)(double) = ^(double seconds) {
    elapsed += seconds;
    double left = start + elapsed - NSDate.date.timeIntervalSince1970;
    while (left > 0) {
      if (left > 0.002) usleep((useconds_t)((left - 0.0015) * 1e6));
      left = start + elapsed - NSDate.date.timeIntervalSince1970;
    }
  };
  long events = 0;
  BOOL phased = ![gesture isEqualToString:@"pan"];
  if ([gesture isEqualToString:@"trackpad"] || [gesture isEqualToString:@"fingers"] || !phased) {
    if (phased) Post(t, 0, 128, 0, YES);
    wait(tick);
    int fingers = (int)lround(0.3 * rate);
    for (int i = 0; i < fingers; i++) {
      Post(t, -(4 + 22 * sin((double)i / fingers * M_PI * 0.85)) * 120 / rate, phased ? (i == 0 ? 1 : 2) : 0, 0, YES);
      events++;
      wait(tick);
    }
    if (phased) {
      Post(t, 0, 4, 0, YES);
      wait(tick);
    }
    if (![gesture isEqualToString:@"fingers"]) {
      double velocity = -24.0 * 120 / rate;
      BOOL first = YES;
      while (fabs(velocity) > 0.4 * 120 / rate) {
        Post(t, velocity, 0, phased ? (first ? 1 : 2) : 0, YES);
        first = NO;
        events++;
        velocity *= pow(0.972, 120 / rate);
        wait(tick);
      }
      if (phased) Post(t, 0, 0, 3, YES);
    }
  } else if ([gesture isEqualToString:@"wheel"]) {
    for (int i = 0; i < 12; i++) {
      Post(t, -1, 0, 0, NO);
      events++;
      wait(0.09);
    }
  }
  double end = NowMs();
  NSDictionary *done = @{ @"id" : cmd[@"id"] ?: @0, @"startMs" : @(start * 1000), @"endMs" : @(end), @"events" : @(events) };
  [[NSJSONSerialization dataWithJSONObject:done options:0 error:nil] writeToFile:gOutbox atomically:YES];
}

static void Poll(void) {
  NSData *data = [NSData dataWithContentsOfFile:gInbox];
  if (!data) return;
  [NSFileManager.defaultManager removeItemAtPath:gInbox error:nil];
  NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![cmd isKindOfClass:NSDictionary.class]) return;
  NSWindow *window = MainWindow();
  if (!window) {
    [[NSJSONSerialization dataWithJSONObject:@{ @"id" : cmd[@"id"] ?: @0, @"error" : @"no window" } options:0 error:nil] writeToFile:gOutbox atomically:YES];
    return;
  }
  NSString *gesture = cmd[@"gesture"];
  BOOL horizontal = [gesture hasSuffix:@"-x"];
  double x = [cmd[@"x"] doubleValue], y = [cmd[@"y"] doubleValue];
  NSRect frame = window.frame;
  CGFloat mainHeight = NSHeight(NSScreen.screens.firstObject.frame);
  Target t = {
    .window = window.windowNumber,
    .global = CGPointMake(NSMinX(frame) + x, mainHeight - (NSMaxY(frame) - y)),
    .local = CGPointMake(x, y),
    .horizontal = horizontal,
    .sign = [cmd[@"reverse"] boolValue] ? -1 : 1,
  };
  NSMutableDictionary *run = [cmd mutableCopy];
  run[@"gesture"] = horizontal ? [gesture substringToIndex:gesture.length - 2] : gesture;
  [NSThread detachNewThreadWithBlock:^{ Gesture(run, t); }];
}

__attribute__((constructor)) static void ScrollInit(void) {
  NSString *exe = NSProcessInfo.processInfo.arguments.firstObject.lastPathComponent;
  NSString *dir = NSProcessInfo.processInfo.environment[@"ARDIA_DATA_DIR"];
  if (![exe isEqualToString:@"Ardia"] || !dir) return;
  gInbox = [dir stringByAppendingPathComponent:@"film-scroll.json"];
  gOutbox = [dir stringByAppendingPathComponent:@"film-scroll-done.json"];
  gSend = [NSProcessInfo.processInfo.environment[@"FIXES_SCROLL_DISPATCH"] isEqualToString:@"send"];
  gSetWindowLocation = (SetWindowLocation)dlsym(RTLD_DEFAULT, "CGEventSetWindowLocation");
  dispatch_async(dispatch_get_main_queue(), ^{
    [[NSRunLoop mainRunLoop] addTimer:[NSTimer timerWithTimeInterval:0.02 repeats:YES block:^(NSTimer *timer) { Poll(); }] forMode:NSRunLoopCommonModes];
  });
}
