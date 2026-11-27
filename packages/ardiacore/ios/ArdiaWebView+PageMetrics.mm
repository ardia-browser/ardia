#import "ArdiaWebViewInternal.h"
#import "ArdiaEvents.h"
#import "ArdiaPageMetricsMath.h"

namespace {

using ardia_page_metrics::Batch;
using ardia_page_metrics::Counts;
using ardia_page_metrics::kMediaErrorKinds;

NSString *const kMediaErrors[kMediaErrorKinds] = {@"media_errors_other", @"media_errors_aborted", @"media_errors_network", @"media_errors_decode", @"media_errors_unsupported"};
constexpr double kMostKept = ardia_page_metrics::kMostPerMessage * 100;

NSLock *MetricsLock() {
  static NSLock *lock = [[NSLock alloc] init];
  return lock;
}

NSMutableDictionary<NSString *, NSNumber *> *Metrics() {
  static NSMutableDictionary *metrics = [NSMutableDictionary dictionary];
  return metrics;
}

NSString *gGenerationEpoch;
uint32_t gGeneration = 0;
uint32_t gLastGeneration = 0;

uint32_t CurrentGenerationLocked() {
  NSString *epoch = ArdiaEvents.consentEpoch ?: @"";
  if (!gGenerationEpoch || ![gGenerationEpoch isEqualToString:epoch]) {
    gGenerationEpoch = [epoch copy];
    [Metrics() removeAllObjects];
    gGeneration = epoch.length ? (gLastGeneration = ardia_page_metrics::NextGeneration(gLastGeneration)) : 0;
  }
  return gGeneration;
}

NSString *GenerationJSON() {
  [MetricsLock() lock];
  const uint32_t generation = CurrentGenerationLocked();
  [MetricsLock() unlock];
  return [NSString stringWithFormat:@"{\"generation\":%u}", generation];
}

void WatchEpochChanges() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    [NSNotificationCenter.defaultCenter addObserverForName:ArdiaConsentEpochDidChangeNotification
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(NSNotification *) {
                                                  NSString *json = GenerationJSON();
                                                  for (ArdiaWebView *view in ardia_web_view::LiveViews().allObjects) [view callFrame:@"" kind:@"metricsGeneration" json:json];
                                                }];
  });
}

double NumberIn(id value) {
  return [value isKindOfClass:NSNumber.class] && value != (id)kCFBooleanTrue && value != (id)kCFBooleanFalse ? [value doubleValue] : NAN;
}

Batch BatchOf(NSDictionary *metrics) {
  Batch batch;
  batch.generation = NumberIn(metrics[@"generation"]);
  NSArray *errors = [metrics[@"errors"] isKindOfClass:NSArray.class] ? metrics[@"errors"] : @[];
  for (NSUInteger i = 0; i < MIN(errors.count, (NSUInteger)kMediaErrorKinds); i++) batch.errors[i] = NumberIn(errors[i]);
  batch.dropped = NumberIn(metrics[@"dropped"]);
  batch.frames = NumberIn(metrics[@"frames"]);
  batch.scrolls = NumberIn(metrics[@"scrolls"]);
  batch.scrollFrames = NumberIn(metrics[@"scrollFrames"]);
  batch.scrollMs = NumberIn(metrics[@"scrollMs"]);
  return batch;
}

void Add(NSString *key, double n) {
  if (n <= 0) return;
  NSMutableDictionary *metrics = Metrics();
  metrics[key] = @(std::min([metrics[key] doubleValue] + n, kMostKept));
}

NSString *DisplayBucket(NSWindow *window) {
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  NSString *rate = screen.maximumFramesPerSecond > 60 ? @"_120hz" : @"_60hz";
  return NSProcessInfo.processInfo.isLowPowerModeEnabled ? [rate stringByAppendingString:@"_low_power"] : rate;
}

}

@implementation ArdiaWebView (PageMetrics)

- (void)sendMetricsGenerationTo:(NSString *)frameId {
  WatchEpochChanges();
  [self callFrame:frameId kind:@"metricsGeneration" json:GenerationJSON()];
}

- (void)notePageMetrics:(NSDictionary *)metrics main:(BOOL)main {
  if (![metrics isKindOfClass:NSDictionary.class]) return;
  const Batch batch = BatchOf(metrics);
  NSString *bucket = DisplayBucket(self.window);
  [MetricsLock() lock];
  const Counts counts = ardia_page_metrics::Accept(main, CurrentGenerationLocked(), batch);
  if (counts.accepted) {
    for (int i = 0; i < kMediaErrorKinds; i++) Add(kMediaErrors[i], counts.errors[i]);
    Add([@"video_frames" stringByAppendingString:bucket], counts.frames);
    Add([@"video_frames_dropped" stringByAppendingString:bucket], counts.dropped);
    Add(@"scroll_bursts", counts.scrolls);
    Add([@"scroll_frames" stringByAppendingString:bucket], counts.scrollFrames);
    Add([@"scroll_ms" stringByAppendingString:bucket], counts.scrollMs);
  }
  [MetricsLock() unlock];
}

+ (NSDictionary<NSString *, NSNumber *> *)takePageMetrics {
  [MetricsLock() lock];
  CurrentGenerationLocked();
  NSDictionary *taken = [Metrics() copy];
  [Metrics() removeAllObjects];
  [MetricsLock() unlock];
  return taken;
}

@end
