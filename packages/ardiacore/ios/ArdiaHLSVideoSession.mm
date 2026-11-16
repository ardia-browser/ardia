#import "ArdiaHLSVideoInternal.h"
#import "ArdiaPictureInPictureInternal.h"

using namespace ardia_runtime;
using namespace ardia_web_view;
using namespace ardia_hls_video;

@implementation ArdiaHLSVideoSession

- (instancetype)initWithTab:(ArdiaCoreTab *)tab frame:(NSString *)frameId {
  if ((self = [super init])) {
    _tab = tab;
    _frame = [frameId copy];
    _keyQueue = dispatch_queue_create("ardia.hlsVideo.keys", DISPATCH_QUEUE_SERIAL);
    _keys = [AVContentKeySession contentKeySessionWithKeySystem:AVContentKeySystemFairPlayStreaming];
    [_keys setDelegate:self queue:_keyQueue];
    _keySessions = [NSMutableDictionary dictionary];
    _keyRequests = [NSMutableDictionary dictionary];
    _keyOwners = [NSMutableDictionary dictionary];
    _rate = 1;
    _volume = 1;
    _scale = 2;
    _view = [ArdiaHLSLayerView new];
    _view.identifier = kViewIdentifier;
    _view.wantsLayer = YES;
    _view.clipsToBounds = YES;
    _view.layer.masksToBounds = YES;
    _view.layer.backgroundColor = NSColor.blackColor.CGColor;
    _corners = [CAShapeLayer layer];
    _corners.hidden = YES;
    [_view.layer addSublayer:_corners];
    _view.hidden = YES;
    __weak ArdiaHLSVideoSession *weakSelf = self;
    _ticker = [NSTimer scheduledTimerWithTimeInterval:kTick
                                              repeats:YES
                                                block:^(NSTimer *timer) {
                                                  ArdiaHLSVideoSession *session = weakSelf;
                                                  if (session) [session tick];
                                                  else [timer invalidate];
                                                }];
  }
  return self;
}

- (void)deliver:(NSDictionary *)event {
  ArdiaCoreTab *tab = _tab;
  if (tab && !tab.closed && _frame.length) [tab callFrame:_frame kind:@"hlsVideo" json:JSONText(event)];
}

- (void)report:(NSDictionary *)payload {
  NSMutableDictionary *tagged = [payload mutableCopy];
  tagged[@"video"] = @YES;
  tagged[@"site"] = @"youtube";
  if (ArdiaCoreTab *tab = _tab) [[ArdiaTabRegistry viewForTab:tab] emit:@"fairPlay" payload:tagged];
}

- (void)failAt:(NSString *)step reason:(NSString *)reason {
  Trace(@"failed at %@: %@", step, reason);
  if (_failed || !_media) return;
  _failed = YES;
  [self report:@{@"event" : @"failed", @"step" : step}];
  [self deliver:@{@"event" : @"failed", @"media" : @(_media), @"step" : step}];
  [self resetPlayback];
}

- (void)close {
  Trace(@"close %ld", (long)_media);
  [_ticker invalidate];
  _ticker = nil;
  [self resetPlayback];
  [_view removeFromSuperview];
  [_keys setDelegate:nil queue:nil];
  [_keys expire];
  [_keySessions removeAllObjects];
  [_keyRequests removeAllObjects];
  [_keyOwners removeAllObjects];
}

- (BOOL)active {
  return _media != 0 && _ready && _player != nil;
}

- (BOOL)plays {
  return _reportedPlaying;
}

- (void)muteChanged {
  ArdiaCoreTab *tab = _tab;
  _player.muted = _pageMuted || (tab && tab.muted);
  _player.volume = (float)_volume;
}

- (void)handle:(NSDictionary *)message {
  NSString *op = Text(message, @"op", 16);
  NSInteger session, media;
  if ([op isEqualToString:@"session"] && WholeNumber(message, @"session", 1, INT_MAX, &session)) return [self openKeySession:session data:Base64(message, @"data")];
  if ([op isEqualToString:@"update"] && WholeNumber(message, @"session", 1, INT_MAX, &session)) return [self updateKeySession:session data:Base64(message, @"data")];
  if ([op isEqualToString:@"closeSession"] && WholeNumber(message, @"session", 1, INT_MAX, &session)) return [self closeKeySession:session];
  if (!WholeNumber(message, @"media", 1, INT_MAX, &media)) return;
  if ([op isEqualToString:@"load"]) return [self load:message media:media];
  if (media != _media) return;
  if ([op isEqualToString:@"detach"]) return [self detach];
  if ([op isEqualToString:@"failed"]) return [self failAt:@"player" reason:@"the page gave up waiting"];
  if ([op isEqualToString:@"play"]) {
    _wantsPlay = YES;
    return [self applyRate];
  }
  if ([op isEqualToString:@"pause"]) {
    _wantsPlay = NO;
    return [self applyRate];
  }
  if ([op isEqualToString:@"seek"]) return [self seek:message];
  if ([op isEqualToString:@"rate"]) {
    double rate;
    if (Bounded(message, @"rate", 0.0625, 16, &rate)) _rate = rate;
    return [self applyRate];
  }
  if ([op isEqualToString:@"volume"]) {
    double volume;
    if (Bounded(message, @"volume", 0, 1, &volume)) _volume = volume;
    _pageMuted = Flag(message, @"muted");
    return [self muteChanged];
  }
  if ([op isEqualToString:@"rect"]) return [self rect:message];
  if ([op isEqualToString:@"pip"]) {
    if (Flag(message, @"enter")) {
      if (![self startPictureInPicture]) [self deliverPictureInPicture];
    } else if (_inPip) {
      [self exitPictureInPicture];
    } else {
      [self deliverPictureInPicture];
    }
  }
}

- (void)load:(NSDictionary *)message media:(NSInteger)media {
  NSInteger part, parts;
  NSString *chunk = Text(message, @"playlist", kMaxPartChars);
  if (!chunk || !WholeNumber(message, @"parts", 1, kMaxParts, &parts) || !WholeNumber(message, @"part", 0, parts - 1, &part)) return;
  if (part == 0) {
    _partsMedia = media;
    _partsExpected = parts;
    _parts = [NSMutableString stringWithString:chunk];
  } else if (_partsMedia == media && _parts && _partsExpected == parts) {
    [_parts appendString:chunk];
  } else {
    return;
  }
  if (part + 1 < parts) return;
  NSString *playlist = _parts;
  _parts = nil;
  double volume, rate;
  if (Bounded(message, @"volume", 0, 1, &volume)) _volume = volume;
  if (Bounded(message, @"rate", 0.0625, 16, &rate)) _rate = rate;
  _pageMuted = Flag(message, @"muted");
  [self startMedia:media playlist:playlist];
}

- (void)startMedia:(NSInteger)media playlist:(NSString *)playlist {
  [self resetPlayback];
  _media = media;
  _ready = NO;
  _wantsPlay = NO;
  _holding = NO;
  _hasPendingSeek = NO;
  _seekSeq = 0;
  _appliedSeq = 0;
  _endedSent = NO;
  _failed = NO;
  _played = NO;
  _hasRect = NO;
  _showing = NO;
  Trace(@"load %ld (%lu chars)", (long)media, (unsigned long)playlist.length);
  if (!RemotePlaylist(playlist)) return [self failAt:@"playback" reason:@"the playlist points somewhere other than https"];
  _loader = [[ArdiaHLSPlaylistLoader alloc] initWithPlaylist:[playlist dataUsingEncoding:NSUTF8StringEncoding] media:media];
  _asset = [AVURLAsset URLAssetWithURL:_loader.url options:nil];
  [_asset.resourceLoader setDelegate:_loader queue:dispatch_get_main_queue()];
  [_keys addContentKeyRecipient:_asset];
  _item = [AVPlayerItem playerItemWithAsset:_asset];
  _player = [AVPlayer playerWithPlayerItem:_item];
  _player.actionAtItemEnd = AVPlayerActionAtItemEndPause;
  _player.allowsExternalPlayback = NO;
  _layer = [AVPlayerLayer playerLayerWithPlayer:_player];
  _layer.videoGravity = AVLayerVideoGravityResizeAspect;
  _layer.backgroundColor = NSColor.blackColor.CGColor;
  [_view.layer insertSublayer:_layer atIndex:0];
  [self muteChanged];
  __weak ArdiaHLSVideoSession *weakSelf = self;
  _endObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVPlayerItemDidPlayToEndTimeNotification
                                                                 object:_item
                                                                  queue:NSOperationQueue.mainQueue
                                                             usingBlock:^(NSNotification *note) {
                                                               [weakSelf reachedEnd];
                                                             }];
  _failObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVPlayerItemFailedToPlayToEndTimeNotification
                                                                  object:_item
                                                                   queue:NSOperationQueue.mainQueue
                                                              usingBlock:^(NSNotification *note) {
                                                                NSError *error = note.userInfo[AVPlayerItemFailedToPlayToEndTimeErrorKey];
                                                                [weakSelf failAt:@"playback" reason:error.localizedDescription ?: @"stopped"];
                                                              }];
}

- (void)resetPlayback {
  if (_endObserver) [NSNotificationCenter.defaultCenter removeObserver:_endObserver];
  if (_failObserver) [NSNotificationCenter.defaultCenter removeObserver:_failObserver];
  _endObserver = nil;
  _failObserver = nil;
  [self dropPictureInPicture];
  [_player pause];
  [_player replaceCurrentItemWithPlayerItem:nil];
  [_layer removeFromSuperlayer];
  if (_asset) [_keys removeContentKeyRecipient:_asset];
  [_asset.resourceLoader setDelegate:nil queue:dispatch_get_main_queue()];
  _layer = nil;
  _player = nil;
  _item = nil;
  _asset = nil;
  _loader = nil;
  _ready = NO;
  _showing = NO;
  _inPip = NO;
  [_keyRequests removeAllObjects];
  _view.hidden = YES;
  [self setReportedPlaying:NO];
}

- (void)detach {
  Trace(@"detach %ld", (long)_media);
  [self resetPlayback];
  _media = 0;
}

- (void)seek:(NSDictionary *)message {
  NSInteger seq;
  double time;
  if (!WholeNumber(message, @"seq", 1, INT_MAX, &seq) || !Bounded(message, @"time", 0, 1e8, &time)) return;
  _seekSeq = seq;
  _endedSent = NO;
  if (!_ready) {
    _hasPendingSeek = YES;
    _pendingSeek = time;
    _pendingSeq = seq;
    return;
  }
  [self seekTo:time seq:seq];
}

- (void)seekTo:(double)time seq:(NSInteger)seq {
  Trace(@"seek %ld to %.3f", (long)seq, time);
  __weak ArdiaHLSVideoSession *weakSelf = self;
  AVPlayerItem *item = _item;
  [_item seekToTime:CMTimeMakeWithSeconds(time, 1000)
        toleranceBefore:kCMTimeZero
         toleranceAfter:kCMTimeZero
      completionHandler:^(BOOL finished) {
        dispatch_async(dispatch_get_main_queue(), ^{
          ArdiaHLSVideoSession *session = weakSelf;
          if (!session || !finished || session->_item != item) return;
          [session seekDone:seq];
        });
      }];
}

- (void)seekDone:(NSInteger)seq {
  if (seq != _seekSeq) return;
  _appliedSeq = seq;
  if (_holding) {
    _holding = NO;
    [self applyRate];
  }
  const double now = Seconds(_player.currentTime);
  [self deliver:@{@"event" : @"seeked", @"media" : @(_media), @"seq" : @(seq), @"time" : @(std::isfinite(now) ? now : 0)}];
}

- (void)applyRate {
  if (!_player) return;
  const float rate = _wantsPlay && _ready && !_holding && !_failed ? (float)_rate : 0;
  if (_player.rate != rate) _player.rate = rate;
  [_pip invalidatePlaybackState];
}

- (void)reachedEnd {
  if (!_media || _endedSent) return;
  _endedSent = YES;
  _wantsPlay = NO;
  [self applyRate];
  [self deliver:@{@"event" : @"ended", @"media" : @(_media)}];
}

- (void)setReportedPlaying:(BOOL)playing {
  if (playing == _reportedPlaying) return;
  _reportedPlaying = playing;
  if (ArdiaCoreTab *tab = _tab) {
    ArdiaWebView *view = [ArdiaTabRegistry viewForTab:tab];
    [view emitMedia];
    [view autoPictureInPictureInputsChanged];
  }
}

- (NSDictionary *)timing {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  const CMTime duration = _item.duration;
  if (CMTIME_IS_INDEFINITE(duration)) out[@"duration"] = @"live";
  else if (std::isfinite(Seconds(duration))) out[@"duration"] = @(Seconds(duration));
  NSMutableArray *buffered = [NSMutableArray array];
  for (NSValue *value in _item.loadedTimeRanges) {
    const CMTimeRange range = value.CMTimeRangeValue;
    const double start = Seconds(range.start), end = Seconds(CMTimeRangeGetEnd(range));
    if (std::isfinite(start) && std::isfinite(end) && buffered.count < 16) [buffered addObject:@[ @(start), @(end) ]];
  }
  out[@"buffered"] = buffered;
  NSValue *seekable = _item.seekableTimeRanges.lastObject;
  if (seekable) {
    const CMTimeRange range = seekable.CMTimeRangeValue;
    const double start = Seconds(range.start), end = Seconds(CMTimeRangeGetEnd(range));
    if (std::isfinite(start) && std::isfinite(end)) out[@"seekable"] = @[ @(start), @(end) ];
  }
  const CGSize size = _item.presentationSize;
  if (size.width > 0 && size.height > 0) out[@"size"] = @[ @((NSInteger)size.width), @((NSInteger)size.height) ];
  return out;
}

- (void)tick {
  ArdiaCoreTab *tab = _tab;
  if (!tab) return [self close];
  if (!_media || !_item || _failed) return;
  if (_item.status == AVPlayerItemStatusFailed) return [self failAt:@"playback" reason:_item.error.localizedDescription ?: @"item failed"];
  if (!_ready) {
    if (_item.status != AVPlayerItemStatusReadyToPlay) return;
    _ready = YES;
    Trace(@"ready %ld", (long)_media);
    NSMutableDictionary *ready = [[self timing] mutableCopy];
    ready[@"event"] = @"ready";
    ready[@"media"] = @(_media);
    [self deliver:ready];
    if (_hasPendingSeek) {
      _hasPendingSeek = NO;
      _holding = YES;
      [self seekTo:_pendingSeek seq:_pendingSeq];
    }
    [self applyRate];
  }
  const BOOL running = _player.rate != 0;
  if (!_holding && !_endedSent && running != _wantsPlay) {
    _wantsPlay = running;
    [self deliver:@{@"event" : @"paused", @"media" : @(_media), @"paused" : @(!running)}];
  }
  const BOOL playing = _player.timeControlStatus == AVPlayerTimeControlStatusPlaying;
  const BOOL waiting = _player.timeControlStatus == AVPlayerTimeControlStatusWaitingToPlayAtSpecifiedRate;
  if (playing && !_showing && _layer.readyForDisplay) {
    _showing = YES;
    [self place];
  }
  if (playing && !_played) {
    _played = YES;
    [self report:@{@"event" : @"played"}];
  }
  [self setReportedPlaying:playing || (_wantsPlay && waiting)];
  const double now = Seconds(_player.currentTime);
  NSMutableDictionary *time = [[self timing] mutableCopy];
  [time addEntriesFromDictionary:@{
    @"event" : @"time",
    @"media" : @(_media),
    @"seq" : @(_appliedSeq),
    @"time" : @(std::isfinite(now) ? now : 0),
    @"playing" : @(playing),
    @"waiting" : @(waiting)
  }];
  [self deliver:time];
  if (_hasRect) [self place];
  if (Tracing() && NSDate.date.timeIntervalSince1970 - _lastTrace >= 2) {
    _lastTrace = NSDate.date.timeIntervalSince1970;
    AVPlayerItemAccessLogEvent *access = _item.accessLog.events.lastObject;
    Trace(@"status time=%.3f rate=%.2f control=%ld size=%@ bitrate=%.0f view=%@ hidden=%d pip=%d", now, _player.rate, (long)_player.timeControlStatus,
          NSStringFromSize(_item.presentationSize), access.indicatedBitrate, NSStringFromRect(_view.frame), _view.hidden, _inPip);
  }
}

- (void)rect:(NSDictionary *)message {
  double x, y, width, height, scale;
  if (!Bounded(message, @"x", -1e5, 1e5, &x) || !Bounded(message, @"y", -1e5, 1e5, &y) || !Bounded(message, @"width", 0, 1e5, &width) ||
      !Bounded(message, @"height", 0, 1e5, &height) || !Bounded(message, @"scale", 0.25, 8, &scale))
    return;
  _rect = NSMakeRect(x, y, width, height);
  if (!Bounded(message, @"coverTop", 0, 1e5, &_coverTop)) _coverTop = 0;
  if (!Bounded(message, @"coverBottom", 0, 1e5, &_coverBottom)) _coverBottom = 0;
  if (!Bounded(message, @"radius", 0, 1e4, &_cornerRadius)) _cornerRadius = 0;
  NSArray *backdrop = [message[@"backdrop"] isKindOfClass:NSArray.class] ? message[@"backdrop"] : nil;
  _backdrop = nil;
  if (backdrop.count == 3) {
    double rgb[3];
    BOOL valid = YES;
    for (NSUInteger i = 0; i < 3; i++) {
      id value = backdrop[i];
      valid = valid && [value isKindOfClass:NSNumber.class] && std::isfinite([value doubleValue]);
      rgb[i] = valid ? MIN(MAX([value doubleValue], 0), 255) / 255 : 0;
    }
    if (valid) _backdrop = [NSColor colorWithSRGBRed:rgb[0] green:rgb[1] blue:rgb[2] alpha:1];
  }
  _scale = scale;
  _rectVisible = Flag(message, @"visible") && width > 0 && height > 0;
  _hasRect = YES;
  [self place];
}

- (void)place {
  ArdiaCoreTab *tab = _tab;
  NSView *content = tab.view;
  NSView *host = content.superview;
  const BOOL show = _media && _showing && _hasRect && _rectVisible && host && content.window && !content.hiddenOrHasHiddenAncestor;
  if (!show) {
    _view.hidden = YES;
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
  WithoutActions(^{
    if (!self->_inPip && self->_layer && self->_layer.superlayer != self->_view.layer) [self->_view.layer insertSublayer:self->_layer atIndex:0];
    if (!NSEqualRects(self->_view.frame, visible)) self->_view.frame = visible;
    const NSRect inside = NSOffsetRect(full, -visible.origin.x, -visible.origin.y);
    CGRect layerFrame = NSRectToCGRect(inside);
    if (!self->_view.isFlipped) layerFrame.origin.y = NSHeight(visible) - CGRectGetMaxY(layerFrame);
    if (!CGRectEqualToRect(self->_layer.frame, layerFrame)) self->_layer.frame = layerFrame;
    self->_layer.contentsScale = backing;
    ardia_pip::RoundVideoCorners(self->_view.layer, self->_corners, self->_cornerRadius * k, self->_backdrop, full, visible, host.isFlipped,
                                 self->_view.isFlipped);
  });
  _view.hidden = _inPip;
  [self preparePictureInPicture];
}

@end
