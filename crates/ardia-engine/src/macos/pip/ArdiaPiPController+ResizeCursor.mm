#import "ArdiaPictureInPictureInternal.h"

@implementation ArdiaPiPController (ResizeCursor)

- (void)resizeStarted {
  ACPiPStamp *stamp = ACPiPStamp.begin;
  [self.view emit:@"pictureInPictureResized" payload:[stamp onto:[_resizeCursor resizeStarted]]];
}

@end
