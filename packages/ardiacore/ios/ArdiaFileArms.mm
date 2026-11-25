#import "ArdiaHost.h"
#import "ArdiaArmLifetimes.h"
#import "ArdiaDownloadMover.h"
#import "ArdiaDownloadPrompts.h"
#import "ArdiaFileArmsInternal.h"
#import "ArdiaFilePaths.h"
#import "ArdiaInternal.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaWindowController.h"

#include <os/lock.h>
#include <sys/stat.h>
#include <unistd.h>

#include <vector>

@implementation ArdiaFileArm
@end

namespace ardia_host {

namespace file_arms {

os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;

constexpr NSUInteger kMaxActiveArms = 16;
constexpr NSUInteger kMaxKeptArms = 64;
constexpr NSUInteger kMaxUploadPaths = 64;
constexpr NSTimeInterval kMaxSeconds = 600;
constexpr NSUInteger kMaxIdBytes = 64;
constexpr NSTimeInterval kUploadRetentionSeconds = 1800;

uint64_t gGeneration = 0;

NSMutableArray<ArdiaFileArm *> *Arms() {
  static NSMutableArray<ArdiaFileArm *> *arms = [NSMutableArray array];
  return arms;
}

NSTimeInterval Now() {
  return NSDate.date.timeIntervalSince1970;
}

bool Active(ArdiaFileArm *arm) {
  return [arm.state isEqualToString:@"armed"];
}

NSString *UploadRoot() {
  return [ardia_files::AppDataRoot(ArdiaLaunchConfig.shared.dataDirectory, NSBundle.mainBundle.bundleIdentifier) stringByAppendingPathComponent:@"file-arms"];
}

bool PrivateFolder(NSString *folder) {
  [NSFileManager.defaultManager createDirectoryAtPath:folder.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
  if (mkdir(folder.fileSystemRepresentation, 0700) != 0 && errno != EEXIST) return false;
  struct stat info;
  if (lstat(folder.fileSystemRepresentation, &info) != 0 || !S_ISDIR(info.st_mode) || info.st_uid != geteuid()) return false;
  if ((info.st_mode & 077) && chmod(folder.fileSystemRepresentation, 0700) != 0) return false;
  return true;
}

void Purge(NSString *folder) {
  if (folder.length) [NSFileManager.defaultManager removeItemAtPath:folder error:nil];
}

void End(ArdiaFileArm *arm, NSString *state, NSString *_Nullable reason, NSMutableArray<NSString *> *purge) {
  const bool unused = arm.answered == 0;
  arm.state = state;
  arm.reason = reason;
  arm.expiresAt = Now();
  if (unused && arm.uploadFolder) {
    [purge addObject:arm.uploadFolder];
    arm.uploadFolder = nil;
  }
}

ardia_files::ArmLife LifeOf(ArdiaFileArm *arm) {
  return {Active(arm), arm.uploadFolder != nil, arm.claims.count, arm.stagingFolders.count, arm.pendingHandoffs, arm.expiresAt, arm.lastAnsweredAt};
}

NSMutableArray<NSString *> *SweepLocked() {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  const NSTimeInterval now = Now();
  NSMutableArray<ArdiaFileArm *> *arms = Arms();
  for (ArdiaFileArm *arm in arms) {
    if (Active(arm) && now >= arm.expiresAt) End(arm, @"expired", nil, purge);
    if (!Active(arm) && arm.uploadFolder && arm.answered > 0 && now - arm.lastAnsweredAt > kUploadRetentionSeconds) {
      [purge addObject:arm.uploadFolder];
      arm.uploadFolder = nil;
    }
  }
  NSIndexSet *old = [arms indexesOfObjectsPassingTest:^BOOL(ArdiaFileArm *arm, NSUInteger, BOOL *) {
    return ardia_files::MayForgetArm(LifeOf(arm), false, now);
  }];
  [arms removeObjectsAtIndexes:old];
  while (arms.count > kMaxKeptArms) {
    NSUInteger oldest = [arms indexOfObjectPassingTest:^BOOL(ArdiaFileArm *arm, NSUInteger, BOOL *) { return ardia_files::MayForgetArm(LifeOf(arm), true, now); }];
    if (oldest == NSNotFound) break;
    [arms removeObjectAtIndex:oldest];
  }
  return purge;
}

void PurgeAll(NSArray<NSString *> *folders) {
  for (NSString *folder in folders) {
    ardia_files::ForgetCopies(folder);
    Purge(folder);
  }
}

ArdiaFileArm *_Nullable ArmNamed(NSString *armId) {
  for (ArdiaFileArm *arm in Arms())
    if ([arm.armId isEqualToString:armId]) return arm;
  return nil;
}

NSDictionary *Refused(NSString *reason, NSString *_Nullable path) {
  return path ? @{@"ok" : @NO, @"reason" : reason, @"path" : path} : @{@"ok" : @NO, @"reason" : reason};
}

NSDictionary *Row(ArdiaFileArm *arm) {
  NSMutableDictionary *row = [@{
    @"id" : arm.armId,
    @"kind" : arm.kind,
    @"tab" : arm.tabId ?: NSNull.null,
    @"paths" : arm.paths,
    @"folder" : @(arm.folder),
    @"once" : @(arm.once),
    @"armedAt" : @(arm.armedAt * 1000),
    @"expiresAt" : @(arm.expiresAt * 1000),
    @"state" : arm.state,
    @"landed" : arm.landed,
    @"answered" : @(arm.answered),
  } mutableCopy];
  if (arm.reason) row[@"reason"] = arm.reason;
  return row;
}

ArdiaWindowController *_Nullable ControllerOf(NSWindow *_Nullable parent) {
  NSWindow *w = parent;
  for (int depth = 0; w && depth < 8; depth++, w = w.sheetParent ?: w.parentWindow) {
    ArdiaWindowController *c = [ArdiaWindowController forNSWindow:w];
    if (c) return c;
  }
  return nil;
}

bool RegularWindow(ArdiaWindowController *_Nullable c) {
  if (!c || c.stray || c.standalone || !c.appWindowId.length) return false;
  ArdiaCoreProfile *profile = c.coreWindow.activeProfile;
  return profile && !profile.offTheRecord;
}

struct Candidate {
  NSString *armId;
  NSString *_Nullable tabId;
  NSString *_Nullable windowId;
  NSTimeInterval armedAt;
};

std::vector<Candidate> CandidatesLocked(NSString *kind) {
  std::vector<Candidate> found;
  for (ArdiaFileArm *arm in Arms())
    if (Active(arm) && [arm.kind isEqualToString:kind]) found.push_back({arm.armId, arm.tabId, arm.windowId, arm.armedAt});
  return found;
}

void EndMoved(NSString *armId) {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (arm && Active(arm)) End(arm, @"cleared", @"tabMoved", purge);
  });
  PurgeAll(purge);
}

struct Ranked {
  NSString *armId;
  int rank;
  NSTimeInterval armedAt;
};

std::vector<Ranked> RankArms(NSString *kind, ArdiaWindowController *panelWindow) {
  std::vector<Candidate> candidates = Locked([&] { return CandidatesLocked(kind); });
  std::vector<Ranked> ranked;
  for (const Candidate &candidate : candidates) {
    int rank = 1;
    if (candidate.tabId) {
      ArdiaCoreTab *tab = TabWithAppTabId(candidate.tabId);
      if (!tab || !tab.profile || tab.profile.offTheRecord) continue;
      ArdiaWindowController *holder = [ArdiaWindowController holding:tab];
      if ([kind isEqualToString:@"upload"] && holder && candidate.windowId && ![holder.appWindowId isEqualToString:candidate.windowId]) {
        EndMoved(candidate.armId);
        continue;
      }
      if (tab.profile != panelWindow.coreWindow.activeProfile || holder != panelWindow) continue;
      rank = 2;
    }
    ranked.push_back({candidate.armId, rank, candidate.armedAt});
  }
  std::stable_sort(ranked.begin(), ranked.end(), [](const Ranked &a, const Ranked &b) {
    return a.rank != b.rank ? a.rank > b.rank : a.armedAt > b.armedAt;
  });
  return ranked;
}

NSString *DownloadStagingRoot() {
  return [ardia_files::AppDataRoot(ArdiaLaunchConfig.shared.dataDirectory, NSBundle.mainBundle.bundleIdentifier) stringByAppendingPathComponent:@"download-staging"];
}

NSArray<NSURL *> *_Nullable UploadPicks(NSString *armId, NSOpenPanel *panel) {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSString *keep = nil;
  NSTimeInterval keepUntil = 0;
  NSArray<NSURL *> *urls = Locked([&]() -> NSArray<NSURL *> * {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm || !Active(arm)) return nil;
    if (arm.staged.count > 1 && !panel.allowsMultipleSelection) {
      End(arm, @"failed", @"oneFileOnly", purge);
      return nil;
    }
    if (!panel.canChooseFiles) {
      End(arm, @"failed", @"wantsFolder", purge);
      return nil;
    }
    NSMutableArray<NSURL *> *picked = [NSMutableArray array];
    for (NSString *path in arm.staged) [picked addObject:[NSURL fileURLWithPath:path isDirectory:NO]];
    arm.landed = arm.paths;
    arm.answered += 1;
    arm.lastAnsweredAt = Now();
    keep = arm.uploadFolder;
    keepUntil = arm.lastAnsweredAt + kUploadRetentionSeconds;
    if (arm.once) {
      arm.state = @"answered";
      arm.expiresAt = Now();
    }
    return picked;
  });
  PurgeAll(purge);
  if (keep) ardia_files::KeepCopiesUntil(keep, keepUntil);
  return urls;
}

NSArray<NSURL *> *_Nullable DownloadPicks(NSString *armId, NSSavePanel *panel) {
  NSString *folder = nil;
  NSString *name = nil;
  bool consumed = Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm || !Active(arm)) return false;
    folder = arm.folder ? arm.paths.firstObject : arm.paths.firstObject.stringByDeletingLastPathComponent;
    name = arm.folder ? nil : arm.paths.firstObject.lastPathComponent;
    arm.answered += 1;
    arm.lastAnsweredAt = Now();
    arm.pendingHandoffs += 1;
    if (arm.once) {
      arm.state = @"answered";
      arm.expiresAt = Now();
    }
    return true;
  });
  if (!consumed) return nil;
  NSString *reason = nil;
  NSString *wanted = name ?: ardia_files::SafeFileName(panel.nameFieldStringValue);
  NSString *fallback = DownloadStagingRoot();
  NSString *stagedName = nil;
  NSString *staging = ardia_files::PlanStaging(folder, armId, wanted, PrivateFolder(fallback) ? fallback : nil, &stagedName, &reason);
  Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm) return;
    if (arm.pendingHandoffs) arm.pendingHandoffs -= 1;
    if (staging) {
      [arm.stagingFolders addObject:staging];
      arm.stagedNames[staging] = wanted;
    }
    else {
      arm.state = @"failed";
      arm.reason = reason ?: @"stagingFailed";
    }
  });
  if (!staging) return nil;
  return @[ [NSURL fileURLWithPath:[staging stringByAppendingPathComponent:stagedName] isDirectory:NO] ];
}

bool InStagingLocked(ArdiaFileArm *arm, NSString *path) {
  NSString *parent = path.stringByDeletingLastPathComponent;
  return [arm.stagingFolders containsObject:parent];
}

void SweepUploadRootOnce() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Purge(UploadRoot());
  });
}

}

using namespace file_arms;

void SweepFileArmsAtLaunch() {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    SweepUploadRootOnce();
  });
}

bool HasArmedPanels() {
  return Locked([] {
    for (ArdiaFileArm *arm in Arms())
      if (Active(arm)) return true;
    return false;
  });
}

NSArray<NSURL *> *ArmedPanelPicks(NSSavePanel *panel, NSWindow *parent, bool *handled, NSString **armId) {
  *handled = false;
  PurgeAll(Locked([] { return SweepLocked(); }));
  const bool open = [panel isKindOfClass:NSOpenPanel.class];
  ArdiaWindowController *panelWindow = ControllerOf(parent);
  if (!RegularWindow(panelWindow)) return nil;
  NSString *profile = ProfileName(panelWindow.coreWindow.activeProfile);
  if (!open && !ardia_files::LooksLikeDownloadPicker(ardia_files::AwaitingDownloadTarget(Now(), profile), panel.message, panel.accessoryView != nil)) return nil;
  std::vector<Ranked> ranked = RankArms(open ? @"upload" : @"download", panelWindow);
  if (ranked.empty()) return nil;
  NSString *pick = ranked.front().armId;
  if (!open) {
    NSMutableArray<NSNumber *> *armedAtMs = [NSMutableArray array];
    for (const Ranked &arm : ranked) [armedAtMs addObject:@(arm.armedAt * 1000)];
    const NSInteger taken = ardia_files::TakeDownloadTargetForArms(Now(), profile, armedAtMs);
    if (taken < 0) return nil;
    pick = ranked[(size_t)taken].armId;
  }
  *handled = true;
  *armId = pick;
  return open ? UploadPicks(pick, (NSOpenPanel *)panel) : DownloadPicks(pick, panel);
}

}

using namespace ardia_host;
using namespace ardia_host::file_arms;

@implementation ArdiaHost (FileArms)

+ (void)armFiles:(NSDictionary<NSString *, id> *)spec completion:(void (^)(NSDictionary<NSString *, id> *result))completion {
  const uint64_t generation = Locked([] { return gGeneration; });
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    completion([self armFilesNow:spec generation:generation]);
  });
}

+ (NSDictionary<NSString *, id> *)armFilesNow:(NSDictionary<NSString *, id> *)spec generation:(uint64_t)generation {
  SweepUploadRootOnce();
  NSString *armId = spec[@"id"];
  NSString *kind = spec[@"kind"];
  id tab = spec[@"tab"];
  id window = spec[@"window"];
  NSArray *paths = spec[@"paths"];
  NSNumber *once = spec[@"once"];
  NSNumber *seconds = spec[@"seconds"];
  if (![armId isKindOfClass:NSString.class] || !armId.length || [armId lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > kMaxIdBytes ||
      [armId rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"abcdef0123456789-"].invertedSet].location != NSNotFound)
    return Refused(@"badId", nil);
  if (![kind isEqualToString:@"upload"] && ![kind isEqualToString:@"download"]) return Refused(@"badKind", nil);
  const bool upload = [kind isEqualToString:@"upload"];
  NSString *tabId = [tab isKindOfClass:NSString.class] ? tab : nil;
  NSString *windowId = [window isKindOfClass:NSString.class] ? window : nil;
  if (upload && (!tabId || !windowId)) return Refused(@"noTab", nil);
  if (![paths isKindOfClass:NSArray.class] || !paths.count || paths.count > kMaxUploadPaths) return Refused(@"badPaths", nil);
  if (!upload && paths.count != 1) return Refused(@"badPaths", nil);
  const NSTimeInterval ttl = [seconds isKindOfClass:NSNumber.class] ? MIN(MAX(seconds.doubleValue, 1), kMaxSeconds) : 120;
  const BOOL onlyOnce = ![once isKindOfClass:NSNumber.class] || once.boolValue;
  NSMutableArray<NSString *> *resolved = [NSMutableArray array];
  BOOL folder = NO;
  for (id path in paths) {
    NSString *reason = nil;
    NSString *canonical = upload ? ardia_files::ChosenPath(path, &reason) : ardia_files::DownloadTarget(path, &folder, &reason);
    if (!canonical) return Refused(reason ?: @"badPath", [path isKindOfClass:NSString.class] ? path : nil);
    [resolved addObject:canonical];
  }
  if (!upload && !folder && !onlyOnce) return Refused(@"onceForFile", nil);
  NSString *uploadFolder = nil;
  NSMutableArray<NSString *> *staged = [NSMutableArray array];
  if (upload) {
    NSString *root = UploadRoot();
    if (!PrivateFolder(root)) return Refused(@"stagingFailed", nil);
    uploadFolder = [root stringByAppendingPathComponent:armId];
    if (mkdir(uploadFolder.fileSystemRepresentation, 0700) != 0) return Refused(@"badId", nil);
    for (NSUInteger i = 0; i < resolved.count; i++) {
      NSString *reason = nil;
      NSString *copy = ardia_files::StageUpload(resolved[i], [uploadFolder stringByAppendingPathComponent:[NSString stringWithFormat:@"%lu", (unsigned long)i]], &reason);
      if (!copy) {
        Purge(uploadFolder);
        return Refused(reason ?: @"stagingFailed", resolved[i]);
      }
      [staged addObject:copy];
    }
  }
  NSString *busyWith = nil;
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSDictionary *result = Locked([&]() -> NSDictionary * {
    [purge addObjectsFromArray:SweepLocked()];
    if (generation != gGeneration) return Refused(@"stopped", nil);
    if (ArmNamed(armId)) return Refused(@"badId", nil);
    NSUInteger active = 0;
    for (ArdiaFileArm *arm in Arms()) {
      if (!Active(arm)) continue;
      active += 1;
      if (upload && [arm.kind isEqualToString:@"upload"] && [arm.windowId isEqualToString:windowId]) busyWith = arm.armId;
    }
    if (busyWith) return @{@"ok" : @NO, @"reason" : @"windowBusy", @"arm" : busyWith};
    if (active >= kMaxActiveArms) return Refused(@"tooMany", nil);
    ArdiaFileArm *arm = [ArdiaFileArm new];
    arm.armId = armId;
    arm.kind = kind;
    arm.tabId = tabId;
    arm.windowId = windowId;
    arm.paths = resolved;
    arm.staged = staged;
    arm.uploadFolder = uploadFolder;
    arm.folder = folder;
    arm.once = onlyOnce;
    arm.armedAt = Now();
    arm.expiresAt = arm.armedAt + ttl;
    arm.state = @"armed";
    arm.landed = @[];
    arm.stagingFolders = [NSMutableArray array];
    arm.claims = [NSMutableDictionary dictionary];
    arm.stagedNames = [NSMutableDictionary dictionary];
    [Arms() addObject:arm];
    return @{@"ok" : @YES, @"arm" : Row(arm)};
  });
  if (![result[@"ok"] boolValue] && uploadFolder) [purge addObject:uploadFolder];
  PurgeAll(purge);
  return result;
}

+ (NSInteger)disarmFiles:(NSArray<NSString *> *)ids purge:(BOOL)purgeCopies {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSMutableArray<NSString *> *emptyStaging = [NSMutableArray array];
  NSInteger cleared = Locked([&] {
    [purge addObjectsFromArray:SweepLocked()];
    if (!ids) gGeneration += 1;
    NSInteger count = 0;
    for (ArdiaFileArm *arm in Arms()) {
      if (ids && ![ids containsObject:arm.armId]) continue;
      if (Active(arm)) {
        End(arm, @"cleared", nil, purge);
        count += 1;
      }
      if (purgeCopies && arm.uploadFolder) {
        [purge addObject:arm.uploadFolder];
        arm.uploadFolder = nil;
      }
      if (purgeCopies && !arm.claims.count) [emptyStaging addObjectsFromArray:arm.stagingFolders];
    }
    return count;
  });
  PurgeAll(purge);
  for (NSString *folder in emptyStaging) rmdir(folder.fileSystemRepresentation);
  return cleared;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)fileArms {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSArray *rows = Locked([&] {
    [purge addObjectsFromArray:SweepLocked()];
    NSMutableArray *list = [NSMutableArray array];
    for (ArdiaFileArm *arm in Arms()) [list addObject:Row(arm)];
    return list;
  });
  PurgeAll(purge);
  return rows;
}

@end
