#import "ArdiaFreezeWatch.h"
#import "ArdiaFreezeCapture.h"

#import <React/RCTBridge+Private.h>
#import <React/RCTBridgeModule.h>
#import <jsi/jsi.h>
#import <mach/mach_time.h>
#import <os/lock.h>
#import <pthread.h>

#include <algorithm>
#include <atomic>
#include <climits>
#include <cstring>

namespace {

namespace jsi = facebook::jsi;

constexpr double kStallMs = 250;
constexpr int kBucketCount = 6;
constexpr double kBucketFloorsMs[kBucketCount] = {250, 500, 1000, 2000, 5000, 10000};
constexpr double kInputWaitFloorMs = 50;
constexpr int kInputRing = 8;
constexpr int kMain = 0;
constexpr int kJs = 1;

struct StallTally {
  uint32_t buckets[kBucketCount];
  double longestMs;
  uint32_t inputWaits;
  double inputWaitMaxMs;
  uint32_t gcMeasured;
  double gcMs;
  double gcLongestMs;
  uint32_t gcBound;
};

struct LoopWatch {
  int thread = kMain;
  ardia_freeze::Stretch stretch;
  uint64_t epochAtStart = 0;
  double inputWaitMs = 0;
  int depth = 0;
  jsi::Runtime *runtime = nullptr;
  double gcAtStartMs = -1;
  double gcCountAtStart = -1;
  CFRunLoopObserverRef wake = nullptr;
  CFRunLoopObserverRef sleep = nullptr;
  CFRunLoopRef loop = nullptr;
};

LoopWatch gMain;
std::atomic<uint64_t> gEpoch{0};
os_unfair_lock gTallyLock = OS_UNFAIR_LOCK_INIT;
StallTally gTally[2];
std::atomic<double> gInputs[kInputRing];
std::atomic<uint32_t> gInputNext{0};
std::atomic<double> gJsBusySinceMs{0};
std::atomic<double> gJsFirstInputMs{-1};

double TicksToMs(uint64_t ticks) {
  static const double scale = [] {
    mach_timebase_info_data_t base;
    mach_timebase_info(&base);
    return (double)base.numer / base.denom / 1e6;
  }();
  return ticks * scale;
}

int BucketOf(double ms) {
  int bucket = 0;
  while (bucket + 1 < kBucketCount && ms >= kBucketFloorsMs[bucket + 1]) bucket++;
  return bucket;
}

struct GcReading {
  double ms = -1;
  double count = -1;
};

GcReading ReadGc(jsi::Runtime *runtime) {
  GcReading reading;
  if (!runtime) return reading;
  try {
    jsi::Runtime &rt = *runtime;
    jsi::Value internal = rt.global().getProperty(rt, "HermesInternal");
    if (!internal.isObject()) return reading;
    jsi::Object hermes = internal.getObject(rt);
    jsi::Value read = hermes.getProperty(rt, "getInstrumentedStats");
    if (!read.isObject() || !read.getObject(rt).isFunction(rt)) return reading;
    jsi::Value stats = read.getObject(rt).getFunction(rt).callWithThis(rt, hermes);
    if (!stats.isObject()) return reading;
    jsi::Object values = stats.getObject(rt);
    jsi::Value seconds = values.getProperty(rt, "js_gcTime");
    jsi::Value count = values.getProperty(rt, "js_numGCs");
    if (seconds.isNumber() && seconds.getNumber() >= 0) reading.ms = seconds.getNumber() * 1000;
    if (count.isNumber() && count.getNumber() >= 0) reading.count = count.getNumber();
  } catch (...) {
    return GcReading();
  }
  return reading;
}

double FirstInputWaitMs(double startMs, double endMs, double earliestMs) {
  double first = earliestMs >= startMs && earliestMs <= endMs ? earliestMs : -1;
  for (int i = 0; i < kInputRing; i++) {
    const double at = gInputs[i].load(std::memory_order_relaxed);
    if (at >= startMs && at <= endMs && (first < 0 || at < first)) first = at;
  }
  return first < 0 ? 0 : endMs - first;
}

void RecordStall(int thread, double ms, uint64_t epoch, double inputWaitMs, double gcMs) {
  os_unfair_lock_lock(&gTallyLock);
  if (epoch && epoch == gEpoch.load()) {
    StallTally &tally = gTally[thread];
    tally.buckets[BucketOf(ms)]++;
    tally.longestMs = std::max(tally.longestMs, ms);
    if (inputWaitMs >= kInputWaitFloorMs) {
      tally.inputWaits++;
      tally.inputWaitMaxMs = std::max(tally.inputWaitMaxMs, inputWaitMs);
    }
    if (gcMs >= 0) {
      tally.gcMeasured++;
      tally.gcMs += gcMs;
      tally.gcLongestMs = std::max(tally.gcLongestMs, gcMs);
      if (gcMs * 2 >= ms) tally.gcBound++;
    }
  }
  os_unfair_lock_unlock(&gTallyLock);
}

void LoopActivity(CFRunLoopObserverRef, CFRunLoopActivity activity, void *info) {
  LoopWatch &watch = *(LoopWatch *)info;
  if (activity == kCFRunLoopEntry) {
    watch.depth++;
    return;
  }
  if (activity == kCFRunLoopExit) {
    watch.depth--;
    return;
  }
  const uint64_t now = mach_absolute_time();
  const bool js = watch.thread == kJs;
  if (activity == kCFRunLoopAfterWaiting) {
    const uint64_t epoch = gEpoch.load(std::memory_order_relaxed);
    if (js) gJsFirstInputMs.store(-1, std::memory_order_relaxed);
    if (js) gJsBusySinceMs.store(TicksToMs(now), std::memory_order_relaxed);
    watch.stretch.id.fetch_add(1, std::memory_order_release);
    watch.stretch.start.store(now, std::memory_order_release);
    watch.epochAtStart = epoch;
    watch.inputWaitMs = 0;
    const GcReading gc = epoch && js && watch.depth == 1 ? ReadGc(watch.runtime) : GcReading();
    watch.gcAtStartMs = gc.ms;
    watch.gcCountAtStart = gc.count;
    ardia_freeze::Arm();
    return;
  }
  if (js) gJsBusySinceMs.store(0, std::memory_order_relaxed);
  const double earliestInputMs = js ? gJsFirstInputMs.exchange(-1, std::memory_order_relaxed) : -1;
  const uint64_t start = watch.stretch.start.exchange(0, std::memory_order_acq_rel);
  if (!start) return;
  ardia_freeze::Idle();
  const double ms = TicksToMs(now - start);
  if (ms < kStallMs) return;
  const double endMs = TicksToMs(now);
  const double inputWaitMs = js ? FirstInputWaitMs(TicksToMs(start), endMs, earliestInputMs) : watch.inputWaitMs;
  double gcMs = -1, gcCount = -1;
  if (js && watch.depth == 1 && watch.gcAtStartMs >= 0) {
    const GcReading gc = ReadGc(watch.runtime);
    if (gc.ms >= 0) gcMs = std::clamp(gc.ms - watch.gcAtStartMs, 0.0, ms);
    if (gc.count >= 0 && watch.gcCountAtStart >= 0) gcCount = std::max(0.0, gc.count - watch.gcCountAtStart);
  }
  RecordStall(watch.thread, ms, watch.epochAtStart, inputWaitMs, gcMs);
  ardia_freeze::StretchEnded({watch.thread, &watch.stretch, watch.stretch.id.load(std::memory_order_acquire), ms, inputWaitMs, gcMs, gcCount, watch.epochAtStart});
}

void Observe(LoopWatch &watch, CFRunLoopRef loop) {
  if (watch.loop) return;
  CFRunLoopObserverContext context = {0, &watch, nullptr, nullptr, nullptr};
  watch.wake = CFRunLoopObserverCreate(kCFAllocatorDefault, kCFRunLoopEntry | kCFRunLoopAfterWaiting, true, LONG_MIN, LoopActivity, &context);
  watch.sleep = CFRunLoopObserverCreate(kCFAllocatorDefault, kCFRunLoopBeforeWaiting | kCFRunLoopExit, true, LONG_MAX, LoopActivity, &context);
  watch.loop = (CFRunLoopRef)CFRetain(loop);
  watch.depth = 1;
  CFRunLoopAddObserver(loop, watch.wake, kCFRunLoopCommonModes);
  CFRunLoopAddObserver(loop, watch.sleep, kCFRunLoopCommonModes);
  ardia_freeze::Watch(watch.thread, pthread_self(), &watch.stretch);
}

void StopObserving(LoopWatch &watch) {
  if (!watch.loop) return;
  ardia_freeze::Unwatch(watch.thread, &watch.stretch);
  CFRunLoopRemoveObserver(watch.loop, watch.wake, kCFRunLoopCommonModes);
  CFRunLoopRemoveObserver(watch.loop, watch.sleep, kCFRunLoopCommonModes);
  CFRunLoopObserverInvalidate(watch.wake);
  CFRunLoopObserverInvalidate(watch.sleep);
  CFRelease(watch.wake);
  CFRelease(watch.sleep);
  CFRelease(watch.loop);
  watch.wake = watch.sleep = nullptr;
  watch.loop = nullptr;
  watch.runtime = nullptr;
  watch.stretch.start = 0;
}

bool OnJsThread() {
  char name[64] = {0};
  return pthread_getname_np(pthread_self(), name, sizeof name) == 0 && strcmp(name, "com.facebook.react.JavaScript") == 0;
}

NSDictionary *Describe(const StallTally &tally) {
  NSMutableArray *buckets = [NSMutableArray arrayWithCapacity:kBucketCount];
  for (int i = 0; i < kBucketCount; i++) [buckets addObject:@(tally.buckets[i])];
  return @{
    @"buckets" : buckets,
    @"longestMs" : @(round(tally.longestMs)),
    @"inputWaits" : @(tally.inputWaits),
    @"inputWaitMaxMs" : @(round(tally.inputWaitMaxMs)),
    @"gcMeasured" : @(tally.gcMeasured),
    @"gcMs" : @(round(tally.gcMs)),
    @"gcLongestMs" : @(round(tally.gcLongestMs)),
    @"gcBound" : @(tally.gcBound),
  };
}

}

void ArdiaFreezeNoteInput(NSTimeInterval eventUptime) {
  const double eventMs = eventUptime * 1000;
  const double jsBusySinceMs = gJsBusySinceMs.load(std::memory_order_relaxed);
  double noInputYet = -1;
  if (jsBusySinceMs > 0 && eventMs >= jsBusySinceMs) gJsFirstInputMs.compare_exchange_strong(noInputYet, eventMs, std::memory_order_relaxed);
  gInputs[gInputNext.fetch_add(1, std::memory_order_relaxed) % kInputRing].store(eventMs, std::memory_order_relaxed);
  if (!pthread_main_np() || !gMain.stretch.start.load(std::memory_order_relaxed)) return;
  gMain.inputWaitMs = std::max(gMain.inputWaitMs, TicksToMs(mach_absolute_time()) - eventMs);
}

@interface ArdiaFreezeWatchModule : NSObject <RCTBridgeModule, RCTInvalidating>
@end

@implementation ArdiaFreezeWatchModule {
  LoopWatch *_js;
}

@synthesize bridge = _bridge;

RCT_EXPORT_MODULE(ACFreezeWatch)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (dispatch_queue_t)methodQueue {
  return RCTJSThread;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(start) {
  if (_js || !OnJsThread()) return @NO;
  _js = new LoopWatch();
  _js->thread = kJs;
  RCTBridge *bridge = _bridge;
  if ([bridge respondsToSelector:@selector(runtime)]) _js->runtime = (jsi::Runtime *)((RCTCxxBridge *)bridge).runtime;
  Observe(*_js, CFRunLoopGetCurrent());
  __weak RCTBridge *weakBridge = bridge;
  ardia_freeze::SetEmitter(^(NSDictionary *record) {
    [weakBridge enqueueJSCall:@"RCTDeviceEventEmitter" method:@"emit" args:@[ @"ardiaFreeze", record ] completion:NULL];
  });
  dispatch_async(dispatch_get_main_queue(), ^{
    Observe(gMain, CFRunLoopGetMain());
  });
  return @YES;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(setConsentEpoch : (double)epoch) {
  os_unfair_lock_lock(&gTallyLock);
  gEpoch = epoch > 0 ? (uint64_t)epoch : 0;
  std::memset(gTally, 0, sizeof gTally);
  os_unfair_lock_unlock(&gTallyLock);
  return @YES;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(take : (double)epoch) {
  os_unfair_lock_lock(&gTallyLock);
  if (epoch <= 0 || (uint64_t)epoch != gEpoch.load()) {
    os_unfair_lock_unlock(&gTallyLock);
    return nil;
  }
  const StallTally main = gTally[kMain], js = gTally[kJs];
  std::memset(gTally, 0, sizeof gTally);
  os_unfair_lock_unlock(&gTallyLock);
  return @{@"main" : Describe(main), @"js" : Describe(js)};
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(annotate : (double)freezeId activity : (NSString *)activity) {
  if (freezeId > 0) ardia_freeze::Annotate((uint64_t)freezeId, activity);
  return @YES;
}

- (void)invalidate {
  LoopWatch *js = _js;
  _js = nullptr;
  if (!js) return;
  if (!js->loop || CFRunLoopGetCurrent() == js->loop) {
    StopObserving(*js);
    delete js;
    return;
  }
  CFRunLoopRef loop = js->loop;
  CFRunLoopPerformBlock(loop, kCFRunLoopCommonModes, ^{
    StopObserving(*js);
    delete js;
  });
  CFRunLoopWakeUp(loop);
}

@end
