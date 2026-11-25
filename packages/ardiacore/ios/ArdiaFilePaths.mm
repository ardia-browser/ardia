#import "ArdiaFilePaths.h"

#include <copyfile.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <unistd.h>
#include <sys/clonefile.h>

#include <vector>

namespace ardia_files {

namespace {

class ScopedFd {
 public:
  explicit ScopedFd(int fd = -1) : fd_(fd) {}
  ~ScopedFd() {
    if (fd_ >= 0) close(fd_);
  }
  ScopedFd(const ScopedFd &) = delete;
  ScopedFd &operator=(const ScopedFd &) = delete;
  int get() const { return fd_; }
  bool valid() const { return fd_ >= 0; }

 private:
  int fd_;
};

NSDictionary *Failure(NSString *reason) {
  return @{@"ok" : @NO, @"reason" : reason};
}

NSUInteger Bytes(NSString *text) {
  return [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
}

NSString *WellFormed(id value, NSString **reason) {
  if (![value isKindOfClass:NSString.class] || ![(NSString *)value length]) {
    *reason = @"notAbsolute";
    return nil;
  }
  NSString *path = value;
  if ([path rangeOfString:@"\0"].location != NSNotFound || [path rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound) {
    *reason = @"badCharacters";
    return nil;
  }
  if (![path hasPrefix:@"/"]) {
    *reason = @"notAbsolute";
    return nil;
  }
  if (Bytes(path) > kMaxPathBytes || !path.fileSystemRepresentation) {
    *reason = @"tooLong";
    return nil;
  }
  for (NSString *part in [path componentsSeparatedByString:@"/"])
    if ([part isEqualToString:@"."] || [part isEqualToString:@".."]) {
      *reason = @"traversal";
      return nil;
    }
  while (path.length > 1 && [path hasSuffix:@"/"]) path = [path substringToIndex:path.length - 1];
  return path;
}

NSString *Resolved(NSString *path) {
  char resolved[PATH_MAX];
  if (!realpath(path.fileSystemRepresentation, resolved)) return nil;
  return [NSFileManager.defaultManager stringWithFileSystemRepresentation:resolved length:strlen(resolved)];
}

NSString *FitBytes(NSString *text, NSUInteger maxBytes) {
  NSString *kept = text;
  while (kept.length && Bytes(kept) > maxBytes) kept = [kept substringToIndex:[kept rangeOfComposedCharacterSequenceAtIndex:kept.length - 1].location];
  return kept;
}

bool ValidName(NSString *name) {
  return name.length && Bytes(name) <= kMaxNameBytes && ![name isEqualToString:@"."] && ![name isEqualToString:@".."] &&
         [name rangeOfString:@"/"].location == NSNotFound && [name rangeOfString:@"\0"].location == NSNotFound;
}

NSString *SafeName(NSString *name) {
  NSString *base = [name isKindOfClass:NSString.class] ? name : @"";
  base = [base stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  base = [base stringByReplacingOccurrencesOfString:@":" withString:@"_"];
  base = [base stringByReplacingOccurrencesOfString:@"\0" withString:@""];
  base = [[base componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet] componentsJoinedByString:@" "];
  base = [base stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  while ([base hasPrefix:@"."]) base = [base substringFromIndex:1];
  if (!base.length) base = @"download";
  return FitBytes(base, kMaxNameBytes);
}

NSString *Numbered(NSString *name, int n) {
  NSString *ext = name.pathExtension;
  NSString *stem = name.stringByDeletingPathExtension;
  if (!stem.length) {
    stem = name;
    ext = @"";
  }
  NSString *tail = ext.length ? [NSString stringWithFormat:@" (%d).%@", n, ext] : [NSString stringWithFormat:@" (%d)", n];
  if (Bytes(tail) >= kMaxNameBytes) tail = [NSString stringWithFormat:@" (%d)", n];
  if (Bytes(stem) + Bytes(tail) > kMaxNameBytes) stem = FitBytes(stem, kMaxNameBytes - Bytes(tail));
  return [stem stringByAppendingString:tail];
}

bool Missing(NSString *path) {
  struct stat info;
  return lstat(path.fileSystemRepresentation, &info) != 0 && errno == ENOENT;
}

}

NSString *SafeFileName(NSString *name) {
  return SafeName(name);
}

NSString *AppDataRoot(NSString *custom, NSString *bundleId) {
  if (custom.length) return custom;
  NSString *support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  if (!support.length) support = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support"];
  return [support stringByAppendingPathComponent:bundleId.length ? bundleId : @"Ardia"];
}

NSString *ChosenPath(id value, NSString **reason) {
  NSString *path = WellFormed(value, reason);
  if (!path) return nil;
  struct stat leaf;
  if (lstat(path.fileSystemRepresentation, &leaf) == 0 && S_ISLNK(leaf.st_mode)) {
    *reason = @"symlink";
    return nil;
  }
  NSString *folder = Resolved(path.stringByDeletingLastPathComponent);
  NSString *canonical = folder ? [folder stringByAppendingPathComponent:path.lastPathComponent] : nil;
  if (canonical && lstat(canonical.fileSystemRepresentation, &leaf) != 0) canonical = nil;
  if (canonical && S_ISLNK(leaf.st_mode)) {
    *reason = @"symlink";
    return nil;
  }
  if (!canonical) {
    *reason = errno == ENOENT || errno == ENOTDIR ? @"missing" : @"unreadable";
    return nil;
  }
  struct stat info;
  if (lstat(canonical.fileSystemRepresentation, &info) != 0) {
    *reason = @"missing";
    return nil;
  }
  if (S_ISDIR(info.st_mode)) {
    *reason = @"folderUpload";
    return nil;
  }
  if (!S_ISREG(info.st_mode)) {
    *reason = @"notAFile";
    return nil;
  }
  if (access(canonical.fileSystemRepresentation, R_OK) != 0) {
    *reason = @"unreadable";
    return nil;
  }
  return canonical;
}

NSString *DownloadTarget(id value, BOOL *folder, NSString **reason) {
  *folder = NO;
  NSString *path = WellFormed(value, reason);
  if (!path) return nil;
  NSString *name = path.lastPathComponent;
  if (!ValidName(name)) {
    *reason = @"badName";
    return nil;
  }
  struct stat info;
  if (lstat(path.fileSystemRepresentation, &info) == 0) {
    if (S_ISLNK(info.st_mode)) {
      *reason = @"symlink";
      return nil;
    }
    if (!S_ISDIR(info.st_mode)) {
      *reason = @"exists";
      return nil;
    }
    NSString *canonical = Resolved(path);
    if (!canonical || access(canonical.fileSystemRepresentation, W_OK | X_OK) != 0) {
      *reason = @"folderNotWritable";
      return nil;
    }
    *folder = YES;
    return canonical;
  }
  if (errno != ENOENT) {
    *reason = errno == ENOTDIR ? @"notAFolder" : @"unreadable";
    return nil;
  }
  NSString *parent = Resolved(path.stringByDeletingLastPathComponent);
  if (!parent) {
    *reason = @"folderMissing";
    return nil;
  }
  if (stat(parent.fileSystemRepresentation, &info) != 0 || !S_ISDIR(info.st_mode)) {
    *reason = @"notAFolder";
    return nil;
  }
  if (access(parent.fileSystemRepresentation, W_OK | X_OK) != 0) {
    *reason = @"folderNotWritable";
    return nil;
  }
  NSString *target = [parent stringByAppendingPathComponent:name];
  if (!Missing(target)) {
    *reason = @"exists";
    return nil;
  }
  return target;
}

NSString *FreePathIn(NSString *folder, NSString *name, NSString **reason) {
  NSString *safe = SafeName(name ?: @"");
  NSString *candidate = [folder stringByAppendingPathComponent:safe];
  for (int n = 1; n < 100 && !Missing(candidate); n++) candidate = [folder stringByAppendingPathComponent:Numbered(safe, n)];
  if (!Missing(candidate)) {
    *reason = @"noFreeName";
    return nil;
  }
  return candidate;
}

bool StillFree(NSString *target, NSString **reason) {
  NSString *parent = target.stringByDeletingLastPathComponent;
  NSString *resolved = Resolved(parent);
  if (!resolved || ![resolved isEqualToString:parent]) {
    *reason = @"folderChanged";
    return false;
  }
  if (!Missing(target)) {
    *reason = @"exists";
    return false;
  }
  return true;
}

NSString *StageUpload(NSString *canonical, NSString *dir, NSString **reason) {
  if (mkdir(dir.fileSystemRepresentation, 0700) != 0 && errno != EEXIST) {
    *reason = @"stagingFailed";
    return nil;
  }
  ScopedFd folder(open(dir.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  struct stat folderInfo;
  if (!folder.valid() || fstat(folder.get(), &folderInfo) != 0 || folderInfo.st_uid != geteuid() || (folderInfo.st_mode & 077)) {
    *reason = @"stagingFailed";
    return nil;
  }
  ScopedFd from(open(canonical.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
  struct stat info;
  if (!from.valid() || fstat(from.get(), &info) != 0) {
    *reason = errno == ELOOP ? @"symlink" : @"unreadable";
    return nil;
  }
  if (!S_ISREG(info.st_mode)) {
    *reason = @"notAFile";
    return nil;
  }
  NSString *name = canonical.lastPathComponent;
  if (!ValidName(name)) {
    *reason = @"badName";
    return nil;
  }
  if (fclonefileat(from.get(), folder.get(), name.fileSystemRepresentation, 0) != 0) {
    ScopedFd to(openat(folder.get(), name.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
    if (!to.valid() || fcopyfile(from.get(), to.get(), nullptr, COPYFILE_DATA) != 0) {
      unlinkat(folder.get(), name.fileSystemRepresentation, 0);
      *reason = @"stagingFailed";
      return nil;
    }
  }
  return [dir stringByAppendingPathComponent:name];
}

NSString *MakeStagingFolder(NSString *folder, NSString *tag, NSString **reason) {
  NSString *pattern = [folder stringByAppendingPathComponent:[NSString stringWithFormat:@".ardia-arm-%@-XXXXXX", tag]];
  if (Bytes(pattern) > kMaxPathBytes) {
    *reason = @"tooLong";
    return nil;
  }
  const char *representation = pattern.fileSystemRepresentation;
  std::vector<char> buffer(representation, representation + strlen(representation) + 1);
  if (!mkdtemp(buffer.data())) {
    *reason = @"folderNotWritable";
    return nil;
  }
  return [NSFileManager.defaultManager stringWithFileSystemRepresentation:buffer.data() length:strlen(buffer.data())];
}

bool RemoveIfSame(NSString *path, dev_t device, ino_t inode, NSString **recoveryPath, void (^beforeRestore)(void)) {
  NSString *removing = [path.stringByDeletingLastPathComponent
      stringByAppendingPathComponent:[NSString stringWithFormat:@".ardia-removing-%08x%08x", arc4random(), arc4random()]];
  if (renamex_np(path.fileSystemRepresentation, removing.fileSystemRepresentation, RENAME_EXCL) != 0) return false;
  struct stat taken;
  if (lstat(removing.fileSystemRepresentation, &taken) == 0 && taken.st_dev == device && taken.st_ino == inode && unlink(removing.fileSystemRepresentation) == 0)
    return true;
  if (beforeRestore) beforeRestore();
  if (renamex_np(removing.fileSystemRepresentation, path.fileSystemRepresentation, RENAME_EXCL) != 0 && recoveryPath) *recoveryPath = removing;
  return false;
}

namespace {

constexpr NSUInteger kLongestPathBytes = PATH_MAX - 1;
constexpr NSUInteger kShortestStagedName = 16;

NSString *FitName(NSString *name, NSUInteger budget) {
  if (Bytes(name) <= budget) return name;
  NSString *ext = name.pathExtension;
  NSString *stem = name.stringByDeletingPathExtension;
  if (ext.length && stem.length && Bytes(ext) + 2 <= budget) return [FitBytes(stem, budget - Bytes(ext) - 1) stringByAppendingFormat:@".%@", ext];
  return FitBytes(name, budget);
}

NSString *MakeTemporaryFolder(NSString *pattern) {
  const char *representation = pattern.fileSystemRepresentation;
  if (!representation) return nil;
  std::vector<char> buffer(representation, representation + strlen(representation) + 1);
  if (!mkdtemp(buffer.data())) return nil;
  return [NSFileManager.defaultManager stringWithFileSystemRepresentation:buffer.data() length:strlen(buffer.data())];
}

}

NSString *PlanStaging(NSString *folder, NSString *tag, NSString *name, NSString *fallbackRoot, NSString **stagedName, NSString **reason) {
  NSMutableArray<NSString *> *patterns = [NSMutableArray array];
  [patterns addObject:[folder stringByAppendingPathComponent:[NSString stringWithFormat:@".ardia-arm-%@-XXXXXX", tag]]];
  [patterns addObject:[folder stringByAppendingPathComponent:@".ardia-XXXXXX"]];
  if (fallbackRoot.length) [patterns addObject:[fallbackRoot stringByAppendingPathComponent:[NSString stringWithFormat:@"%@-XXXXXX", tag]]];
  NSString *safe = SafeName(name);
  NSString *chosen = nil;
  NSString *fitted = nil;
  for (int pass = 0; pass < 2 && !chosen; pass++)
    for (NSString *pattern in patterns) {
      const NSUInteger used = Bytes(pattern) + 1;
      if (used >= kLongestPathBytes) continue;
      const NSUInteger budget = MIN(kLongestPathBytes - used, kMaxNameBytes);
      if (pass == 0 ? budget >= Bytes(safe) : budget >= kShortestStagedName) {
        chosen = pattern;
        fitted = FitName(safe, budget);
        break;
      }
    }
  if (!chosen) {
    *reason = @"tooLong";
    return nil;
  }
  NSString *made = MakeTemporaryFolder(chosen);
  if (!made) {
    *reason = @"folderNotWritable";
    return nil;
  }
  *stagedName = fitted;
  return made;
}

NSDictionary<NSString *, id> *PlaceFile(NSString *source, NSString *target) {
  NSString *reason = nil;
  if (![target isKindOfClass:NSString.class] || !WellFormed(source, &reason) || !WellFormed(target, &reason)) return Failure(reason ?: @"badPath");
  ScopedFd from(open(source.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
  struct stat info;
  if (!from.valid() || fstat(from.get(), &info) != 0) return Failure(errno == ELOOP ? @"symlink" : @"sourceMissing");
  if (!S_ISREG(info.st_mode)) return Failure(@"notAFile");
  if ([source isEqualToString:target]) return @{@"ok" : @YES, @"path" : target, @"bytes" : @(info.st_size)};
  NSString *parent = target.stringByDeletingLastPathComponent;
  NSString *name = target.lastPathComponent;
  if (!ValidName(name)) return Failure(@"badName");
  if (!StillFree(target, &reason)) return Failure(reason);
  ScopedFd dir(open(parent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (!dir.valid()) return Failure(@"folderChanged");
  char where[MAXPATHLEN];
  if (fcntl(dir.get(), F_GETPATH, where) != 0 || ![[NSFileManager.defaultManager stringWithFileSystemRepresentation:where length:strlen(where)] isEqualToString:parent])
    return Failure(@"folderChanged");
  NSString *temporary = [NSString stringWithFormat:@".ardia-placing-%08x%08x", arc4random(), arc4random()];
  const char *tmp = temporary.fileSystemRepresentation;
  const off_t bytes = info.st_size;
  if (renameatx_np(AT_FDCWD, source.fileSystemRepresentation, dir.get(), tmp, RENAME_EXCL) == 0) {
    struct stat moved;
    if (fstatat(dir.get(), tmp, &moved, AT_SYMLINK_NOFOLLOW) != 0 || moved.st_dev != info.st_dev || moved.st_ino != info.st_ino) {
      if (renameatx_np(dir.get(), tmp, AT_FDCWD, source.fileSystemRepresentation, RENAME_EXCL) != 0)
        return @{@"ok" : @NO, @"reason" : @"sourceChanged", @"recoveryPath" : [parent stringByAppendingPathComponent:temporary]};
      return Failure(@"sourceChanged");
    }
    if (renameatx_np(dir.get(), tmp, dir.get(), name.fileSystemRepresentation, RENAME_EXCL) == 0) return @{@"ok" : @YES, @"path" : target, @"bytes" : @(bytes)};
    const int failed = errno;
    if (renameatx_np(dir.get(), tmp, AT_FDCWD, source.fileSystemRepresentation, RENAME_EXCL) != 0)
      return @{@"ok" : @NO, @"reason" : failed == EEXIST ? @"exists" : @"moveFailed", @"recoveryPath" : [parent stringByAppendingPathComponent:temporary]};
    return Failure(failed == EEXIST ? @"exists" : @"moveFailed");
  }
  if (errno == EEXIST) return Failure(@"moveFailed");
  if (errno != EXDEV) return Failure(@"moveFailed");
  {
    ScopedFd to(openat(dir.get(), tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
    if (!to.valid()) return Failure(@"moveFailed");
    if (fcopyfile(from.get(), to.get(), nullptr, COPYFILE_DATA | COPYFILE_STAT | COPYFILE_XATTR) != 0) {
      unlinkat(dir.get(), tmp, 0);
      return Failure(@"moveFailed");
    }
  }
  if (renameatx_np(dir.get(), tmp, dir.get(), name.fileSystemRepresentation, RENAME_EXCL) != 0) {
    const int failed = errno;
    unlinkat(dir.get(), tmp, 0);
    return Failure(failed == EEXIST ? @"exists" : @"moveFailed");
  }
  NSString *retained = nil;
  if (RemoveIfSame(source, info.st_dev, info.st_ino, &retained)) return @{@"ok" : @YES, @"path" : target, @"bytes" : @(bytes)};
  if (retained) return @{@"ok" : @YES, @"path" : target, @"bytes" : @(bytes), @"sourceLeft" : @YES, @"recoveryPath" : retained};
  return @{@"ok" : @YES, @"path" : target, @"bytes" : @(bytes), @"sourceLeft" : @YES};
}
}
