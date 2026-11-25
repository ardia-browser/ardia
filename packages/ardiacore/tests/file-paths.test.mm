#import "../ios/ArdiaFilePaths.h"
#import "../ios/ArdiaDownloadPrompts.h"
#import "../ios/ArdiaArmLifetimes.h"

#include <cstdio>
#include <cstdlib>
#include <sys/stat.h>
#include <unistd.h>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

using namespace ardia_files;

static NSString *gRoot;

static NSString *At(NSString *relative) {
  return [gRoot stringByAppendingPathComponent:relative];
}

static NSString *Make(NSString *relative, NSString *text) {
  NSString *path = At(relative);
  [NSFileManager.defaultManager createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
  [text writeToFile:path atomically:NO encoding:NSUTF8StringEncoding error:nil];
  return path;
}

static BOOL Exists(NSString *path) {
  struct stat info;
  return lstat(path.fileSystemRepresentation, &info) == 0;
}

static NSString *Text(NSString *path) {
  return [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
}

static void TestChosenPath() {
  NSString *reason = nil;
  NSString *file = Make(@"up/report.pdf", @"pdf");
  CHECK([ChosenPath(file, &reason) isEqualToString:file]);
  reason = nil;
  CHECK(ChosenPath(At(@"up"), &reason) == nil && [reason isEqualToString:@"folderUpload"]);
  symlink(file.fileSystemRepresentation, At(@"up/link.pdf").fileSystemRepresentation);
  reason = nil;
  CHECK(ChosenPath(At(@"up/link.pdf"), &reason) == nil && [reason isEqualToString:@"symlink"]);
  symlink("/nowhere/at/all", At(@"up/dangling.pdf").fileSystemRepresentation);
  reason = nil;
  CHECK(ChosenPath(At(@"up/dangling.pdf"), &reason) == nil && [reason isEqualToString:@"symlink"]);
  symlink(At(@"up").fileSystemRepresentation, At(@"uplink").fileSystemRepresentation);
  CHECK([ChosenPath(At(@"uplink/report.pdf"), &reason) isEqualToString:file]);
  for (id bad : @[ @"", @"relative/path", @"/a/../etc/passwd", @"/a/./b", @"/a\nb", [NSString stringWithFormat:@"/a%C", (unichar)0], @42, NSNull.null ]) {
    reason = nil;
    CHECK(ChosenPath(bad, &reason) == nil);
    CHECK(reason.length > 0);
  }
  NSMutableString *longPath = [NSMutableString stringWithString:@"/"];
  while (longPath.length <= kMaxPathBytes) [longPath appendString:@"aaaaaaaaaa/"];
  reason = nil;
  CHECK(ChosenPath(longPath, &reason) == nil && [reason isEqualToString:@"tooLong"]);
  reason = nil;
  CHECK(ChosenPath(At(@"up/missing.pdf"), &reason) == nil && [reason isEqualToString:@"missing"]);
  NSString *locked = Make(@"up/locked.txt", @"x");
  chmod(locked.fileSystemRepresentation, 0000);
  reason = nil;
  if (geteuid() != 0) CHECK(ChosenPath(locked, &reason) == nil && [reason isEqualToString:@"unreadable"]);
  chmod(locked.fileSystemRepresentation, 0600);
  mkfifo(At(@"up/fifo").fileSystemRepresentation, 0600);
  reason = nil;
  CHECK(ChosenPath(At(@"up/fifo"), &reason) == nil && [reason isEqualToString:@"notAFile"]);
}

static void TestDownloadTarget() {
  NSString *reason = nil;
  BOOL folder = YES;
  [NSFileManager.defaultManager createDirectoryAtPath:At(@"down") withIntermediateDirectories:YES attributes:nil error:nil];
  CHECK([DownloadTarget(At(@"down/new.zip"), &folder, &reason) isEqualToString:At(@"down/new.zip")] && !folder);
  CHECK([DownloadTarget(At(@"down"), &folder, &reason) isEqualToString:At(@"down")] && folder);
  CHECK([DownloadTarget([At(@"down") stringByAppendingString:@"/"], &folder, &reason) isEqualToString:At(@"down")] && folder);
  Make(@"down/taken.zip", @"x");
  reason = nil;
  CHECK(DownloadTarget(At(@"down/taken.zip"), &folder, &reason) == nil && [reason isEqualToString:@"exists"]);
  symlink(At(@"down/taken.zip").fileSystemRepresentation, At(@"down/alias.zip").fileSystemRepresentation);
  reason = nil;
  CHECK(DownloadTarget(At(@"down/alias.zip"), &folder, &reason) == nil && [reason isEqualToString:@"symlink"]);
  symlink(At(@"down").fileSystemRepresentation, At(@"downlink").fileSystemRepresentation);
  reason = nil;
  CHECK(DownloadTarget(At(@"downlink"), &folder, &reason) == nil && [reason isEqualToString:@"symlink"]);
  symlink("/nowhere/at/all", At(@"down/dangling").fileSystemRepresentation);
  reason = nil;
  CHECK(DownloadTarget(At(@"down/dangling"), &folder, &reason) == nil && [reason isEqualToString:@"symlink"]);
  CHECK([DownloadTarget(At(@"downlink/via.zip"), &folder, &reason) isEqualToString:At(@"down/via.zip")]);
  reason = nil;
  CHECK(DownloadTarget(At(@"nofolder/x.zip"), &folder, &reason) == nil && [reason isEqualToString:@"folderMissing"]);
  reason = nil;
  CHECK(DownloadTarget(At(@"down/taken.zip/inner"), &folder, &reason) == nil && [reason isEqualToString:@"notAFolder"]);
  reason = nil;
  CHECK(DownloadTarget(At(@"down/../escape.zip"), &folder, &reason) == nil && [reason isEqualToString:@"traversal"]);
  NSMutableString *longName = [NSMutableString string];
  while (longName.length <= kMaxNameBytes) [longName appendString:@"n"];
  reason = nil;
  CHECK(DownloadTarget([At(@"down") stringByAppendingPathComponent:longName], &folder, &reason) == nil && [reason isEqualToString:@"badName"]);
}

static void TestFreePathIn() {
  NSString *reason = nil;
  NSString *folder = At(@"free");
  [NSFileManager.defaultManager createDirectoryAtPath:folder withIntermediateDirectories:YES attributes:nil error:nil];
  CHECK([FreePathIn(folder, @"a.txt", &reason) isEqualToString:At(@"free/a.txt")]);
  Make(@"free/a.txt", @"x");
  CHECK([FreePathIn(folder, @"a.txt", &reason) isEqualToString:At(@"free/a (1).txt")]);
  CHECK([FreePathIn(folder, @"../../etc/passwd", &reason) isEqualToString:At(@"free/.._.._etc_passwd")] ||
        [FreePathIn(folder, @"../../etc/passwd", &reason) isEqualToString:At(@"free/_.._etc_passwd")]);
  CHECK([FreePathIn(folder, @"", &reason) isEqualToString:At(@"free/download")]);
  CHECK([FreePathIn(folder, @"..", &reason) isEqualToString:At(@"free/download")]);
  CHECK([FreePathIn(folder, @".hidden", &reason) isEqualToString:At(@"free/hidden")]);
  NSString *made = FreePathIn(folder, @"a:b/c\nd", &reason);
  CHECK(made && [made.stringByDeletingLastPathComponent isEqualToString:folder]);
}

static void TestPlaceFile() {
  [NSFileManager.defaultManager createDirectoryAtPath:At(@"place") withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *source = Make(@"staging/file.bin", @"payload");
  NSDictionary *placed = PlaceFile(source, At(@"place/file.bin"));
  CHECK([placed[@"ok"] boolValue]);
  CHECK([placed[@"bytes"] intValue] == 7);
  CHECK(!Exists(source));
  CHECK([Text(At(@"place/file.bin")) isEqualToString:@"payload"]);
  NSString *second = Make(@"staging/second.bin", @"other");
  placed = PlaceFile(second, At(@"place/file.bin"));
  CHECK(![placed[@"ok"] boolValue] && [placed[@"reason"] isEqualToString:@"exists"]);
  CHECK([Text(At(@"place/file.bin")) isEqualToString:@"payload"]);
  CHECK(Exists(second));
  symlink("/etc/hosts", At(@"place/trap").fileSystemRepresentation);
  placed = PlaceFile(second, At(@"place/trap"));
  CHECK(![placed[@"ok"] boolValue]);
  CHECK(Exists(second));
  placed = PlaceFile(At(@"staging/none.bin"), At(@"place/none.bin"));
  CHECK(![placed[@"ok"] boolValue] && [placed[@"reason"] isEqualToString:@"sourceMissing"]);
  placed = PlaceFile(At(@"place/file.bin"), At(@"place/file.bin"));
  CHECK([placed[@"ok"] boolValue]);
  symlink(At(@"place").fileSystemRepresentation, At(@"placelink").fileSystemRepresentation);
  placed = PlaceFile(second, At(@"placelink/through.bin"));
  CHECK(![placed[@"ok"] boolValue] && [placed[@"reason"] isEqualToString:@"folderChanged"]);
  CHECK(Exists(second));
  placed = PlaceFile(second, At(@"place/.."));
  CHECK(![placed[@"ok"] boolValue]);
  symlink(second.fileSystemRepresentation, At(@"staging/second-link.bin").fileSystemRepresentation);
  placed = PlaceFile(At(@"staging/second-link.bin"), At(@"place/from-link.bin"));
  CHECK(![placed[@"ok"] boolValue] && [placed[@"reason"] isEqualToString:@"symlink"]);
  CHECK(!Exists(At(@"place/from-link.bin")));
  placed = PlaceFile(@"relative.bin", At(@"place/rel.bin"));
  CHECK(![placed[@"ok"] boolValue]);
  NSArray *listing = [NSFileManager.defaultManager contentsOfDirectoryAtPath:At(@"place") error:nil];
  CHECK(listing != nil);
  NSArray *leftovers = [listing filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"SELF BEGINSWITH '.ardia-placing-'"]];
  CHECK(leftovers.count == 0);
}

static void TestStageUpload() {
  NSString *reason = nil;
  NSString *file = Make(@"stage-src/doc.txt", @"original");
  NSString *dir = At(@"staging-area");
  NSString *staged = StageUpload(file, dir, &reason);
  CHECK([staged isEqualToString:[dir stringByAppendingPathComponent:@"doc.txt"]]);
  CHECK([Text(staged) isEqualToString:@"original"]);
  struct stat info;
  CHECK(lstat(dir.fileSystemRepresentation, &info) == 0 && (info.st_mode & 0777) == 0700);
  [@"changed" writeToFile:file atomically:NO encoding:NSUTF8StringEncoding error:nil];
  CHECK([Text(staged) isEqualToString:@"original"]);
  [NSFileManager.defaultManager removeItemAtPath:file error:nil];
  symlink("/etc/hosts", file.fileSystemRepresentation);
  reason = nil;
  CHECK(StageUpload(file, At(@"staging-two"), &reason) == nil && [reason isEqualToString:@"symlink"]);
  mkfifo(At(@"stage-src/pipe").fileSystemRepresentation, 0600);
  reason = nil;
  CHECK(StageUpload(At(@"stage-src/pipe"), At(@"staging-three"), &reason) == nil && [reason isEqualToString:@"notAFile"]);
  [NSFileManager.defaultManager createDirectoryAtPath:At(@"open-staging") withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions : @0755} error:nil];
  reason = nil;
  CHECK(StageUpload(Make(@"stage-src/b.txt", @"b"), At(@"open-staging"), &reason) == nil && [reason isEqualToString:@"stagingFailed"]);
}

static void TestPromptedDownloadConflict() {
  NSString *reason = nil;
  NSString *folder = At(@"prompted");
  [NSFileManager.defaultManager createDirectoryAtPath:folder withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *staging = MakeStagingFolder(folder, @"f-test", &reason);
  CHECK(staging && [staging.stringByDeletingLastPathComponent isEqualToString:folder]);
  struct stat info;
  CHECK(lstat(staging.fileSystemRepresentation, &info) == 0 && (info.st_mode & 0777) == 0700);
  NSString *staged = [staging stringByAppendingPathComponent:@"report.zip"];
  [@"downloaded" writeToFile:staged atomically:NO encoding:NSUTF8StringEncoding error:nil];
  NSString *target = [folder stringByAppendingPathComponent:@"report.zip"];
  Make(@"prompted/report.zip", @"someone else's file");
  NSDictionary *placed = PlaceFile(staged, target);
  CHECK(![placed[@"ok"] boolValue] && [placed[@"reason"] isEqualToString:@"exists"]);
  CHECK([Text(target) isEqualToString:@"someone else's file"]);
  CHECK([Text(staged) isEqualToString:@"downloaded"]);
  [NSFileManager.defaultManager removeItemAtPath:target error:nil];
  placed = PlaceFile(staged, target);
  CHECK([placed[@"ok"] boolValue] && [Text(target) isEqualToString:@"downloaded"] && !Exists(staged));
  CHECK(rmdir(staging.fileSystemRepresentation) == 0);
  NSArray *left = [NSFileManager.defaultManager contentsOfDirectoryAtPath:folder error:nil];
  CHECK(left.count == 1);
}

static void TestAppDataRoot() {
  CHECK([AppDataRoot(@"/tmp/scratch-data", @"dev.ardia") isEqualToString:@"/tmp/scratch-data"]);
  NSString *installed = AppDataRoot(nil, @"dev.ardia.Ardia");
  CHECK([installed hasSuffix:@"/Library/Application Support/dev.ardia.Ardia"]);
  CHECK([installed hasPrefix:NSHomeDirectory()]);
  CHECK([AppDataRoot(@"", nil) hasSuffix:@"/Library/Application Support/Ardia"]);
}

static void TestNamesKeepWholeCharacters() {
  NSString *reason = nil;
  NSString *folder = At(@"emoji");
  [NSFileManager.defaultManager createDirectoryAtPath:folder withIntermediateDirectories:YES attributes:nil error:nil];
  NSMutableString *name = [NSMutableString string];
  while ([name lengthOfBytesUsingEncoding:NSUTF8StringEncoding] < 300) [name appendString:@"\U0001F600"];
  NSString *made = FreePathIn(folder, name, &reason);
  NSString *leaf = made.lastPathComponent;
  CHECK(leaf.length > 0 && [leaf lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= kMaxNameBytes);
  CHECK([leaf dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO] != nil);
  const unichar last = [leaf characterAtIndex:leaf.length - 1];
  CHECK(!(last >= 0xD800 && last <= 0xDBFF));
  [@"x" writeToFile:made atomically:NO encoding:NSUTF8StringEncoding error:nil];
  NSString *next = FreePathIn(folder, name, &reason).lastPathComponent;
  CHECK([next hasSuffix:@" (1)"] && [next lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= kMaxNameBytes && [next dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO] != nil);
  NSString *longExtension = [@"a." stringByPaddingToLength:250 withString:@"x" startingAtIndex:0];
  NSString *firstLong = FreePathIn(folder, longExtension, &reason);
  CHECK(firstLong != nil);
  [@"x" writeToFile:firstLong atomically:NO encoding:NSUTF8StringEncoding error:nil];
  NSString *numberedLong = FreePathIn(folder, longExtension, &reason).lastPathComponent;
  CHECK(numberedLong.length > 0 && [numberedLong lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= kMaxNameBytes && ![numberedLong isEqualToString:firstLong.lastPathComponent]);
}

static void TestDownloadPickerDetection() {
  ForgetDownloadPrompts();
  CHECK(!AwaitingDownloadTarget(1000, @"Work"));
  NoteDownloadEvent(@{@"id" : @"a", @"state" : @"downloading", @"path" : @"", @"offTheRecord" : @NO, @"profile" : @"Work"}, 1000);
  CHECK(AwaitingDownloadTarget(1001, @"Work"));
  CHECK(!AwaitingDownloadTarget(1001, @"Home"));
  CHECK(!AwaitingDownloadTarget(1001, nil));
  CHECK(LooksLikeDownloadPicker(AwaitingDownloadTarget(1001, @"Work"), @"", false));
  CHECK(!LooksLikeDownloadPicker(AwaitingDownloadTarget(1001, @"Home"), @"", false));
  CHECK(!LooksLikeDownloadPicker(AwaitingDownloadTarget(1001, @"Work"), @"Export passwords", false));
  CHECK(!LooksLikeDownloadPicker(AwaitingDownloadTarget(1001, @"Work"), @"", true));
  CHECK(!TakeDownloadTarget(1001, @"Work", 0));
  NoteDownloadEvent(@{@"id" : @"a", @"state" : @"cancelled", @"path" : @"", @"profile" : @"Work"}, 1001);
  NoteDownloadEvent(@{@"id" : @"early", @"state" : @"downloading", @"path" : @"", @"profile" : @"Work", @"startTime" : @(999000.0)}, 1001);
  CHECK(AwaitingDownloadTarget(1001, @"Work"));
  CHECK(!TakeDownloadTarget(1001, @"Work", 1000000.0));
  CHECK(AwaitingDownloadTarget(1001, @"Work"));
  NoteDownloadEvent(@{@"id" : @"early", @"state" : @"cancelled", @"path" : @"", @"profile" : @"Work"}, 1001);
  NoteDownloadEvent(@{@"id" : @"t1", @"state" : @"downloading", @"path" : @"", @"profile" : @"Work", @"startTime" : @(1000000.4)}, 1001);
  CHECK(TakeDownloadTarget(1001, @"Work", 1000000.9));
  CHECK(!AwaitingDownloadTarget(1001, @"Work"));
  CHECK(!TakeDownloadTarget(1001, @"Work", 0));
  NoteDownloadEvent(@{@"id" : @"a2", @"state" : @"downloading", @"path" : @"", @"profile" : @"Work", @"startTime" : @(1000500.0)}, 1001);
  CHECK(AwaitingDownloadTarget(1001, @"Work"));
  CHECK(!TakeDownloadTarget(1001, @"Home", 0));
  CHECK(TakeDownloadTarget(1001, @"Work", 1000000.0));
  NoteDownloadEvent(@{@"id" : @"stale-prompt", @"state" : @"downloading", @"path" : @"", @"profile" : @"Work", @"startTime" : @(1000600.0)}, 1100);
  CHECK(AwaitingDownloadTarget(1110, @"Work"));
  CHECK(!AwaitingDownloadTarget(1121, @"Work"));
  CHECK(!TakeDownloadTarget(1121, @"Work", 1000000.0));
  CHECK(TakeDownloadTarget(1119, @"Work", 1000000.0));
  NoteDownloadEvent(@{@"id" : @"a2", @"state" : @"downloading", @"path" : @"/Users/me/Downloads/a2.zip", @"profile" : @"Work"}, 1001);
  NoteDownloadEvent(@{@"id" : @"a", @"state" : @"downloading", @"path" : @"/Users/me/Downloads/a.zip", @"offTheRecord" : @NO, @"profile" : @"Work"}, 1002);
  CHECK(!AwaitingDownloadTarget(1003, @"Work"));
  NoteDownloadEvent(@{@"id" : @"p", @"state" : @"downloading", @"path" : @"", @"offTheRecord" : @YES, @"profile" : @"Work"}, 1004);
  CHECK(!AwaitingDownloadTarget(1005, @"Work"));
  NoteDownloadEvent(@{@"id" : @"b", @"state" : @"downloading", @"path" : @"", @"profile" : @""}, 1006);
  CHECK(AwaitingDownloadTarget(1007, @""));
  NoteDownloadEvent(@{@"id" : @"b", @"state" : @"cancelled", @"path" : @"", @"profile" : @""}, 1008);
  CHECK(!AwaitingDownloadTarget(1009, @""));
  NoteDownloadEvent(@{@"id" : @"c", @"state" : @"downloading", @"path" : @"", @"profile" : @"Work"}, 1010);
  CHECK(!AwaitingDownloadTarget(1010 + 121, @"Work"));
  NoteDownloadEvent(@{@"state" : @"downloading"}, 2000);
  NoteDownloadEvent((NSDictionary *)@"junk", 2000);
  CHECK(!AwaitingDownloadTarget(2001, @""));
}

static void TestRemoveIfSame() {
  NSString *copied = Make(@"remove/original.bin", @"copied");
  struct stat info;
  lstat(copied.fileSystemRepresentation, &info);
  CHECK(RemoveIfSame(copied, info.st_dev, info.st_ino, nil));
  CHECK(!Exists(copied));
  NSString *swapped = Make(@"remove/swapped.bin", @"original");
  lstat(swapped.fileSystemRepresentation, &info);
  [NSFileManager.defaultManager removeItemAtPath:swapped error:nil];
  Make(@"remove/swapped.bin", @"a different file at the same path");
  CHECK(!RemoveIfSame(swapped, info.st_dev, info.st_ino, nil));
  CHECK([Text(swapped) isEqualToString:@"a different file at the same path"]);
  NSArray *listing = [NSFileManager.defaultManager contentsOfDirectoryAtPath:At(@"remove") error:nil];
  CHECK(listing != nil && listing.count == 1);
  CHECK(!RemoveIfSame(At(@"remove/none.bin"), info.st_dev, info.st_ino, nil));
  NSString *raced = Make(@"remove/raced.bin", @"first");
  lstat(raced.fileSystemRepresentation, &info);
  [NSFileManager.defaultManager removeItemAtPath:raced error:nil];
  Make(@"remove/raced.bin", @"second");
  NSString *recovery = nil;
  CHECK(!RemoveIfSame(raced, info.st_dev, info.st_ino, &recovery, ^{
    Make(@"remove/raced.bin", @"third, written while Ardia held the second aside");
  }));
  CHECK(recovery != nil && [recovery.lastPathComponent hasPrefix:@".ardia-removing-"]);
  CHECK([Text(recovery) isEqualToString:@"second"]);
  CHECK([Text(raced) isEqualToString:@"third, written while Ardia held the second aside"]);
  NSString *restored = nil;
  NSString *calm = Make(@"remove/calm.bin", @"one");
  lstat(calm.fileSystemRepresentation, &info);
  [NSFileManager.defaultManager removeItemAtPath:calm error:nil];
  Make(@"remove/calm.bin", @"two");
  CHECK(!RemoveIfSame(calm, info.st_dev, info.st_ino, &restored));
  CHECK(restored == nil && [Text(calm) isEqualToString:@"two"]);
}

static void TestArmLifetimes() {
  ArmLife waiting = {true, false, 0, 0, 0, 0, 0};
  CHECK(!MayForgetArm(waiting, true, 10000));
  ArmLife ended = {false, false, 0, 0, 0, 1000, 900};
  CHECK(MayForgetArm(ended, true, 1001));
  CHECK(!MayForgetArm(ended, false, 1001));
  CHECK(MayForgetArm(ended, false, 1000 + kKeepEndedArmSeconds + 1));
  ArmLife claimed = {false, false, 1, 0, 0, 0, 0};
  CHECK(!MayForgetArm(claimed, true, 1e9) && !MayForgetArm(claimed, false, 1e9));
  ArmLife handingOff = {false, false, 0, 0, 1, 0, 0};
  CHECK(!MayForgetArm(handingOff, true, 1e9) && !MayForgetArm(handingOff, false, 1e9));
  ArmLife staged = {false, false, 0, 1, 0, 1000, 1000};
  CHECK(!MayForgetArm(staged, true, 1000 + 60) && !MayForgetArm(staged, false, 1000 + kKeepEndedArmSeconds + 1));
  CHECK(MayForgetArm(staged, true, 1000 + kKeepHandoffSeconds + 1) && MayForgetArm(staged, false, 1000 + kKeepHandoffSeconds + 1));
  ArmLife copies = {false, true, 0, 0, 0, 0, 0};
  CHECK(!MayForgetArm(copies, true, 1e9));

  NSString *soon = Make(@"copies/soon/0/a.txt", @"a").stringByDeletingLastPathComponent.stringByDeletingLastPathComponent;
  NSString *later = Make(@"copies/later/0/b.txt", @"b").stringByDeletingLastPathComponent.stringByDeletingLastPathComponent;
  NSString *kept = Make(@"copies/kept/0/c.txt", @"c").stringByDeletingLastPathComponent.stringByDeletingLastPathComponent;
  const NSTimeInterval now = NSDate.date.timeIntervalSince1970;
  KeepCopiesUntil(soon, now + 0.2);
  KeepCopiesUntil(later, now + 0.6);
  KeepCopiesUntil(kept, now + 0.2);
  ForgetCopies(kept);
  usleep(450000);
  CHECK(!Exists(soon));
  CHECK(Exists(later));
  usleep(500000);
  CHECK(!Exists(later));
  CHECK(Exists(kept));
}

static NSString *FolderOfBytes(NSString *base, NSUInteger total) {
  NSString *path = base;
  while ([path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] < total) {
    const NSUInteger left = total - [path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] - 1;
    if (left == 0) break;
    path = [path stringByAppendingPathComponent:[@"" stringByPaddingToLength:MIN(left, (NSUInteger)200) withString:@"d" startingAtIndex:0]];
  }
  [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:nil];
  return path;
}

static void TestArmOrderForWaitingDownloads() {
  ForgetDownloadPrompts();
  NoteDownloadEvent(@{@"id" : @"between", @"state" : @"downloading", @"path" : @"", @"profile" : @"Work", @"startTime" : @(200.0)}, 5000);
  CHECK(TakeDownloadTargetForArms(5001, @"Work", @[ @(300.0), @(100.0) ]) == 1);
  CHECK(TakeDownloadTargetForArms(5001, @"Work", @[ @(300.0), @(100.0) ]) == -1);
  NoteDownloadEvent(@{@"id" : @"late", @"state" : @"downloading", @"path" : @"", @"profile" : @"Work", @"startTime" : @(400.0)}, 5002);
  CHECK(TakeDownloadTargetForArms(5003, @"Work", @[ @(300.0), @(100.0) ]) == 0);
  NoteDownloadEvent(@{@"id" : @"too-early", @"state" : @"downloading", @"path" : @"", @"profile" : @"Work", @"startTime" : @(50.0)}, 5004);
  CHECK(TakeDownloadTargetForArms(5005, @"Work", @[ @(300.0), @(100.0) ]) == -1);
  ForgetDownloadPrompts();
}

static void TestStagingFitsPathMax() {
  NSString *fallback = At(@"fallback-staging");
  [NSFileManager.defaultManager createDirectoryAtPath:fallback withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions : @0700} error:nil];
  NSString *tag = @"f-0123456789abcdef";
  NSString *suggested = @"a-suggested-name.bin";
  NSString *reason = nil;
  NSString *staged = nil;

  NSString *near = FolderOfBytes(At(@"near"), 970);
  NSString *made = PlanStaging(near, tag, suggested, fallback, &staged, &reason);
  CHECK(made && [made.stringByDeletingLastPathComponent isEqualToString:near]);
  CHECK([staged isEqualToString:suggested]);
  CHECK([[made stringByAppendingPathComponent:staged] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= PATH_MAX - 1);

  NSString *destinationFolder = FolderOfBytes(At(@"deep"), 992);
  NSString *destination = [destinationFolder stringByAppendingPathComponent:@"file.bin"];
  CHECK([destination lengthOfBytesUsingEncoding:NSUTF8StringEncoding] == 1001);
  BOOL isFolder = YES;
  reason = nil;
  CHECK([DownloadTarget(destination, &isFolder, &reason) isEqualToString:destination] && !isFolder);
  staged = nil;
  made = PlanStaging(destinationFolder, tag, @"server-named-download.bin", fallback, &staged, &reason);
  CHECK(made != nil);
  NSString *stagedPath = [made stringByAppendingPathComponent:staged];
  CHECK([stagedPath lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= PATH_MAX - 1);
  CHECK([@"payload" writeToFile:stagedPath atomically:NO encoding:NSUTF8StringEncoding error:nil]);
  NSDictionary *placed = PlaceFile(stagedPath, destination);
  CHECK([placed[@"ok"] boolValue] && [Text(destination) isEqualToString:@"payload"]);
  CHECK(rmdir(made.fileSystemRepresentation) == 0);

  NSString *edge = FolderOfBytes(At(@"edge"), 1015);
  staged = nil;
  made = PlanStaging(edge, tag, suggested, fallback, &staged, &reason);
  CHECK(made && [made.stringByDeletingLastPathComponent isEqualToString:fallback]);
  CHECK([staged isEqualToString:suggested]);

  NSString *longName = [[@"" stringByPaddingToLength:240 withString:@"n" startingAtIndex:0] stringByAppendingString:@".zip"];
  staged = nil;
  made = PlanStaging(near, tag, longName, nil, &staged, &reason);
  CHECK(made != nil && [staged hasSuffix:@".zip"] && [staged lengthOfBytesUsingEncoding:NSUTF8StringEncoding] >= 16);
  CHECK([[made stringByAppendingPathComponent:staged] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= PATH_MAX - 1);

  staged = nil;
  reason = nil;
  CHECK(PlanStaging(edge, tag, suggested, nil, &staged, &reason) == nil && [reason isEqualToString:@"tooLong"]);
}

int main() {
  @autoreleasepool {
    char base[] = "/tmp/ardia-file-paths-XXXXXX";
    char *made = mkdtemp(base);
    char resolved[PATH_MAX];
    realpath(made, resolved);
    gRoot = @(resolved);
    TestChosenPath();
    TestDownloadTarget();
    TestFreePathIn();
    TestPlaceFile();
    TestStageUpload();
    TestPromptedDownloadConflict();
    TestAppDataRoot();
    TestNamesKeepWholeCharacters();
    TestDownloadPickerDetection();
    TestRemoveIfSame();
    TestArmLifetimes();
    TestArmOrderForWaitingDownloads();
    TestStagingFitsPathMax();
    [NSFileManager.defaultManager removeItemAtPath:gRoot error:nil];
    if (failures) return 1;
    std::printf("file-paths: ok\n");
  }
  return 0;
}
