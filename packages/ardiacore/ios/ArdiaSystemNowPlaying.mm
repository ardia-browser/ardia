#import "ArdiaHLSVideo.h"
#import "ArdiaInternal.h"
#import "ArdiaProtectedVideo.h"
#import "ArdiaWebViewInternal.h"

#import <MediaPlayer/MediaPlayer.h>

namespace {

constexpr NSUInteger kMaxArtworkBytes = 4 << 20;

__weak ArdiaWebView *gOwner;
NSDictionary *gPublished;
NSString *gArtworkURL;
MPMediaItemArtwork *gArtwork;

MPRemoteCommandHandlerStatus Forward(NSString *action, double seconds) {
  ArdiaWebView *owner = gOwner;
  if (!owner) return MPRemoteCommandHandlerStatusNoActionableNowPlayingItem;
  [owner mediaCommand:action seconds:seconds];
  [owner noteSystemNowPlayingCommand];
  return MPRemoteCommandHandlerStatusSuccess;
}

void InstallCommands() {
  static BOOL installed;
  if (installed) return;
  installed = YES;
  MPRemoteCommandCenter *center = MPRemoteCommandCenter.sharedCommandCenter;
  NSDictionary<NSString *, MPRemoteCommand *> *simple = @{
    @"play" : center.playCommand,
    @"pause" : center.pauseCommand,
    @"toggle" : center.togglePlayPauseCommand,
    @"next" : center.nextTrackCommand,
    @"previous" : center.previousTrackCommand,
  };
  [simple enumerateKeysAndObjectsUsingBlock:^(NSString *action, MPRemoteCommand *command, BOOL *) {
    [command addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *) {
      return Forward(action, 0);
    }];
  }];
  [center.changePlaybackPositionCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
    if (![event isKindOfClass:MPChangePlaybackPositionCommandEvent.class]) return MPRemoteCommandHandlerStatusCommandFailed;
    return Forward(@"seekTo", ((MPChangePlaybackPositionCommandEvent *)event).positionTime);
  }];
}

void EnableCommands(NSArray *actions, BOOL seekable) {
  MPRemoteCommandCenter *center = MPRemoteCommandCenter.sharedCommandCenter;
  center.playCommand.enabled = YES;
  center.pauseCommand.enabled = YES;
  center.togglePlayPauseCommand.enabled = YES;
  center.nextTrackCommand.enabled = [actions containsObject:@"nexttrack"];
  center.previousTrackCommand.enabled = [actions containsObject:@"previoustrack"];
  center.changePlaybackPositionCommand.enabled = seekable;
}

NSString *TextOf(NSDictionary *state, NSString *key) {
  return [state[key] isKindOfClass:NSString.class] ? state[key] : @"";
}

void Publish(NSDictionary *state) {
  const BOOL playing = [state[@"playbackState"] isEqual:@"playing"];
  double rate = [state[@"playbackRate"] isKindOfClass:NSNumber.class] ? [state[@"playbackRate"] doubleValue] : 1;
  if (!(rate > 0)) rate = 1;
  double position = [state[@"position"] isKindOfClass:NSNumber.class] ? [state[@"position"] doubleValue] : 0;
  const double timestamp = [state[@"timestamp"] isKindOfClass:NSNumber.class] ? [state[@"timestamp"] doubleValue] : 0;
  if (playing && timestamp > 0) position += MAX(0, NSDate.date.timeIntervalSince1970 * 1000 - timestamp) / 1000 * rate;
  const double duration = [state[@"duration"] isKindOfClass:NSNumber.class] ? [state[@"duration"] doubleValue] : 0;
  const BOOL timed = std::isfinite(duration) && duration > 0;
  NSMutableDictionary *info = [@{
    MPMediaItemPropertyTitle : TextOf(state, @"title"),
    MPMediaItemPropertyArtist : TextOf(state, @"artist"),
    MPMediaItemPropertyAlbumTitle : TextOf(state, @"album"),
    MPNowPlayingInfoPropertyMediaType : @(MPNowPlayingInfoMediaTypeVideo),
    MPNowPlayingInfoPropertyElapsedPlaybackTime : @(timed ? MIN(MAX(position, 0), duration) : MAX(position, 0)),
    MPNowPlayingInfoPropertyPlaybackRate : @(playing ? rate : 0),
    MPNowPlayingInfoPropertyDefaultPlaybackRate : @1,
  } mutableCopy];
  if (timed) info[MPMediaItemPropertyPlaybackDuration] = @(duration);
  if (gArtwork) info[MPMediaItemPropertyArtwork] = gArtwork;
  EnableCommands([state[@"actions"] isKindOfClass:NSArray.class] ? state[@"actions"] : @[], timed);
  MPNowPlayingInfoCenter *center = MPNowPlayingInfoCenter.defaultCenter;
  center.nowPlayingInfo = info;
  center.playbackState = playing ? MPNowPlayingPlaybackStatePlaying : MPNowPlayingPlaybackStatePaused;
  gPublished = [center.nowPlayingInfo copy];
}

void Withdraw() {
  gOwner = nil;
  gArtworkURL = nil;
  gArtwork = nil;
  MPNowPlayingInfoCenter *center = MPNowPlayingInfoCenter.defaultCenter;
  const BOOL stillOurs = gPublished && [center.nowPlayingInfo isEqualToDictionary:gPublished];
  gPublished = nil;
  if (!stillOurs) return;
  center.nowPlayingInfo = nil;
  center.playbackState = MPNowPlayingPlaybackStateStopped;
}

void FetchArtwork(NSString *url, NSString *profileName) {
  void (^done)(NSData *) = ^(NSData *data) {
    dispatch_async(dispatch_get_main_queue(), ^{
      ArdiaWebView *owner = gOwner;
      if (!owner || ![url isEqualToString:gArtworkURL] || !data.length || data.length > kMaxArtworkBytes) return;
      NSImage *image = [[NSImage alloc] initWithData:data];
      if (!image || image.size.width <= 0 || image.size.height <= 0) return;
      gArtwork = [[MPMediaItemArtwork alloc] initWithBoundsSize:image.size
                                                 requestHandler:^NSImage *(CGSize) {
                                                   return image;
                                                 }];
      [owner systemNowPlayingChanged];
    });
  };
  if ([url hasPrefix:@"data:image/"]) {
    NSURL *parsed = [NSURL URLWithString:url];
    return done(parsed ? [NSData dataWithContentsOfURL:parsed] : nil);
  }
  NSString *scheme = [NSURL URLWithString:url].scheme.lowercaseString;
  if (!([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"])) return;
  void (^fetch)(ArdiaCoreProfile *) = ^(ArdiaCoreProfile *profile) {
    if (!profile || profile.destroyed) return;
    [profile fetchIcon:url maxBytes:kMaxArtworkBytes completion:done];
  };
  if (ardia_host::IsPrivateProfile(profileName)) return fetch(ardia_host::LoadedProfile(profileName));
  ardia_host::WithProfile(profileName, fetch);
}

}

@implementation ArdiaWebView (SystemNowPlaying)

- (BOOL)playsNativeVideo {
  return [ArdiaHLSVideo activeInTab:_tab] || [ArdiaProtectedVideo activeInTab:_tab];
}

- (void)systemNowPlayingChanged {
  NSDictionary *state = _reports.nowPlaying.selected;
  NSString *playback = state[@"playbackState"];
  const BOOL shown = state && self.playsNativeVideo && ([playback isEqual:@"playing"] || [playback isEqual:@"paused"]);
  ArdiaWebView *owner = gOwner;
  if (!shown) {
    if (owner == self || (!owner && gPublished)) Withdraw();
    return;
  }
  if (owner && owner != self && ![playback isEqual:@"playing"]) return;
  if (owner != self) {
    gArtworkURL = nil;
    gArtwork = nil;
  }
  gOwner = self;
  InstallCommands();
  NSString *artwork = [state[@"artwork"] isKindOfClass:NSString.class] ? state[@"artwork"] : nil;
  if (!(artwork == gArtworkURL || [artwork isEqualToString:gArtworkURL])) {
    gArtworkURL = artwork;
    gArtwork = nil;
    if (artwork.length) FetchArtwork(artwork, _profile);
  }
  Publish(state);
}

- (void)withdrawSystemNowPlaying {
  ArdiaWebView *owner = gOwner;
  if (owner == self || (!owner && gPublished)) Withdraw();
}

- (void)noteSystemNowPlayingCommand {
  NSMutableDictionary *report = [@{@"event" : @"nowPlayingCommand", @"video" : @YES} mutableCopy];
  if ([ArdiaHLSVideo activeInTab:_tab]) report[@"site"] = @"youtube";
  [self emit:@"fairPlay" payload:report];
}

@end
