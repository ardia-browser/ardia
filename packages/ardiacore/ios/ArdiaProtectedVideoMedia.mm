#import "ArdiaProtectedVideoInternal.h"

#import "ArdiaLaunchConfig.h"

using namespace ardia_runtime;
using namespace ardia_web_view;

namespace {

struct Box {
  std::string type;
  size_t start;
  size_t body;
  size_t end;
};

uint32_t U32(const uint8_t *p) {
  return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}

std::vector<Box> Boxes(const uint8_t *bytes, size_t start, size_t end) {
  std::vector<Box> boxes;
  size_t at = start;
  while (at + 8 <= end) {
    uint64_t size = U32(bytes + at);
    size_t header = 8;
    if (size == 1) {
      if (at + 16 > end) break;
      size = (uint64_t)U32(bytes + at + 8) << 32 | U32(bytes + at + 12);
      header = 16;
    } else if (size == 0) {
      size = end - at;
    }
    if (size < header || size > end - at) break;
    boxes.push_back({std::string((const char *)bytes + at + 4, 4), at, at + header, at + (size_t)size});
    at += (size_t)size;
  }
  return boxes;
}

size_t ChildrenOffset(const std::string &type) {
  if (type == "stsd") return 8;
  if (type == "encv" || type == "avc1" || type == "avc3" || type == "hvc1" || type == "hev1" || type == "dvh1" || type == "dvhe") return 78;
  if (type == "enca" || type == "mp4a" || type == "ec-3" || type == "ac-3") return 28;
  return 0;
}

void Walk(const uint8_t *bytes, size_t start, size_t end, const std::function<bool(const Box &)> &visit) {
  for (const Box &box : Boxes(bytes, start, end)) {
    if (!visit(box)) continue;
    const size_t children = box.body + ChildrenOffset(box.type);
    if (children < box.end) Walk(bytes, children, box.end, visit);
  }
}

bool Container(const std::string &type) {
  static const char *containers[] = {"moov", "trak", "mdia", "minf", "stbl", "stsd", "encv", "enca", "sinf", "schi", "fpsd", "fpsk"};
  for (const char *name : containers)
    if (type == name) return true;
  return false;
}

}

namespace ardia_protected_video {

bool Tracing() {
  static const bool tracing = [ArdiaLaunchConfig.shared traced:@"protectedVideo"];
  return tracing;
}

void Trace(NSString *format, ...) {
  if (!Tracing()) return;
  va_list args;
  va_start(args, format);
  NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
  va_end(args);
  NSLog(@"[protectedVideo] %@", line);
}

bool WholeNumber(NSDictionary *d, NSString *key, NSInteger low, NSInteger high, NSInteger *out) {
  double value;
  if (!Finite(d, key, &value) || value != floor(value) || value < low || value > high) return false;
  *out = (NSInteger)value;
  return true;
}

bool Bounded(NSDictionary *d, NSString *key, double low, double high, double *out) {
  return Finite(d, key, out) && *out >= low && *out <= high;
}

NSData *Base64(NSDictionary *d, NSString *key, NSUInteger maxChars) {
  NSString *text = Text(d, key, maxChars);
  return text.length ? [[NSData alloc] initWithBase64EncodedString:text options:0] : nil;
}

NSString *Hex(NSData *data) {
  NSMutableString *hex = [NSMutableString stringWithCapacity:data.length * 2];
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  for (NSUInteger i = 0; i < data.length; i++) [hex appendFormat:@"%02x", bytes[i]];
  return hex;
}

NSData *Unhex(NSString *text) {
  if (text.length != 32) return nil;
  NSMutableData *data = [NSMutableData dataWithCapacity:16];
  for (NSUInteger i = 0; i < 32; i += 2) {
    unsigned value;
    NSScanner *scanner = [NSScanner scannerWithString:[text substringWithRange:NSMakeRange(i, 2)]];
    if (![scanner scanHexInt:&value]) return nil;
    const uint8_t byte = value;
    [data appendBytes:&byte length:1];
  }
  return data;
}

NSData *InitKeyID(NSData *init) {
  const uint8_t *bytes = (const uint8_t *)init.bytes;
  NSData *found = nil;
  Walk(bytes, 0, init.length, [&](const Box &box) {
    if (!found && box.type == "tenc" && box.end - box.start >= 32) found = [NSData dataWithBytes:bytes + box.start + 16 length:16];
    return Container(box.type);
  });
  return found;
}

NSArray<NSData *> *FairPlayKeyIDs(NSData *pssh) {
  static const uint8_t kFairPlaySystem[16] = {0x94, 0xce, 0x86, 0xfb, 0x07, 0xff, 0x4f, 0x43, 0xad, 0xb8, 0x93, 0xd2, 0xfa, 0x96, 0x8c, 0xa2};
  const uint8_t *bytes = (const uint8_t *)pssh.bytes;
  NSMutableOrderedSet<NSData *> *ids = [NSMutableOrderedSet orderedSet];
  for (const Box &box : Boxes(bytes, 0, pssh.length)) {
    if (box.type != "pssh" || box.end - box.start < 32 || memcmp(bytes + box.start + 12, kFairPlaySystem, 16) != 0) continue;
    size_t at = box.start + 28;
    if (bytes[box.start + 8] > 0) {
      if (at + 4 > box.end) continue;
      const uint32_t count = U32(bytes + at);
      at += 4;
      for (uint32_t i = 0; i < count && at + 16 <= box.end; i++, at += 16) [ids addObject:[NSData dataWithBytes:bytes + at length:16]];
    }
    if (at + 4 > box.end) continue;
    at += 4;
    Walk(bytes, at, box.end, [&](const Box &inner) {
      if (inner.type == "fkri" && inner.end - inner.start >= 28) [ids addObject:[NSData dataWithBytes:bytes + inner.start + 12 length:16]];
      return Container(inner.type);
    });
  }
  return ids.array;
}

NSData *FairPlayPssh(NSData *cenc) {
  static const uint8_t kFairPlaySystem[16] = {0x94, 0xce, 0x86, 0xfb, 0x07, 0xff, 0x4f, 0x43, 0xad, 0xb8, 0x93, 0xd2, 0xfa, 0x96, 0x8c, 0xa2};
  const uint8_t *bytes = (const uint8_t *)cenc.bytes;
  for (const Box &box : Boxes(bytes, 0, cenc.length))
    if (box.type == "pssh" && box.end - box.start >= 32 && memcmp(bytes + box.start + 12, kFairPlaySystem, 16) == 0)
      return [cenc subdataWithRange:NSMakeRange(box.start, box.end - box.start)];
  return nil;
}

NSArray<NSData *> *SinfKeyIDs(NSData *json) {
  id parsed = JSONObject([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] ?: @"");
  NSDictionary *object = [parsed isKindOfClass:NSDictionary.class] ? parsed : nil;
  NSArray *sinfs = [object[@"sinf"] isKindOfClass:NSArray.class] ? object[@"sinf"] : nil;
  NSMutableOrderedSet<NSData *> *ids = [NSMutableOrderedSet orderedSet];
  for (id entry in sinfs) {
    if (![entry isKindOfClass:NSString.class]) continue;
    NSData *sinf = [[NSData alloc] initWithBase64EncodedString:entry options:0];
    if (NSData *kid = sinf ? InitKeyID(sinf) : nil) [ids addObject:kid];
  }
  return ids.array;
}

NSString *CodecsOf(NSString *mime) {
  NSRange at = [mime rangeOfString:@"codecs=" options:NSCaseInsensitiveSearch];
  if (at.location == NSNotFound) return nil;
  NSString *codecs = [[mime substringFromIndex:NSMaxRange(at)] stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\"' ;"]];
  NSRange end = [codecs rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"\"';"]];
  if (end.location != NSNotFound) codecs = [codecs substringToIndex:end.location];
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,-"];
  if (!codecs.length || codecs.length > 128 || [codecs rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return nil;
  return codecs;
}

uint32_t InitTimescale(NSData *init) {
  const uint8_t *bytes = (const uint8_t *)init.bytes;
  uint32_t found = 0;
  Walk(bytes, 0, init.length, [&](const Box &box) {
    if (!found && box.type == "mdhd" && box.end - box.body >= 24) found = U32(bytes + box.body + (bytes[box.body] == 1 ? 20 : 12));
    return box.type == "moov" || box.type == "trak" || box.type == "mdia";
  });
  return found;
}

int64_t FragmentDecodeTime(NSData *segment) {
  const uint8_t *bytes = (const uint8_t *)segment.bytes;
  int64_t found = -1;
  Walk(bytes, 0, segment.length, [&](const Box &box) {
    if (found < 0 && box.type == "tfdt" && box.end - box.body >= 8) {
      const uint8_t *p = bytes + box.body;
      if (p[0] != 1) found = U32(p + 4);
      else if (box.end - box.body >= 12) found = (int64_t)((uint64_t)U32(p + 4) << 32 | U32(p + 8));
    }
    return box.type == "moof" || box.type == "traf";
  });
  return found;
}

NSArray *SingleSamples(CMSampleBufferRef buffer, double offset) {
  NSMutableArray *out = [NSMutableArray array];
  const CMItemCount count = CMSampleBufferGetNumSamples(buffer);
  for (CMItemCount i = 0; i < count; i++) {
    CMSampleBufferRef one = NULL;
    if (count == 1) one = (CMSampleBufferRef)CFRetain(buffer);
    else if (CMSampleBufferCopySampleBufferForRange(kCFAllocatorDefault, buffer, CFRangeMake(i, 1), &one) != noErr) continue;
    if (offset != 0) {
      CMSampleTimingInfo timing;
      CMSampleBufferRef shifted = NULL;
      if (CMSampleBufferGetSampleTimingInfo(one, 0, &timing) == noErr) {
        const int32_t scale = CMTIME_IS_VALID(timing.presentationTimeStamp) ? timing.presentationTimeStamp.timescale : 90000;
        const CMTime delta = CMTimeMakeWithSeconds(offset, MAX(scale, 1000));
        if (CMTIME_IS_VALID(timing.presentationTimeStamp)) timing.presentationTimeStamp = CMTimeAdd(timing.presentationTimeStamp, delta);
        if (CMTIME_IS_VALID(timing.decodeTimeStamp)) timing.decodeTimeStamp = CMTimeAdd(timing.decodeTimeStamp, delta);
        CMSampleBufferCreateCopyWithNewTiming(kCFAllocatorDefault, one, 1, &timing, &shifted);
      }
      CFRelease(one);
      one = shifted;
      if (!one) continue;
    }
    [out addObject:(__bridge_transfer id)one];
  }
  return out;
}

CMSampleBufferRef HiddenCopy(CMSampleBufferRef sample) {
  CMSampleBufferRef copy = NULL;
  if (CMSampleBufferCreateCopy(kCFAllocatorDefault, sample, &copy) != noErr || !copy) return NULL;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(copy, true);
  for (CFIndex i = 0; attachments && i < CFArrayGetCount(attachments); i++)
    CFDictionarySetValue((CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, i), kCMSampleAttachmentKey_DoNotDisplay, kCFBooleanTrue);
  return copy;
}

double StartOf(CMSampleBufferRef sample) {
  return CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
}

double EndOf(CMSampleBufferRef sample) {
  const CMTime duration = CMSampleBufferGetDuration(sample);
  return StartOf(sample) + (CMTIME_IS_NUMERIC(duration) ? CMTimeGetSeconds(duration) : 0);
}

}

using namespace ardia_protected_video;

namespace {

bool IsSync(CMSampleBufferRef sample) {
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  if (!attachments || !CFArrayGetCount(attachments)) return true;
  CFDictionaryRef first = (CFDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
  CFBooleanRef notSync = (CFBooleanRef)CFDictionaryGetValue(first, kCMSampleAttachmentKey_NotSync);
  return !notSync || !CFBooleanGetValue(notSync);
}

}

@implementation ArdiaPVSegment
@end

@implementation ArdiaPVTrack
- (instancetype)init {
  if ((self = [super init])) {
    _assemblySeq = -1;
    _parser = [NSClassFromString(@"AVStreamDataParser") new];
    [_parser setDelegate:self];
  }
  return self;
}

- (void)dealloc {
  [_parser setDelegate:nil];
}

- (BOOL)parse:(NSData *)unit {
  _parsedVideo = [NSMutableArray array];
  _parsedAudio = [NSMutableArray array];
  _parseError = _parser ? nil : @"no stream parser";
  [_parser appendStreamData:unit];
  [_parser providePendingMediaData];
  return !_parseError;
}

- (void)streamDataParser:(id)parser didParseStreamDataAsAsset:(AVAsset *)asset {
  Trace(@"buffer %ld parsed init: %lu tracks", (long)_buffer, (unsigned long)asset.tracks.count);
}

- (void)streamDataParser:(id)parser didParseStreamDataAsAsset:(AVAsset *)asset withDiscontinuity:(BOOL)discontinuity {
  [self streamDataParser:parser didParseStreamDataAsAsset:asset];
}

- (void)streamDataParser:(id)parser didFailToParseStreamDataWithError:(NSError *)error {
  _parseError = error.description ?: @"parse failed";
}

- (void)streamDataParser:(id)parser
     didProvideMediaData:(CMSampleBufferRef)sample
              forTrackID:(CMPersistentTrackID)trackID
               mediaType:(NSString *)mediaType
                   flags:(NSUInteger)flags {
  if ([mediaType isEqualToString:AVMediaTypeVideo]) [_parsedVideo addObject:(__bridge id)sample];
  else if ([mediaType isEqualToString:AVMediaTypeAudio]) [_parsedAudio addObject:(__bridge id)sample];
}

- (void)streamDataParserWillProvideContentKeyRequestInitializationData:(id)parser forTrackID:(CMPersistentTrackID)trackID {
}

- (void)streamDataParser:(id)parser didProvideContentKeyRequestInitializationData:(NSData *)data forTrackID:(CMPersistentTrackID)trackID {
  NSData *kid = SinfKeyIDs(data).firstObject;
  if (kid && !_kid) _kid = kid;
  Trace(@"buffer %ld track %d needs key %@", (long)_buffer, trackID, kid ? Hex(kid) : @"?");
}
@end

@implementation ArdiaPVLane
- (instancetype)initWithRenderer:(id<AVQueuedSampleBufferRendering>)renderer video:(BOOL)video {
  if ((self = [super init])) {
    _renderer = renderer;
    _video = video;
    _stored = [NSMutableArray array];
    _enqueued = [NSHashTable weakObjectsHashTable];
    _promisedFloor = kCMTimeInvalid;
  }
  return self;
}

- (void)dealloc {
  if (_format) CFRelease(_format);
}

- (ArdiaPVSegment *)containing:(double)time {
  ArdiaPVSegment *best = nil;
  for (ArdiaPVSegment *segment in _stored)
    if (segment->_start <= time + kOverlap && segment->_end > time && (!best || segment->_serial > best->_serial)) best = segment;
  if (best) return best;
  for (ArdiaPVSegment *segment in _stored)
    if (segment->_start > time && segment->_start < time + kJoin && (!best || segment->_start < best->_start)) best = segment;
  return best;
}

- (ArdiaPVSegment *)following:(ArdiaPVSegment *)tail {
  ArdiaPVSegment *best = nil;
  for (ArdiaPVSegment *segment in _stored)
    if (segment != tail && segment->_start > tail->_start && fabs(segment->_start - tail->_end) < kJoin && (!best || segment->_serial > best->_serial)) best = segment;
  return best;
}

- (double)endFrom:(double)time {
  ArdiaPVSegment *segment = [self containing:time];
  if (!segment) return NAN;
  for (NSUInteger steps = 0; steps < _stored.count; steps++) {
    ArdiaPVSegment *next = [self following:segment];
    if (!next) break;
    segment = next;
  }
  return segment->_end;
}

- (NSUInteger)bytes {
  NSUInteger total = 0;
  for (ArdiaPVSegment *segment in _stored) total += segment->_bytes;
  return total;
}

- (void)drop:(NSIndexSet *)indexes position:(double)position {
  [_stored enumerateObjectsAtIndexes:indexes
                             options:0
                          usingBlock:^(ArdiaPVSegment *old, NSUInteger index, BOOL *stop) {
                            if (old == self->_feed) {
                              self->_feed = nil;
                              self->_dirty = YES;
                            } else if ([self->_enqueued containsObject:old] && old->_end > position) {
                              self->_dirty = YES;
                            }
                          }];
  [_stored removeObjectsAtIndexes:indexes];
}

- (void)store:(ArdiaPVSegment *)segment position:(double)position {
  [self drop:[_stored indexesOfObjectsPassingTest:^BOOL(ArdiaPVSegment *old, NSUInteger index, BOOL *stop) {
          return segment->_start < old->_end - kOverlap && segment->_end > old->_start + kOverlap;
        }]
      position:position];
  NSUInteger at = [_stored indexOfObjectPassingTest:^BOOL(ArdiaPVSegment *old, NSUInteger index, BOOL *stop) {
    return old->_start > segment->_start;
  }];
  [_stored insertObject:segment atIndex:at == NSNotFound ? _stored.count : at];
  if (_stored.count > kMaxStoredSegments) [self drop:[NSIndexSet indexSetWithIndexesInRange:NSMakeRange(0, _stored.count - kMaxStoredSegments)] position:position];
}

- (void)removeFrom:(double)start to:(double)end position:(double)position {
  [self drop:[_stored indexesOfObjectsPassingTest:^BOOL(ArdiaPVSegment *segment, NSUInteger index, BOOL *stop) {
          const double middle = (segment->_start + segment->_end) / 2;
          return middle >= start && middle < end;
        }]
      position:position];
}

- (void)evictBefore:(double)time position:(double)position {
  [self drop:[_stored indexesOfObjectsPassingTest:^BOOL(ArdiaPVSegment *segment, NSUInteger index, BOOL *stop) {
          return segment->_end < time && segment != self->_feed;
        }]
      position:position];
}

- (void)cueAt:(double)time {
  _feed = nil;
  _feedIndex = 0;
  ArdiaPVSegment *segment = [self containing:time];
  if (!segment) return;
  _feed = segment;
  if (!_video) return;
  const NSUInteger at = [_stored indexOfObjectIdenticalTo:segment];
  for (NSInteger i = (NSInteger)at; i >= 0 && i + 4 > (NSInteger)at; i--) {
    ArdiaPVSegment *candidate = _stored[i];
    NSInteger found = -1;
    for (NSUInteger k = 0; k < candidate->_samples.count; k++) {
      CMSampleBufferRef sample = (__bridge CMSampleBufferRef)candidate->_samples[k];
      if (IsSync(sample) && StartOf(sample) <= time + 1e-4) found = (NSInteger)k;
    }
    if (found >= 0) {
      _feed = candidate;
      _feedIndex = (NSUInteger)found;
      return;
    }
    if (i > 0 && fabs(candidate->_start - _stored[i - 1]->_end) >= kJoin) return;
  }
}

- (CMTime)upcomingFloor {
  CMTime floor = kCMTimeInvalid;
  ArdiaPVSegment *segment = _feed;
  NSUInteger index = _feedIndex, seen = 0;
  while (segment && seen < kUpcomingWindow) {
    if (index >= segment->_samples.count) {
      segment = [self following:segment];
      index = 0;
      continue;
    }
    const CMTime start = CMSampleBufferGetPresentationTimeStamp((__bridge CMSampleBufferRef)segment->_samples[index++]);
    if (!CMTIME_IS_NUMERIC(start)) return kCMTimeInvalid;
    if (!CMTIME_IS_NUMERIC(floor) || CMTimeCompare(start, floor) < 0) floor = start;
    seen++;
  }
  return seen == kUpcomingWindow ? floor : kCMTimeInvalid;
}

- (void)clear {
  [_renderer stopRequestingMediaData];
  _requesting = NO;
  [_stored removeAllObjects];
  [_enqueued removeAllObjects];
  _feed = nil;
  _feedIndex = 0;
  _dirty = NO;
  _blocked = NO;
  _from = 0;
  _promisedFloor = kCMTimeInvalid;
  if (_format) CFRelease(_format);
  _format = NULL;
}

- (NSString *)ranges {
  NSMutableArray *out = [NSMutableArray array];
  double start = NAN, end = NAN;
  for (ArdiaPVSegment *segment in _stored) {
    if (std::isfinite(end) && segment->_start <= end + kJoin) {
      end = MAX(end, segment->_end);
      continue;
    }
    if (std::isfinite(start)) [out addObject:[NSString stringWithFormat:@"%.1f-%.1f", start, end]];
    start = segment->_start;
    end = segment->_end;
  }
  if (std::isfinite(start)) [out addObject:[NSString stringWithFormat:@"%.1f-%.1f", start, end]];
  return [out componentsJoinedByString:@","];
}
@end

@implementation ArdiaPVKeySession
@end

@implementation ArdiaPVLayerView
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}

- (BOOL)isOpaque {
  return NO;
}
@end
