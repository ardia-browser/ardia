#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaProtectedVideoInternal.h"

using namespace ardia_runtime;
using namespace ardia_web_view;
using namespace ardia_protected_video;

static void *kPossibleContext = &kPossibleContext;

namespace {

NSView *PictureInPicturePanelContent() {
  for (NSWindow *window in NSApp.windows)
    if (window.visible && [NSStringFromClass(window.class) containsString:@"PIPPanel"]) return window.contentView;
  return nil;
}

void HideEmptyMirror(NSView *view) {
  if ([NSStringFromClass(view.class) isEqualToString:@"AVPictureInPictureCALayerHostView"] && !view.layer.sublayers.count && !view.layer.contents) view.hidden = YES;
  for (NSView *subview in view.subviews) HideEmptyMirror(subview);
}

}

@implementation ArdiaPVSession (PictureInPicture)

- (void)preparePictureInPicture {
  if (_pip || !_showing || !_view.window || ![AVPictureInPictureController isPictureInPictureSupported]) return;
  AVPictureInPictureControllerContentSource *source = [[AVPictureInPictureControllerContentSource alloc] initWithSampleBufferDisplayLayer:_display
                                                                                                                         playbackDelegate:self];
  _pip = [[AVPictureInPictureController alloc] initWithContentSource:source];
  ardia_pip::PrepareSystemPictureInPicture();
  _pip.delegate = self;
  [_pip addObserver:self forKeyPath:@"pictureInPicturePossible" options:NSKeyValueObservingOptionNew context:kPossibleContext];
  Trace(@"pip controller ready: possible=%d", _pip.pictureInPicturePossible);
}

- (void)reconnectPictureInPicture {
  if (!_pip.pictureInPictureActive || _pipReopening) return;
  Trace(@"pip reopens after a video size change");
  _pipReopening = YES;
  [self report:@{@"event" : @"pipReopen", @"video" : @YES}];
  [_pip stopPictureInPicture];
}

- (void)fitPictureInPicture {
  NSView *panel = _pipPanel;
  if (!_inPip || !panel) return;
  const CGRect frame = {CGPointZero, NSSizeToCGSize(panel.bounds.size)};
  WithoutActions(^{
    if (!CGRectEqualToRect(self->_display.frame, frame)) self->_display.frame = frame;
  });
  HideEmptyMirror(panel);
}

- (void)watchPictureInPicturePanel {
  [self unwatchPictureInPicturePanel];
  NSView *panel = PictureInPicturePanelContent();
  Trace(@"pip panel %@", panel ? NSStringFromSize(panel.bounds.size) : @"missing");
  if (!_pipReopening) [self report:@{@"event" : @"pip", @"video" : @YES, @"fitted" : @(panel != nil)}];
  if (!panel) return;
  _pipPanel = panel;
  panel.postsFrameChangedNotifications = YES;
  __weak ArdiaPVSession *weakSelf = self;
  _pipPanelObserver = [NSNotificationCenter.defaultCenter addObserverForName:NSViewFrameDidChangeNotification
                                                                      object:panel
                                                                       queue:NSOperationQueue.mainQueue
                                                                  usingBlock:^(NSNotification *) {
                                                                    [weakSelf fitPictureInPicture];
                                                                  }];
  [self fitPictureInPicture];
}

- (void)unwatchPictureInPicturePanel {
  if (_pipPanelObserver) [NSNotificationCenter.defaultCenter removeObserver:_pipPanelObserver];
  _pipPanelObserver = nil;
  _pipPanel = nil;
}

- (void)dropPictureInPicture {
  [self unwatchPictureInPicturePanel];
  if (!_pip) return;
  [_pip removeObserver:self forKeyPath:@"pictureInPicturePossible" context:kPossibleContext];
  [_pip stopPictureInPicture];
  _pip.delegate = nil;
  _pip = nil;
  _pipWanted = NO;
  _pipReopening = NO;
  _pipStopping = NO;
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
  if (context != kPossibleContext) return [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!self->_pip) return;
    Trace(@"pip possible=%d after %.0f ms", self->_pip.pictureInPicturePossible, self->_pipWanted ? (CACurrentMediaTime() - self->_pipAskedAt) * 1000 : 0);
    if (self->_pipWanted && self->_pip.pictureInPicturePossible && !self->_pip.pictureInPictureActive) [self->_pip startPictureInPicture];
  });
}

- (BOOL)startPictureInPicture {
  Trace(@"pip start: supported=%d started=%d controller=%d possible=%d active=%d", AVPictureInPictureController.isPictureInPictureSupported, _started, _pip != nil,
        _pip.pictureInPicturePossible, _pip.pictureInPictureActive);
  if (!_started) return NO;
  [self preparePictureInPicture];
  if (!_pip) return NO;
  if (_pip.pictureInPictureActive) return YES;
  _pipWanted = YES;
  _pipAskedAt = CACurrentMediaTime();
  const NSInteger request = ++_pipRequest;
  if (_pip.pictureInPicturePossible) [_pip startPictureInPicture];
  __weak ArdiaPVSession *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kPictureInPictureDeadline * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaPVSession *session = weakSelf;
    if (!session || session->_pipRequest != request || !session->_pipWanted || session->_pip.pictureInPictureActive) return;
    Trace(@"pip never became possible");
    session->_pipWanted = NO;
    session->_pipReopening = NO;
    [session deliverPictureInPicture];
  });
  return YES;
}

- (void)deliverPictureInPicture {
  if (_media) [self deliver:@{@"event" : @"pip", @"media" : @(_media), @"active" : @(_inPip)}];
}

- (void)exitPictureInPicture {
  _pipWanted = NO;
  _pipReopening = NO;
  _pipStopping = _pip.pictureInPictureActive;
  const NSInteger request = ++_pipRequest;
  Trace(@"pip stop requested: active=%d", _pip.pictureInPictureActive);
  if (_pip.pictureInPictureActive) {
    [_pip stopPictureInPicture];
    __weak ArdiaPVSession *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kPictureInPictureDeadline * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      ArdiaPVSession *session = weakSelf;
      if (!session || session->_pipRequest != request || !session->_inPip) return;
      Trace(@"pip never stopped (active=%d), closing it", session->_pip.pictureInPictureActive);
      if (session->_pip.pictureInPictureActive) [session dropPictureInPicture];
      [session pictureInPictureControllerDidStopPictureInPicture:session->_pip];
    });
    return;
  }
  _inPip = NO;
  [self unwatchPictureInPicturePanel];
  [self place];
  [self deliverPictureInPicture];
}

- (void)playbackStateChanged {
  [_pip invalidatePlaybackState];
}

- (void)pictureInPictureControllerDidStartPictureInPicture:(AVPictureInPictureController *)controller {
  Trace(@"pip started after %.0f ms", _pipWanted ? (CACurrentMediaTime() - _pipAskedAt) * 1000 : 0);
  _pipWanted = NO;
  _pipRequest++;
  _inPip = YES;
  [self place];
  [self watchPictureInPicturePanel];
  _pipReopening = NO;
  [self deliverPictureInPicture];
}

- (void)pictureInPictureControllerDidStopPictureInPicture:(AVPictureInPictureController *)controller {
  Trace(@"pip stopped");
  _inPip = NO;
  _pipStopping = NO;
  [self unwatchPictureInPicturePanel];
  [self place];
  if (_pipReopening) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self->_inPip || [self startPictureInPicture]) return;
      self->_pipReopening = NO;
      [self deliverPictureInPicture];
    });
    return;
  }
  [self deliverPictureInPicture];
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller failedToStartPictureInPictureWithError:(NSError *)error {
  Trace(@"pip failed: %@", error.localizedDescription);
  _pipWanted = NO;
  _pipReopening = NO;
  _inPip = NO;
  [self unwatchPictureInPicturePanel];
  [self deliverPictureInPicture];
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler:(void (^)(BOOL))completionHandler {
  const BOOL asked = ardia_pip::UserAskedToRestore();
  Trace(@"pip restore: asked=%d reopening=%d stopping=%d", asked, _pipReopening, _pipStopping);
  if (asked || (!_pipReopening && !_pipStopping)) ardia_pip::BackToTab(_tab, @"Back to Tab (protected video)");
  completionHandler(YES);
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller setPlaying:(BOOL)playing {
  Trace(@"pip asks to %@", playing ? @"play" : @"pause");
  _wantsPlay = playing;
  [self applyRate];
  [self deliver:@{@"event" : @"paused", @"media" : @(_media), @"paused" : @(!playing)}];
  [self playbackStateChanged];
}

- (CMTimeRange)pictureInPictureControllerTimeRangeForPlayback:(AVPictureInPictureController *)controller {
  const double end = _duration > 0 ? _duration : [self bufferedEnd];
  const CMTimeRange range = std::isfinite(end) && end > 0 ? CMTimeRangeMake(kCMTimeZero, CMTimeMakeWithSeconds(end, 1000)) : kCMTimeRangeInvalid;
  if (!CMTimeRangeEqual(range, _tracedRange)) {
    _tracedRange = range;
    Trace(@"pip time range %.3f-%.3f", CMTimeGetSeconds(range.start), CMTimeGetSeconds(CMTimeRangeGetEnd(range)));
  }
  return range;
}

- (BOOL)pictureInPictureControllerIsPlaybackPaused:(AVPictureInPictureController *)controller {
  return !_wantsPlay || _endedSent;
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller didTransitionToRenderSize:(CMVideoDimensions)newRenderSize {
  Trace(@"pip render size %dx%d", newRenderSize.width, newRenderSize.height);
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller skipByInterval:(CMTime)skipInterval completionHandler:(void (^)(void))completionHandler {
  const double delta = CMTimeGetSeconds(skipInterval);
  Trace(@"pip skip %.3f", delta);
  if (std::isfinite(delta) && _media) [self deliver:@{@"event" : @"seekBy", @"media" : @(_media), @"delta" : @(delta)}];
  completionHandler();
}

@end
