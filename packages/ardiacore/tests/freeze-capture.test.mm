#import "../ios/ArdiaFreezeCapture.h"
#import "../ios/ArdiaEvents.h"
#import "../ios/ArdiaLaunchConfig.h"
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-braces"
#include "../ios/ArdiaStackSample.c"
#pragma clang diagnostic pop

#include <mach/mach_time.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <functional>
#include <string>
#include <thread>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wincomplete-implementation"
#pragma clang diagnostic ignored "-Wobjc-property-implementation"
#pragma clang diagnostic ignored "-Wobjc-designated-initializers"

static NSString *gDataDir;

@implementation ArdiaLaunchConfig
+ (ArdiaLaunchConfig *)shared {
  static ArdiaLaunchConfig *config = [self alloc];
  return config;
}
- (NSString *)dataDirectory {
  return gDataDir;
}
- (BOOL)testFlag:(NSString *)key {
  return [key isEqualToString:@"freezeWatchActive"];
}
@end

@implementation ArdiaEvents
+ (NSString *)consentEpoch {
  return @"period-under-test";
}
@end

@implementation ArdiaConsentStamp
- (instancetype)initWithEpoch:(NSString *)epoch {
  if ((self = [super init])) _epoch = [epoch copy];
  return self;
}
- (NSDictionary *)onto:(NSDictionary *)payload {
  NSMutableDictionary *stamped = [payload mutableCopy];
  stamped[@"epoch"] = _epoch;
  return stamped;
}
@end

#pragma clang diagnostic pop

namespace {

int failures = 0;

void expect(bool ok, const char *what) {
  std::fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", what);
  if (!ok) failures++;
}

ardia_freeze::Stretch gStretch;
std::atomic<int> gEmitted{0};
std::atomic<bool> gPlugEntered{false};
dispatch_semaphore_t gPlugRelease;
NSMutableArray<NSDictionary *> *gRecords;
NSLock *gRecordsLock;

void Spin(int ms) {
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
  while (std::chrono::steady_clock::now() < until) {
  }
}

void RunStretch(int ms) {
  const uint64_t id = gStretch.id.fetch_add(1) + 1;
  const uint64_t start = mach_absolute_time();
  gStretch.start.store(start);
  ardia_freeze::Arm();
  Spin(ms);
  gStretch.start.exchange(0);
  ardia_freeze::Idle();
  ardia_freeze::StretchEnded({0, &gStretch, id, (double)ms, 0, -1, -1, 1});
}

void PumpMainUntil(const std::function<bool()> &done, double seconds) {
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds((int)(seconds * 1000));
  while (!done() && std::chrono::steady_clock::now() < until) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
}

std::string Slot(int index) {
  NSData *file = [NSData dataWithContentsOfFile:[gDataDir stringByAppendingPathComponent:@"freezes.txt"]];
  if ((index + 1) * 4096 > (int)file.length) return "";
  std::string text((const char *)file.bytes + index * 4096, 4096);
  return text.substr(0, text.find('\n'));
}

}

int main() {
  @autoreleasepool {
    gDataDir = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString];
    gPlugRelease = dispatch_semaphore_create(0);
    gRecords = [NSMutableArray array];
    gRecordsLock = [NSLock new];
    ardia_freeze::SetEmitter(^(NSDictionary *record) {
      [gRecordsLock lock];
      [gRecords addObject:record];
      [gRecordsLock unlock];
      if (gEmitted.fetch_add(1) == 0) {
        gPlugEntered = true;
        dispatch_semaphore_wait(gPlugRelease, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC));
      }
    });

    std::atomic<bool> workerDone{false};
    std::thread worker([&] {
      ardia_freeze::Watch(0, pthread_self(), &gStretch);
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      RunStretch(700);
      for (int i = 0; i < 400 && !gPlugEntered; i++) std::this_thread::sleep_for(std::chrono::milliseconds(10));
      RunStretch(2300);
      RunStretch(900);
      workerDone = true;
    });
    PumpMainUntil([&] { return workerDone.load(); }, 30);
    expect(gPlugEntered, "the first freeze's finish is holding the work queue");
    dispatch_semaphore_signal(gPlugRelease);
    PumpMainUntil([&] { return gEmitted.load() >= 3; }, 10);
    worker.join();

    [gRecordsLock lock];
    NSArray<NSDictionary *> *records = [gRecords copy];
    [gRecordsLock unlock];
    expect(records.count == 3, "three freezes, three records, though the second finished only after the third began");
    NSDictionary *second = records.count > 1 ? records[1] : nil;
    expect([second[@"id"] intValue] == 2 && [second[@"durationMs"] doubleValue] >= 2300, "the delayed finish reports the second freeze with its own length");
    expect([second[@"samples"] count] > 0, "the second freeze keeps its stack samples");
    expect([second[@"epoch"] isEqualToString:@"period-under-test"] && [second[@"watchEpoch"] intValue] == 1, "the record carries the consent stamp from when its capture began and the watch epoch");
    expect(Slot(1) == "freeze 2 main recovered", "the second freeze's slot, written frozen at 2 s, now says recovered");
    expect(Slot(2) == "freeze 3 main recovered", "the third freeze is recorded too");
    std::fprintf(stderr, "%s\n", failures ? "FAILED" : "all passed");
    [NSFileManager.defaultManager removeItemAtPath:gDataDir error:nil];
  }
  return failures ? 1 : 0;
}
