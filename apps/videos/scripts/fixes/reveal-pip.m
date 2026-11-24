#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>

static NSString *gLog;
static NSMutableDictionary<NSNumber *, NSString *> *gSeen;
static BOOL gPinUnhooked;

static void LeaveAlphaAlone(id self, SEL _cmd, NSString *keyPath, id object, NSDictionary *change, void *context) {}

static void UnhookThePin(void) {
  Class pin = gPinUnhooked ? nil : NSClassFromString(@"ACInvisibleWindowPin");
  if (!pin) return;
  method_setImplementation(class_getInstanceMethod(pin, @selector(observeValueForKeyPath:ofObject:change:context:)), (IMP)LeaveAlphaAlone);
  gPinUnhooked = YES;
}

static BOOL ShowsPage(NSView *view) {
  static Class page;
  if (!page) page = NSClassFromString(@"RenderWidgetHostViewCocoa");
  if (page && [view isKindOfClass:page]) return YES;
  for (NSView *child in view.subviews)
    if (ShowsPage(child)) return YES;
  return NO;
}

static BOOL IsDocumentPictureInPicture(NSWindow *window) {
  Class core = NSClassFromString(@"ArdiaCoreWindow");
  SEL frameless = NSSelectorFromString(@"isChromeFramelessWindow:");
  if (!core || ![core respondsToSelector:frameless]) return NO;
  if (!((BOOL (*)(id, SEL, id))objc_msgSend)(core, frameless, window)) return NO;
  return window.visible && window.level >= NSFloatingWindowLevel && (window.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces) && ShowsPage(window.contentView);
}

static void Note(NSString *line) {
  NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:gLog];
  if (!file) {
    [NSFileManager.defaultManager createFileAtPath:gLog contents:nil attributes:nil];
    file = [NSFileHandle fileHandleForWritingAtPath:gLog];
  }
  [file seekToEndOfFile];
  [file writeData:[[NSString stringWithFormat:@"%lld %@\n", (long long)(NSDate.date.timeIntervalSince1970 * 1000), line] dataUsingEncoding:NSUTF8StringEncoding]];
  [file closeFile];
}

static void Watch(void) {
  UnhookThePin();
  NSMutableDictionary<NSNumber *, NSString *> *now = [NSMutableDictionary dictionary];
  for (NSWindow *window in NSApp.windows) {
    if (!IsDocumentPictureInPicture(window)) continue;
    NSNumber *number = @(window.windowNumber);
    NSString *state = [NSString stringWithFormat:@"frame %@ alpha %.2f", NSStringFromRect(window.frame), window.alphaValue];
    if (!gSeen[number] || (window.alphaValue > 0.99 && ![gSeen[number] isEqualToString:state])) Note([NSString stringWithFormat:@"pip window %@ %@", number, state]);
    now[number] = state;
  }
  for (NSNumber *gone in gSeen)
    if (!now[gone]) Note([NSString stringWithFormat:@"gone window %@", gone]);
  gSeen = now;
}

__attribute__((constructor)) static void RevealInit(void) {
  NSString *exe = NSProcessInfo.processInfo.arguments.firstObject.lastPathComponent;
  NSString *dir = NSProcessInfo.processInfo.environment[@"ARDIA_DATA_DIR"];
  if (![exe isEqualToString:@"Ardia"] || !dir) return;
  gLog = [dir stringByAppendingPathComponent:@"film-pip.log"];
  gSeen = [NSMutableDictionary dictionary];
  dispatch_async(dispatch_get_main_queue(), ^{
    [[NSRunLoop mainRunLoop] addTimer:[NSTimer timerWithTimeInterval:0.03 repeats:YES block:^(NSTimer *timer) { Watch(); }] forMode:NSRunLoopCommonModes];
  });
}
