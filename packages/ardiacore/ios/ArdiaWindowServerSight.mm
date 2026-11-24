#import "ArdiaChromeWindowInternal.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaWindowSightMath.h"

#import <objc/runtime.h>

#include <vector>

namespace {

const void *kActedActiveSpaceKey = &kActedActiveSpaceKey;

ardia_window_sight::Rect SightRect(CGRect r) { return {r.origin.x, r.origin.y, r.size.width, r.size.height}; }

BOOL OwnerIsRegularApp(pid_t pid, NSMutableDictionary<NSNumber *, NSNumber *> *known) {
  NSNumber *regular = known[@(pid)];
  if (!regular) {
    NSRunningApplication *owner = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    regular = @(owner != nil && owner.activationPolicy == NSApplicationActivationPolicyRegular);
    known[@(pid)] = regular;
  }
  return regular.boolValue;
}

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

WindowServerSight ReadWindowServerSight(NSWindow *window, BOOL skipBackgroundOverlays) {
  uint32_t count = 0;
  CGDirectDisplayID ids[32];
  if (CGGetActiveDisplayList(32, ids, &count) != kCGErrorSuccess) return {};
  std::vector<ardia_window_sight::Rect> displays;
  for (uint32_t i = 0; i < count; i++)
    if (!CGDisplayIsAsleep(ids[i])) displays.push_back(SightRect(CGDisplayBounds(ids[i])));
  const CGWindowID number = (CGWindowID)window.windowNumber;
  NSArray<NSDictionary *> *above = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow | kCGWindowListOptionIncludingWindow, number));
  CGRect mine = CGRectNull;
  std::vector<ardia_window_sight::Rect> covers;
  std::vector<ardia_window_sight::Rect> overlays;
  const pid_t ownPid = getpid();
  NSMutableDictionary<NSNumber *, NSNumber *> *regularOwners = [NSMutableDictionary dictionary];
  for (NSDictionary *info in above) {
    CGRect bounds;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(id)kCGWindowBounds], &bounds)) continue;
    if ([info[(id)kCGWindowNumber] unsignedIntValue] == number) {
      if (![info[(id)kCGWindowIsOnscreen] boolValue]) return {};
      mine = bounds;
      continue;
    }
    if (!ardia_window_sight::CountsAsCover([info[(id)kCGWindowLayer] intValue], [info[(id)kCGWindowAlpha] doubleValue])) continue;
    const pid_t pid = [info[(id)kCGWindowOwnerPID] intValue];
    const ardia_window_sight::Rect cover = SightRect(bounds);
    if (skipBackgroundOverlays && pid != ownPid && ardia_window_sight::IsBackgroundOverlay([&] { return OwnerIsRegularApp(pid, regularOwners); }, cover, displays)) overlays.push_back(cover);
    else covers.push_back(cover);
  }
  if (CGRectIsNull(mine)) return {};
  const ardia_window_sight::Rect sight = SightRect(mine);
  return {ardia_window_sight::PartlyVisible(sight, covers, displays), ardia_window_sight::VisibleOnlyPastOverlays(sight, covers, overlays, displays)};
}

}
