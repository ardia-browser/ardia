#import "ArdiaPictureInPictureInternal.h"

@implementation ArdiaPiPController (Skip)

- (BOOL)skipBy:(double)seconds at:(NSPoint)point clickCount:(NSInteger)clickCount {
  ArdiaWebView *view = _view;
  if (!view || !seconds) return NO;
  [view seekPictureInPictureBy:seconds];
  [view emit:@"pictureInPictureSkip" payload:@{@"seconds" : @(seconds)}];
  _lastSkip = @{@"seconds" : @(seconds), @"point" : NSStringFromPoint(point), @"clickCount" : @(clickCount), @"count" : @(++_skips)};
  return YES;
}

- (NSDictionary *)skipInfo {
  return @{@"lastSkip" : _lastSkip ?: @{}, @"count" : @(_skips)};
}

@end
