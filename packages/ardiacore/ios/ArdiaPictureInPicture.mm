#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaWindowController.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaChromeWindowHost.h"
#import "ArdiaPiPThrowMath.h"
#import "ArdiaPiPSeekMath.h"
#import "ArdiaPiPZoomMath.h"

#import <ApplicationServices/ApplicationServices.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <QuartzCore/QuartzCore.h>

using namespace ardia_pip;

namespace {

void InstallMenuMonitor() {
  static id monitor;
  if (monitor) return;
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskRightMouseDown
                                                  handler:^NSEvent *(NSEvent *event) {
                                                    ArdiaPiPController *controller =
                                                        event.window ? [ArdiaPiPController forWindow:event.window] : nil;
                                                    if (!controller) return event;
                                                    [NSMenu popUpContextMenu:[controller menu] withEvent:event forView:controller.overlay];
                                                    return nil;
                                                  }];
}

double ClickSkipSeconds(NSWindow *window, NSPoint local) {
  ArdiaPiPController *controller = [ArdiaPiPController forWindow:window];
  if (!controller.view || controller.stashedEdge != ArdiaPiPEdgeNone) return 0;
  return ardia_pip_seek::SkipSecondsAt(local.x, NSWidth(window.frame));
}

BOOL OnStashHandle(NSWindow *window, NSEvent *event) {
  ArdiaPiPController *controller = [ArdiaPiPController forWindow:window];
  ArdiaPiPHandle *handle = controller.overlay.handle;
  if (!handle || handle.hidden || controller.stashedEdge == ArdiaPiPEdgeNone) return NO;
  return NSPointInRect([handle convertPoint:event.locationInWindow fromView:nil], handle.bounds);
}

NSString *WhyPressPasses(NSWindow *window, NSEvent *event) {
  if (event.modifierFlags & NSEventModifierFlagControl) return @"control held";
  if (OnStashHandle(window, event)) return nil;
  if (event.clickCount > 1 && !ClickSkipSeconds(window, event.locationInWindow)) return @"double click";
  if ([window respondsToSelector:@selector(_resizeDirectionForMouseLocation:)] &&
      [window _resizeDirectionForMouseLocation:event.locationInWindow] != -1)
    return @"resize edge";
  NSView *frameView = window.contentView.superview;
  return frameView && [frameView hitTest:event.locationInWindow] == frameView ? nil : @"Chrome control";
}

void NotePress(NSWindow *window, NSEvent *event, NSString *outcome) {
  NoteGesture(@"press window=%ld clicks=%ld appActive=%d key=%d -> %@", (long)window.windowNumber, (long)event.clickCount, NSApp.isActive,
              window.keyWindow, outcome);
}

__weak ArdiaPiPController *gDragged;

NSPoint gGrabLocal;

NSPoint gGrabMouse;

double gGrabTravel;

double gGrabSkip;

NSInteger gGrabClicks;

BOOL gGrabHandle;

void NoteGrabTravel(NSEvent *event) {
  const NSPoint mouse = PointerOf(event);
  gGrabTravel = std::max(gGrabTravel, ardia_pip_seek::Travel(mouse.x - gGrabMouse.x, mouse.y - gGrabMouse.y));
}

void InstallDragMonitor() {
  static id monitor;
  if (monitor) return;
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp
                                                  handler:^NSEvent *(NSEvent *event) {
                                                    if ([ArdiaPiPZoom continueEdgeResize:event]) return nil;
                                                    if (event.type == NSEventTypeLeftMouseDown) {
                                                      NSWindow *window = event.window;
                                                      ArdiaPiPController *pressed = window ? [ArdiaPiPController forWindow:window] : nil;
                                                      if ([ArdiaPiPZoom beginEdgeResize:window event:event]) {
                                                        NotePress(window, event, @"edge resize");
                                                        ActivateWithOnlyPictureInPicture(pressed, NO);
                                                        return nil;
                                                      }
                                                      NSString *passes = pressed ? WhyPressPasses(window, event) : @"";
                                                      ArdiaPiPController *grabbed = passes ? nil : pressed;
                                                      gDragged = grabbed;
                                                      if (pressed) NotePress(window, event, passes ? [@"passed: " stringByAppendingString:passes] : @"grab");
                                                      if (!grabbed) return event;
                                                      ActivateWithOnlyPictureInPicture(grabbed, NO);
                                                      [grabbed dragBegan:event];
                                                      gGrabMouse = PointerOf(event);
                                                      gGrabLocal = NSMakePoint(gGrabMouse.x - NSMinX(window.frame), gGrabMouse.y - NSMinY(window.frame));
                                                      gGrabTravel = 0;
                                                      gGrabSkip = ClickSkipSeconds(window, event.locationInWindow);
                                                      gGrabClicks = event.clickCount;
                                                      gGrabHandle = OnStashHandle(window, event);
                                                      ardia_host::NotePointer(event, @"pipDrag");
                                                      return nil;
                                                    }
                                                    ArdiaPiPController *dragged = gDragged;
                                                    if (!dragged) return event;
                                                    NoteGrabTravel(event);
                                                    if (event.type == NSEventTypeLeftMouseUp) {
                                                      gDragged = nil;
                                                      [dragged dragEnded:event];
                                                      if (gGrabSkip && ardia_pip_seek::IsClick(gGrabTravel))
                                                        [dragged skipDraggedBy:gGrabSkip at:gGrabLocal clickCount:gGrabClicks];
                                                      if (gGrabHandle && ardia_pip_seek::IsClick(gGrabTravel)) [dragged unstashFromHandle];
                                                      NoteGesture(@"release window=%ld travel=%.0f click=%d skip=%+.0f handle=%d", (long)dragged.window.windowNumber,
                                                                  gGrabTravel, ardia_pip_seek::IsClick(gGrabTravel), gGrabSkip, gGrabHandle);
                                                      ardia_host::NotePointer(event, @"pipDrag");
                                                    } else {
                                                      [dragged dragMoved:event];
                                                    }
                                                    return nil;
                                                  }];
}

id gOtherAppPinchMonitor;

void FollowPinchesFromOtherApps() {
  const BOOL wanted = ardia_pip_zoom::WantsOtherAppPinches(NSApp.isActive, [ArdiaPiPZoom enabled], [ArdiaPiPZoom anyZoomable]);
  if (wanted == (gOtherAppPinchMonitor != nil)) return;
  if (!wanted) {
    [NSEvent removeMonitor:gOtherAppPinchMonitor];
    gOtherAppPinchMonitor = nil;
    NoteGesture(@"other-app pinch monitor off appActive=%d zoomOn=%d zoomable=%d", NSApp.isActive, [ArdiaPiPZoom enabled], [ArdiaPiPZoom anyZoomable]);
    return;
  }
  gOtherAppPinchMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskMagnify
                                                                 handler:^(NSEvent *event) {
                                                                   PinchFromOtherApp(event);
                                                                 }];
  NoteGesture(@"other-app pinch monitor %@", gOtherAppPinchMonitor ? @"on" : @"refused by macOS");
}

void InstallZoomMonitor() {
  static id monitor;
  if (!monitor) {
    monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel | NSEventMaskMagnify
                                                    handler:^NSEvent *(NSEvent *event) {
                                                      return [ArdiaPiPController handleSwipe:event] || [ArdiaPiPZoom handle:event] ? nil : event;
                                                    }];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    for (NSNotificationName name in @[ NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification ])
      [center addObserverForName:name object:NSApp queue:nil usingBlock:^(NSNotification *) {
        FollowPinchesFromOtherApps();
      }];
    [center addObserverForName:NSWindowWillCloseNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
      [ArdiaPiPZoom dropStandInOn:note.object];
      RefreshPinchesFromOtherApps();
    }];
    [center addObserverForName:NSWindowDidChangeOcclusionStateNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
      NSWindow *window = note.object;
      if (!window.visible) [ArdiaPiPZoom dropStandInOn:window];
      RefreshPinchesFromOtherApps();
    }];
    [center addObserverForName:NSApplicationDidHideNotification object:NSApp queue:nil usingBlock:^(NSNotification *) {
      [ArdiaPiPZoom dropStandInOn:nil];
    }];
    [center addObserverForName:NSUserDefaultsDidChangeNotification object:nil queue:nil usingBlock:^(NSNotification *) {
      RefreshPinchesFromOtherApps();
    }];
  }
  FollowPinchesFromOtherApps();
}

bool Attach(ArdiaWebView *view, NSString *host, ArdiaConsentStamp *stamp) {
  for (NSWindow *window in NSApp.windows) {
    ArdiaPiPController *controller = [ArdiaPiPController forWindow:window];
    if (!IsChromeVideoPictureInPicture(window) && !(controller && window.visible)) continue;
    if (!window.hasShadow) continue;
    if (controller.view && controller.view.browserId != view.browserId) continue;
    BOOL fresh = !controller;
    if (fresh) controller = [[ArdiaPiPController alloc] initWithWindow:window];
    controller.view = view;
    controller.host = host;
    [controller roundCorners];
    JoinFullScreenSpaces(window);
    PreventActivation(window);
    if (fresh) NoteGesture(@"video window=%ld size=%.0fx%.0f", (long)window.windowNumber, NSWidth(window.frame), NSHeight(window.frame));
    if (fresh) [view emit:@"pictureInPicture" payload:[stamp onto:@{@"kind" : @"video", @"active" : @YES, @"fullScreenSpaces" : @(JoinsFullScreenSpaces(window)), @"leftApp" : @(view.leftAppInPictureInPicture), @"leftTab" : @(!view.seenByUser)}]];
    if (ardia_host::Background()) {
      window.alphaValue = 0;
      window.ignoresMouseEvents = YES;
    }
    InstallMenuMonitor();
    InstallDragMonitor();
    InstallZoomMonitor();
    NSString *selfTest = ardia_host::Background() ? [ArdiaLaunchConfig.shared testValue:@"pipSelfTest"] : nil;
    if (fresh && [@[ @"close", @"backToTab" ] containsObject:selfTest]) [controller runButtonSelfTest:selfTest];
    else if (fresh && [selfTest isEqual:@"hover"]) [controller runHoverSelfTest];
    else if (fresh && selfTest) [controller runSelfTest];
    return true;
  }
  return false;
}

}

namespace {

NSString *DevShowAlpha(NSWindow *window, float alpha) {
  using MainConnection = int (*)(void);
  using SetAlpha = int (*)(int, int, float);
  auto connection = (MainConnection)dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
  auto set = (SetAlpha)dlsym(RTLD_DEFAULT, "CGSSetWindowAlpha");
  if (!ArdiaLaunchConfig.shared.testInstance) return @"test instances only";
  if (!connection || !set) return @"no CGSSetWindowAlpha";
  return set(connection(), (int)window.windowNumber, alpha) == 0 ? @"started" : @"refused";
}

void DevDescribeLayer(CALayer *layer, NSUInteger depth, NSMutableString *out) {
  [out appendFormat:@"%@L %@ %@ frame %@ bounds %@ radius %.2f mask %d curve %@ border %.1f opacity %.2f scale %.1f hidden %d%@\n",
                    [@"" stringByPaddingToLength:depth * 2 withString:@" " startingAtIndex:0], NSStringFromClass(layer.class),
                    layer.name ?: @"", NSStringFromRect(layer.frame), NSStringFromRect(layer.bounds), layer.cornerRadius,
                    layer.masksToBounds, layer.cornerCurve, layer.borderWidth, layer.opacity, layer.contentsScale, layer.hidden,
                    layer.mask ? [NSString stringWithFormat:@" layerMask %@", NSStringFromRect(layer.mask.frame)] : @""];
  for (CALayer *sublayer in layer.sublayers) DevDescribeLayer(sublayer, depth + 1, out);
}

void DevDescribeView(NSView *view, NSUInteger depth, NSMutableString *out) {
  [out appendFormat:@"%@V %@ frame %@ bounds %@ layer %d flipped %d\n", [@"" stringByPaddingToLength:depth * 2 withString:@" " startingAtIndex:0],
                    NSStringFromClass(view.class), NSStringFromRect(view.frame), NSStringFromRect(view.bounds), view.layer != nil,
                    view.isFlipped];
  for (NSView *subview in view.subviews) DevDescribeView(subview, depth + 1, out);
}

NSView *DevFindView(NSView *view, NSString *className) {
  if ([NSStringFromClass(view.class) isEqual:className]) return view;
  for (NSView *subview in view.subviews)
    if (NSView *found = DevFindView(subview, className)) return found;
  return nil;
}

NSString *DevZoomSetting(NSString *value) {
  if (!ArdiaLaunchConfig.shared.testInstance) return @"test instances only";
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  NSMutableDictionary *arguments = [[defaults volatileDomainForName:NSArgumentDomain] mutableCopy] ?: [NSMutableDictionary dictionary];
  if ([value isEqual:@"default"]) [arguments removeObjectForKey:kZoomDefault];
  else arguments[kZoomDefault] = @([value isEqual:@"1"]);
  [defaults setVolatileDomain:arguments forName:NSArgumentDomain];
  FollowPinchesFromOtherApps();
  return [ArdiaPiPZoom enabled] ? @"1" : @"0";
}

NSString *DevJSON(NSDictionary *object) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  return json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"";
}

NSString *DevFraming(ArdiaPiPController *controller) {
  NSWindow *window = controller.window;
  NSView *content = window.contentView;
  NSView *compositor = DevFindView(content, @"ViewsCompositorSuperview");
  NSDictionary *framing = @{
    @"styleMask" : @(window.styleMask),
    @"fullSizeContentView" : @((window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0),
    @"titled" : @((window.styleMask & NSWindowStyleMaskTitled) != 0),
    @"window" : NSStringFromSize(window.frame.size),
    @"contentRect" : NSStringFromRect([window contentRectForFrameRect:window.frame]),
    @"content" : NSStringFromRect(content.frame),
    @"compositor" : compositor ? NSStringFromRect([compositor convertRect:compositor.bounds toView:nil]) : @"",
    @"overlay" : NSStringFromRect([controller.overlay convertRect:controller.overlay.bounds toView:nil]),
    @"contentRadius" : @(content.layer.cornerRadius),
    @"contentMasks" : @(content.layer.masksToBounds),
    @"rimRadius" : @(controller.overlay.layer.cornerRadius),
    @"rimWidth" : @(controller.overlay.layer.borderWidth),
    @"radius" : @(controller.cornerRadius),
    @"scale" : @(window.backingScaleFactor),
  };
  NSData *json = [NSJSONSerialization dataWithJSONObject:framing options:0 error:nil];
  return json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"";
}

NSString *DevLayerTree(NSWindow *window) {
  NSMutableString *out = [NSMutableString string];
  [out appendFormat:@"window %@ frame %@ content %@ style %lu scale %.1f opaque %d shadow %d\n", NSStringFromClass(window.class),
                    NSStringFromRect(window.frame), NSStringFromRect([window contentRectForFrameRect:window.frame]),
                    (unsigned long)window.styleMask, window.backingScaleFactor, window.opaque, window.hasShadow];
  NSView *frameView = window.contentView.superview ?: window.contentView;
  DevDescribeView(frameView, 0, out);
  if (frameView.layer) DevDescribeLayer(frameView.layer, 0, out);
  return out;
}

}

namespace ardia_pip {

static NSTimeInterval gBackToTabActivationUntil = 0;

void MarkBackToTabActivation() {
  if (!ardia_host::Background() && !NSApp.isActive) gBackToTabActivationUntil = NSProcessInfo.processInfo.systemUptime + 2;
}

BOOL ConsumeBackToTabActivation() {
  const BOOL pending = NSProcessInfo.processInfo.systemUptime <= gBackToTabActivationUntil;
  gBackToTabActivationUntil = 0;
  return pending;
}

static BOOL gActiveOnlyForPictureInPicture;

static NSUInteger gPictureInPictureActivation;

static void EndActiveOnlyForPictureInPicture(NSString *why) {
  if (!gActiveOnlyForPictureInPicture) return;
  gActiveOnlyForPictureInPicture = NO;
  NoteGesture(@"active only for PiP ended: %@", why);
  for (NSWindow *window in NSApp.windows) [ArdiaWindowController reconsiderSightOf:window];
}

static void WatchActiveOnlyForPictureInPicture() {
  static BOOL watching;
  if (watching) return;
  watching = YES;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    EndActiveOnlyForPictureInPicture(@"resigned active");
  }];
  [center addObserverForName:NSWindowDidBecomeKeyNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
    if (![ArdiaPiPController forWindow:note.object]) EndActiveOnlyForPictureInPicture(@"another window became key");
  }];
}

BOOL ActiveOnlyForPictureInPicture() { return gActiveOnlyForPictureInPicture; }

void ActivateWithOnlyPictureInPicture(ArdiaPiPController *controller, BOOL move) {
  NSWindow *window = controller.window;
  if (!window || NSApp.active) return;
  NoteGesture(@"activate with only PiP asked (%@) window=%ld", move ? @"move" : @"press", (long)window.windowNumber);
  gActivations++;
  const NSUInteger activation = ++gPictureInPictureActivation;
  ArdiaConsentStamp *activationStamp = ArdiaConsentStamp.begin;
  __weak ArdiaWebView *source = controller.view;
  __block BOOL becameActive = NO;
  __block id watch = [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidBecomeActiveNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    becameActive = YES;
  }];
  const double reportAfter = ardia_host::Background() ? 1.5 : 0.5;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(reportAfter * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [NSNotificationCenter.defaultCenter removeObserver:watch];
    watch = nil;
    if (!NSApp.active && activation == gPictureInPictureActivation) EndActiveOnlyForPictureInPicture(@"still inactive after the wait");
    NoteGesture(@"activation outcome (%@) becameActive=%d activeNow=%d", move ? @"move" : @"press", becameActive, NSApp.active);
    [source emit:@"pictureInPictureActivated" payload:[activationStamp onto:@{@"move" : @(move), @"activated" : @(becameActive || NSApp.active)}]];
  });
  if (ardia_host::Background()) {
    NoteGesture(@"activation refused: test instance");
    return ardia_host::LogActivation(@"activate with only Picture in Picture in front (skipped in a test instance)");
  }
  WatchActiveOnlyForPictureInPicture();
  gActiveOnlyForPictureInPicture = YES;
  MarkBackToTabActivation();
  typedef CGError (*BringsOneWindowForward)(ProcessSerialNumber *, uint32_t, uint32_t);
  static const auto bringForward = (BringsOneWindowForward)dlsym(RTLD_DEFAULT, "_SLPSSetFrontProcessWithOptions");
  static const uint32_t kUserGenerated = 0x200;
  ProcessSerialNumber process;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  const BOOL known = GetCurrentProcess(&process) == noErr;
#pragma clang diagnostic pop
  const CGError brought = bringForward && known ? bringForward(&process, (uint32_t)window.windowNumber, kUserGenerated) : kCGErrorCannotComplete;
  if (brought != kCGErrorSuccess) {
    NoteGesture(@"activation refused: bring forward found=%d process=%d error=%d", bringForward != nullptr, known, brought);
    ConsumeBackToTabActivation();
    return EndActiveOnlyForPictureInPicture(@"activation refused");
  }
  [window makeKeyWindow];
}

BOOL ActivateApp(NSString *why) {
  gActivations++;
  const BOOL fromOtherApp = !NSApp.isActive;
  NoteGesture(@"activate app: %@ fromOtherApp=%d", why, fromOtherApp);
  if (ardia_host::Background()) {
    ardia_host::LogActivation([@"activateIgnoringOtherApps (skipped in a test instance): " stringByAppendingString:why]);
    return fromOtherApp;
  }
  MarkBackToTabActivation();
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  [NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
  return fromOtherApp;
}

void WatchZoom() { InstallZoomMonitor(); }

void PinchFromOtherApp(NSEvent *event) {
  if (!ardia_pip_zoom::WantsOtherAppPinches(NSApp.isActive, [ArdiaPiPZoom enabled], [ArdiaPiPZoom anyZoomable])) return FollowPinchesFromOtherApps();
  [ArdiaPiPZoom handleFromOtherApp:event];
}

void RefreshPinchesFromOtherApps() {
  dispatch_async(dispatch_get_main_queue(), ^{
    FollowPinchesFromOtherApps();
  });
}

BOOL FollowsPinchesFromOtherApps() { return gOtherAppPinchMonitor != nil; }

NSWindow *GrabbedWindow() { return gDragged.window; }

BOOL TabRequestedActivation(ArdiaWebView *view, BOOL *fromOtherApp) {
  *fromOtherApp = NO;
  for (NSWindow *window in NSApp.windows)
    if ([ArdiaPiPController forWindow:window].view == view && window.visible) {
      MarkBackToTabActivation();
      NoteGesture(@"Back to Tab from Chrome's button window=%ld shadow=%d", (long)window.windowNumber, window.hasShadow);
      if (window.hasShadow) continue;
      *fromOtherApp = ActivateApp(@"Back to Tab (Chrome's button)");
      return YES;
    }
  return NO;
}

void VideoEntered(ArdiaWebView *view, NSString *host, ArdiaConsentStamp *stamp) {
  __block int tries = 0;
  __block void (^look)(void);
  __weak ArdiaWebView *weakView = view;
  look = ^{
    ArdiaWebView *strongView = weakView;
    if (!strongView || Attach(strongView, host, stamp) || ++tries >= 20) {
      look = nil;
      return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), look);
  };
  look();
}

void DocumentEntered(ArdiaWebView *view, ArdiaConsentStamp *stamp) {
  __block int tries = 0;
  __block void (^look)(void);
  __weak ArdiaWebView *weakView = view;
  look = ^{
    ArdiaWebView *strongView = weakView;
    NSWindow *found = nil;
    for (NSWindow *window in NSApp.windows)
      if (window.visible && IsChromeDocumentPictureInPicture(window) && IsChromeFloatingWindow(window)) found = window;
    if (strongView && found) {
      NoteGesture(@"document window=%ld size=%.0fx%.0f", (long)found.windowNumber, NSWidth(found.frame), NSHeight(found.frame));
      JoinFullScreenSpaces(found);
      InstallZoomMonitor();
      [strongView emit:@"pictureInPicture" payload:[stamp onto:@{@"kind" : @"document", @"active" : @YES, @"fullScreenSpaces" : @(JoinsFullScreenSpaces(found)), @"leftApp" : @(strongView.leftAppInPictureInPicture), @"leftTab" : @(!strongView.seenByUser)}]];
    }
    if (!strongView || found || ++tries >= 20) {
      look = nil;
      return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), look);
  };
  look();
}

}

@implementation ArdiaWebView (PictureInPictureDev)

+ (NSArray<NSDictionary<NSString *, id> *> *)devPictureInPicture {
  NSMutableArray *list = [NSMutableArray array];
  for (NSWindow *window in NSApp.windows) {
    ArdiaPiPController *controller = [ArdiaPiPController forWindow:window];
    if (!controller && !(window.visible && window.level >= NSFloatingWindowLevel) && !IsChromeDocumentPictureInPicture(window))
      continue;
    CALayer *content = window.contentView.layer;
    [list addObject:@{
      @"window" : @(window.windowNumber),
      @"class" : NSStringFromClass(window.class),
      @"title" : window.title ?: @"",
      @"video" : @(IsChromeVideoPictureInPicture(window)),
      @"document" : @(IsChromeDocumentPictureInPicture(window)),
      @"frame" : NSStringFromRect(window.frame),
      @"visible" : @(window.visible),
      @"alpha" : @(window.alphaValue),
      @"ignoresMouseEvents" : @(window.ignoresMouseEvents),
      @"level" : @(window.level),
      @"subrole" : window.accessibilitySubrole ?: @"",
      @"canHide" : @(window.canHide),
      @"collectionBehavior" : @(window.collectionBehavior),
      @"joinsFullScreenSpaces" : @(JoinsFullScreenSpaces(window)),
      @"styled" : @(controller != nil),
      @"rounded" : @(controller && content.cornerRadius == controller.cornerRadius && content.masksToBounds && !window.opaque),
      @"cornerRadius" : @(content.cornerRadius),
      @"rim" : @(controller.overlay.layer.borderWidth),
      @"keepOnTop" : @(controller.keepOnTop),
      @"stashed" : @(controller.stashedEdge),
      @"key" : @(window.keyWindow),
      @"host" : controller.host ?: @"",
      @"backToTab" : @(controller.view != nil),
      @"minSize" : NSStringFromSize(window.contentMinSize),
      @"maxSize" : NSStringFromSize(window.contentMaxSize),
      @"resizable" : @((window.styleMask & NSWindowStyleMaskResizable) != 0),
      @"visibleFrame" : NSStringFromRect(ScreenFor(window.frame).visibleFrame),
    }];
  }
  return list;
}

+ (NSString *)devPictureInPictureAction:(NSString *)action {
  if ([action isEqual:@"pinchMonitor"]) return FollowsPinchesFromOtherApps() ? @"1" : @"0";
  if ([action hasPrefix:@"zoomSetting:"]) return DevZoomSetting([action substringFromIndex:12]);
  if ([action isEqual:@"appHidden"]) {
    if (!ArdiaLaunchConfig.shared.testInstance) return @"test instances only";
    [NSNotificationCenter.defaultCenter postNotificationName:NSApplicationDidHideNotification object:NSApp];
    return @"posted";
  }
  ArdiaPiPController *controller = nil;
  for (NSWindow *window in NSApp.windows)
    if ([ArdiaPiPController forWindow:window] && window.visible) controller = [ArdiaPiPController forWindow:window];
  if (!controller) return @"";
  if ([action isEqual:@"selftest"]) [controller runSelfTest];
  else if ([@[ @"close", @"backToTab" ] containsObject:action]) [controller runButtonSelfTest:action];
  else if ([action isEqual:@"menu"]) return [[controller.menu.itemArray valueForKey:@"title"] componentsJoinedByString:@"|"];
  else if ([action hasPrefix:@"snapshot:"]) return [controller snapshot:[action substringFromIndex:9]];
  else if ([action hasPrefix:@"frame:"]) [controller.window setFrame:NSRectFromString([action substringFromIndex:6]) display:YES];
  else if ([action hasPrefix:@"alpha:"]) return DevShowAlpha(controller.window, [action substringFromIndex:6].floatValue);
  else if ([action hasPrefix:@"mouse:"]) [controller devMouse:[[action substringFromIndex:6] componentsSeparatedByString:@":"]];
  else if ([action isEqual:@"stash"]) [controller stashAt:ArdiaPiPEdgeRight];
  else if ([action isEqual:@"unstash"]) [controller unstash];
  else if ([action isEqual:@"keepOnTop"]) controller.keepOnTop = !controller.keepOnTop;
  else if ([action isEqual:@"handle"]) [controller.overlay.handle setHovered:!controller.overlay.handle.hovered];
  else if ([action hasPrefix:@"swipe:"]) [controller devSwipe:[[action substringFromIndex:6] componentsSeparatedByString:@","]];
  else if ([action hasPrefix:@"drag:"]) [controller devDrag:[[action substringFromIndex:5] componentsSeparatedByString:@","]];
  else if ([action isEqual:@"layers"]) return DevLayerTree(controller.window);
  else if ([action isEqual:@"framing"]) return DevFraming(controller);
  else if ([action isEqual:@"throw"]) return DevJSON([controller throwInfo]);
  else if ([action isEqual:@"skip"]) return DevJSON([controller skipInfo]);
  else if ([action isEqual:@"resizeCursor"]) return DevJSON([controller.resizeCursor probe]);
  else if ([action hasPrefix:@"pinch:"]) [ArdiaPiPZoom devPinch:controller.window args:[[action substringFromIndex:6] componentsSeparatedByString:@","]];
  else if ([action isEqual:@"pinchStats"]) return DevJSON([ArdiaPiPZoom devPinchStats:controller.window]);
  else if ([action isEqual:@"standIn"]) return [ArdiaPiPZoom devStandInWindow:controller.window];
  else if ([action isEqual:@"lastPinch"]) return DevJSON([ArdiaPiPZoom devLastPinch]);
  else if ([action hasPrefix:@"magnify:"]) return [controller devMagnify:[[action substringFromIndex:8] componentsSeparatedByString:@","]];
  else if ([action hasPrefix:@"hittable:"]) {
    if (!ArdiaLaunchConfig.shared.testInstance) return @"test instances only";
    controller.window.ignoresMouseEvents = ![[action substringFromIndex:9] isEqual:@"1"];
    return controller.window.ignoresMouseEvents ? @"0" : @"1";
  }
  else if ([action hasPrefix:@"resizeCursor:"]) controller.resizeCursor.enabled = [[action substringFromIndex:13] isEqual:@"on"];
  else if ([action isEqual:@"interactive"]) {
    if (!ArdiaLaunchConfig.shared.testInstance) return @"test instances only";
    NSWindow *window = controller.window;
    auto setAlpha = (void (*)(id, SEL, CGFloat))class_getMethodImplementation(window.class, @selector(setAlphaValue:));
    setAlpha(window, @selector(setAlphaValue:), 1);
    window.ignoresMouseEvents = NO;
    return DevShowAlpha(window, 1);
  }
  else if ([action hasPrefix:@"skip:"]) {
    const NSPoint centre = NSMakePoint(NSWidth(controller.window.frame) / 2, NSHeight(controller.window.frame) / 2);
    return [controller skipBy:[action substringFromIndex:5].doubleValue at:centre clickCount:0] ? @"started" : @"no page";
  }
  else return @"";
  return @"started";
}

@end

@implementation ArdiaChromeWindowHost (PictureInPicture)

+ (BOOL)isVideoPictureInPictureWindow:(NSWindow *)window {
  return [ArdiaPiPController forWindow:window] != nil;
}

+ (BOOL)consumePictureInPictureActivation {
  return ConsumeBackToTabActivation();
}

+ (BOOL)activeOnlyForPictureInPicture {
  return ActiveOnlyForPictureInPicture();
}

+ (BOOL)activateForPictureInPictureReturn {
  return ActivateApp(@"Back to Tab (WebKit Picture in Picture)");
}

@end
