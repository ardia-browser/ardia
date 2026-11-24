#import "ArdiaChromeWindowInternal.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaWindowSightMath.h"

#import <objc/runtime.h>

#include <vector>

namespace {

const void *kActedActiveSpaceKey = &kActedActiveSpaceKey;

ardia_window_sight::Rect SightRect(CGRect r) { return {r.origin.x, r.origin.y, r.size.width, r.size.height}; }

}

namespace ardia_window {

void ActActiveSpace(NSWindow *window, NSNumber *onSpace) {
  objc_setAssociatedObject(window, kActedActiveSpaceKey, onSpace, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if ([ArdiaLaunchConfig.shared traced:@"visibility"]) NSLog(@"[ardiacore-vis] window %ld acted active Space %@", (long)window.windowNumber, onSpace ?: @"off");
  [NSWorkspace.sharedWorkspace.notificationCenter postNotificationName:NSWorkspaceActiveSpaceDidChangeNotification object:NSWorkspace.sharedWorkspace];
}

BOOL OffActiveSpace(NSWindow *window) {
  if (!window.visible) return NO;
  if (NSNumber *acted = objc_getAssociatedObject(window, kActedActiveSpaceKey)) return !acted.boolValue;
  if (ardia_host::Background()) return NO;
  return !window.isOnActiveSpace;
}

BOOL ReadWindowServerSight(NSWindow *window) {
  const CGWindowID number = (CGWindowID)window.windowNumber;
  NSArray<NSDictionary *> *above = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow | kCGWindowListOptionIncludingWindow, number));
  CGRect mine = CGRectNull;
  std::vector<ardia_window_sight::Rect> covers;
  for (NSDictionary *info in above) {
    CGRect bounds;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(id)kCGWindowBounds], &bounds)) continue;
    if ([info[(id)kCGWindowNumber] unsignedIntValue] == number) {
      if (![info[(id)kCGWindowIsOnscreen] boolValue]) return NO;
      mine = bounds;
      continue;
    }
    if (!ardia_window_sight::CountsAsCover([info[(id)kCGWindowLayer] intValue], [info[(id)kCGWindowAlpha] doubleValue])) continue;
    covers.push_back(SightRect(bounds));
  }
  if (CGRectIsNull(mine)) return NO;
  uint32_t count = 0;
  CGDirectDisplayID ids[32];
  if (CGGetActiveDisplayList(32, ids, &count) != kCGErrorSuccess) return NO;
  std::vector<ardia_window_sight::Rect> displays;
  for (uint32_t i = 0; i < count; i++)
    if (!CGDisplayIsAsleep(ids[i])) displays.push_back(SightRect(CGDisplayBounds(ids[i])));
  return ardia_window_sight::PartlyVisible(SightRect(mine), covers, displays);
}

}
