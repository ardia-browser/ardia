#import "ArdiaFreezeCapture.h"
#import "ArdiaFreezeArming.h"

#import <AppKit/AppKit.h>
#import "ArdiaEvents.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaStackSample.h"

#include <algorithm>
#include <cstring>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach/mach_time.h>
#include <os/lock.h>
#include <sys/time.h>
#include <unistd.h>

namespace ardia_freeze {
namespace {

constexpr double kFreezeMs = 400;
constexpr double kSampleGapMs = 100;
constexpr int kSamples = 3;
constexpr double kWriteAtMs = 2000;
constexpr int kSlots = 20;
constexpr int kSlotBytes = 4096;
constexpr int kSlotTail = 640;
constexpr int kMaxImages = 6;
constexpr int kKept = 4;
const char *const kOwnImages[] = {"Ardia", "Ardia.debug.dylib", "Chromium Framework", "hermes"};
const char *const kThreadNames[kThreadCount] = {"main", "js"};

struct Image {
  char name[32];
  uint64_t low;
  uint64_t high;
  char uuid[37];
};

struct Capture {
  bool active;
  const Stretch *source;
  uint64_t stretch;
  uint64_t start;
  double startedMs;
  int thread;
  int attempts;
  int count;
  bool written;
  int slot;
  uint64_t seq;
  int thermal;
  double durationMs;
  double inputWaitMs;
  double gcMs;
  double gcCount;
  char activity[25];
  char consent[48];
  ArdiaStackSample samples[kSamples];
};

dispatch_queue_t gFireQueue;
dispatch_queue_t gWorkQueue;
dispatch_source_t gTimer;
os_unfair_lock gWatchLock = OS_UNFAIR_LOCK_INIT;
os_unfair_lock gCaptureLock = OS_UNFAIR_LOCK_INIT;
std::atomic<bool> gActive{false};
std::atomic<bool> gReady{false};
std::atomic<int> gThermal{0};
const Stretch *gStretches[kThreadCount];
ArdiaSampledThread gSampled[kThreadCount];
bool gWatched[kThreadCount];
Capture gCaptures[kThreadCount];
Capture gKept[kKept];
int gKeptNext;
Image gImages[kMaxImages];
int gImageCount;
uint64_t gCacheLow, gCacheHigh;
int gFd = -1;
int gNextSlot;
uint64_t gSeq;
char gBuffer[kSlotBytes];
void (^gEmit)(NSDictionary *);
id gActiveObservers[3];

uint64_t MsToTicks(double ms) {
  static const double perMs = [] {
    mach_timebase_info_data_t base;
    mach_timebase_info(&base);
    return 1e6 * base.denom / base.numer;
  }();
  return (uint64_t)(ms * perMs);
}

double TicksToMs(uint64_t ticks) {
  return ticks / (double)MsToTicks(1);
}

double WallMs() {
  struct timeval now;
  gettimeofday(&now, nullptr);
  return now.tv_sec * 1000.0 + now.tv_usec / 1000;
}

void FormatUuid(const uint8_t *bytes, char *out) {
  static const char hex[] = "0123456789abcdef";
  int o = 0;
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out[o++] = '-';
    out[o++] = hex[bytes[i] >> 4];
    out[o++] = hex[bytes[i] & 15];
  }
  out[o] = 0;
}

bool TextRange(const mach_header_64 *header, uint64_t *low, uint64_t *high, char *uuid) {
  if (!header || header->magic != MH_MAGIC_64) return false;
  *low = *high = 0;
  if (uuid) uuid[0] = 0;
  const uint8_t *command = (const uint8_t *)(header + 1);
  for (uint32_t c = 0; c < header->ncmds; c++) {
    const auto *load = (const load_command *)command;
    if (load->cmd == LC_SEGMENT_64 && strcmp(((const segment_command_64 *)load)->segname, "__TEXT") == 0) {
      *low = (uint64_t)header;
      *high = *low + ((const segment_command_64 *)load)->vmsize;
    } else if (load->cmd == LC_UUID && uuid) {
      FormatUuid(((const uuid_command *)load)->uuid, uuid);
    }
    command += load->cmdsize;
  }
  return *high > *low;
}

void LoadImages() {
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *path = _dyld_get_image_name(i);
    if (!path) continue;
    const auto *header = (const mach_header_64 *)_dyld_get_image_header(i);
    if (strncmp(path, "/System/", 8) == 0 || strncmp(path, "/usr/lib/", 9) == 0) {
      uint64_t low, high;
      if (TextRange(header, &low, &high, nullptr)) {
        gCacheLow = gCacheLow ? std::min(gCacheLow, low) : low;
        gCacheHigh = std::max(gCacheHigh, high);
      }
      continue;
    }
    const char *slash = strrchr(path, '/');
    const char *base = slash ? slash + 1 : path;
    if (gImageCount >= kMaxImages || std::none_of(std::begin(kOwnImages), std::end(kOwnImages), [&](const char *own) { return strcmp(own, base) == 0; })) continue;
    Image image = {};
    strlcpy(image.name, base, sizeof image.name);
    if (TextRange(header, &image.low, &image.high, image.uuid) && image.uuid[0]) gImages[gImageCount++] = image;
  }
}

int ImageOf(uint64_t pc, uint64_t *offset) {
  for (int i = 0; i < gImageCount; i++)
    if (pc >= gImages[i].low && pc < gImages[i].high) {
      *offset = pc - gImages[i].low;
      return i;
    }
  if (pc >= gCacheLow && pc < gCacheHigh) {
    *offset = pc - gCacheLow;
    return -1;
  }
  *offset = 0;
  return -2;
}

const char *ImageName(int image) {
  return image >= 0 ? gImages[image].name : image == -1 ? "system" : "other";
}

struct Text {
  char *out;
  int size;
  int used = 0;
  void put(const char *s) {
    while (*s && used < size - 1) out[used++] = *s++;
  }
  void num(uint64_t n) {
    char digits[24];
    int d = 0;
    do digits[d++] = (char)('0' + n % 10);
    while ((n /= 10) && d < 24);
    while (d && used < size - 1) out[used++] = digits[--d];
  }
  void hex(uint64_t n) {
    static const char hexDigits[] = "0123456789abcdef";
    char digits[17];
    int d = 0;
    do digits[d++] = hexDigits[n & 15];
    while ((n >>= 4) && d < 16);
    put("0x");
    while (d && used < size - 1) out[used++] = digits[--d];
  }
};

void WriteSlot(const Capture &c) {
  if (gFd < 0) return;
  Text t{gBuffer, kSlotBytes};
  t.put("freeze ");
  t.num(c.seq);
  t.put(" ");
  t.put(kThreadNames[c.thread]);
  t.put(c.durationMs > 0 ? " recovered\n" : " frozen\n");
  t.put("started_ms ");
  t.num((uint64_t)c.startedMs);
  t.put("\nduration_ms ");
  t.num((uint64_t)(c.durationMs > 0 ? c.durationMs : kWriteAtMs));
  t.put("\ninput_wait_ms ");
  t.num((uint64_t)c.inputWaitMs);
  t.put("\ngc_ms ");
  if (c.gcMs >= 0) t.num((uint64_t)c.gcMs);
  else t.put("unknown");
  t.put("\nactivity ");
  t.put(c.activity[0] ? c.activity : "none");
  t.put("\nthermal ");
  t.num((uint64_t)c.thermal);
  t.put("\n");
  bool used[kMaxImages] = {};
  for (int s = 0; s < c.count && t.used < kSlotBytes - kSlotTail; s++) {
    t.put("sample ");
    t.num((uint64_t)s + 1);
    t.put(" state ");
    t.num((uint64_t)std::max(0, (int)c.samples[s].runState));
    t.put("\n");
    for (uint32_t f = 0; f < c.samples[s].count && t.used < kSlotBytes - kSlotTail; f++) {
      uint64_t offset;
      const int image = ImageOf(c.samples[s].frames[f], &offset);
      if (image >= 0) used[image] = true;
      t.put("  ");
      t.put(ImageName(image));
      t.put(" +");
      t.hex(offset);
      t.put("\n");
    }
  }
  for (int i = 0; i < gImageCount; i++)
    if (used[i]) {
      t.put("image ");
      t.put(gImages[i].name);
      t.put(" ");
      t.put(gImages[i].uuid);
      t.put("\n");
    }
  t.put("end\n");
  while (t.used < kSlotBytes - 1) gBuffer[t.used++] = ' ';
  gBuffer[kSlotBytes - 1] = '\n';
  pwrite(gFd, gBuffer, kSlotBytes, (off_t)c.slot * kSlotBytes);
}

void OpenRecords() {
  NSString *dir = ArdiaLaunchConfig.shared.dataDirectory;
  if (!dir) {
    NSURL *support = [NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:nil];
    dir = [support URLByAppendingPathComponent:NSBundle.mainBundle.bundleIdentifier ?: @"Ardia"].path;
  }
  if (!dir) return;
  [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *path = [dir stringByAppendingPathComponent:@"freezes.txt"];
  NSData *existing = [NSData dataWithContentsOfFile:path];
  gFd = open(path.fileSystemRepresentation, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (gFd < 0) return;
  uint64_t newest = 0;
  for (int slot = 0; slot < kSlots && (slot + 1) * kSlotBytes <= (int)existing.length; slot++) {
    const char *text = (const char *)existing.bytes + slot * kSlotBytes;
    if (strncmp(text, "freeze ", 7) != 0) continue;
    const uint64_t seq = strtoull(text + 7, nullptr, 10);
    if (seq > newest) {
      newest = seq;
      gNextSlot = (slot + 1) % kSlots;
    }
  }
  gSeq = newest;
}

void SetTimer(void *, uint64_t due) {
  if (!due) {
    dispatch_source_set_timer(gTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
    return;
  }
  const uint64_t now = mach_absolute_time();
  const int64_t ns = due > now ? (int64_t)(TicksToMs(due - now) * 1e6) : 0;
  dispatch_source_set_timer(gTimer, dispatch_time(DISPATCH_TIME_NOW, ns), DISPATCH_TIME_FOREVER, 20 * NSEC_PER_MSEC);
}

FreezeArming<> gArming(&SetTimer, nullptr);

void Begin(Capture &c, int thread, const Stretch *source, uint64_t stretch, uint64_t start) {
  if (c.active) gArming.captureEnded();
  c = {};
  c.active = true;
  c.source = source;
  c.thread = thread;
  c.stretch = stretch;
  c.start = start;
  c.startedMs = WallMs() - TicksToMs(mach_absolute_time() - start);
  c.gcMs = -1;
  c.gcCount = -1;
  c.thermal = gThermal.load(std::memory_order_relaxed);
  strlcpy(c.consent, ArdiaEvents.consentEpoch.UTF8String ?: "", sizeof c.consent);
  c.seq = ++gSeq;
  c.slot = gNextSlot;
  gNextSlot = (gNextSlot + 1) % kSlots;
  gArming.captureBegan();
}

void Clear(Capture &c) {
  if (c.active) gArming.captureEnded();
  c = {};
}

void Fire() {
  gArming.fired();
  if (!gReady.load()) return;
  uint64_t next = UINT64_MAX;
  bool debugger = false, checkedDebugger = false;
  uint64_t writeSeq[kThreadCount] = {};
  os_unfair_lock_lock(&gWatchLock);
  for (int t = 0; t < kThreadCount; t++) {
    if (!gWatched[t]) continue;
    const Stretch *source = gStretches[t];
    const uint64_t id = source->id.load(std::memory_order_acquire);
    const uint64_t start = source->start.load(std::memory_order_acquire);
    if (!start || id != source->id.load(std::memory_order_acquire)) continue;
    const uint64_t now = mach_absolute_time();
    if (now - start < MsToTicks(kFreezeMs)) {
      next = std::min(next, start + MsToTicks(kFreezeMs));
      continue;
    }
    os_unfair_lock_lock(&gCaptureLock);
    Capture &c = gCaptures[t];
    if (!c.active || c.stretch != id || c.source != source) {
      if (gActive.load()) Begin(c, t, source, id, start);
    }
    if (c.active && c.stretch == id && c.source == source) {
      if (c.attempts < kSamples) {
        if (!checkedDebugger) debugger = ArdiaDebuggerAttached(), checkedDebugger = true;
        c.attempts = debugger ? kSamples : c.attempts + 1;
        if (!debugger && ArdiaStackSampleTake(&gSampled[t], &c.samples[c.count]) && source->id.load(std::memory_order_acquire) == id &&
            source->start.load(std::memory_order_acquire))
          c.count++;
        if (c.attempts < kSamples) next = std::min(next, now + MsToTicks(kSampleGapMs));
      }
      if (!c.written) {
        if (now - start >= MsToTicks(kWriteAtMs)) writeSeq[t] = c.seq;
        else next = std::min(next, start + MsToTicks(kWriteAtMs));
      }
    }
    os_unfair_lock_unlock(&gCaptureLock);
  }
  os_unfair_lock_unlock(&gWatchLock);
  for (int t = 0; t < kThreadCount; t++) {
    if (!writeSeq[t]) continue;
    os_unfair_lock_lock(&gCaptureLock);
    Capture &c = gCaptures[t];
    if (c.active && c.seq == writeSeq[t] && !c.written) {
      WriteSlot(c);
      c.written = true;
    }
    os_unfair_lock_unlock(&gCaptureLock);
  }
  if (next != UINT64_MAX) gArming.armAt(next);
}

NSDictionary *Describe(const Capture &c) {
  NSMutableArray *samples = [NSMutableArray array];
  bool used[kMaxImages] = {};
  for (int s = 0; s < c.count; s++) {
    NSMutableArray *frames = [NSMutableArray array];
    for (uint32_t f = 0; f < c.samples[s].count; f++) {
      uint64_t offset;
      const int image = ImageOf(c.samples[s].frames[f], &offset);
      if (image >= 0) used[image] = true;
      [frames addObject:@{@"image" : @(ImageName(image)), @"offset" : @(offset)}];
    }
    [samples addObject:@{@"state" : @(c.samples[s].runState), @"frames" : frames}];
  }
  NSMutableArray *images = [NSMutableArray array];
  for (int i = 0; i < gImageCount; i++)
    if (used[i]) [images addObject:@{@"name" : @(gImages[i].name), @"uuid" : @(gImages[i].uuid)}];
  return @{
    @"id" : @(c.seq),
    @"thread" : @(kThreadNames[c.thread]),
    @"startedAt" : @(round(c.startedMs)),
    @"durationMs" : @(round(c.durationMs)),
    @"inputWaitMs" : @(round(c.inputWaitMs)),
    @"gcMs" : @(c.gcMs >= 0 ? round(c.gcMs) : -1),
    @"gcCount" : @(c.gcCount),
    @"thermal" : @(c.thermal),
    @"samples" : samples,
    @"images" : images,
  };
}

void Finish(const Ended &ended, Capture done) {
  done.durationMs = std::max(ended.ms, 1.0);
  done.inputWaitMs = ended.inputWaitMs;
  done.gcMs = ended.gcMs;
  done.gcCount = ended.gcCount;
  os_unfair_lock_lock(&gCaptureLock);
  WriteSlot(done);
  gKept[gKeptNext] = done;
  gKeptNext = (gKeptNext + 1) % kKept;
  os_unfair_lock_unlock(&gCaptureLock);
  gArming.disarmIfIdle();
  NSMutableDictionary *record = [Describe(done) mutableCopy];
  record[@"watchEpoch"] = @(ended.epoch);
  if (gEmit) gEmit([[[ArdiaConsentStamp alloc] initWithEpoch:@(done.consent)] onto:record]);
}

void WatchActivation() {
  const bool actedOut = [ArdiaLaunchConfig.shared testFlag:@"freezeWatchActive"];
  gActive = actedOut || NSApp.isActive;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  gActiveObservers[0] = [center addObserverForName:NSApplicationDidBecomeActiveNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    gActive = true;
  }];
  gActiveObservers[1] = [center addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    gActive = actedOut;
  }];
  gThermal = (int)NSProcessInfo.processInfo.thermalState;
  gActiveObservers[2] = [center addObserverForName:NSProcessInfoThermalStateDidChangeNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    gThermal = (int)NSProcessInfo.processInfo.thermalState;
  }];
}

void Setup() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    dispatch_queue_attr_t utility = dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_UTILITY, 0);
    gFireQueue = dispatch_queue_create("ardia.freeze-watch.fire", utility);
    gWorkQueue = dispatch_queue_create("ardia.freeze-watch.work", utility);
    gTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gFireQueue);
    dispatch_source_set_event_handler(gTimer, ^{
      Fire();
    });
    dispatch_source_set_timer(gTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
    dispatch_resume(gTimer);
    dispatch_async(gWorkQueue, ^{
      LoadImages();
      os_unfair_lock_lock(&gCaptureLock);
      OpenRecords();
      os_unfair_lock_unlock(&gCaptureLock);
      gReady = true;
    });
  });
}

}

void Watch(int thread, pthread_t pthread, const Stretch *stretch) {
  Setup();
  ArdiaSampledThread sampled = {};
  const bool ok = stretch && ArdiaSampledThreadInit(&sampled, pthread);
  if (ok) mach_port_mod_refs(mach_task_self(), sampled.port, MACH_PORT_RIGHT_SEND, 1);
  if (thread == 0 && ok) dispatch_async(dispatch_get_main_queue(), ^{
    WatchActivation();
  });
  mach_port_t released = MACH_PORT_NULL;
  os_unfair_lock_lock(&gWatchLock);
  if (gWatched[thread]) released = gSampled[thread].port;
  gWatched[thread] = ok;
  gSampled[thread] = sampled;
  gStretches[thread] = ok ? stretch : nullptr;
  os_unfair_lock_lock(&gCaptureLock);
  Clear(gCaptures[thread]);
  os_unfair_lock_unlock(&gCaptureLock);
  os_unfair_lock_unlock(&gWatchLock);
  if (released != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), released);
}

void Unwatch(int thread, const Stretch *stretch) {
  if (!gFireQueue) return;
  mach_port_t released = MACH_PORT_NULL;
  os_unfair_lock_lock(&gWatchLock);
  if (gWatched[thread] && gStretches[thread] == stretch) {
    released = gSampled[thread].port;
    gWatched[thread] = false;
    gStretches[thread] = nullptr;
    if (stretch->start.load(std::memory_order_acquire)) gArming.sleep();
    os_unfair_lock_lock(&gCaptureLock);
    Clear(gCaptures[thread]);
    os_unfair_lock_unlock(&gCaptureLock);
  }
  os_unfair_lock_unlock(&gWatchLock);
  if (released != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), released);
}

void Arm() {
  if (gTimer) gArming.wake(mach_absolute_time(), MsToTicks(kFreezeMs), gActive.load(std::memory_order_relaxed));
}

void Idle() {
  if (gTimer) gArming.sleep();
}

void StretchEnded(const Ended &ended) {
  if (!gWorkQueue || ended.ms < kFreezeMs) return;
  Capture done;
  os_unfair_lock_lock(&gCaptureLock);
  Capture &c = gCaptures[ended.thread];
  const bool ours = c.active && c.stretch == ended.id && c.source == ended.source;
  if (ours) {
    done = c;
    Clear(c);
  }
  os_unfair_lock_unlock(&gCaptureLock);
  if (!ours) return;
  const Ended copy = ended;
  dispatch_async(gWorkQueue, ^{
    Finish(copy, done);
  });
}

void SetEmitter(void (^emit)(NSDictionary *record)) {
  Setup();
  void (^kept)(NSDictionary *) = [emit copy];
  dispatch_async(gWorkQueue, ^{
    gEmit = kept;
  });
}

void Annotate(uint64_t freezeId, NSString *activity) {
  if (!gWorkQueue || activity.length == 0 || activity.length > 24) return;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"];
  if ([activity rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return;
  struct Name {
    char text[25];
  } name = {};
  strlcpy(name.text, activity.UTF8String, sizeof name.text);
  dispatch_async(gWorkQueue, ^{
    os_unfair_lock_lock(&gCaptureLock);
    for (Capture &kept : gKept)
      if (kept.seq == freezeId && kept.durationMs > 0) {
        strlcpy(kept.activity, name.text, sizeof kept.activity);
        WriteSlot(kept);
      }
    os_unfair_lock_unlock(&gCaptureLock);
  });
}

}
