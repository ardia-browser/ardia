#import "ArdiaHLSVideoInternal.h"
#import "ArdiaLaunchConfig.h"

using namespace ardia_runtime;
using namespace ardia_web_view;

namespace ardia_hls_video {

bool Tracing() {
  static const bool tracing = [ArdiaLaunchConfig.shared traced:@"protectedVideo"];
  return tracing;
}

void Trace(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
void Trace(NSString *format, ...) {
  if (!Tracing()) return;
  va_list args;
  va_start(args, format);
  NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
  va_end(args);
  NSLog(@"[hlsVideo] %@", line);
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

NSData *Base64(NSDictionary *d, NSString *key) {
  NSString *text = Text(d, key, kMaxKeyChars);
  return text.length ? [[NSData alloc] initWithBase64EncodedString:text options:0] : nil;
}

bool AllowedURI(NSString *uri) {
  NSString *lower = uri.lowercaseString;
  return [lower hasPrefix:@"https://"] || [lower hasPrefix:kKeyScheme];
}

bool RemotePlaylist(NSString *playlist) {
  if (![playlist hasPrefix:@"#EXTM3U"]) return false;
  static NSRegularExpression *attribute = [NSRegularExpression regularExpressionWithPattern:@"URI=\"([^\"]*)\"" options:0 error:nil];
  for (NSString *raw in [playlist componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
    NSString *line = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if (!line.length) continue;
    if (![line hasPrefix:@"#"]) {
      if (!AllowedURI(line)) return false;
      continue;
    }
    for (NSTextCheckingResult *match in [attribute matchesInString:line options:0 range:NSMakeRange(0, line.length)])
      if (!AllowedURI([line substringWithRange:[match rangeAtIndex:1]])) return false;
  }
  return true;
}

NSData *LegacyInitData(NSString *keyURI) {
  NSData *uri = [keyURI dataUsingEncoding:NSUTF16LittleEndianStringEncoding];
  const uint32_t size = CFSwapInt32HostToLittle((uint32_t)uri.length);
  NSMutableData *data = [NSMutableData dataWithBytes:&size length:4];
  [data appendData:uri];
  return data;
}

bool ReadChunk(NSData *data, NSUInteger *at, NSData **out) {
  if (*at + 4 > data.length) return false;
  uint32_t size;
  [data getBytes:&size range:NSMakeRange(*at, 4)];
  size = CFSwapInt32LittleToHost(size);
  *at += 4;
  if (size > data.length - *at) return false;
  *out = [data subdataWithRange:NSMakeRange(*at, size)];
  *at += size;
  return true;
}

bool ParseSessionData(NSData *data, NSString **keyURI, NSData **contentId, NSData **certificate) {
  NSUInteger at = 0;
  NSData *uri, *content, *cert;
  if (!ReadChunk(data, &at, &uri) || !ReadChunk(data, &at, &content) || !ReadChunk(data, &at, &cert) || at != data.length) return false;
  NSString *text = [[NSString alloc] initWithData:uri encoding:NSUTF16LittleEndianStringEncoding];
  if (![text hasPrefix:kKeyScheme] || text.length > kMaxKeyURIChars || !content.length || !cert.length) return false;
  *keyURI = text;
  *contentId = content;
  *certificate = cert;
  return true;
}

double Seconds(CMTime time) {
  const double seconds = CMTIME_IS_NUMERIC(time) ? CMTimeGetSeconds(time) : NAN;
  return std::isfinite(seconds) ? seconds : NAN;
}

}

using namespace ardia_hls_video;

namespace {

BOOL gEnabled = NO;

}

@implementation ArdiaHLSLayerView

- (NSView *)hitTest:(NSPoint)point {
  return nil;
}

- (BOOL)isFlipped {
  return YES;
}

@end

@implementation ArdiaHLSPlaylistLoader {
  NSData *_playlist;
}

- (instancetype)initWithPlaylist:(NSData *)playlist media:(NSInteger)media {
  if ((self = [super init])) {
    _playlist = playlist;
    _url = [NSURL URLWithString:[NSString stringWithFormat:@"%@://master/%ld.m3u8", kPlaylistScheme, (long)media]];
  }
  return self;
}

- (BOOL)resourceLoader:(AVAssetResourceLoader *)resourceLoader shouldWaitForLoadingOfRequestedResource:(AVAssetResourceLoadingRequest *)request {
  if (![request.request.URL isEqual:_url]) return NO;
  if (AVAssetResourceLoadingContentInformationRequest *info = request.contentInformationRequest) {
    info.contentType = @"public.m3u-playlist";
    info.contentLength = (long long)_playlist.length;
    info.byteRangeAccessSupported = NO;
  }
  if (AVAssetResourceLoadingDataRequest *dataRequest = request.dataRequest) {
    const long long start = MIN(MAX(dataRequest.requestedOffset, 0LL), (long long)_playlist.length);
    const long long length = dataRequest.requestsAllDataToEndOfResource ? (long long)_playlist.length - start
                                                                          : MIN((long long)dataRequest.requestedLength, (long long)_playlist.length - start);
    [dataRequest respondWithData:[_playlist subdataWithRange:NSMakeRange((NSUInteger)start, (NSUInteger)length)]];
  }
  [request finishLoading];
  return YES;
}

@end

@implementation ArdiaHLSKeySession
@end

@implementation ArdiaHLSVideo

+ (NSMapTable<ArdiaCoreTab *, ArdiaHLSVideoSession *> *)sessions {
  static NSMapTable *sessions = [NSMapTable weakToStrongObjectsMapTable];
  return sessions;
}

+ (NSMapTable<ArdiaCoreTab *, NSDate *> *)reloads {
  static NSMapTable *reloads = [NSMapTable weakToStrongObjectsMapTable];
  return reloads;
}

+ (BOOL)enabled {
  return gEnabled;
}

+ (void)setEnabled:(BOOL)enabled {
  if (enabled == gEnabled) return;
  gEnabled = enabled;
  if (enabled) return;
  for (ArdiaHLSVideoSession *session in self.sessions.objectEnumerator.allObjects) [session close];
  [self.sessions removeAllObjects];
}

+ (BOOL)servesOrigin:(NSString *)origin {
  return [origin isEqualToString:kOrigin];
}

+ (void)helloFromTab:(ArdiaCoreTab *)tab origin:(NSString *)origin bridged:(BOOL)bridged {
  if (!tab || bridged == ArdiaProtectedVideo.enabled || ![self servesOrigin:origin]) return;
  NSDate *last = [self.reloads objectForKey:tab];
  if (last && -last.timeIntervalSinceNow < kReloadGap) return;
  [self.reloads setObject:NSDate.date forKey:tab];
  Trace(@"reload: the page started with the bridge %@", bridged ? @"on" : @"off");
  [tab reload];
}

+ (void)tab:(ArdiaCoreTab *)tab frame:(NSString *)frameId message:(NSDictionary *)message {
  if (!gEnabled || !tab || !frameId.length) return;
  ArdiaHLSVideoSession *session = [self.sessions objectForKey:tab];
  if (session && ![session.frame isEqualToString:frameId]) {
    [session close];
    session = nil;
  }
  if (!session) {
    session = [[ArdiaHLSVideoSession alloc] initWithTab:tab frame:frameId];
    [self.sessions setObject:session forKey:tab];
  }
  [session handle:message];
}

+ (void)pageGoneFromTab:(ArdiaCoreTab *)tab {
  if (!tab) return;
  ArdiaHLSVideoSession *session = [self.sessions objectForKey:tab];
  if (!session) return;
  [self.sessions removeObjectForKey:tab];
  [session close];
}

+ (void)muteChangedInTab:(ArdiaCoreTab *)tab {
  if (tab) [[self.sessions objectForKey:tab] muteChanged];
}

+ (BOOL)activeInTab:(ArdiaCoreTab *)tab {
  return tab && [[self.sessions objectForKey:tab] active];
}

+ (BOOL)playsInTab:(ArdiaCoreTab *)tab {
  return tab && [[self.sessions objectForKey:tab] plays];
}

+ (BOOL)startPictureInPictureInTab:(ArdiaCoreTab *)tab {
  return tab && [[self.sessions objectForKey:tab] startPictureInPicture];
}

+ (void)exitPictureInPictureInTab:(ArdiaCoreTab *)tab {
  if (tab) [[self.sessions objectForKey:tab] exitPictureInPicture];
}

@end
