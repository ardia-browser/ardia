#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaProtectedVideoInternal.h"

using namespace ardia_runtime;
using namespace ardia_web_view;
using namespace ardia_protected_video;

@implementation ArdiaPVSession (Playback)

- (void)keepDisplayAwake:(BOOL)awake {
  if (awake == (_displayAwake != nil)) return;
  if (awake) {
    _displayAwake = [NSProcessInfo.processInfo beginActivityWithOptions:NSActivityIdleDisplaySleepDisabled | NSActivityUserInitiated reason:@"Playing video"];
  } else {
    [NSProcessInfo.processInfo endActivity:_displayAwake];
    _displayAwake = nil;
  }
}

- (void)setUpRenderers {
  _display = [AVSampleBufferDisplayLayer new];
  _display.videoGravity = AVLayerVideoGravityResizeAspect;
  _display.backgroundColor = NSColor.blackColor.CGColor;
  _audio = [AVSampleBufferAudioRenderer new];
  _sync = [AVSampleBufferRenderSynchronizer new];
  [_sync addRenderer:_display];
  [_sync addRenderer:_audio];
  _videoLane = [[ArdiaPVLane alloc] initWithRenderer:_display.sampleBufferRenderer video:YES];
  _audioLane = [[ArdiaPVLane alloc] initWithRenderer:_audio video:NO];
  __weak ArdiaPVSession *weakSelf = self;
  _audioFlushObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVSampleBufferAudioRendererWasFlushedAutomaticallyNotification
                                                                        object:_audio
                                                                         queue:NSOperationQueue.mainQueue
                                                                    usingBlock:^(NSNotification *note) {
                                                                      ArdiaPVSession *session = weakSelf;
                                                                      if (!session || !session->_started) return;
                                                                      Trace(@"audio flushed by the system");
                                                                      [session restart:session->_audioLane at:[session position]];
                                                                    }];
  _decodeFailureObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVSampleBufferVideoRendererDidFailToDecodeNotification
                                                                           object:_display.sampleBufferRenderer
                                                                            queue:NSOperationQueue.mainQueue
                                                                       usingBlock:^(NSNotification *note) {
                                                                         ArdiaPVSession *session = weakSelf;
                                                                         if (!session || session->_decodeFailures++ > 4) return;
                                                                         Trace(@"video decode failed: %@", note.userInfo[AVSampleBufferVideoRendererDidFailToDecodeNotificationErrorKey]);
                                                                       }];
  [self addRenderersAsKeyRecipients];
  _view = [[ArdiaPVLayerView alloc] initWithFrame:NSZeroRect];
  _view.identifier = kViewIdentifier;
  CALayer *clip = [CALayer layer];
  clip.masksToBounds = YES;
  [clip addSublayer:_display];
  _corners = [CAShapeLayer layer];
  _corners.hidden = YES;
  [clip addSublayer:_corners];
  _view.layer = clip;
  _view.wantsLayer = YES;
  _view.hidden = YES;
}

- (void)tearDownRenderers {
  [self resetPlayback];
  if (_audioFlushObserver) [NSNotificationCenter.defaultCenter removeObserver:_audioFlushObserver];
  _audioFlushObserver = nil;
  if (_decodeFailureObserver) [NSNotificationCenter.defaultCenter removeObserver:_decodeFailureObserver];
  _decodeFailureObserver = nil;
}

- (void)resetPlayback {
  [self clearBoundary];
  [_sync setRate:0 time:kCMTimeZero];
  [_videoLane clear];
  [_audioLane clear];
  [_display.sampleBufferRenderer flushWithRemovalOfDisplayedImage:YES completionHandler:nil];
  [_audio flush];
  _started = NO;
  _stalled = NO;
  _pendingTarget = NAN;
  _sizeChangeAt = NAN;
  _endedSent = NO;
}

- (NSArray<ArdiaPVLane *> *)lanes {
  BOOL video = _videoLane->_stored.count > 0, audio = _audioLane->_stored.count > 0;
  for (ArdiaPVTrack *track in _tracks.allValues) {
    if (track->_video) video = YES;
    else audio = YES;
  }
  NSMutableArray<ArdiaPVLane *> *lanes = [NSMutableArray array];
  if (video) [lanes addObject:_videoLane];
  if (audio) [lanes addObject:_audioLane];
  return lanes;
}

- (double)position {
  if (!_started) return std::isfinite(_pendingTarget) ? _pendingTarget : 0;
  const double now = CMTimeGetSeconds(_sync.currentTime);
  return std::isfinite(now) ? now : 0;
}

- (double)bufferedEndFrom:(double)time {
  NSArray<ArdiaPVLane *> *lanes = [self lanes];
  if (!lanes.count) return NAN;
  double end = INFINITY;
  for (ArdiaPVLane *lane in lanes) {
    const double laneEnd = [lane endFrom:time];
    if (!std::isfinite(laneEnd)) return NAN;
    end = MIN(end, laneEnd);
  }
  return end;
}

- (double)bufferedEnd {
  return [self bufferedEndFrom:[self position]];
}

- (double)naturalStart {
  double start = -INFINITY;
  for (ArdiaPVLane *lane in [self lanes]) {
    if (!lane->_stored.count) return NAN;
    start = MAX(start, lane->_stored.firstObject->_start);
  }
  return std::isfinite(start) ? MAX(start, 0) : NAN;
}

- (BOOL)canStartAt:(double)time {
  const double end = [self bufferedEndFrom:time];
  return std::isfinite(end) && (end - time >= kResumeAhead || _ended || (_duration > 0 && end >= _duration - 0.1));
}

- (void)seekTo:(double)time {
  if ([self canStartAt:time]) return [self startAt:time];
  Trace(@"seek target %.3f not stored, waiting for appends", time);
  [self clearBoundary];
  _started = NO;
  _stalled = NO;
  _pendingTarget = time;
  [_sync setRate:0 time:CMTimeMakeWithSeconds(time, 90000)];
  [self halt:_videoLane];
  [self halt:_audioLane];
  [self playbackStateChanged];
}

- (void)startAt:(double)time {
  Trace(@"start at %.3f for seek %ld", time, (long)_seekSeq);
  _pendingTarget = NAN;
  _started = YES;
  _stalled = NO;
  [_sync setRate:0 time:CMTimeMakeWithSeconds(time, 90000)];
  [self restart:_videoLane at:time];
  [self restart:_audioLane at:time];
  _appliedSeq = _seekSeq;
  [self clearBoundary];
  [self armBoundary];
  [self applyRate];
  [self playbackStateChanged];
}

- (void)halt:(ArdiaPVLane *)lane {
  [self idle:lane];
  if (lane->_video) [_display.sampleBufferRenderer flushWithRemovalOfDisplayedImage:NO completionHandler:nil];
  else [_audio flush];
  [lane->_enqueued removeAllObjects];
  lane->_feed = nil;
  lane->_dirty = NO;
  lane->_blocked = NO;
  lane->_promisedFloor = kCMTimeInvalid;
}

- (void)restart:(ArdiaPVLane *)lane at:(double)time {
  [self halt:lane];
  lane->_from = time;
  [lane cueAt:time];
  [self feed:lane];
}

- (void)idle:(ArdiaPVLane *)lane {
  [lane->_renderer stopRequestingMediaData];
  lane->_requesting = NO;
}

- (void)feed:(ArdiaPVLane *)lane {
  if (!_started || !lane->_feed || lane->_blocked || lane->_requesting) return;
  lane->_requesting = YES;
  __weak ArdiaPVSession *weakSelf = self;
  __weak ArdiaPVLane *weakLane = lane;
  [lane->_renderer requestMediaDataWhenReadyOnQueue:dispatch_get_main_queue()
                                         usingBlock:^{
                                           ArdiaPVSession *session = weakSelf;
                                           ArdiaPVLane *target = weakLane;
                                           if (session && target) [session pump:target];
                                         }];
  [self pump:lane];
}

- (void)pump:(ArdiaPVLane *)lane {
  while (lane->_requesting && lane->_renderer.readyForMoreMediaData) {
    ArdiaPVSegment *segment = lane->_feed;
    if (!segment) return [self idle:lane];
    if (lane->_feedIndex >= segment->_samples.count) {
      ArdiaPVSegment *next = [lane following:segment];
      if (!next) return [self idle:lane];
      lane->_feed = next;
      lane->_feedIndex = 0;
      continue;
    }
    id key = segment->_kid ? _contentKeys[segment->_kid] : nil;
    if (segment->_kid && !key) {
      if (!lane->_blocked) Trace(@"%@ waits for key %@", lane->_video ? @"video" : @"audio", Hex(segment->_kid));
      lane->_blocked = YES;
      return [self idle:lane];
    }
    CMSampleBufferRef sample = (__bridge CMSampleBufferRef)segment->_samples[lane->_feedIndex++];
    CMSampleBufferRef hidden = NULL;
    if (EndOf(sample) <= lane->_from + 1e-4) {
      if (!lane->_video) continue;
      hidden = HiddenCopy(sample);
      if (!hidden) continue;
    }
    CMSampleBufferRef queued = hidden ?: sample;
    if (lane->_video) [self noteFormat:queued lane:lane];
    [lane->_renderer enqueueSampleBuffer:queued];
    if (hidden) CFRelease(hidden);
    [lane->_enqueued addObject:segment];
    if (lane->_video) [self promiseUpcoming:lane];
  }
}

- (void)promiseUpcoming:(ArdiaPVLane *)lane {
  if (@available(macOS 14.4, *)) {
    const CMTime floor = [lane upcomingFloor];
    if (!CMTIME_IS_NUMERIC(floor) || (CMTIME_IS_NUMERIC(lane->_promisedFloor) && CMTimeCompare(floor, lane->_promisedFloor) <= 0)) return;
    lane->_promisedFloor = floor;
    [_display.sampleBufferRenderer expectMinimumUpcomingSampleBufferPresentationTime:floor];
  }
}

- (void)noteFormat:(CMSampleBufferRef)sample lane:(ArdiaPVLane *)lane {
  CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
  if (!format || (lane->_format && CMFormatDescriptionEqual(format, lane->_format))) return;
  const CMVideoDimensions size = CMVideoFormatDescriptionGetDimensions(format);
  Trace(@"video format %dx%d from %.3f decode %.3f", size.width, size.height, StartOf(sample), CMTimeGetSeconds(CMSampleBufferGetDecodeTimeStamp(sample)));
  if (lane->_format) {
    const CMVideoDimensions was = CMVideoFormatDescriptionGetDimensions(lane->_format);
    if (was.width != size.width || was.height != size.height) _sizeChangeAt = std::isfinite(_sizeChangeAt) ? MIN(_sizeChangeAt, StartOf(sample)) : StartOf(sample);
  }
  CFRetain(format);
  if (lane->_format) CFRelease(lane->_format);
  lane->_format = format;
}

- (void)lanesChanged {
  if (!_media || _failed) return;
  if (!_started) {
    const double target = std::isfinite(_pendingTarget) ? _pendingTarget : [self naturalStart];
    if (std::isfinite(target) && [self canStartAt:target]) return [self startAt:target];
    if (std::isfinite(target)) Trace(@"waiting for %.3f: video=[%@] audio=[%@]", target, [_videoLane ranges], [_audioLane ranges]);
    return;
  }
  const double now = [self position];
  for (ArdiaPVLane *lane in @[ _videoLane, _audioLane ]) {
    if ((lane->_dirty || !lane->_feed) && [lane containing:now]) {
      Trace(@"%@ re-enqueue at %.3f", lane->_video ? @"video" : @"audio", now);
      [self restart:lane at:now];
    } else {
      [self feed:lane];
    }
  }
  [self armBoundary];
  const double end = [self bufferedEnd];
  if (_stalled && std::isfinite(end) && (end - now >= kResumeAhead || _ended)) {
    _stalled = NO;
    Trace(@"resume at %.3f (buffered to %.3f)", now, end);
    [self applyRate];
  }
  if (_ended && !_endedSent && (!std::isfinite(end) || now >= end - 0.05)) [self reachedEnd];
}

- (void)keysChanged {
  for (ArdiaPVLane *lane in @[ _videoLane, _audioLane ]) {
    if (!lane->_blocked) continue;
    lane->_blocked = NO;
    [self feed:lane];
  }
}

- (void)armBoundary {
  const double end = _started ? [self bufferedEnd] : NAN;
  if (end == _boundaryTime || (std::isnan(end) && std::isnan(_boundaryTime))) return;
  [self clearBoundary];
  if (!std::isfinite(end)) return;
  _boundaryTime = end;
  __weak ArdiaPVSession *weakSelf = self;
  _boundary = [_sync addBoundaryTimeObserverForTimes:@[ [NSValue valueWithCMTime:CMTimeMakeWithSeconds(MAX(0, end - 0.02), 90000)] ]
                                               queue:dispatch_get_main_queue()
                                          usingBlock:^{
                                            [weakSelf reachedBufferedEnd];
                                          }];
}

- (void)clearBoundary {
  if (_boundary) [_sync removeTimeObserver:_boundary];
  _boundary = nil;
  _boundaryTime = NAN;
}

- (void)reachedBufferedEnd {
  if (!_started) return;
  const double now = [self position], end = [self bufferedEnd];
  if (std::isfinite(end) && now < end - 0.05) {
    [self clearBoundary];
    return [self armBoundary];
  }
  if (_ended) return [self reachedEnd];
  if (_stalled) return;
  _stalled = YES;
  Trace(@"stalled at %.3f (buffered to %.3f)", now, end);
  [self applyRate];
}

- (void)reachedEnd {
  if (_endedSent) return;
  _endedSent = YES;
  _wantsPlay = NO;
  Trace(@"ended at %.3f", [self position]);
  [self applyRate];
  [self deliver:@{@"event" : @"ended", @"media" : @(_media)}];
}

- (void)applyRate {
  const float rate = _wantsPlay && _started && !_stalled && !_endedSent && !_failed ? (float)_rate : 0;
  if (_sync.rate == rate) return;
  _sync.rate = rate;
  [self playbackStateChanged];
  if (_started)
    [self deliver:@{@"event" : @"time", @"media" : @(_media), @"seq" : @(_appliedSeq), @"time" : @([self position]), @"playing" : @(rate > 0)}];
}

- (void)tick {
  ArdiaCoreTab *tab = _tab;
  if (!tab) return [self close];
  if (tab.closed) return;
  [self place];
  if (!_started) return [self keepDisplayAwake:NO];
  AVSampleBufferVideoRenderer *video = _display.sampleBufferRenderer;
  if (video.status == AVQueuedSampleBufferRenderingStatusFailed) return [self failAt:@"playback" reason:video.error.description ?: @"video renderer failed"];
  if (_audio.status == AVQueuedSampleBufferRenderingStatusFailed) return [self failAt:@"playback" reason:_audio.error.description ?: @"audio renderer failed"];
  const double now = [self position];
  if (std::isfinite(_sizeChangeAt) && now >= _sizeChangeAt) {
    _sizeChangeAt = NAN;
    if (_inPip) [self reconnectPictureInPicture];
  }
  if (video.requiresFlushToResumeDecoding) {
    Trace(@"video decoder needs a flush at %.3f", now);
    [self restart:_videoLane at:now];
  }
  const BOOL playing = CMTimebaseGetRate(_sync.timebase) > 0;
  [self keepDisplayAwake:playing && !_endedSent];
  if (playing && !_played) {
    _played = YES;
    [self report:@{@"event" : @"played", @"video" : @YES}];
  }
  if (playing && !_showing) {
    _showing = YES;
    [self place];
  }
  if (playing != _reportedPlaying) {
    _reportedPlaying = playing;
    ArdiaWebView *view = [ArdiaTabRegistry viewForTab:tab];
    [view emitMedia];
    [view autoPictureInPictureInputsChanged];
    [self playbackStateChanged];
  }
  __weak ArdiaPVSession *weakSelf = self;
  [video loadVideoPerformanceMetricsWithCompletionHandler:^(AVVideoPerformanceMetrics *metrics) {
    if (!metrics) return;
    const NSInteger total = metrics.totalNumberOfFrames, dropped = metrics.numberOfDroppedFrames;
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf noteFrames:total dropped:dropped];
    });
  }];
  [self deliver:@{@"event" : @"time", @"media" : @(_media), @"seq" : @(_appliedSeq), @"time" : @(now), @"playing" : @(playing), @"dropped" : @(_droppedFrames)}];
  if (playing && !_stalled && !_endedSent) {
    const double end = [self bufferedEnd];
    if (!std::isfinite(end) || now >= end - 0.03) [self reachedBufferedEnd];
  }
  if ([_videoLane bytes] + [_audioLane bytes] > kMaxStoredBytes) {
    [_videoLane evictBefore:now - kKeepBehind position:now];
    [_audioLane evictBefore:now - kKeepBehind position:now];
  }
  if (Tracing() && NSDate.date.timeIntervalSince1970 - _lastTrace >= 1) {
    _lastTrace = NSDate.date.timeIntervalSince1970;
    [_display.sampleBufferRenderer loadVideoPerformanceMetricsWithCompletionHandler:^(AVVideoPerformanceMetrics *metrics) {
      if (metrics)
        Trace(@"frames total=%ld dropped=%ld corrupted=%ld delay=%.2f", (long)metrics.totalNumberOfFrames, (long)metrics.numberOfDroppedFrames,
              (long)metrics.numberOfCorruptedFrames, metrics.totalAccumulatedFrameDelay);
    }];
    NSView *host = _view.superview;
    NSString *mirror = @"none";
    for (NSView *sibling in host.subviews)
      if ([sibling.identifier isEqualToString:kMirrorIdentifier])
        mirror = [NSString stringWithFormat:@"%@%@", [host.subviews indexOfObjectIdenticalTo:sibling] > [host.subviews indexOfObjectIdenticalTo:_view] ? @"above" : @"below",
                                            sibling.hidden ? @"-hidden" : @""];
    Trace(@"status rate=%.2f timebase=%.2f time=%.3f video=[%@] audio=[%@] stalled=%d status=%ld/%ld view=%@ layer=%@ rect=%@@%.2f hidden=%d mirror=%@ pip=%d", _sync.rate,
          CMTimebaseGetRate(_sync.timebase), now, [_videoLane ranges], [_audioLane ranges], _stalled, (long)video.status, (long)_audio.status, NSStringFromRect(_view.frame),
          NSStringFromRect(NSRectFromCGRect(_display.frame)), NSStringFromRect(_rect), _scale, _view.hidden, mirror, _inPip);
  }
}

- (void)noteFrames:(NSInteger)total dropped:(NSInteger)dropped {
  _droppedFrames += dropped >= _rendererDropped ? dropped - _rendererDropped : dropped;
  _rendererDropped = dropped;
  _shownFrames += total >= _rendererFrames ? total - _rendererFrames : total;
  _rendererFrames = total;
  if (_choppyReported || _shownFrames < kChoppyMinimumFrames || _droppedFrames * kChoppyDropShare < _shownFrames) return;
  _choppyReported = YES;
  [self report:@{@"event" : @"choppy", @"video" : @YES}];
}

- (void)place {
  ArdiaCoreTab *tab = _tab;
  NSView *content = tab.view;
  NSView *host = content.superview;
  const BOOL show = _media && _showing && _hasRect && _rectVisible && host && content.window && !content.hiddenOrHasHiddenAncestor;
  if (!show) {
    if (!_view.hidden) _view.hidden = YES;
    return;
  }
  NSView *mirror = nil;
  for (NSView *sibling in host.subviews)
    if ([sibling.identifier isEqualToString:kMirrorIdentifier]) mirror = sibling;
  NSArray<NSView *> *siblings = host.subviews;
  const NSUInteger mine = [siblings indexOfObjectIdenticalTo:_view];
  const NSUInteger page = [siblings indexOfObjectIdenticalTo:content];
  const NSUInteger mirrored = mirror ? [siblings indexOfObjectIdenticalTo:mirror] : NSNotFound;
  const BOOL ordered = _view.superview == host && mine != NSNotFound && mine > page && (mirrored == NSNotFound || mine < mirrored) &&
                       (mirrored != NSNotFound || mine == siblings.count - 1);
  if (!ordered) {
    if (mirror) [host addSubview:_view positioned:NSWindowBelow relativeTo:mirror];
    else [host addSubview:_view positioned:NSWindowAbove relativeTo:nil];
  }
  const CGFloat backing = content.window.backingScaleFactor ?: 2;
  const double k = _scale / backing;
  NSRect inContent = NSMakeRect(_rect.origin.x * k, _rect.origin.y * k, _rect.size.width * k, _rect.size.height * k);
  NSRect uncovered = NSMakeRect(inContent.origin.x, (_rect.origin.y + _coverTop) * k, inContent.size.width,
                                MAX(0, _rect.size.height - _coverTop - _coverBottom) * k);
  if (!content.isFlipped) {
    inContent.origin.y = NSHeight(content.bounds) - NSMaxY(inContent);
    uncovered.origin.y = NSHeight(content.bounds) - NSMaxY(uncovered);
  }
  const NSRect full = [content convertRect:inContent toView:host];
  const NSRect visible = NSIntersectionRect([content convertRect:uncovered toView:host], content.frame);
  if (NSIsEmptyRect(visible)) {
    _view.hidden = YES;
    return;
  }
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  if (!NSEqualRects(_view.frame, visible)) _view.frame = visible;
  const NSRect inside = NSOffsetRect(full, -visible.origin.x, -visible.origin.y);
  CGRect layerFrame = NSRectToCGRect(inside);
  if (host.isFlipped) layerFrame.origin.y = NSHeight(visible) - CGRectGetMaxY(layerFrame);
  if (!_inPip && !CGRectEqualToRect(_display.frame, layerFrame)) _display.frame = layerFrame;
  if (_display.contentsScale != backing) _display.contentsScale = backing;
  ardia_pip::RoundVideoCorners(_view.layer, _corners, _cornerRadius * k, _backdrop, full, visible, host.isFlipped, NO);
  [CATransaction commit];
  if (_view.hidden != _inPip) _view.hidden = _inPip;
  [self preparePictureInPicture];
}

@end
