#import "ArdiaHost.h"
#import "ArdiaDownloadMover.h"
#import "ArdiaFileArmsInternal.h"
#import "ArdiaFilePaths.h"

#include <unistd.h>

using namespace ardia_host::file_arms;

namespace {

constexpr int kPlaceTries = 8;

}

@implementation ArdiaHost (FileArmDownloads)

+ (NSDictionary<NSString *, id> *)claimArmedDownload:(NSString *)armId download:(NSString *)downloadId path:(NSString *)path {
  if (!downloadId.length || !path.length) return Refused(@"noPath", nil);
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSDictionary *result = Locked([&]() -> NSDictionary * {
    [purge addObjectsFromArray:SweepLocked()];
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm || ![arm.kind isEqualToString:@"download"]) return Refused(@"noArm", nil);
    if (arm.claims[downloadId]) return @{@"ok" : @YES, @"mode" : InStagingLocked(arm, arm.claims[downloadId]) ? @"prompted" : @"automatic"};
    for (ArdiaFileArm *other in Arms()) {
      if (![other.kind isEqualToString:@"download"]) continue;
      if (other.claims[downloadId] && other != arm) return Refused(@"claimedByAnother", nil);
      if (!InStagingLocked(other, path)) continue;
      if (other != arm) return Refused(@"stagedForAnother", nil);
      arm.claims[downloadId] = path;
      return @{@"ok" : @YES, @"mode" : @"prompted"};
    }
    if (!Active(arm)) return Refused(@"taken", nil);
    arm.claims[downloadId] = path;
    arm.answered += 1;
    arm.lastAnsweredAt = Now();
    if (arm.once) {
      arm.state = @"claimed";
      arm.expiresAt = Now();
    }
    return @{@"ok" : @YES, @"mode" : @"automatic"};
  });
  PurgeAll(purge);
  return result;
}

+ (void)placeArmedDownload:(NSString *)armId download:(NSString *)downloadId path:(NSString *)path completion:(void (^)(NSDictionary<NSString *, id> *result))completion {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    completion([self placeArmedDownloadNow:armId download:downloadId path:path]);
  });
}

+ (NSDictionary<NSString *, id> *)placeArmedDownloadNow:(NSString *)armId download:(NSString *)downloadId path:(NSString *)path {
  NSString *claimed = nil;
  NSString *destination = nil;
  BOOL folder = NO;
  BOOL prompted = NO;
  NSString *stagedName = nil;
  Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm || ![arm.kind isEqualToString:@"download"]) return;
    claimed = arm.claims[downloadId];
    destination = arm.paths.firstObject;
    folder = arm.folder;
    prompted = claimed && InStagingLocked(arm, path);
    if (prompted) stagedName = arm.stagedNames[path.stringByDeletingLastPathComponent];
  });
  if (!claimed) return Refused(@"notClaimed", nil);
  if (![claimed isEqualToString:path] && !prompted && ![claimed.stringByDeletingLastPathComponent isEqualToString:path.stringByDeletingLastPathComponent])
    return Refused(@"notClaimed", nil);
  NSDictionary *placed = nil;
  for (int attempt = 0; attempt < kPlaceTries; attempt++) {
    NSString *reason = nil;
    NSString *target = folder ? ardia_files::FreePathIn(destination, stagedName ?: path.lastPathComponent, &reason) : destination;
    if (!target) {
      placed = Refused(reason ?: @"noFreeName", nil);
      break;
    }
    placed = ardia_files::PlaceFile(path, target);
    if ([placed[@"ok"] boolValue] || placed[@"recoveryPath"] || !folder || ![placed[@"reason"] isEqualToString:@"exists"]) break;
  }
  const bool ok = [placed[@"ok"] boolValue];
  NSMutableDictionary *answer = [placed mutableCopy];
  [answer removeObjectForKey:@"recoveryPath"];
  if (!ok && placed[@"recoveryPath"]) answer[@"stagedPath"] = placed[@"recoveryPath"];
  else if (!ok && prompted) answer[@"stagedPath"] = path;
  if (ok && placed[@"recoveryPath"]) answer[@"sourceLeftAt"] = placed[@"recoveryPath"];
  if (ok) [ArdiaDownloadMover.shared rememberMove:downloadId from:path to:placed[@"path"]];
  Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm) return;
    if (ok) arm.landed = [arm.landed arrayByAddingObject:placed[@"path"]];
    else {
      arm.state = @"failed";
      arm.reason = placed[@"reason"];
    }
    [arm.claims removeObjectForKey:downloadId];
    if (ok && prompted) {
      [arm.stagingFolders removeObject:path.stringByDeletingLastPathComponent];
      [arm.stagedNames removeObjectForKey:path.stringByDeletingLastPathComponent];
    }
  });
  if (ok && prompted) rmdir(path.stringByDeletingLastPathComponent.fileSystemRepresentation);
  return answer;
}

+ (BOOL)releaseArmedDownload:(NSString *)armId download:(NSString *)downloadId state:(NSString *)state {
  NSString *emptyStaging = nil;
  const BOOL released = Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    NSString *claimed = arm.claims[downloadId];
    if (!claimed) return NO;
    [arm.claims removeObjectForKey:downloadId];
    if (InStagingLocked(arm, claimed)) {
      emptyStaging = claimed.stringByDeletingLastPathComponent;
      [arm.stagingFolders removeObject:emptyStaging];
      [arm.stagedNames removeObjectForKey:emptyStaging];
    }
    if (!Active(arm) && !arm.landed.count) {
      arm.state = @"failed";
      arm.reason = [state isEqualToString:@"cancelled"] ? @"cancelled" : @"downloadFailed";
    }
    return YES;
  });
  if (emptyStaging) rmdir(emptyStaging.fileSystemRepresentation);
  return released;
}

@end
