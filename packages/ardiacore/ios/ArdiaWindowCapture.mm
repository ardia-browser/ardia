#import "ArdiaChromeWindowInternal.h"
#import "ArdiaLaunchConfig.h"

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

@interface ArdiaWindowCaptureHold : NSObject
@property(nonatomic) BOOL live;
@property(nonatomic) BOOL screen;
@property(nonatomic, readonly) NSMutableSet<NSNumber *> *windows;
- (BOOL)covers:(NSWindow *)window;
@end

@implementation ArdiaWindowCaptureHold

- (instancetype)init {
  if ((self = [super init])) _windows = [NSMutableSet set];
  return self;
}

- (BOOL)covers:(NSWindow *)window {
  return _screen || [_windows containsObject:@(window.windowNumber)];
}

@end

namespace {

NSMapTable<ArdiaCoreTab *, ArdiaWindowCaptureHold *> *Holds() {
  static NSMapTable *holds = [NSMapTable weakToStrongObjectsMapTable];
  return holds;
}

BOOL IsHeld(NSWindow *window) {
  for (ArdiaCoreTab *tab in Holds().keyEnumerator) {
    ArdiaWindowCaptureHold *hold = [Holds() objectForKey:tab];
    if (hold.live && !tab.closed && [hold covers:window]) return YES;
  }
  return NO;
}

BOOL InstallOcclusionHold() {
  static BOOL installed;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    SEL isOccluded = NSSelectorFromString(@"isOccluded");
    Method m = class_getInstanceMethod(NSWindow.class, isOccluded);
    if (!m) return;
    auto original = (BOOL(*)(id, SEL))method_getImplementation(m);
    method_setImplementation(m, imp_implementationWithBlock(^BOOL(NSWindow *window) {
      return IsHeld(window) ? NO : original(window, isOccluded);
    }));
    installed = YES;
  });
  return installed;
}

void Recheck(ArdiaWindowCaptureHold *hold) {
  for (NSWindow *window in NSApp.windows)
    if ([hold covers:window])
      [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeOcclusionStateNotification object:window];
}

ArdiaWindowCaptureHold *HoldOf(ArdiaCoreTab *tab) {
  ArdiaWindowCaptureHold *hold = [Holds() objectForKey:tab];
  if (!hold) {
    hold = [ArdiaWindowCaptureHold new];
    [Holds() setObject:hold forKey:tab];
  }
  return hold;
}

}

namespace ardia_window {

void ApproveCapture(ArdiaCoreTab *tab, NSString *sourceId) {
  if (!tab) return;
  const BOOL screen = [sourceId hasPrefix:@"screen:"];
  const NSInteger number = [sourceId hasPrefix:@"window:"] ? [[sourceId componentsSeparatedByString:@":"][1] integerValue] : 0;
  ArdiaWindowCaptureHold *hold = screen || number > 0 ? HoldOf(tab) : [Holds() objectForKey:tab];
  if (!hold) return;
  if (!hold.live) {
    hold.screen = NO;
    [hold.windows removeAllObjects];
  }
  hold.screen = hold.screen || screen;
  if (number > 0) [hold.windows addObject:@(number)];
  if (hold.live && InstallOcclusionHold()) Recheck(hold);
}

void SetCaptureLive(ArdiaCoreTab *tab, BOOL live) {
  ArdiaWindowCaptureHold *hold = [Holds() objectForKey:tab];
  if (!live) {
    if (!hold.live) return;
    [Holds() removeObjectForKey:tab];
    if ([ArdiaLaunchConfig.shared traced:@"visibility"]) NSLog(@"[ardiacore-vis] capture ended, its windows may be occluded again");
    Recheck(hold);
    return;
  }
  hold = HoldOf(tab);
  if (hold.live) return;
  hold.live = YES;
  if (!InstallOcclusionHold()) {
    NSLog(@"[ardiacore-vis] -[NSWindow isOccluded] is missing, so a shared window cannot keep drawing");
    return;
  }
  if ([ArdiaLaunchConfig.shared traced:@"visibility"]) NSLog(@"[ardiacore-vis] holding captured windows visible");
  Recheck(hold);
}

}
