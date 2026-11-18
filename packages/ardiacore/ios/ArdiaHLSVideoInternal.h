#import "ArdiaHLSVideo.h"
#import "ArdiaInternal.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaProtectedVideo.h"
#import "ArdiaRuntime.h"
#import "ArdiaTabRegistry.h"
#import "ArdiaWebViewInternal.h"

#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <CoreMedia/CoreMedia.h>
#import <QuartzCore/QuartzCore.h>

#include <climits>
#include <cmath>

namespace ardia_hls_video {

constexpr NSUInteger kMaxPartChars = 32 * 1024;
constexpr NSInteger kMaxParts = 40;
constexpr NSUInteger kMaxKeyChars = 64 * 1024;
constexpr NSUInteger kMaxKeyData = 45000;
constexpr NSInteger kMaxKeySessions = 64;
constexpr NSUInteger kMaxKeyURIChars = 4096;
constexpr NSTimeInterval kTick = 0.25;
constexpr NSTimeInterval kReloadGap = 5;
constexpr double kPictureInPictureDeadline = 3;
NSString *const kViewIdentifier = @"ardia.protectedVideo";
NSString *const kMirrorIdentifier = @"ardia.videoMirror";
NSString *const kPlaylistScheme = @"ardia-hls";
NSString *const kKeyScheme = @"skd://";
NSString *const kOrigin = @"https://www.youtube.com";

void Trace(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
bool Tracing();
bool Tracing();
bool WholeNumber(NSDictionary *d, NSString *key, NSInteger low, NSInteger high, NSInteger *out);
bool Bounded(NSDictionary *d, NSString *key, double low, double high, double *out);
NSData *Base64(NSDictionary *d, NSString *key);
bool AllowedURI(NSString *uri);
bool RemotePlaylist(NSString *playlist);
NSData *LegacyInitData(NSString *keyURI);
bool ReadChunk(NSData *data, NSUInteger *at, NSData **out);
bool ParseSessionData(NSData *data, NSString **keyURI, NSData **contentId, NSData **certificate);
double Seconds(CMTime time);

}

@interface ArdiaHLSLayerView : NSView
@end

@interface ArdiaHLSPlaylistLoader : NSObject <AVAssetResourceLoaderDelegate>
@property(readonly) NSURL *url;
- (instancetype)initWithPlaylist:(NSData *)playlist media:(NSInteger)media;
@end

@interface ArdiaHLSKeySession : NSObject {
 @public
  NSString *_keyURI;
  NSData *_contentId;
  NSData *_certificate;
  AVContentKeyRequest *_awaiting;
  BOOL _succeeded;
}
@end

@interface ArdiaHLSVideoSession : NSObject <AVContentKeySessionDelegate, AVPictureInPictureControllerDelegate>
{
 @public
  __weak ArdiaCoreTab *_tab;
  dispatch_queue_t _keyQueue;
  AVContentKeySession *_keys;
  NSMutableDictionary<NSNumber *, ArdiaHLSKeySession *> *_keySessions;
  NSMutableDictionary<NSString *, AVContentKeyRequest *> *_keyRequests;
  NSMutableDictionary<NSString *, NSNumber *> *_keyOwners;
  NSInteger _media;
  NSInteger _partsMedia;
  NSInteger _partsExpected;
  NSMutableString *_parts;
  ArdiaHLSPlaylistLoader *_loader;
  AVURLAsset *_asset;
  AVPlayerItem *_item;
  AVPlayer *_player;
  AVPlayerLayer *_layer;
  ArdiaHLSLayerView *_view;
  AVPictureInPictureController *_pip;
  id _endObserver;
  id _failObserver;
  NSTimer *_ticker;
  BOOL _ready;
  BOOL _wantsPlay;
  BOOL _holding;
  BOOL _hasPendingSeek;
  double _pendingSeek;
  NSInteger _pendingSeq;
  NSInteger _seekSeq;
  NSInteger _appliedSeq;
  double _rate;
  double _volume;
  BOOL _pageMuted;
  BOOL _endedSent;
  BOOL _failed;
  BOOL _played;
  BOOL _licenseFailed;
  BOOL _reportedPlaying;
  BOOL _showing;
  BOOL _hasRect;
  NSRect _rect;
  double _coverTop;
  double _coverBottom;
  double _cornerRadius;
  NSColor *_backdrop;
  CAShapeLayer *_corners;
  double _scale;
  BOOL _rectVisible;
  BOOL _inPip;
  BOOL _pipWanted;
  BOOL _pipStopping;
  NSInteger _pipRequest;
  CFTimeInterval _pipAskedAt;
  NSTimeInterval _lastTrace;
}
@property(readonly) NSString *frame;
- (instancetype)initWithTab:(ArdiaCoreTab *)tab frame:(NSString *)frameId;
- (void)handle:(NSDictionary *)message;
- (void)close;
- (void)muteChanged;
- (BOOL)active;
- (BOOL)plays;
- (BOOL)startPictureInPicture;
- (void)exitPictureInPicture;
- (void)deliver:(NSDictionary *)event;
- (void)report:(NSDictionary *)payload;
- (void)place;
@end

@interface ArdiaHLSVideoSession (Keys)
- (void)openKeySession:(NSInteger)session data:(NSData *)data;
- (void)updateKeySession:(NSInteger)session data:(NSData *)data;
- (void)closeKeySession:(NSInteger)session;
@end

@interface ArdiaHLSVideoSession (PictureInPicture)
- (void)preparePictureInPicture;
- (void)dropPictureInPicture;
- (void)deliverPictureInPicture;
@end
