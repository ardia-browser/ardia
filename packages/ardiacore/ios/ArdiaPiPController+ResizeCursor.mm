#import "ArdiaPictureInPictureInternal.h"

@implementation ArdiaPiPController (ResizeCursor)

- (void)resizeStarted {
  ArdiaConsentStamp *stamp = ArdiaConsentStamp.begin;
  [self.view emit:@"pictureInPictureResized" payload:[stamp onto:[_resizeCursor resizeStarted]]];
}

@end
