#import "ArdiaPictureInPictureInternal.h"

@implementation ArdiaPiPController (Spaces)

- (void)activeSpaceChanged {
  ArdiaConsentStamp *stamp = ArdiaConsentStamp.begin;
  __weak ArdiaPiPController *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.6 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaPiPController *controller = weakSelf;
    NSWindow *window = controller.window;
    ArdiaWebView *view = controller.view;
    if (!window || !view || !window.isVisible || window.isOnActiveSpace) return;
    ardia_pip::NoteGesture(@"pip left behind on a Space switch window=%ld joins=%d", (long)window.windowNumber, ardia_pip::JoinsFullScreenSpaces(window));
    [view emit:@"autoPictureInPictureKept" payload:[stamp onto:@{@"reason" : ardia_pip::JoinsFullScreenSpaces(window) ? @"leftOnSpaceSwitchJoining" : @"leftOnSpaceSwitch"}]];
  });
}

@end
