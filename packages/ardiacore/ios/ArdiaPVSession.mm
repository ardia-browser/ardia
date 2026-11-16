#import "ArdiaProtectedVideoInternal.h"

using namespace ardia_runtime;
using namespace ardia_web_view;
using namespace ardia_protected_video;

@implementation ArdiaPVSession

- (instancetype)initWithTab:(ArdiaCoreTab *)tab frame:(NSString *)frameId {
  if ((self = [super init])) {
    _tab = tab;
    _frame = [frameId copy];
    _keyQueue = dispatch_queue_create("ardia.protectedVideo.keys", DISPATCH_QUEUE_SERIAL);
    _keys = [AVContentKeySession contentKeySessionWithKeySystem:AVContentKeySystemFairPlayStreaming];
    [_keys setDelegate:self queue:_keyQueue];
    _keySessions = [NSMutableDictionary dictionary];
    _keyOwners = [NSMutableDictionary dictionary];
    _keyRequests = [NSMutableDictionary dictionary];
    _contentKeys = [NSMutableDictionary dictionary];
    _keyBatch = [NSMutableArray array];
    _tracks = [NSMutableDictionary dictionary];
    _pendingTarget = NAN;
    _sizeChangeAt = NAN;
    _boundaryTime = NAN;
    _tracedRange = kCMTimeRangeInvalid;
    _rate = 1;
    _volume = 1;
    _scale = 2;
    [self setUpRenderers];
    __weak ArdiaPVSession *weakSelf = self;
    _ticker = [NSTimer scheduledTimerWithTimeInterval:kTick
                                              repeats:YES
                                                block:^(NSTimer *timer) {
                                                  ArdiaPVSession *session = weakSelf;
                                                  if (session) [session tick];
                                                  else [timer invalidate];
                                                }];
    [self muteChanged];
  }
  return self;
}

- (NSString *)frame {
  return _frame;
}

- (void)deliver:(NSDictionary *)event {
  ArdiaCoreTab *tab = _tab;
  if (tab && !tab.closed && _frame.length) [tab callFrame:_frame kind:@"protectedVideo" json:JSONText(event)];
}

- (void)report:(NSDictionary *)payload {
  if (ArdiaCoreTab *tab = _tab) [[ArdiaTabRegistry viewForTab:tab] emit:@"fairPlay" payload:payload];
}

- (void)failAt:(NSString *)step reason:(NSString *)reason {
  Trace(@"failed at %@: %@", step, reason);
  if (_failed || !_media) return;
  _failed = YES;
  [self report:@{@"event" : @"failed", @"step" : step, @"video" : @YES}];
  [self deliver:@{@"event" : @"failed", @"media" : @(_media), @"step" : step}];
  [self resetPlayback];
}

- (void)close {
  Trace(@"close %ld", (long)_media);
  [_ticker invalidate];
  _ticker = nil;
  [self keepDisplayAwake:NO];
  [self dropPictureInPicture];
  [self tearDownRenderers];
  [_view removeFromSuperview];
  [_keys setDelegate:nil queue:nil];
  [_keys expire];
  [_tracks removeAllObjects];
  if (_reportedPlaying) {
    _reportedPlaying = NO;
    if (ArdiaCoreTab *tab = _tab) [[ArdiaTabRegistry viewForTab:tab] emitMedia];
  }
}

- (BOOL)active {
  return _media != 0 && _started;
}

- (BOOL)plays {
  return _reportedPlaying;
}

- (void)muteChanged {
  ArdiaCoreTab *tab = _tab;
  _audio.muted = _pageMuted || (tab && tab.muted);
  _audio.volume = (float)_volume;
}

- (void)handle:(NSDictionary *)message {
  NSString *op = Text(message, @"op", 16);
  NSInteger session, media;
  if ([op isEqualToString:@"certificate"]) {
    NSData *certificate = Base64(message, @"data", kMaxPartChars);
    if (certificate.length && certificate.length <= kMaxKeyData) {
      _certificate = certificate;
      [self flushKeyRequests];
    }
    return;
  }
  if ([op isEqualToString:@"request"] && WholeNumber(message, @"session", 1, INT_MAX, &session)) return [self keyRequest:message session:session];
  if ([op isEqualToString:@"update"] && WholeNumber(message, @"session", 1, INT_MAX, &session)) return [self keyUpdate:message session:session];
  if ([op isEqualToString:@"closeSession"] && WholeNumber(message, @"session", 1, INT_MAX, &session)) {
    [_keySessions removeObjectForKey:@(session)];
    return;
  }
  if (!WholeNumber(message, @"media", 1, INT_MAX, &media)) return;
  if ([op isEqualToString:@"attach"]) return [self attach:media];
  if (media != _media) return;
  if ([op isEqualToString:@"detach"]) return [self detach];
  if ([op isEqualToString:@"buffer"]) return [self buffer:message];
  if ([op isEqualToString:@"append"]) return [self append:message];
  if ([op isEqualToString:@"remove"]) return [self remove:message];
  if ([op isEqualToString:@"dropBuffer"]) return [self dropBuffer:message];
  if ([op isEqualToString:@"end"]) {
    _ended = Flag(message, @"ended");
    return [self lanesChanged];
  }
  if ([op isEqualToString:@"duration"]) {
    double duration;
    if (!Bounded(message, @"duration", 0, 1e8, &duration) || duration == _duration) return;
    _duration = duration;
    return [self playbackStateChanged];
  }
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

- (void)attach:(NSInteger)media {
  [self resetPlayback];
  [_tracks removeAllObjects];
  _media = media;
  _ended = NO;
  _seekSeq = 0;
  _appliedSeq = 0;
  _wantsPlay = NO;
  _failed = NO;
  _played = NO;
  _hasRect = NO;
  _showing = NO;
  _duration = 0;
  _droppedFrames = 0;
  _shownFrames = 0;
  _choppyReported = NO;
  Trace(@"attach %ld", (long)media);
}

- (void)detach {
  Trace(@"detach %ld", (long)_media);
  [self resetPlayback];
  [_tracks removeAllObjects];
  _media = 0;
  _showing = NO;
  _duration = 0;
  [self place];
}

- (void)buffer:(NSDictionary *)message {
  NSInteger buffer;
  NSString *mime = Text(message, @"mime", 256);
  if (!WholeNumber(message, @"buffer", 1, 64, &buffer) || !mime.length) return;
  ArdiaPVTrack *track = _tracks[@(buffer)];
  if (!track) {
    if ((NSInteger)_tracks.count >= kMaxBuffers) return;
    track = [ArdiaPVTrack new];
    track->_buffer = buffer;
    _tracks[@(buffer)] = track;
  }
  track->_video = [mime.lowercaseString hasPrefix:@"video/"];
  Trace(@"buffer %ld %@", (long)buffer, mime);
}

- (void)append:(NSDictionary *)message {
  NSInteger buffer, seq, part, parts;
  if (!WholeNumber(message, @"buffer", 1, 64, &buffer) || !WholeNumber(message, @"seq", 0, INT_MAX, &seq) ||
      !WholeNumber(message, @"parts", 1, kMaxParts, &parts) || !WholeNumber(message, @"part", 0, parts - 1, &part))
    return;
  ArdiaPVTrack *track = _tracks[@(buffer)];
  NSData *data = Base64(message, @"data", kMaxPartChars);
  if (!track || !data) return;
  if (part == 0) {
    track->_assemblySeq = seq;
    track->_assemblyNext = 0;
    track->_assembly = [NSMutableData data];
  }
  if (track->_assemblySeq != seq || track->_assemblyNext != part || track->_assembly.length + data.length > kMaxUnitBytes) {
    if (track->_assemblySeq >= 0)
      Trace(@"buffer %ld drops seq %ld at part %ld/%ld (assembling seq %ld, expected part %ld, %lu bytes)", (long)buffer, (long)seq, (long)part, (long)parts,
            (long)track->_assemblySeq, (long)track->_assemblyNext, (unsigned long)track->_assembly.length);
    track->_assemblySeq = -1;
    track->_assembly = nil;
    return;
  }
  [track->_assembly appendData:data];
  track->_assemblyNext = part + 1;
  if (part + 1 < parts) return;
  NSData *unit = track->_assembly;
  track->_assembly = nil;
  track->_assemblySeq = -1;
  NSString *kind = Text(message, @"kind", 16);
  if ([kind isEqualToString:@"init"]) {
    if ([track->_init isEqualToData:unit]) return;
    track->_init = unit;
    track->_kid = InitKeyID(unit);
    track->_timescale = InitTimescale(unit);
    if (![track parse:unit]) return [self failAt:@"playback" reason:track->_parseError];
    Trace(@"init buffer %ld timescale %u key %@", (long)buffer, track->_timescale, track->_kid ? Hex(track->_kid) : @"none");
    return;
  }
  double start, end;
  if (![kind isEqualToString:@"segment"] || !track->_init || !Bounded(message, @"start", -1e6, 1e8, &start) || !Bounded(message, @"end", start, 1e8, &end)) {
    Trace(@"buffer %ld drops seq %ld: kind %@ init %d", (long)buffer, (long)seq, kind, track->_init != nil);
    return;
  }
  if (![track parse:unit]) return [self failAt:@"playback" reason:track->_parseError];
  const int64_t decodeTime = FragmentDecodeTime(unit);
  const double offset = decodeTime >= 0 && track->_timescale ? start - (double)decodeTime / track->_timescale : 0;
  if (!track->_parsedVideo.count && !track->_parsedAudio.count) Trace(@"buffer %ld segment %.3f-%.3f parsed no samples", (long)buffer, start, end);
  [self store:track->_parsedVideo in:_videoLane offset:offset key:track->_kid bytes:unit.length];
  [self store:track->_parsedAudio in:_audioLane offset:offset key:track->_kid bytes:unit.length];
  track->_parsedVideo = nil;
  track->_parsedAudio = nil;
  if (_ended) _ended = NO;
  [self lanesChanged];
}

- (void)store:(NSArray *)buffers in:(ArdiaPVLane *)lane offset:(double)offset key:(NSData *)kid bytes:(NSUInteger)bytes {
  if (!buffers.count) return;
  NSMutableArray *samples = [NSMutableArray array];
  double start = INFINITY, end = -INFINITY;
  for (id buffer in buffers)
    for (id sample in SingleSamples((__bridge CMSampleBufferRef)buffer, fabs(offset) > 1e-4 ? offset : 0)) {
      start = MIN(start, StartOf((__bridge CMSampleBufferRef)sample));
      end = MAX(end, EndOf((__bridge CMSampleBufferRef)sample));
      [samples addObject:sample];
    }
  if (!samples.count || !std::isfinite(start) || !std::isfinite(end)) return;
  ArdiaPVSegment *segment = [ArdiaPVSegment new];
  segment->_samples = samples;
  segment->_start = start;
  segment->_end = MAX(end, start + 0.001);
  segment->_bytes = bytes;
  segment->_kid = kid;
  segment->_serial = ++_serials;
  if (Tracing()) {
    NSMutableArray<NSString *> *replaced = [NSMutableArray array];
    for (ArdiaPVSegment *old in lane->_stored)
      if (segment->_start < old->_end - kOverlap && segment->_end > old->_start + kOverlap) [replaced addObject:[NSString stringWithFormat:@"%.3f-%.3f", old->_start, old->_end]];
    if (replaced.count)
      Trace(@"%@ segment %.3f-%.3f replaces %@", lane->_video ? @"video" : @"audio", segment->_start, segment->_end, [replaced componentsJoinedByString:@","]);
  }
  [lane store:segment position:[self position]];
}

- (void)remove:(NSDictionary *)message {
  NSInteger buffer;
  double start, end;
  if (!WholeNumber(message, @"buffer", 1, 64, &buffer) || !Bounded(message, @"start", -1e6, 1e8, &start) || !Finite(message, @"end", &end) || end < start) return;
  ArdiaPVTrack *track = _tracks[@(buffer)];
  if (!track) return;
  [track->_video ? _videoLane : _audioLane removeFrom:start to:end position:[self position]];
  [self lanesChanged];
}

- (void)dropBuffer:(NSDictionary *)message {
  NSInteger buffer;
  if (!WholeNumber(message, @"buffer", 1, 64, &buffer)) return;
  ArdiaPVTrack *track = _tracks[@(buffer)];
  if (!track) return;
  [_tracks removeObjectForKey:@(buffer)];
  Trace(@"drop buffer %ld", (long)buffer);
  for (ArdiaPVTrack *other in _tracks.objectEnumerator)
    if (other->_video == track->_video) return [self lanesChanged];
  [track->_video ? _videoLane : _audioLane removeFrom:-1e6 to:1e8 position:[self position]];
  [self lanesChanged];
}

- (void)seek:(NSDictionary *)message {
  NSInteger seq;
  double time;
  if (!WholeNumber(message, @"seq", 1, INT_MAX, &seq) || !Bounded(message, @"time", 0, 1e8, &time)) return;
  _seekSeq = seq;
  _endedSent = NO;
  Trace(@"seek %ld to %.3f (started %d)", (long)seq, time, _started);
  [self seekTo:time];
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

@end
