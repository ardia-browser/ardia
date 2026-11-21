#import "ArdiaPictureInPictureInternal.h"

@implementation ArdiaPiPController (Skip)

- (BOOL)skipBy:(double)seconds at:(NSPoint)point clickCount:(NSInteger)clickCount {
  return [self skipBy:seconds at:point clickCount:clickCount stamp:ArdiaConsentStamp.begin];
}

- (BOOL)skipDraggedBy:(double)seconds at:(NSPoint)point clickCount:(NSInteger)clickCount {
  return [self skipBy:seconds at:point clickCount:clickCount stamp:_dragStamp];
}

- (BOOL)skipBy:(double)seconds at:(NSPoint)point clickCount:(NSInteger)clickCount stamp:(ArdiaConsentStamp *)stamp {
  ArdiaWebView *view = _view;
  if (!view || !seconds) return NO;
  [view seekPictureInPictureBy:seconds];
  [view emit:@"pictureInPictureSkip" payload:[stamp onto:@{@"seconds" : @(seconds)}]];
  _lastSkip = @{@"seconds" : @(seconds), @"point" : NSStringFromPoint(point), @"clickCount" : @(clickCount), @"count" : @(++_skips)};
  return YES;
}

- (NSDictionary *)skipInfo {
  return @{@"lastSkip" : _lastSkip ?: @{}, @"count" : @(_skips)};
}

@end
