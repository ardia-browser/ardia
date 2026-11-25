#import "ArdiaArmLifetimes.h"

#include <os/lock.h>

namespace ardia_files {

namespace {

os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
uint64_t gTimerGeneration = 0;

NSMutableDictionary<NSString *, NSNumber *> *Deadlines() {
  static NSMutableDictionary<NSString *, NSNumber *> *deadlines = [NSMutableDictionary dictionary];
  return deadlines;
}

NSTimeInterval Now() {
  return NSDate.date.timeIntervalSince1970;
}

void ScheduleLocked(NSTimeInterval now) {
  gTimerGeneration += 1;
  if (!Deadlines().count) return;
  NSTimeInterval earliest = DBL_MAX;
  for (NSNumber *deadline in Deadlines().objectEnumerator) earliest = MIN(earliest, deadline.doubleValue);
  const uint64_t generation = gTimerGeneration;
  const double wait = MAX(earliest - now, 0) + 0.05;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    os_unfair_lock_lock(&gLock);
    const bool current = generation == gTimerGeneration;
    os_unfair_lock_unlock(&gLock);
    if (current) SweepExpiredCopies(Now());
  });
}

}

bool MayForgetArm(const ArmLife &life, bool forRoom, NSTimeInterval now) {
  if (life.active || life.hasCopies || life.claims || life.pendingHandoffs) return false;
  if (life.stagingFolders && now - life.lastAnsweredAt < kKeepHandoffSeconds) return false;
  return forRoom || now - life.endedAt > kKeepEndedArmSeconds;
}

void KeepCopiesUntil(NSString *folder, NSTimeInterval deadline) {
  if (!folder.length) return;
  os_unfair_lock_lock(&gLock);
  Deadlines()[folder] = @(deadline);
  ScheduleLocked(Now());
  os_unfair_lock_unlock(&gLock);
}

void ForgetCopies(NSString *folder) {
  if (!folder.length) return;
  os_unfair_lock_lock(&gLock);
  [Deadlines() removeObjectForKey:folder];
  ScheduleLocked(Now());
  os_unfair_lock_unlock(&gLock);
}

NSUInteger SweepExpiredCopies(NSTimeInterval now) {
  NSMutableArray<NSString *> *expired = [NSMutableArray array];
  os_unfair_lock_lock(&gLock);
  for (NSString *folder in Deadlines().allKeys)
    if (Deadlines()[folder].doubleValue <= now) {
      [expired addObject:folder];
      [Deadlines() removeObjectForKey:folder];
    }
  ScheduleLocked(now);
  os_unfair_lock_unlock(&gLock);
  for (NSString *folder in expired) [NSFileManager.defaultManager removeItemAtPath:folder error:nil];
  return expired.count;
}

}
