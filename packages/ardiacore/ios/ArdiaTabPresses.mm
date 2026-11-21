#import "ArdiaTabPresses.h"

#import <os/lock.h>

#include <cmath>

namespace {

constexpr NSUInteger kMaxKept = 64;
constexpr double kSameEventMs = 0.5;

os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
NSUInteger gLastPress = 0;
NSMutableArray<NSArray *> *gUnheard;
NSMutableArray<NSArray *> *gSwitches;
NSSet<NSString *> *gSplitKeys;
void (^gOnJavaScriptThread)(void (^)(void));

struct Locked {
  Locked() { os_unfair_lock_lock(&gLock); }
  ~Locked() { os_unfair_lock_unlock(&gLock); }
};

void Keep(NSMutableArray<NSArray *> *__strong &list, NSArray *entry) {
  if (!list) list = [NSMutableArray array];
  if (list.count >= kMaxKept) [list removeObjectAtIndex:0];
  [list addObject:entry];
}

}

NSUInteger ArdiaTabPressBegan(NSString *key, double stamp) {
  Locked lock;
  const NSUInteger press = ++gLastPress;
  Keep(gUnheard, @[ [key copy], @(press), @(stamp) ]);
  return press;
}

NSUInteger ArdiaTabPressClaim(NSString *key, double stamp) {
  Locked lock;
  for (NSUInteger i = 0; i < gUnheard.count; i++) {
    NSArray *entry = gUnheard[i];
    if (![entry[0] isEqualToString:key] || std::fabs([entry[2] doubleValue] - stamp) > kSameEventMs) continue;
    const NSUInteger press = [entry[1] unsignedIntegerValue];
    [gUnheard removeObjectAtIndex:i];
    return press;
  }
  return 0;
}

NSArray<NSNumber *> *ArdiaTabPressesTakeUnheard(NSUInteger upTo) {
  Locked lock;
  NSMutableArray<NSNumber *> *taken = [NSMutableArray array];
  while (gUnheard.count && [gUnheard.firstObject[1] unsignedIntegerValue] <= upTo) {
    [taken addObject:gUnheard.firstObject[1]];
    [gUnheard removeObjectAtIndex:0];
  }
  return taken;
}

void ArdiaTabSwitchNote(NSString *key, NSUInteger press) {
  if (!key.length) return;
  Locked lock;
  for (NSUInteger i = gSwitches.count; i-- > 0;)
    if ([gSwitches[i][0] isEqualToString:key]) [gSwitches removeObjectAtIndex:i];
  Keep(gSwitches, @[ [key copy], @(press) ]);
}

NSUInteger ArdiaTabSwitchTake(NSString *key) {
  Locked lock;
  for (NSUInteger i = gSwitches.count; i-- > 0;) {
    if (![gSwitches[i][0] isEqualToString:key]) continue;
    const NSUInteger press = [gSwitches[i][1] unsignedIntegerValue];
    [gSwitches removeObjectsInRange:NSMakeRange(0, i + 1)];
    return press;
  }
  return 0;
}

void ArdiaTabSwitchesForget(NSUInteger press) {
  if (!press) return;
  Locked lock;
  for (NSUInteger i = gSwitches.count; i-- > 0;)
    if ([gSwitches[i][1] unsignedIntegerValue] == press) [gSwitches removeObjectAtIndex:i];
}

void ArdiaTabSplitsSet(NSArray<NSString *> *keys) {
  NSSet<NSString *> *set = [NSSet setWithArray:keys ?: @[]];
  Locked lock;
  gSplitKeys = set;
}

BOOL ArdiaTabInSplit(NSString *key) {
  Locked lock;
  return [gSplitKeys containsObject:key];
}

void ArdiaTabPressesSetJavaScriptThread(void (^run)(void (^)(void))) {
  Locked lock;
  gOnJavaScriptThread = [run copy];
  [gUnheard removeAllObjects];
  [gSwitches removeAllObjects];
}

void ArdiaTabPressesOnJavaScriptThread(void (^block)(void)) {
  void (^run)(void (^)(void));
  {
    Locked lock;
    run = gOnJavaScriptThread;
  }
  if (run) run(block);
}
