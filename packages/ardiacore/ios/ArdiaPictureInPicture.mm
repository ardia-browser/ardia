#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaWindowController.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaChromeWindowHost.h"
#import "ArdiaPiPThrowMath.h"
#import "ArdiaPiPSeekMath.h"

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

BOOL GrabsWindowBackground(NSWindow *window, NSEvent *event) {
  if (!window || ![ArdiaPiPController forWindow:window] || (event.modifierFlags & NSEventModifierFlagControl)) return NO;
  if (OnStashHandle(window, event)) return YES;
  if (event.clickCount > 1 && !ClickSkipSeconds(window, event.locationInWindow)) return NO;
  if ([window respondsToSelector:@selector(_resizeDirectionForMouseLocation:)] &&
      [window _resizeDirectionForMouseLocation:event.locationInWindow] != -1)
    return NO;
  NSView *frameView = window.contentView.superview;
  return frameView && [frameView hitTest:event.locationInWindow] == frameView;
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
                                                      if ([ArdiaPiPZoom beginEdgeResize:window event:event]) {
                                                        ActivateWithOnlyPictureInPicture([ArdiaPiPController forWindow:window], NO);
                                                        return nil;
                                                      }
                                                      ArdiaPiPController *grabbed =
                                                          GrabsWindowBackground(window, event) ? [ArdiaPiPController forWindow:window] : nil;
                                                      gDragged = grabbed;
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
                                                      ardia_host::NotePointer(event, @"pipDrag");
                                                    } else {
                                                      [dragged dragMoved:event];
                                                    }
                                                    return nil;
                                                  }];
}

void InstallZoomMonitor() {
  static id monitor;
  if (monitor) return;
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel | NSEventMaskMagnify
                                                  handler:^NSEvent *(NSEvent *event) {
                                                    return [ArdiaPiPController handleSwipe:event] || [ArdiaPiPZoom handle:event] ? nil : event;
                                                  }];
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

static void EndActiveOnlyForPictureInPicture() {
  if (!gActiveOnlyForPictureInPicture) return;
  gActiveOnlyForPictureInPicture = NO;
  for (NSWindow *window in NSApp.windows) [ArdiaWindowController reconsiderSightOf:window];
}

static void WatchActiveOnlyForPictureInPicture() {
  static BOOL watching;
  if (watching) return;
  watching = YES;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    EndActiveOnlyForPictureInPicture();
  }];
  [center addObserverForName:NSWindowDidBecomeKeyNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
    if (![ArdiaPiPController forWindow:note.object]) EndActiveOnlyForPictureInPicture();
  }];
}

BOOL ActiveOnlyForPictureInPicture() { return gActiveOnlyForPictureInPicture; }

void ActivateWithOnlyPictureInPicture(ArdiaPiPController *controller, BOOL move) {
  NSWindow *window = controller.window;
  if (!window || NSApp.active) return;
  gActivations++;
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
    if (!NSApp.active) EndActiveOnlyForPictureInPicture();
    [source emit:@"pictureInPictureActivated" payload:[activationStamp onto:@{@"move" : @(move), @"activated" : @(becameActive || NSApp.active)}]];
  });
  if (ardia_host::Background()) return ardia_host::LogActivation(@"activate with only Picture in Picture in front (skipped in a test instance)");
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
  if (!bringForward || !known || bringForward(&process, (uint32_t)window.windowNumber, kUserGenerated) != kCGErrorSuccess)
    [NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
  [window makeKeyWindow];
}

BOOL ActivateApp(NSString *why) {
  gActivations++;
  const BOOL fromOtherApp = !NSApp.isActive;
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

NSWindow *GrabbedWindow() { return gDragged.window; }

BOOL TabRequestedActivation(ArdiaWebView *view, BOOL *fromOtherApp) {
  *fromOtherApp = NO;
  for (NSWindow *window in NSApp.windows)
    if ([ArdiaPiPController forWindow:window].view == view && window.visible) {
      MarkBackToTabActivation();
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
      JoinFullScreenSpaces(found);
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
