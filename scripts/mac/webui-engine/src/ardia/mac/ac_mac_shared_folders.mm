#include "ardia/mac/ac_mac_shared_folders.h"

#import <AppKit/AppKit.h>
#include <CoreServices/CoreServices.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <iterator>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_shared_folders_policy.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/posix/safe_strerror.h"
#include "base/strings/string_util.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/task_traits.h"
#include "base/task/thread_pool.h"

namespace ardia_mac::shared_folders {

namespace {

namespace policy = shared_folders_policy;
using Identity = policy::Identity;
using Done = ShellHostView::Done;

constexpr std::string_view kCapabilities[] = {
    "ArdiaSharedFolders.location",
    "ArdiaSharedFolders.read",
    "ArdiaSharedFolders.apply",
    "ArdiaSharedFolders.resolve",
    "ArdiaSharedFolders.discard",
    "ArdiaSharedFolders.create",
    "ArdiaSharedFolders.watch",
    "ArdiaSharedFolders.revealFolder",
};

constexpr char kOutside[] = "A folder change pointed outside the shared folder.";

struct Outcome {
  bool ok = true;
  base::Value value;
};

Outcome Succeeded(base::Value value) {
  return Outcome{true, std::move(value)};
}

Outcome Refused(const std::string& message, std::string_view code = policy::kFailureCode) {
  return Outcome{false, Failure(code, message)};
}

scoped_refptr<base::SequencedTaskRunner> FolderRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN}));
  return *runner;
}

std::string Quoted(std::string_view name) {
  return "“" + std::string(name) + "”";
}

std::string LastComponent(const std::string& path) {
  return base::FilePath(path).BaseName().value();
}

std::string DirectoryOf(const std::string& path) {
  return base::FilePath(path).DirName().value();
}

std::string ErrorText(int code) {
  return base::safe_strerror(code);
}

std::string PosixFailure(int code) {
  return "The operation couldn’t be completed: " + ErrorText(code);
}

std::optional<std::string> RealPath(const std::string& path) {
  char* real = realpath(path.c_str(), nullptr);
  if (!real) {
    return std::nullopt;
  }
  std::string resolved(real);
  free(real);
  return resolved;
}

Identity IdentityOf(const struct stat& info) {
  return Identity{static_cast<std::int64_t>(info.st_dev), static_cast<std::int64_t>(info.st_ino)};
}

std::optional<Identity> DirectoryIdentity(const std::string& path) {
  struct stat info = {};
  if (stat(path.c_str(), &info) != 0 || !S_ISDIR(info.st_mode)) {
    return std::nullopt;
  }
  return IdentityOf(info);
}

base::DictValue Resolved(const std::string& path, const Identity& identity) {
  return base::DictValue()
      .Set("path", path)
      .Set("device", static_cast<double>(identity.device))
      .Set("inode", static_cast<double>(identity.inode));
}

NSURL* UrlFor(const std::string& path, bool directory = false) {
  return [NSURL fileURLWithPath:base::SysUTF8ToNSString(path) isDirectory:directory];
}

class Folder {
 public:
  Folder(base::ScopedFD fd, std::string path) : fd_(std::move(fd)), path_(std::move(path)) {
    while (path_.size() > 1 && path_.back() == '/') {
      path_.pop_back();
    }
  }

  int fd() const { return fd_.get(); }
  const std::string& path() const { return path_; }

  std::string Child(std::string_view name) const {
    return path_ == "/" ? "/" + std::string(name) : path_ + "/" + std::string(name);
  }

  std::optional<Identity> identity() const {
    struct stat info = {};
    if (fstat(fd_.get(), &info) != 0) {
      return std::nullopt;
    }
    return IdentityOf(info);
  }

 private:
  base::ScopedFD fd_;
  std::string path_;
};

using FolderRef = std::shared_ptr<Folder>;

enum class Kind { kFile, kDirectory, kSymlink, kOther, kMissing, kBlocked };

struct Found {
  struct stat info = {};
  int error = 0;
};

Found InfoIn(int fd, const std::string& name) {
  Found found;
  if (fstatat(fd, name.c_str(), &found.info, AT_SYMLINK_NOFOLLOW) != 0) {
    found.error = errno;
  }
  return found;
}

Kind KindOf(const Found& found) {
  if (found.error != 0) {
    return found.error == ENOENT ? Kind::kMissing : Kind::kBlocked;
  }
  switch (found.info.st_mode & S_IFMT) {
    case S_IFREG:
      return Kind::kFile;
    case S_IFDIR:
      return Kind::kDirectory;
    case S_IFLNK:
      return Kind::kSymlink;
    default:
      return Kind::kOther;
  }
}

Kind KindIn(const Folder& folder, const std::string& name) {
  return KindOf(InfoIn(folder.fd(), name));
}

struct Opened {
  FolderRef folder;
  int error = 0;
};

Opened OpenDirectoryIn(const Folder& parent, const std::string& name) {
  const int fd = openat(parent.fd(), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    return Opened{nullptr, errno};
  }
  return Opened{std::make_shared<Folder>(base::ScopedFD(fd), parent.Child(name)), 0};
}

struct ScanBudget {
  std::size_t entries = 0;
  std::size_t bytes = 0;
  bool Exceeded() const { return entries > policy::kMaxEntries || bytes > policy::kMaxScanBytes; }
};

std::optional<std::vector<std::string>> Names(const Folder& folder,
                                              ScanBudget* budget,
                                              std::size_t stop_after,
                                              int* error) {
  const int copy = dup(folder.fd());
  DIR* stream = copy >= 0 ? fdopendir(copy) : nullptr;
  if (!stream) {
    *error = errno;
    if (copy >= 0) {
      close(copy);
    }
    return std::nullopt;
  }
  rewinddir(stream);
  std::vector<std::string> names;
  while (names.size() < stop_after) {
    errno = 0;
    dirent* entry = readdir(stream);
    if (!entry) {
      const int code = errno;
      closedir(stream);
      if (code != 0) {
        *error = code;
        return std::nullopt;
      }
      return names;
    }
    const std::string name(entry->d_name);
    if (name == "." || name == "..") {
      continue;
    }
    names.push_back(name);
    if (budget) {
      ++budget->entries;
      if (budget->Exceeded()) {
        break;
      }
    }
  }
  closedir(stream);
  return names;
}

void StartDownloading(const std::string& path) {
  [[NSFileManager defaultManager] startDownloadingUbiquitousItemAtURL:UrlFor(path) error:nil];
}

std::optional<std::string> WaitingFor(const std::string& path) {
  NSURL* url = UrlFor(path);
  NSDictionary* values = [url resourceValuesForKeys:@[ NSURLIsUbiquitousItemKey, NSURLUbiquitousItemDownloadingStatusKey ]
                                              error:nil];
  if (![values[NSURLIsUbiquitousItemKey] boolValue]) {
    return std::nullopt;
  }
  NSString* status = values[NSURLUbiquitousItemDownloadingStatusKey];
  if (!status || [status isEqualToString:NSURLUbiquitousItemDownloadingStatusCurrent]) {
    return std::nullopt;
  }
  StartDownloading(path);
  return "download";
}

bool IsPackage(const std::string& path) {
  NSNumber* package = nil;
  [UrlFor(path, true) getResourceValue:&package forKey:NSURLIsPackageKey error:nil];
  return package.boolValue;
}

std::optional<std::string> BoundedRead(int directory, const std::string& name, std::size_t limit) {
  base::ScopedFD fd(openat(directory, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
  if (!fd.is_valid()) {
    return std::nullopt;
  }
  struct stat info = {};
  if (fstat(fd.get(), &info) != 0 || !S_ISREG(info.st_mode)) {
    return std::nullopt;
  }
  std::string data;
  char buffer[16384];
  for (;;) {
    const ssize_t count = read(fd.get(), buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      return std::nullopt;
    }
    if (count == 0) {
      return data;
    }
    data.append(buffer, static_cast<std::size_t>(count));
    if (data.size() > limit) {
      return std::nullopt;
    }
  }
}

struct Coordinated {
  policy::Coordination outcome = policy::Coordination::kFailed;
  std::string error;
};

template <typename Call>
Coordinated RunCoordinated(Call&& call) {
  NSFileCoordinator* coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
  auto gate = std::make_shared<policy::CoordinationGate>();
  dispatch_block_t expire = dispatch_block_create(static_cast<dispatch_block_flags_t>(0), ^{
    if (gate->Expire()) {
      [coordinator cancel];
    }
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(policy::kCoordinationTimeoutSeconds) *
                                                      static_cast<int64_t>(NSEC_PER_SEC)),
                 dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), expire);
  __block bool ran = false;
  NSError* error = call(coordinator, ^bool {
    if (!gate->Begin()) {
      return false;
    }
    ran = true;
    return true;
  });
  dispatch_block_cancel(expire);
  Coordinated result;
  result.outcome = policy::CoordinationOutcome(ran, *gate);
  if (result.outcome == policy::Coordination::kFailed && error) {
    result.error = base::SysNSStringToUTF8(error.localizedDescription);
  }
  return result;
}

template <typename Body>
Coordinated CoordinateReading(const std::string& path, Body& body) {
  Body* run = &body;
  NSURL* url = UrlFor(path);
  return RunCoordinated([run, url](NSFileCoordinator* coordinator, bool (^begin)(void)) {
    NSError* error = nil;
    [coordinator coordinateReadingItemAtURL:url
                                    options:NSFileCoordinatorReadingWithoutChanges
                                      error:&error
                                 byAccessor:^(NSURL*) {
                                   if (begin()) {
                                     (*run)();
                                   }
                                 }];
    return error;
  });
}

template <typename Body>
Coordinated CoordinateWriting(const std::string& path, NSFileCoordinatorWritingOptions options, Body& body) {
  Body* run = &body;
  NSURL* url = UrlFor(path);
  return RunCoordinated([run, url, options](NSFileCoordinator* coordinator, bool (^begin)(void)) {
    NSError* error = nil;
    [coordinator coordinateWritingItemAtURL:url
                                    options:options
                                      error:&error
                                 byAccessor:^(NSURL*) {
                                   if (begin()) {
                                     (*run)();
                                   }
                                 }];
    return error;
  });
}

template <typename Body>
Coordinated CoordinateMoving(const std::string& from, const std::string& to, Body& body) {
  Body* run = &body;
  NSURL* source = UrlFor(from);
  NSURL* destination = UrlFor(to);
  return RunCoordinated([run, source, destination](NSFileCoordinator* coordinator, bool (^begin)(void)) {
    NSError* error = nil;
    [coordinator coordinateWritingItemAtURL:source
                                    options:NSFileCoordinatorWritingForMoving
                           writingItemAtURL:destination
                                    options:NSFileCoordinatorWritingForReplacing
                                      error:&error
                                 byAccessor:^(NSURL* moving, NSURL* replacing) {
                                   if (!begin()) {
                                     return;
                                   }
                                   [coordinator itemAtURL:moving willMoveToURL:replacing];
                                   const bool renamed = (*run)();
                                   [coordinator itemAtURL:moving
                                             didMoveToURL:policy::MovedTo(renamed) ? replacing : moving];
                                 }];
    return error;
  });
}

std::optional<std::string> Uncoordinated(const Coordinated& coordinated, const std::string& folder) {
  switch (coordinated.outcome) {
    case policy::Coordination::kRan:
      return std::nullopt;
    case policy::Coordination::kTimedOut:
      return "The folder " + Quoted(LastComponent(folder)) + " didn\u2019t answer in time.";
    case policy::Coordination::kFailed:
      return "Ardia couldn\u2019t get to " + Quoted(LastComponent(folder)) +
             (coordinated.error.empty() ? std::string(".") : ": " + coordinated.error);
  }
  return std::nullopt;
}

std::optional<std::string> ReadText(const Folder& directory, const std::string& name, std::size_t limit) {
  std::optional<std::string> data;
  auto read = [&] { data = BoundedRead(directory.fd(), name, limit); };
  if (CoordinateReading(directory.Child(name), read).outcome != policy::Coordination::kRan || !data) {
    return std::nullopt;
  }
  if (data->starts_with("bplist")) {
    NSData* bytes = [NSData dataWithBytes:data->data() length:data->size()];
    id plist = [NSPropertyListSerialization propertyListWithData:bytes options:NSPropertyListImmutable format:nil error:nil];
    NSData* xml = plist ? [NSPropertyListSerialization dataWithPropertyList:plist
                                                                     format:NSPropertyListXMLFormat_v1_0
                                                                    options:0
                                                                      error:nil]
                        : nil;
    if (!xml) {
      return std::nullopt;
    }
    std::string converted(static_cast<const char*>(xml.bytes), xml.length);
    return base::IsStringUTF8(converted) ? std::optional(converted) : std::nullopt;
  }
  return base::IsStringUTF8(*data) ? data : std::nullopt;
}

std::optional<std::string> LinkUrl(const Folder& directory, const std::string& name) {
  std::optional<std::string> data = BoundedRead(directory.fd(), name, policy::kMaxLinkBytes);
  if (!data) {
    return std::nullopt;
  }
  NSData* bytes = [NSData dataWithBytes:data->data() length:data->size()];
  id plist = [NSPropertyListSerialization propertyListWithData:bytes options:NSPropertyListImmutable format:nil error:nil];
  if (![plist isKindOfClass:[NSDictionary class]]) {
    return std::nullopt;
  }
  id url = static_cast<NSDictionary*>(plist)[@"URL"];
  if (![url isKindOfClass:[NSString class]]) {
    return std::nullopt;
  }
  return base::SysNSStringToUTF8(
      [static_cast<NSString*>(url) stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]);
}

base::DictValue ExceededLevel() {
  return base::DictValue().Set("entries", base::ListValue()).Set("manifest", base::Value()).Set("manifestPending", true);
}

base::DictValue ErrorLevel(const std::string& message) {
  return ExceededLevel().Set("error", message);
}

base::DictValue Level(const Folder& directory, int depth, ScanBudget& budget) {
  int error = 0;
  std::optional<std::vector<std::string>> names = Names(directory, &budget, SIZE_MAX, &error);
  if (!names) {
    return ErrorLevel("Can’t read " + Quoted(LastComponent(directory.path())) + ": " + ErrorText(error));
  }
  if (budget.Exceeded()) {
    return ExceededLevel();
  }
  const std::set<std::string> present(names->begin(), names->end());
  std::sort(names->begin(), names->end());
  base::ListValue entries;
  base::Value manifest;
  bool manifest_pending = false;
  const auto held = [&entries](const std::string& name, std::string_view reason) {
    entries.Append(base::DictValue().Set("kind", "pending").Set("file", name).Set("reason", reason));
  };
  for (const std::string& name : *names) {
    const std::string path = directory.Child(name);
    const Found found = InfoIn(directory.fd(), name);
    const Kind kind = KindOf(found);
    if (name.starts_with(".")) {
      if (policy::IsManifest(name)) {
        std::optional<std::string> text;
        if (kind == Kind::kFile && !WaitingFor(path)) {
          text = ReadText(directory, name, policy::kMaxManifestBytes);
        }
        if (text) {
          budget.bytes += text->size();
          if (budget.Exceeded()) {
            return ExceededLevel();
          }
          manifest = base::Value(std::move(*text));
        } else {
          manifest_pending = true;
        }
        continue;
      }
      const std::optional<std::string> real = policy::PlaceholderTarget(name);
      if (!real || kind != Kind::kFile) {
        continue;
      }
      StartDownloading(directory.Child(*real));
      if (policy::IsManifest(*real)) {
        manifest_pending = true;
      } else if (policy::IsLinkName(*real) && !present.contains(*real)) {
        held(*real, "download");
      }
      continue;
    }
    switch (kind) {
      case Kind::kDirectory: {
        if (IsPackage(path) || depth >= policy::kMaxDepth) {
          held(name, "unreadable");
          continue;
        }
        Opened child = OpenDirectoryIn(directory, name);
        if (!child.folder) {
          if (child.error == ENOENT) {
            continue;
          }
          if (child.error == ELOOP || child.error == ENOTDIR) {
            held(name, "unreadable");
            continue;
          }
          return ErrorLevel("Can’t read " + Quoted(name) + ": " + ErrorText(child.error));
        }
        base::DictValue inner = Level(*child.folder, depth + 1, budget);
        if (budget.Exceeded()) {
          return ExceededLevel();
        }
        if (const std::string* inner_error = inner.FindString("error")) {
          return ErrorLevel(*inner_error);
        }
        entries.Append(base::DictValue().Set("kind", "dir").Set("file", name).Set("level", std::move(inner)));
        break;
      }
      case Kind::kFile:
        if (!policy::IsLinkName(name)) {
          held(name, "unreadable");
        } else if (static_cast<std::size_t>(found.info.st_size) > policy::kMaxLinkBytes) {
          held(name, "unreadable");
        } else if (std::optional<std::string> reason = WaitingFor(path)) {
          held(name, *reason);
        } else if (std::optional<std::string> text = ReadText(directory, name, policy::kMaxLinkBytes)) {
          budget.bytes += text->size();
          if (budget.Exceeded()) {
            return ExceededLevel();
          }
          entries.Append(base::DictValue().Set("kind", "link").Set("file", name).Set("text", std::move(*text)));
        } else {
          held(name, "unreadable");
        }
        break;
      case Kind::kMissing:
        continue;
      case Kind::kBlocked:
        return ErrorLevel("Can’t read " + Quoted(name) + " in " + Quoted(LastComponent(directory.path())) + ".");
      case Kind::kSymlink:
      case Kind::kOther:
        held(name, "unreadable");
        break;
    }
  }
  return base::DictValue()
      .Set("entries", std::move(entries))
      .Set("manifest", std::move(manifest))
      .Set("manifestPending", manifest_pending);
}

enum class RootState { kOpened, kMissing, kReplaced, kFailed };

struct Root {
  RootState state = RootState::kFailed;
  FolderRef folder;
  int error = 0;
};

Root OpenRoot(const std::string& path, const std::optional<Identity>& identity) {
  const int fd = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | (identity ? O_NOFOLLOW : 0));
  if (fd < 0) {
    const int code = errno;
    struct stat info = {};
    if (identity && (code == ELOOP || code == ENOTDIR) && lstat(path.c_str(), &info) == 0 && S_ISLNK(info.st_mode)) {
      return Root{RootState::kReplaced, nullptr, code};
    }
    return Root{code == ENOENT || code == ENOTDIR ? RootState::kMissing : RootState::kFailed, nullptr, code};
  }
  auto folder = std::make_shared<Folder>(base::ScopedFD(fd), path);
  if (identity && folder->identity() != identity) {
    return Root{RootState::kReplaced, nullptr, 0};
  }
  return Root{RootState::kOpened, std::move(folder), 0};
}

std::string ReplacedMessage(const std::string& path) {
  return Quoted(LastComponent(path)) + " isn’t the folder Ardia added any more.";
}

Outcome Read(const std::string& path, const std::optional<Identity>& identity) {
  const Root root = OpenRoot(path, identity);
  switch (root.state) {
    case RootState::kMissing:
      return Succeeded(base::Value(base::DictValue().Set("exists", false)));
    case RootState::kReplaced:
      return Succeeded(base::Value(base::DictValue().Set("exists", false).Set("error", ReplacedMessage(path))));
    case RootState::kFailed:
      return Succeeded(base::Value(base::DictValue().Set("exists", false).Set(
          "error", "Can’t open " + Quoted(LastComponent(path)) + ": " + ErrorText(root.error))));
    case RootState::kOpened:
      break;
  }
  ScanBudget budget;
  base::DictValue top = Level(*root.folder, 0, budget);
  if (budget.Exceeded()) {
    return Succeeded(base::Value(base::DictValue().Set("exists", false).Set(
        "error", Quoted(LastComponent(path)) + " holds more than " + std::to_string(policy::kMaxEntries) +
                     " items or " + std::to_string(policy::kMaxScanBytes / 1024 / 1024) +
                     " MB of links; Ardia syncs smaller folders.")));
  }
  return Succeeded(base::Value(base::DictValue().Set("exists", true).Set("root", std::move(top))));
}

struct Step {
  std::optional<std::string> conflict;
  std::optional<std::string> failure;
};

Step Conflict(std::string path) {
  return Step{std::move(path), std::nullopt};
}

Step Failed(std::string message) {
  return Step{std::nullopt, std::move(message)};
}

struct Parent {
  FolderRef folder;
  std::optional<std::string> failure;
};

Parent ParentOf(const std::vector<std::string>& parts, const FolderRef& root) {
  FolderRef current = root;
  for (std::size_t index = 0; index + 1 < parts.size(); ++index) {
    Opened next = OpenDirectoryIn(*current, parts[index]);
    if (!next.folder) {
      if (next.error == ENOENT) {
        return Parent{};
      }
      if (next.error == ELOOP || next.error == ENOTDIR) {
        return Parent{nullptr, kOutside};
      }
      return Parent{nullptr, PosixFailure(next.error)};
    }
    current = std::move(next.folder);
  }
  if (KindIn(*current, parts.back()) == Kind::kSymlink) {
    return Parent{nullptr, kOutside};
  }
  return Parent{std::move(current), std::nullopt};
}

struct Staged {
  NSURL* staging = nil;
  std::string temporary;
};

std::optional<Staged> Stage(const std::string& text, const Folder& near, const std::string& name) {
  NSFileManager* files = [NSFileManager defaultManager];
  NSURL* staging = [files URLForDirectory:NSItemReplacementDirectory
                                 inDomain:NSUserDomainMask
                        appropriateForURL:UrlFor(near.path(), true)
                                   create:YES
                                    error:nil];
  if (!staging) {
    return std::nullopt;
  }
  const std::string temporary = base::SysNSStringToUTF8(staging.path) + "/" + name;
  if (!base::WriteFile(base::FilePath(temporary), text)) {
    [files removeItemAtURL:staging error:nil];
    return std::nullopt;
  }
  return Staged{staging, temporary};
}

void Unstage(const Staged& staged) {
  [[NSFileManager defaultManager] removeItemAtURL:staged.staging error:nil];
}

Step Write(const std::string& text,
           const Folder& folder,
           const std::string& name,
           bool create,
           const std::optional<std::string>& expect,
           const std::string& path) {
  std::optional<Staged> staged = Stage(text, folder, name);
  if (!staged) {
    return Failed("The link couldn’t be staged next to " + Quoted(LastComponent(folder.path())) + ".");
  }
  bool landed = false;
  int failure = 0;
  auto body = [&] {
    switch (KindIn(folder, name)) {
      case Kind::kMissing:
        if (!create && expect) {
          return;
        }
        if (renameatx_np(AT_FDCWD, staged->temporary.c_str(), folder.fd(), name.c_str(), RENAME_EXCL) == 0) {
          landed = true;
        } else if (errno != EEXIST) {
          failure = errno;
        }
        return;
      case Kind::kFile:
        if (create) {
          return;
        }
        if (expect && LinkUrl(folder, name) != expect) {
          return;
        }
        if (renameatx_np(AT_FDCWD, staged->temporary.c_str(), folder.fd(), name.c_str(), 0) == 0) {
          landed = true;
        } else {
          failure = errno;
        }
        return;
      default:
        return;
    }
  };
  const Coordinated coordinated = CoordinateWriting(folder.Child(name), NSFileCoordinatorWritingForReplacing, body);
  Unstage(*staged);
  if (std::optional<std::string> failed = Uncoordinated(coordinated, folder.path())) {
    return Failed(*failed);
  }
  if (failure) {
    return Failed(PosixFailure(failure));
  }
  return landed ? Step{} : Conflict(path);
}

Step Move(const Folder& source,
          const std::string& name,
          const Folder& destination,
          const std::string& target,
          const std::string& to_path) {
  if (KindIn(destination, target) != Kind::kMissing) {
    return Conflict(to_path);
  }
  bool moved = false;
  int failure = 0;
  auto body = [&]() -> bool {
    if (KindIn(destination, target) != Kind::kMissing) {
      return false;
    }
    if (renameatx_np(source.fd(), name.c_str(), destination.fd(), target.c_str(), RENAME_EXCL) == 0) {
      moved = true;
    } else if (errno != EEXIST) {
      failure = errno;
    }
    return moved;
  };
  if (std::optional<std::string> failed =
          Uncoordinated(CoordinateMoving(source.Child(name), destination.Child(target), body), source.path())) {
    return Failed(*failed);
  }
  if (failure) {
    return Failed(PosixFailure(failure));
  }
  return moved ? Step{} : Conflict(to_path);
}

Step Delete(const Folder& folder, const std::string& name, const std::string& expect, const std::string& path) {
  const Kind kind = KindIn(folder, name);
  if (kind == Kind::kMissing && KindIn(folder, policy::PlaceholderFor(name)) == Kind::kFile) {
    StartDownloading(folder.Child(name));
    return Conflict(path);
  }
  if (kind == Kind::kBlocked) {
    return Conflict(path);
  }
  if (kind != Kind::kFile) {
    return Step{};
  }
  int failure = 0;
  auto body = [&] {
    if (LinkUrl(folder, name) != expect) {
      return;
    }
    if (unlinkat(folder.fd(), name.c_str(), 0) != 0 && errno != ENOENT) {
      failure = errno;
    }
  };
  if (std::optional<std::string> failed =
          Uncoordinated(CoordinateWriting(folder.Child(name), NSFileCoordinatorWritingForDeleting, body), folder.path())) {
    return Failed(*failed);
  }
  return failure ? Failed(PosixFailure(failure)) : Step{};
}

void RestoreExclusively(const std::string& order, const Folder& directory) {
  std::optional<Staged> staged = Stage(order, directory, std::string(policy::kManifestName));
  if (!staged) {
    return;
  }
  renameatx_np(AT_FDCWD, staged->temporary.c_str(), directory.fd(), std::string(policy::kManifestName).c_str(),
               RENAME_EXCL);
  Unstage(*staged);
}

std::optional<std::string> RemoveEmptyDirectory(const Folder& parent, const std::string& name) {
  if (KindIn(parent, name) != Kind::kDirectory) {
    return std::nullopt;
  }
  Opened directory = OpenDirectoryIn(parent, name);
  if (!directory.folder) {
    if (directory.error == ENOENT || directory.error == ENOTDIR || directory.error == ELOOP) {
      return std::nullopt;
    }
    return PosixFailure(directory.error);
  }
  int error = 0;
  std::optional<std::vector<std::string>> names =
      Names(*directory.folder, nullptr, std::size(policy::kHousekeeping) + 1, &error);
  if (!names) {
    return PosixFailure(error);
  }
  if (!std::ranges::all_of(*names, [](const std::string& item) { return policy::IsHousekeeping(item); })) {
    return std::nullopt;
  }
  const std::string manifest(policy::kManifestName);
  const std::optional<std::string> order =
      KindIn(*directory.folder, manifest) == Kind::kFile
          ? BoundedRead(directory.folder->fd(), manifest, policy::kMaxManifestBytes)
          : std::nullopt;
  for (std::string_view item : policy::kHousekeeping) {
    const std::string housekeeping(item);
    if (KindIn(*directory.folder, housekeeping) == Kind::kFile) {
      unlinkat(directory.folder->fd(), housekeeping.c_str(), 0);
    }
  }
  if (unlinkat(parent.fd(), name.c_str(), AT_REMOVEDIR) == 0) {
    return std::nullopt;
  }
  const int code = errno;
  if (order) {
    RestoreExclusively(*order, *directory.folder);
  }
  if (code != ENOTEMPTY && code != ENOENT && code != EEXIST) {
    return PosixFailure(code);
  }
  return std::nullopt;
}

const std::string* StringField(const base::DictValue& op, std::string_view key) {
  return op.FindString(key);
}

std::optional<std::string> OptionalStringField(const base::DictValue& op, std::string_view key) {
  const std::string* value = op.FindString(key);
  return value ? std::optional(*value) : std::nullopt;
}

Step ApplyOne(const base::DictValue& op, const FolderRef& root) {
  const std::string* kind_name = StringField(op, "op");
  const std::string* path = StringField(op, "path");
  const std::optional<std::vector<std::string>> parts = path ? policy::RelativeParts(*path) : std::nullopt;
  if (!kind_name || !parts) {
    return Failed(kOutside);
  }
  const std::string& name = parts->back();
  const Parent parent = ParentOf(*parts, root);
  if (parent.failure) {
    return Failed(*parent.failure);
  }
  const FolderRef& folder = parent.folder;
  switch (policy::OpNamed(*kind_name)) {
    case policy::OpKind::kWrite: {
      const std::string* text = StringField(op, "text");
      if (!text || !policy::WritableName(name)) {
        return Failed("Only links and the folder’s order are written.");
      }
      if (!folder) {
        return Conflict(*path);
      }
      return Write(*text, *folder, name, op.FindBool("create").value_or(true), OptionalStringField(op, "expect"), *path);
    }
    case policy::OpKind::kMove: {
      const std::string* to_path = StringField(op, "to");
      const std::optional<std::vector<std::string>> to_parts = to_path ? policy::RelativeParts(*to_path) : std::nullopt;
      if (!to_parts) {
        return Failed("A rename pointed outside the shared folder.");
      }
      const Parent destination = ParentOf(*to_parts, root);
      if (destination.failure) {
        return Failed(*destination.failure);
      }
      const Kind from = folder ? KindIn(*folder, name) : Kind::kMissing;
      const bool movable = from == Kind::kMissing || from == Kind::kDirectory ||
                           (from == Kind::kFile && policy::IsLinkName(name));
      if (!movable || (!policy::IsLinkName(to_parts->back()) && from == Kind::kFile)) {
        return Failed("Only links and folders are renamed.");
      }
      if (!folder || from == Kind::kMissing) {
        return Step{};
      }
      if (!destination.folder) {
        return Conflict(*to_path);
      }
      return Move(*folder, name, *destination.folder, to_parts->back(), *to_path);
    }
    case policy::OpKind::kDelete: {
      const std::optional<std::string> expect = OptionalStringField(op, "expect");
      if (!policy::IsLinkName(name) || !expect) {
        return Failed("Only links are deleted.");
      }
      if (!folder) {
        return Step{};
      }
      return Delete(*folder, name, *expect, *path);
    }
    case policy::OpKind::kMkdir: {
      if (!folder) {
        return Conflict(*path);
      }
      switch (KindIn(*folder, name)) {
        case Kind::kDirectory:
          return Step{};
        case Kind::kMissing:
          if (mkdirat(folder->fd(), name.c_str(), 0755) != 0 && errno != EEXIST) {
            return Failed(PosixFailure(errno));
          }
          return KindIn(*folder, name) == Kind::kDirectory ? Step{} : Conflict(*path);
        default:
          return Conflict(*path);
      }
    }
    case policy::OpKind::kRmdir: {
      if (folder) {
        if (std::optional<std::string> failure = RemoveEmptyDirectory(*folder, name)) {
          return Failed(*failure);
        }
      }
      return Step{};
    }
    case policy::OpKind::kUnknown:
      return Failed("Unknown folder change " + Quoted(*kind_name) + ".");
  }
  return Failed(kOutside);
}

Outcome Apply(const std::string& path, const std::string& json, const std::optional<Identity>& identity) {
  std::optional<base::Value> parsed =
      json.size() <= policy::kMaxOpsBytes ? base::JSONReader::Read(json, base::JSON_PARSE_RFC) : std::nullopt;
  if (!parsed || !parsed->is_list() || parsed->GetList().size() > policy::kMaxOps) {
    return Refused("The folder changes couldn’t be read.");
  }
  for (const base::Value& op : parsed->GetList()) {
    if (!op.is_dict()) {
      return Refused("The folder changes couldn’t be read.");
    }
  }
  const Root root = OpenRoot(path, identity);
  switch (root.state) {
    case RootState::kMissing:
      return Refused("The folder " + Quoted(LastComponent(path)) + " is missing.");
    case RootState::kReplaced:
      return Refused(ReplacedMessage(path));
    case RootState::kFailed:
      return Refused("Can’t open " + Quoted(LastComponent(path)) + ": " + ErrorText(root.error));
    case RootState::kOpened:
      break;
  }
  base::ListValue conflicts;
  for (const base::Value& op : parsed->GetList()) {
    Step step = ApplyOne(op.GetDict(), root.folder);
    if (step.failure) {
      return Refused(*step.failure);
    }
    if (step.conflict) {
      conflicts.Append(std::move(*step.conflict));
      break;
    }
  }
  return Succeeded(base::Value(base::DictValue().Set("conflicts", std::move(conflicts))));
}

std::string HomeDirectory() {
  const std::string home = base::SysNSStringToUTF8(NSHomeDirectory());
  return RealPath(home).value_or(home);
}

Outcome Resolve(const std::string& path) {
  const std::string name = LastComponent(path);
  const std::optional<std::string> real = RealPath(path);
  if (!real) {
    const int code = errno;
    return Refused(code == ENOENT ? "There’s no folder at " + path + "."
                                  : "Can’t open " + Quoted(name) + ": " + ErrorText(code));
  }
  if (policy::RefusedFolder(*real, HomeDirectory())) {
    return Refused(*real + " is a system or home folder; pick a folder inside it.", policy::kRefusedCode);
  }
  const std::optional<Identity> found = DirectoryIdentity(*real);
  if (!found) {
    return Refused(Quoted(name) + " isn’t a folder Ardia can sync.");
  }
  if (access(real->c_str(), R_OK | X_OK) != 0) {
    return Refused("Can’t read " + Quoted(name) + ": " + ErrorText(errno));
  }
  return Succeeded(base::Value(Resolved(*real, *found)));
}

Outcome Create(const std::string& parent_path, const std::optional<Identity>& parent_identity, const std::string& name) {
  const std::string parent_name = LastComponent(parent_path);
  if (!parent_identity && !base::CreateDirectory(base::FilePath(parent_path))) {
    return Refused("Can’t make " + Quoted(parent_name) + ".");
  }
  const int fd = open(parent_path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | (parent_identity ? O_NOFOLLOW : 0));
  if (fd < 0) {
    return Refused("Can’t open " + Quoted(parent_name) + ": " + ErrorText(errno));
  }
  const Folder parent(base::ScopedFD(fd), RealPath(parent_path).value_or(parent_path));
  if (parent_identity && parent.identity() != parent_identity) {
    return Refused(Quoted(parent_name) + " isn’t the folder that was checked any more; nothing was made.");
  }
  const std::string stem = policy::FolderName(name);
  for (int number = 1; number <= policy::kMaxNumberedCopies; ++number) {
    const std::string candidate = policy::NumberedName(stem, number);
    if (mkdirat(parent.fd(), candidate.c_str(), 0755) == 0) {
      Opened made = OpenDirectoryIn(parent, candidate);
      const std::optional<Identity> found = made.folder ? made.folder->identity() : std::nullopt;
      if (!found) {
        return Refused("The new folder " + Quoted(candidate) + " couldn’t be opened.");
      }
      return Succeeded(base::Value(Resolved(made.folder->path(), *found)));
    }
    if (errno != EEXIST) {
      return Refused(PosixFailure(errno));
    }
  }
  return Refused("Every name like " + Quoted(stem) + " is taken.");
}

Outcome Discard(const std::string& path, const Identity& expected) {
  base::ScopedFD fd(open(DirectoryOf(path).c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  if (!fd.is_valid()) {
    return Succeeded(base::Value(false));
  }
  const std::string name = LastComponent(path);
  struct stat info = {};
  if (fstatat(fd.get(), name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(info.st_mode) ||
      IdentityOf(info) != expected) {
    return Succeeded(base::Value(false));
  }
  return Succeeded(base::Value(unlinkat(fd.get(), name.c_str(), AT_REMOVEDIR) == 0));
}

std::optional<std::string> ExplicitDataDirectory() {
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  if (command->HasSwitch("ardia-data-dir")) {
    return command->GetSwitchValuePath("ardia-data-dir").value();
  }
  if (const char* data = getenv("ARDIA_DATA_DIR"); data && *data) {
    return std::string(data);
  }
  return std::nullopt;
}

std::string ICloudDrive() {
  return base::SysNSStringToUTF8(NSHomeDirectory()) + "/" + std::string(policy::kICloudDriveSuffix);
}

std::string StringAt(const base::ListValue* values, std::size_t index) {
  return values && index < values->size() && (*values)[index].is_string() ? (*values)[index].GetString()
                                                                           : std::string();
}

bool NullAt(const base::ListValue* values, std::size_t index) {
  return !values || index >= values->size() || (*values)[index].is_none();
}

std::optional<Identity> IdentityAt(const base::ListValue* values, std::size_t index) {
  if (!values || index >= values->size() || !(*values)[index].is_dict()) {
    return std::nullopt;
  }
  const base::DictValue& identity = (*values)[index].GetDict();
  const std::optional<double> device = identity.FindDouble("device");
  const std::optional<double> inode = identity.FindDouble("inode");
  if (!device || !inode) {
    return std::nullopt;
  }
  return policy::IdentityFrom(*device, *inode);
}

void RunOnFolders(base::OnceCallback<Outcome()> work, Done done) {
  FolderRunner()->PostTaskAndReplyWithResult(
      FROM_HERE, std::move(work),
      base::BindOnce([](Done done, Outcome outcome) { std::move(done).Run(outcome.ok, std::move(outcome.value)); },
                     std::move(done)));
}

void Watch(ShellHostView& host, const base::ListValue* values, Done done) {
  std::vector<std::string> paths;
  if (values && !values->empty() && (*values)[0].is_list()) {
    for (const base::Value& path : (*values)[0].GetList()) {
      if (path.is_string()) {
        paths.push_back(path.GetString());
      }
    }
  }
  if (!policy::WatchedPathsValid(paths)) {
    return std::move(done).Run(false, Failure("ERR_SHARED_FOLDER_REQUEST", "The watched folders aren’t valid"));
  }
  std::unique_ptr<Watcher>& watcher = host.shared_folder_watcher();
  if (!watcher) {
    watcher = std::make_unique<Watcher>(base::BindRepeating(
        [](base::WeakPtr<ShellHostView> host, std::vector<std::string> changed) {
          if (!host) {
            return;
          }
          base::ListValue list;
          for (std::string& path : changed) {
            list.Append(std::move(path));
          }
          host->Emit("ArdiaSharedFolders", "onChange", base::Value(base::DictValue().Set("paths", std::move(list))));
        },
        host.GetWeakPtr()));
  }
  watcher->Watch(std::move(paths));
  std::move(done).Run(true, base::Value());
}

void RevealFolder(ShellHostView& host, const base::ListValue* values, Done done) {
  const std::string path = StringAt(values, 0);
  if (!policy::ValidAbsolutePath(path)) {
    return std::move(done).Run(false, Failure("ERR_SHARED_FOLDER_REQUEST", "Only a folder on this Mac can be shown"));
  }
  if (BackgroundInstance()) {
    host.Note("reveal folder (not shown): " + path);
  } else {
    [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[ UrlFor(path, true) ]];
  }
  std::move(done).Run(true, base::Value());
}

}

struct Watcher::Core {
  dispatch_queue_t queue = nil;
  FSEventStreamRef stream = nullptr;
  FSEventStreamEventId last_event = kFSEventStreamEventIdSinceNow;
  std::vector<std::pair<std::string, std::string>> roots;
  scoped_refptr<base::SequencedTaskRunner> reply_runner;
  base::WeakPtr<Watcher> watcher;

  void StopStream() {
    if (!stream) {
      return;
    }
    const FSEventStreamEventId latest = FSEventStreamGetLatestEventId(stream);
    if (latest != 0) {
      last_event = latest;
    }
    FSEventStreamStop(stream);
    FSEventStreamInvalidate(stream);
    FSEventStreamRelease(stream);
    stream = nullptr;
  }

  void Changed(NSArray* paths) {
    std::vector<std::string> watched;
    for (const auto& [requested, real] : roots) {
      for (id path in paths) {
        if ([path isKindOfClass:[NSString class]] &&
            policy::WatchHit(real, base::SysNSStringToUTF8(static_cast<NSString*>(path)))) {
          watched.push_back(requested);
          break;
        }
      }
    }
    if (!watched.empty()) {
      reply_runner->PostTask(FROM_HERE, base::BindOnce(&Watcher::Deliver, watcher, std::move(watched)));
    }
  }

  static void Callback(ConstFSEventStreamRef,
                       void* info,
                       size_t,
                       void* paths,
                       const FSEventStreamEventFlags*,
                       const FSEventStreamEventId*) {
    if (info) {
      static_cast<Core*>(info)->Changed((__bridge NSArray*)paths);
    }
  }

  void Restart() {
    StopStream();
    if (roots.empty()) {
      return;
    }
    NSMutableArray* real_paths = [NSMutableArray array];
    for (const auto& root : roots) {
      [real_paths addObject:base::SysUTF8ToNSString(root.second)];
    }
    FSEventStreamContext context = {0, this, nullptr, nullptr, nullptr};
    const FSEventStreamCreateFlags flags = kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot |
                                           kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagUseCFTypes;
    FSEventStreamRef created = FSEventStreamCreate(nullptr, &Core::Callback, &context,
                                                   (__bridge CFArrayRef)real_paths, last_event, 0.2, flags);
    if (!created) {
      return;
    }
    FSEventStreamSetDispatchQueue(created, queue);
    if (!FSEventStreamStart(created)) {
      FSEventStreamInvalidate(created);
      FSEventStreamRelease(created);
      return;
    }
    stream = created;
  }
};

Watcher::Watcher(OnChange on_change) : core_(std::make_unique<Core>()), on_change_(std::move(on_change)) {
  core_->queue = dispatch_queue_create("dev.ardia.mac.webui.shared-folders.watch", DISPATCH_QUEUE_SERIAL);
  core_->reply_runner = base::SequencedTaskRunner::GetCurrentDefault();
  core_->watcher = weak_factory_.GetWeakPtr();
}

Watcher::~Watcher() {
  Core* core = core_.release();
  dispatch_async(core->queue, ^{
    core->roots.clear();
    core->StopStream();
    delete core;
  });
}

void Watcher::Deliver(std::vector<std::string> paths) {
  on_change_.Run(std::move(paths));
}

void Watcher::Watch(std::vector<std::string> paths) {
  Core* core = core_.get();
  auto requested = std::make_shared<std::vector<std::string>>(std::move(paths));
  dispatch_async(core->queue, ^{
    std::vector<std::pair<std::string, std::string>> next;
    for (const std::string& path : *requested) {
      next.emplace_back(path, RealPath(path).value_or(base::FilePath(path).StripTrailingSeparators().value()));
    }
    const auto real_of = [](const std::vector<std::pair<std::string, std::string>>& roots) {
      std::vector<std::string> real;
      for (const auto& root : roots) {
        real.push_back(root.second);
      }
      return real;
    };
    const bool same = real_of(next) == real_of(core->roots);
    core->roots = std::move(next);
    if (same && (core->stream || core->roots.empty())) {
      return;
    }
    core->Restart();
  });
}

bool Handles(std::string_view method) {
  return std::ranges::find(kCapabilities, method) != std::end(kCapabilities);
}

void AppendCapabilities(base::ListValue& capabilities) {
  for (std::string_view capability : kCapabilities) {
    capabilities.Append(capability);
  }
}

base::DictValue Location() {
  const std::string icloud = ICloudDrive();
  const std::optional<std::string> data = ExplicitDataDirectory();
  const std::string parent =
      (data ? *data : icloud) + "/" + std::string(policy::kSharedParentName);
  struct stat info = {};
  const bool available = stat(icloud.c_str(), &info) == 0 && S_ISDIR(info.st_mode);
  return base::DictValue().Set("path", parent).Set("iCloudAvailable", available).Set("iCloudPath", icloud);
}

void Invoke(ShellHostView& host,
            const std::string& method,
            const base::ListValue* values,
            ShellHostView::Done done) {
  const std::string first = StringAt(values, 0);
  const auto refuse = [&done](std::string_view message) {
    std::move(done).Run(false, Failure("ERR_SHARED_FOLDER_REQUEST", message));
  };
  if (method == "ArdiaSharedFolders.watch") {
    return Watch(host, values, std::move(done));
  }
  if (method == "ArdiaSharedFolders.revealFolder") {
    return RevealFolder(host, values, std::move(done));
  }
  if (method == "ArdiaSharedFolders.location") {
    return RunOnFolders(base::BindOnce([] { return Succeeded(base::Value(Location())); }), std::move(done));
  }
  if (!policy::ValidAbsolutePath(first)) {
    return refuse("A shared folder path must be absolute");
  }
  if (method == "ArdiaSharedFolders.read" || method == "ArdiaSharedFolders.apply") {
    const std::size_t identity_index = method == "ArdiaSharedFolders.read" ? 1 : 2;
    const std::optional<Identity> identity = IdentityAt(values, identity_index);
    if (!identity && !NullAt(values, identity_index)) {
      return refuse("A shared folder identity is a device and an inode");
    }
    if (method == "ArdiaSharedFolders.read") {
      return RunOnFolders(base::BindOnce(&Read, first, identity), std::move(done));
    }
    if (!values || values->size() < 2 || !(*values)[1].is_string()) {
      return refuse("Folder changes are JSON text");
    }
    return RunOnFolders(base::BindOnce(&Apply, first, (*values)[1].GetString(), identity), std::move(done));
  }
  if (method == "ArdiaSharedFolders.resolve") {
    return RunOnFolders(base::BindOnce(&Resolve, first), std::move(done));
  }
  if (method == "ArdiaSharedFolders.discard") {
    const std::optional<Identity> identity = IdentityAt(values, 1);
    if (!identity) {
      return refuse("A shared folder identity is a device and an inode");
    }
    return RunOnFolders(base::BindOnce(&Discard, first, *identity), std::move(done));
  }
  if (method == "ArdiaSharedFolders.create") {
    const std::optional<Identity> identity = IdentityAt(values, 1);
    if (!identity && !NullAt(values, 1)) {
      return refuse("A shared folder identity is a device and an inode");
    }
    if (!values || values->size() < 3 || !(*values)[2].is_string() ||
        (*values)[2].GetString().size() > policy::kMaxPathBytes) {
      return refuse("A shared folder needs a name");
    }
    return RunOnFolders(base::BindOnce(&Create, first, identity, (*values)[2].GetString()), std::move(done));
  }
  refuse("Unknown shared folder call");
}

}
