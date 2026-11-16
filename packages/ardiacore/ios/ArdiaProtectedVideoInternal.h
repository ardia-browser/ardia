#import "ArdiaProtectedVideo.h"
#import "ArdiaInternal.h"
#import "ArdiaRuntime.h"
#import "ArdiaTabRegistry.h"
#import "ArdiaWebViewInternal.h"

#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <CoreMedia/CoreMedia.h>
#import <QuartzCore/QuartzCore.h>

#include <climits>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <string>
#include <vector>

namespace ardia_protected_video {

constexpr NSUInteger kMaxPartChars = 62 * 1024;
constexpr NSInteger kMaxParts = 800;
constexpr NSUInteger kMaxUnitBytes = 32 * 1024 * 1024;
constexpr NSUInteger kMaxKeyData = 48 * 1024;
constexpr NSInteger kMaxBuffers = 8;
constexpr NSInteger kMaxKeySessions = 64;
constexpr NSUInteger kMaxStoredSegments = 4000;
constexpr NSUInteger kMaxStoredBytes = 320 * 1024 * 1024;
constexpr double kJoin = 0.3;
constexpr double kOverlap = 0.05;
constexpr NSUInteger kUpcomingWindow = 16;
constexpr NSInteger kChoppyMinimumFrames = 600;
constexpr NSInteger kChoppyDropShare = 20;
constexpr double kKeepBehind = 30;
constexpr double kResumeAhead = 1;
constexpr double kPictureInPictureDeadline = 3;
constexpr NSTimeInterval kTick = 0.25;
constexpr NSInteger kContentKeyTimedOut = -19152;
NSString *const kViewIdentifier = @"ardia.protectedVideo";
NSString *const kMirrorIdentifier = @"ardia.videoMirror";

void Trace(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
bool Tracing();
bool WholeNumber(NSDictionary *d, NSString *key, NSInteger low, NSInteger high, NSInteger *out);
bool Bounded(NSDictionary *d, NSString *key, double low, double high, double *out);
NSData *Base64(NSDictionary *d, NSString *key, NSUInteger maxChars);
NSString *Hex(NSData *data);
NSData *Unhex(NSString *text);
NSData *InitKeyID(NSData *init);
uint32_t InitTimescale(NSData *init);
int64_t FragmentDecodeTime(NSData *segment);
NSArray<NSData *> *FairPlayKeyIDs(NSData *pssh);
NSData *FairPlayPssh(NSData *cenc);
NSArray<NSData *> *SinfKeyIDs(NSData *json);
NSString *CodecsOf(NSString *mime);
NSArray *SingleSamples(CMSampleBufferRef buffer, double offset);
CMSampleBufferRef HiddenCopy(CMSampleBufferRef sample) CF_RETURNS_RETAINED;
double StartOf(CMSampleBufferRef sample);
double EndOf(CMSampleBufferRef sample);

}

@protocol ArdiaStreamDataParsing <NSObject>
- (void)setDelegate:(id)delegate;
- (void)appendStreamData:(NSData *)data;
- (void)providePendingMediaData;
@end

@interface ArdiaPVSegment : NSObject {
 @public
  NSArray *_samples;
  double _start;
  double _end;
  NSUInteger _bytes;
  NSData *_kid;
  NSInteger _serial;
}
@end

@interface ArdiaPVTrack : NSObject {
 @public
  NSInteger _buffer;
  BOOL _video;
  id<ArdiaStreamDataParsing> _parser;
  NSData *_init;
  NSData *_kid;
  uint32_t _timescale;
  NSMutableArray *_parsedVideo;
  NSMutableArray *_parsedAudio;
  NSString *_parseError;
  NSInteger _assemblySeq;
  NSInteger _assemblyNext;
  NSMutableData *_assembly;
}
- (BOOL)parse:(NSData *)unit;
@end

@interface ArdiaPVLane : NSObject {
 @public
  BOOL _video;
  id<AVQueuedSampleBufferRendering> _renderer;
  NSMutableArray<ArdiaPVSegment *> *_stored;
  ArdiaPVSegment *_feed;
  NSUInteger _feedIndex;
  double _from;
  BOOL _requesting;
  BOOL _dirty;
  BOOL _blocked;
  NSHashTable<ArdiaPVSegment *> *_enqueued;
  CMFormatDescriptionRef _format;
  CMTime _promisedFloor;
}
- (instancetype)initWithRenderer:(id<AVQueuedSampleBufferRendering>)renderer video:(BOOL)video;
- (ArdiaPVSegment *)containing:(double)time;
- (ArdiaPVSegment *)following:(ArdiaPVSegment *)tail;
- (double)endFrom:(double)time;
- (NSUInteger)bytes;
- (void)store:(ArdiaPVSegment *)segment position:(double)position;
- (void)removeFrom:(double)start to:(double)end position:(double)position;
- (void)evictBefore:(double)time position:(double)position;
- (void)cueAt:(double)time;
- (CMTime)upcomingFloor;
- (void)clear;
- (NSString *)ranges;
@end

@interface ArdiaPVKeySession : NSObject {
 @public
  NSString *_keySystem;
  BOOL _raw;
  BOOL _succeeded;
  NSData *_awaitingKid;
  NSMutableArray<NSDictionary *> *_rawQueue;
}
@end

@interface ArdiaPVLayerView : NSView
@end

@interface ArdiaPVSession : NSObject {
  __weak ArdiaCoreTab *_tab;
  NSString *_frame;
  dispatch_queue_t _keyQueue;
  AVContentKeySession *_keys;
  NSData *_certificate;
  NSMutableDictionary<NSNumber *, ArdiaPVKeySession *> *_keySessions;
  NSMutableDictionary<NSData *, NSNumber *> *_keyOwners;
  NSMutableDictionary<NSData *, AVContentKeyRequest *> *_keyRequests;
  NSMutableDictionary<NSData *, id> *_contentKeys;
  NSMutableArray<AVContentKeyRequest *> *_keyBatch;
  NSNumber *_lastKeySession;
  BOOL _flushQueued;
  NSInteger _media;
  NSMutableDictionary<NSNumber *, ArdiaPVTrack *> *_tracks;
  ArdiaPVLane *_videoLane;
  ArdiaPVLane *_audioLane;
  NSInteger _serials;
  BOOL _ended;
  BOOL _started;
  BOOL _stalled;
  double _pendingTarget;
  NSInteger _seekSeq;
  NSInteger _appliedSeq;
  BOOL _wantsPlay;
  double _rate;
  double _volume;
  BOOL _pageMuted;
  double _duration;
  AVSampleBufferRenderSynchronizer *_sync;
  AVSampleBufferDisplayLayer *_display;
  AVSampleBufferAudioRenderer *_audio;
  id _boundary;
  double _boundaryTime;
  id _audioFlushObserver;
  id _decodeFailureObserver;
  NSInteger _decodeFailures;
  ArdiaPVLayerView *_view;
  AVPictureInPictureController *_pip;
  BOOL _inPip;
  BOOL _pipReopening;
  BOOL _pipStopping;
  double _sizeChangeAt;
  BOOL _pipWanted;
  CFTimeInterval _pipAskedAt;
  NSInteger _pipRequest;
  CMTimeRange _tracedRange;
  __weak NSView *_pipPanel;
  id _pipPanelObserver;
  id<NSObject> _displayAwake;
  NSTimer *_ticker;
  BOOL _hasRect;
  NSRect _rect;
  double _coverTop;
  double _coverBottom;
  double _cornerRadius;
  NSColor *_backdrop;
  CAShapeLayer *_corners;
  double _scale;
  BOOL _rectVisible;
  BOOL _showing;
  BOOL _reportedPlaying;
  BOOL _played;
  BOOL _failed;
  BOOL _licenseFailed;
  BOOL _endedSent;
  NSTimeInterval _lastTrace;
  NSInteger _droppedFrames;
  NSInteger _rendererDropped;
  NSInteger _shownFrames;
  NSInteger _rendererFrames;
  BOOL _choppyReported;
}
- (instancetype)initWithTab:(ArdiaCoreTab *)tab frame:(NSString *)frameId;
- (void)handle:(NSDictionary *)message;
- (void)close;
- (void)muteChanged;
- (BOOL)active;
- (BOOL)plays;
@property(readonly) NSString *frame;
- (void)deliver:(NSDictionary *)event;
- (void)report:(NSDictionary *)payload;
- (void)failAt:(NSString *)step reason:(NSString *)reason;
- (void)attach:(NSInteger)media;
- (void)detach;
- (void)buffer:(NSDictionary *)message;
- (void)append:(NSDictionary *)message;
- (void)remove:(NSDictionary *)message;
- (void)seek:(NSDictionary *)message;
- (void)rect:(NSDictionary *)message;
@end

@interface ArdiaPVSession (Playback)
- (void)setUpRenderers;
- (void)keepDisplayAwake:(BOOL)awake;
- (void)tearDownRenderers;
- (void)resetPlayback;
- (NSArray<ArdiaPVLane *> *)lanes;
- (double)position;
- (double)bufferedEnd;
- (void)seekTo:(double)time;
- (void)lanesChanged;
- (void)keysChanged;
- (void)applyRate;
- (void)tick;
- (void)noteFrames:(NSInteger)total dropped:(NSInteger)dropped;
- (void)place;
@end

@interface ArdiaPVSession (PictureInPicture) <AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate>
- (void)preparePictureInPicture;
- (void)dropPictureInPicture;
- (BOOL)startPictureInPicture;
- (void)reconnectPictureInPicture;
- (void)exitPictureInPicture;
- (void)deliverPictureInPicture;
- (void)playbackStateChanged;
@end

@interface ArdiaPVSession (Keys) <AVContentKeySessionDelegate>
- (void)keyRequest:(NSDictionary *)message session:(NSInteger)session;
- (void)keyUpdate:(NSDictionary *)message session:(NSInteger)session;
- (NSData *)keyIDOf:(AVContentKeyRequest *)request;
- (void)addRenderersAsKeyRecipients;
- (void)flushKeyRequests;
- (void)askPage:(NSInteger)session for:(NSArray<AVContentKeyRequest *> *)requests;
@end
