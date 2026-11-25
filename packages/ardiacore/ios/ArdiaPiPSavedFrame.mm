#import "ArdiaPictureInPicture.h"
#import "ArdiaHost.h"
#import "ArdiaPiPGestureLog.h"

#include <algorithm>

namespace ardia_pip {

void ForgetSavedSize() {
  NSString *file = [ArdiaHost.dataDirectory stringByAppendingPathComponent:@"ArdiaPictureInPicture.plist"];
  NSArray *saved = [NSArray arrayWithContentsOfFile:file];
  if (saved.count != 4) return;
  for (id value in saved)
    if (![value isKindOfClass:NSNumber.class]) return;
  const int x = [saved[0] intValue], y = [saved[1] intValue], width = [saved[2] intValue], height = [saved[3] intValue];
  if (width <= 1 && height <= 1) return;
  NSScreen *primary = NSScreen.screens.firstObject;
  if (!primary) return;
  const CGFloat top = NSMaxY(primary.frame);
  const NSPoint center = NSMakePoint(x + width / 2.0, top - (y + height / 2.0));
  NSScreen *screen = primary;
  for (NSScreen *candidate in NSScreen.screens)
    if (NSPointInRect(center, candidate.frame)) screen = candidate;
  const NSRect area = screen.visibleFrame, bounds = screen.frame;
  const BOOL right = center.x >= NSMidX(area), bottom = center.y < NSMidY(area);
  const int left = (int)NSMinX(bounds), screenTop = (int)(top - NSMaxY(bounds));
  const int anchorX = std::clamp(right ? x + width - 1 : x, left, left + (int)NSWidth(bounds) - 1);
  const int anchorY = std::clamp(bottom ? y + height - 1 : y, screenTop, screenTop + (int)NSHeight(bounds) - 1);
  if (![@[ @(anchorX), @(anchorY), @1, @1 ] writeToFile:file atomically:YES]) return;
  NoteGesture(@"pip size forgotten was=%dx%d at %d,%d anchor=%d,%d", width, height, x, y, anchorX, anchorY);
}

}
