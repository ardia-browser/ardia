#import <AppKit/AppKit.h>

static NSString *gInbox;
static NSString *gOutbox;

static NSWindow *MainWindow(void) {
  NSWindow *best = nil;
  for (NSWindow *w in NSApp.windows) {
    if (!w.isVisible || [w.title isEqualToString:@"Settings"]) continue;
    if (!best || w.frame.size.width * w.frame.size.height > best.frame.size.width * best.frame.size.height) best = w;
  }
  return best;
}

static void Resize(NSWindow *window, NSSize to, double ms) {
  NSRect from = window.frame;
  CGFloat top = NSMaxY(from);
  NSInteger steps = MAX(1, (NSInteger)round(ms / 16.0));
  for (NSInteger i = 1; i <= steps; i++) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(i * 0.016 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      double k = 0.5 - 0.5 * cos(M_PI * (double)i / steps);
      CGFloat w = from.size.width + (to.width - from.size.width) * k;
      CGFloat h = from.size.height + (to.height - from.size.height) * k;
      [window setFrame:NSMakeRect(from.origin.x, top - h, w, h) display:YES];
      if (i == steps) [[NSString stringWithFormat:@"%g,%g", window.frame.size.width, window.frame.size.height] writeToFile:gOutbox atomically:YES encoding:NSUTF8StringEncoding error:nil];
    });
  }
}

static void Poll(void) {
  NSString *text = [NSString stringWithContentsOfFile:gInbox encoding:NSUTF8StringEncoding error:nil];
  if (!text) return;
  [NSFileManager.defaultManager removeItemAtPath:gInbox error:nil];
  NSArray<NSString *> *parts = [text componentsSeparatedByString:@","];
  NSWindow *window = MainWindow();
  if (parts.count < 3 || !window) {
    [@"error" writeToFile:gOutbox atomically:YES encoding:NSUTF8StringEncoding error:nil];
    return;
  }
  Resize(window, NSMakeSize(parts[0].doubleValue, parts[1].doubleValue), parts[2].doubleValue);
}

__attribute__((constructor)) static void FrameInit(void) {
  NSString *exe = NSProcessInfo.processInfo.arguments.firstObject.lastPathComponent;
  NSString *dir = NSProcessInfo.processInfo.environment[@"ARDIA_DATA_DIR"];
  if (![exe isEqualToString:@"Ardia"] || !dir) return;
  gInbox = [dir stringByAppendingPathComponent:@"film-frame.txt"];
  gOutbox = [dir stringByAppendingPathComponent:@"film-frame-done.txt"];
  dispatch_async(dispatch_get_main_queue(), ^{
    [[NSRunLoop mainRunLoop] addTimer:[NSTimer timerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *timer) { Poll(); }] forMode:NSRunLoopCommonModes];
  });
}
