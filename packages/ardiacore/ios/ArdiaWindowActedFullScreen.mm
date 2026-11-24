#import "ArdiaChromeWindowInternal.h"
#import "ArdiaLaunchConfig.h"

#import <objc/runtime.h>

#include <cmath>

namespace {

const void *kActingKey = &kActingKey;

const void *kActedOcclusionTurnKey = &kActedOcclusionTurnKey;

const void *kActedRestoreFrameKey = &kActedRestoreFrameKey;

}

namespace ardia_window {

void ActWindowFullScreen(ArdiaCoreWindow *coreWindow, BOOL enter, NSTimeInterval seconds) {
  NSWindow *window = coreWindow.window;
  if (!window || objc_getAssociatedObject(window, kActingKey)) return;
  __weak NSWindow *weakWindow = window;
  __weak ArdiaCoreWindow *weakCore = coreWindow;
  void (^set)(BOOL) = ^(BOOL on) {
    if (NSWindow *w = weakWindow) objc_setAssociatedObject(w, kActedFullScreenKey, on ? @YES : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    ArdiaCoreWindow *c = weakCore;
    c.actedFullScreen = on;
  };
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  const BOOL trace = [ArdiaLaunchConfig.shared traced:@"visibility"];
  if (trace) NSLog(@"[ardiacore-vis] window %ld acted %@", (long)window.windowNumber, enter ? @"willEnterFullScreen" : @"willExitFullScreen");
  [center postNotificationName:enter ? NSWindowWillEnterFullScreenNotification : NSWindowWillExitFullScreenNotification object:window];
  if (enter) set(YES);
  if (enter) {
    objc_setAssociatedObject(window, kActedRestoreFrameKey, [NSValue valueWithRect:window.frame], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    if (NSScreen *screen = window.screen ?: NSScreen.mainScreen) [window setFrame:screen.frame display:YES];
  } else if (NSValue *restore = objc_getAssociatedObject(window, kActedRestoreFrameKey)) {
    objc_setAssociatedObject(window, kActedRestoreFrameKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [window setFrame:restore.rectValue display:YES];
  }
  objc_setAssociatedObject(window, kActingKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  const NSTimeInterval gap = gActedOcclusionGap;
  if (!isnan(gap)) {
    NSObject *turn = [NSObject new];
    objc_setAssociatedObject(window, kActedOcclusionTurnKey, turn, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    ActOcclusion(window, @NO);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MAX(0, seconds + gap) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      NSWindow *w = weakWindow;
      if (w && objc_getAssociatedObject(w, kActedOcclusionTurnKey) == turn) ActOcclusion(w, @YES);
    });
  }
  void (^finish)(void) = ^{
    NSWindow *w = weakWindow;
    if (!w) return;
    objc_setAssociatedObject(w, kActingKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    if (!enter) set(NO);
    if (trace) NSLog(@"[ardiacore-vis] window %ld acted %@", (long)w.windowNumber, enter ? @"didEnterFullScreen" : @"didExitFullScreen");
    [center postNotificationName:enter ? NSWindowDidEnterFullScreenNotification : NSWindowDidExitFullScreenNotification object:w];
  };
  if (seconds > 0) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), finish);
  else finish();
}


}
