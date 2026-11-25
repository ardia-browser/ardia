#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <QuartzCore/QuartzCore.h>
#import <dlfcn.h>

typedef CGImageRef (*CreateImageFromArray)(CGRect, CFArrayRef, uint32_t);

static NSString *gDir;
static NSString *gLastCommand = @"";
static dispatch_queue_t gQueue;
static dispatch_source_t gPoll;
static dispatch_source_t gTick;
static CreateImageFromArray gCapture;
static AVAssetWriter *gWriter;
static AVAssetWriterInput *gInput;
static AVAssetWriterInputPixelBufferAdaptor *gAdaptor;
static CGRect gRect;
static CGFloat gScale = 2;
static BOOL gLayers;
static CGRect gCrop;
static NSRect gMainFrame;
static BOOL gCropped;
static double gStart;
static double gEnd;
static size_t gWidth;
static size_t gHeight;
static long gFrames;
static long gDropped;

static void Status(NSString *line) {
  NSString *path = [gDir stringByAppendingPathComponent:@"status"];
  NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:path];
  if (!h) {
    [[NSFileManager defaultManager] createFileAtPath:path contents:nil attributes:nil];
    h = [NSFileHandle fileHandleForWritingAtPath:path];
  }
  [h seekToEndOfFile];
  [h writeData:[[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
  [h closeFile];
}

static NSArray<NSDictionary *> *OwnWindows(void) {
  pid_t me = getpid();
  NSArray *all = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
  NSMutableArray *mine = [NSMutableArray array];
  for (NSDictionary *w in all) {
    if ([w[(id)kCGWindowOwnerPID] intValue] != me) continue;
    CGRect r;
    if (!CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)w[(id)kCGWindowBounds], &r)) continue;
    if (r.size.width <= 1 || r.size.height <= 1) continue;
    if ([w[(id)kCGWindowAlpha] doubleValue] <= 0) continue;
    [mine addObject:w];
  }
  return mine;
}

static double Now(void) { return [[NSDate date] timeIntervalSince1970]; }

static void Finish(void) {
  if (gTick) {
    dispatch_source_cancel(gTick);
    gTick = nil;
  }
  if (!gWriter) return;
  [gInput markAsFinished];
  AVAssetWriter *writer = gWriter;
  gWriter = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC));
  Status([NSString stringWithFormat:@"frames %ld dropped %ld", gFrames, gDropped]);
  Status(writer.status == AVAssetWriterStatusCompleted ? @"finished" : [NSString stringWithFormat:@"error %@", writer.error]);
}

static void HideOutside(CALayer *layer, CALayer *root, CGRect area, NSMutableArray<CALayer *> *hidden, int depth) {
  for (CALayer *child in [layer.sublayers copy]) {
    if (child.hidden) continue;
    CGRect placed = [child convertRect:child.bounds toLayer:root];
    if (!CGRectIntersectsRect(placed, area)) {
      child.hidden = YES;
      [hidden addObject:child];
    } else if (depth < 6 && !CGRectContainsRect(area, placed)) {
      HideOutside(child, root, area, hidden, depth + 1);
    }
  }
}

static void DrawLayers(CGContextRef ctx) {
  CGContextClipToRect(ctx, CGRectMake(0, 0, gWidth, gHeight));
  dispatch_sync(dispatch_get_main_queue(), ^{
    CGFloat screenHeight = NSScreen.screens.firstObject.frame.size.height;
    for (NSWindow *window in [NSApp.orderedWindows reverseObjectEnumerator]) {
      if (!window.isVisible || window.alphaValue <= 0) continue;
      NSView *view = window.contentView;
      CALayer *layer = view.layer;
      if (!layer || layer.bounds.size.width <= 0 || layer.bounds.size.height <= 0) continue;
      NSRect frame = window.frame;
      CGFloat left = frame.origin.x - gRect.origin.x;
      CGFloat top = (screenHeight - NSMaxY(frame)) - gRect.origin.y;
      CGFloat bottom = gRect.size.height - top - frame.size.height;
      if (left >= gRect.size.width || bottom >= gRect.size.height || left + frame.size.width <= 0 || bottom + frame.size.height <= 0) continue;
      NSRect placed = [view convertRect:view.bounds toView:nil];
      NSMutableArray<CALayer *> *hidden = [NSMutableArray array];
      [CATransaction begin];
      [CATransaction setDisableActions:YES];
      if (gCropped && NSEqualRects(frame, gMainFrame)) {
        NSRect area = NSMakeRect(gCrop.origin.x, frame.size.height - gCrop.origin.y - gCrop.size.height, gCrop.size.width, gCrop.size.height);
        HideOutside(layer, layer, NSRectToCGRect([view convertRect:area fromView:nil]), hidden, 0);
      }
      CGContextSaveGState(ctx);
      CGContextScaleCTM(ctx, gScale, gScale);
      CGContextTranslateCTM(ctx, left + placed.origin.x, bottom + placed.origin.y);
      CGContextScaleCTM(ctx, placed.size.width / layer.bounds.size.width, placed.size.height / layer.bounds.size.height);
      if (view.isFlipped || layer.isGeometryFlipped) {
        CGContextTranslateCTM(ctx, 0, layer.bounds.size.height);
        CGContextScaleCTM(ctx, 1, -1);
      }
      [layer renderInContext:ctx];
      CGContextRestoreGState(ctx);
      for (CALayer *l in hidden) l.hidden = NO;
      [CATransaction commit];
    }
  });
}

static void Grab(void) {
  if (!gWriter) return;
  double t = Now();
  if (t > gEnd) {
    Finish();
    return;
  }
  if (!gInput.readyForMoreMediaData) {
    gDropped++;
    return;
  }
  CGImageRef image = NULL;
  if (!gLayers) {
    NSArray *windows = OwnWindows();
    if (windows.count == 0) return;
    const void **ids = malloc(sizeof(void *) * windows.count);
    for (NSUInteger i = 0; i < windows.count; i++) ids[i] = (const void *)(uintptr_t)[windows[i][(id)kCGWindowNumber] unsignedIntValue];
    CFArrayRef list = CFArrayCreate(NULL, ids, (CFIndex)windows.count, NULL);
    free(ids);
    image = gCapture(gRect, list, 8);
    CFRelease(list);
    if (!image) {
      gDropped++;
      return;
    }
  }
  CVPixelBufferRef buffer = NULL;
  CVPixelBufferPoolCreatePixelBuffer(NULL, gAdaptor.pixelBufferPool, &buffer);
  if (!buffer) {
    if (image) CGImageRelease(image);
    gDropped++;
    return;
  }
  CVPixelBufferLockBaseAddress(buffer, 0);
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(buffer), gWidth, gHeight, 8, CVPixelBufferGetBytesPerRow(buffer), space, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGContextSetRGBFillColor(ctx, 0, 0, 0, 1);
  CGContextFillRect(ctx, CGRectMake(0, 0, gWidth, gHeight));
  if (image) CGContextDrawImage(ctx, CGRectMake(0, 0, gWidth, gHeight), image);
  else DrawLayers(ctx);
  CGContextRelease(ctx);
  CGColorSpaceRelease(space);
  CVPixelBufferUnlockBaseAddress(buffer, 0);
  if (image) CGImageRelease(image);
  if (gFrames == 0) {
    gStart = t;
    [gWriter startSessionAtSourceTime:kCMTimeZero];
    Status([NSString stringWithFormat:@"recording %lld", (long long)llround(t * 1000)]);
  }
  CMTime at = CMTimeMakeWithSeconds(t - gStart, 600);
  if ([gAdaptor appendPixelBuffer:buffer withPresentationTime:at]) gFrames++;
  else gDropped++;
  CVPixelBufferRelease(buffer);
}

static void Start(NSString *out, int fps, double seconds) {
  Finish();
  NSArray *windows = OwnWindows();
  NSDictionary *largest = nil;
  double area = 0;
  for (NSDictionary *w in windows) {
    CGRect r;
    CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)w[(id)kCGWindowBounds], &r);
    if (r.size.width * r.size.height > area) {
      area = r.size.width * r.size.height;
      largest = w;
    }
  }
  if (!largest) {
    Status(@"error no window");
    return;
  }
  CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)largest[(id)kCGWindowBounds], &gRect);
  gRect = CGRectIntegral(gRect);
  const char *crop = getenv("FIXES_SELFREC_CROP");
  if (crop) {
    double cx = 0, cy = 0, cw = 0, ch = 0;
    if (sscanf(crop, "%lf,%lf,%lf,%lf", &cx, &cy, &cw, &ch) == 4) {
      gRect = CGRectMake(gRect.origin.x + cx, gRect.origin.y + cy, cw, ch);
      gCrop = CGRectMake(cx, cy, cw, ch);
      gCropped = YES;
    }
  }
  __block CGFloat scale = 2;
  dispatch_sync(dispatch_get_main_queue(), ^{
    for (NSWindow *w in NSApp.windows) {
      if (w.windowNumber == [largest[(id)kCGWindowNumber] integerValue]) {
        scale = w.backingScaleFactor;
        gMainFrame = w.frame;
      }
    }
  });
  if (getenv("FIXES_SELFREC_SCALE")) scale = atof(getenv("FIXES_SELFREC_SCALE"));
  gScale = scale;
  gWidth = ((size_t)(gRect.size.width * scale)) & ~1;
  gHeight = ((size_t)(gRect.size.height * scale)) & ~1;
  [[NSFileManager defaultManager] removeItemAtPath:out error:nil];
  NSError *error = nil;
  gWriter = [AVAssetWriter assetWriterWithURL:[NSURL fileURLWithPath:out] fileType:AVFileTypeQuickTimeMovie error:&error];
  if (!gWriter) {
    Status([NSString stringWithFormat:@"error %@", error]);
    return;
  }
  NSDictionary *settings = @{
    AVVideoCodecKey : AVVideoCodecTypeH264,
    AVVideoWidthKey : @(gWidth),
    AVVideoHeightKey : @(gHeight),
    AVVideoCompressionPropertiesKey : @{AVVideoAverageBitRateKey : @(40000000), AVVideoExpectedSourceFrameRateKey : @(fps)},
  };
  gInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
  gInput.expectsMediaDataInRealTime = YES;
  gAdaptor = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:gInput sourcePixelBufferAttributes:@{
    (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
    (id)kCVPixelBufferWidthKey : @(gWidth),
    (id)kCVPixelBufferHeightKey : @(gHeight),
  }];
  [gWriter addInput:gInput];
  [gWriter startWriting];
  gFrames = 0;
  gDropped = 0;
  gEnd = Now() + seconds;
  Status([NSString stringWithFormat:@"rect %d,%d,%d,%d scale %g size %zux%zu", (int)gRect.origin.x, (int)gRect.origin.y, (int)gRect.size.width, (int)gRect.size.height, scale, gWidth, gHeight]);
  gTick = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gQueue);
  dispatch_source_set_timer(gTick, DISPATCH_TIME_NOW, NSEC_PER_SEC / fps, NSEC_PER_MSEC);
  dispatch_source_set_event_handler(gTick, ^{ Grab(); });
  dispatch_resume(gTick);
}

static void Poll(void) {
  NSString *command = [NSString stringWithContentsOfFile:[gDir stringByAppendingPathComponent:@"cmd"] encoding:NSUTF8StringEncoding error:nil];
  if (!command || [command isEqualToString:gLastCommand]) return;
  gLastCommand = command;
  NSArray *parts = [[command stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] componentsSeparatedByString:@"\t"];
  if ([parts[0] isEqualToString:@"start"] && parts.count >= 5) Start(parts[2], [parts[3] intValue], [parts[4] doubleValue]);
  else if ([parts[0] isEqualToString:@"stop"]) Finish();
}

__attribute__((constructor)) static void SelfRecInit(void) {
  const char *dir = getenv("FIXES_SELFREC_DIR");
  if (!dir) return;
  if (![[NSBundle mainBundle].bundlePath.lastPathComponent isEqualToString:@"Ardia.app"]) return;
  gLayers = getenv("FIXES_SELFREC_LAYERS") != NULL;
  gCapture = (CreateImageFromArray)dlsym(RTLD_DEFAULT, "CGWindowListCreateImageFromArray");
  if (!gCapture && !gLayers) return;
  gDir = [NSString stringWithUTF8String:dir];
  [[NSFileManager defaultManager] createDirectoryAtPath:gDir withIntermediateDirectories:YES attributes:nil error:nil];
  gQueue = dispatch_queue_create("selfrec", DISPATCH_QUEUE_SERIAL);
  gPoll = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gQueue);
  dispatch_source_set_timer(gPoll, DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(gPoll, ^{ Poll(); });
  dispatch_resume(gPoll);
}
