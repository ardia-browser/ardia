// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_control_file.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <algorithm>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/posix/eintr_wrapper.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/strcat.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/synchronization/lock.h"
#include "build/build_config.h"
#include "chrome/common/chrome_paths.h"

#if BUILDFLAG(IS_MAC)
#include <membership.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <uuid/uuid.h>
#endif

namespace ardia {
namespace {

constexpr char kControlFileName[] = "ArdiaControl.json";

base::Lock& PublishLock() {
  static base::NoDestructor<base::Lock> lock;
  return *lock;
}

uint64_t g_live_generation = 0;

std::string ErrnoText() {
  return base::ToLowerASCII(strerror(errno));
}

#if BUILDFLAG(IS_MAC)
enum class AclState { kNone, kDenyOnly, kAllows, kUnknown };

AclState ExtendedAcl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) {
    return errno == ENOENT || errno == ENOTSUP ? AclState::kNone
                                               : AclState::kUnknown;
  }
  uuid_t owner;
  const bool owner_known = mbr_uid_to_uuid(geteuid(), owner) == 0;
  AclState state = AclState::kDenyOnly;
  acl_entry_t entry;
  for (int id = ACL_FIRST_ENTRY; acl_get_entry(acl, id, &entry) == 0;
       id = ACL_NEXT_ENTRY) {
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag) != 0) {
      state = AclState::kAllows;
      break;
    }
    if (tag == ACL_EXTENDED_DENY) {
      continue;
    }
    void* qualifier = acl_get_qualifier(entry);
    const bool only_owner =
        tag == ACL_EXTENDED_ALLOW && qualifier && owner_known &&
        uuid_compare(*static_cast<uuid_t*>(qualifier), owner) == 0;
    if (qualifier) {
      acl_free(qualifier);
    }
    if (!only_owner) {
      state = AclState::kAllows;
      break;
    }
  }
  acl_free(acl);
  return state;
}
#endif

#if BUILDFLAG(IS_LINUX)
enum class MountCheck { kEnforced, kShared, kUnknown };

MountCheck PermissionsOfMount(int dir_fd) {
  std::string fdinfo;
  if (!base::ReadFileToString(
          base::FilePath(base::StrCat(
              {"/proc/self/fdinfo/", base::NumberToString(dir_fd)})),
          &fdinfo)) {
    return MountCheck::kUnknown;
  }
  std::string mount_id;
  for (std::string_view line : base::SplitStringPiece(
           fdinfo, "\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    if (base::StartsWith(line, "mnt_id:")) {
      mount_id = std::string(base::TrimWhitespaceASCII(
          line.substr(strlen("mnt_id:")), base::TRIM_ALL));
    }
  }
  std::string mounts;
  if (mount_id.empty() ||
      !base::ReadFileToString(base::FilePath("/proc/self/mountinfo"),
                              &mounts)) {
    return MountCheck::kUnknown;
  }
  for (std::string_view line : base::SplitStringPiece(
           mounts, "\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    const std::vector<std::string_view> fields = base::SplitStringPiece(
        line, " ", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
    if (fields.empty() || fields[0] != mount_id) {
      continue;
    }
    const auto dash = std::ranges::find(fields, std::string_view("-"));
    if (dash == fields.end() || fields.end() - dash < 4) {
      return MountCheck::kUnknown;
    }
    const std::string_view type = *(dash + 1);
    const std::vector<std::string_view> options = base::SplitStringPiece(
        *(dash + 3), ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
    const auto has = [&options](std::string_view option) {
      return std::ranges::find(options, option) != options.end();
    };
    const bool fuse = type == "fuse" || type == "fuseblk" ||
                      base::StartsWith(type, "fuse.") ||
                      base::StartsWith(type, "fuseblk.");
    if (fuse) {
      return has("allow_other") && !has("default_permissions")
                 ? MountCheck::kShared
                 : MountCheck::kEnforced;
    }
    if (type == "cifs" || type == "smb3") {
      return has("noperm") ? MountCheck::kShared : MountCheck::kEnforced;
    }
    return MountCheck::kEnforced;
  }
  return MountCheck::kUnknown;
}
#endif

std::string UnsafeControlFolder(int dir_fd, const base::FilePath& dir) {
  struct stat info;
  if (fstat(dir_fd, &info) != 0) {
    return base::StrCat({"Couldn't read ", dir.value(), ": ", ErrnoText()});
  }
  if (!S_ISDIR(info.st_mode)) {
    return base::StrCat({dir.value(), " isn't a folder."});
  }
  if (info.st_uid != geteuid()) {
    return base::StrCat({dir.value(), " belongs to another user."});
  }
  if (info.st_mode & (S_IWGRP | S_IWOTH)) {
    return base::StrCat({"Others can write to ", dir.value(), "."});
  }
#if BUILDFLAG(IS_LINUX)
  switch (PermissionsOfMount(dir_fd)) {
    case MountCheck::kEnforced:
      break;
    case MountCheck::kShared:
      return base::StrCat(
          {dir.value(), " is on a shared mount that doesn't check "
                        "permissions (FUSE allow_other without "
                        "default_permissions, or SMB noperm), so other users "
                        "could read the control token there."});
    case MountCheck::kUnknown:
      return base::StrCat({"Couldn't check the mount ", dir.value(),
                           " is on (/proc/self/mountinfo), so the control "
                           "token isn't published there."});
  }
#endif
#if BUILDFLAG(IS_MAC)
  struct statfs volume;
  if (fstatfs(dir_fd, &volume) != 0) {
    return base::StrCat({"Couldn't read ", dir.value(), ": ", ErrnoText()});
  }
  if (volume.f_flags & MNT_IGNORE_OWNERSHIP) {
    return base::StrCat(
        {dir.value(), " is on a disk that ignores ownership, so anyone "
                      "could read the control token there."});
  }
  if (const AclState acl = ExtendedAcl(dir_fd);
      acl != AclState::kNone && acl != AclState::kDenyOnly) {
    return base::StrCat({dir.value(),
                         " has an access list that lets someone else in."});
  }
#endif
  return std::string();
}

bool OnlyOwnerCanRead(int fd) {
  if (fchmod(fd, S_IRUSR | S_IWUSR) != 0) {
    return false;
  }
#if BUILDFLAG(IS_MAC)
  if (ExtendedAcl(fd) != AclState::kNone) {
    acl_t empty = acl_init(0);
    if (!empty) {
      return false;
    }
    const bool cleared = acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED) == 0;
    acl_free(empty);
    if (!cleared || ExtendedAcl(fd) != AclState::kNone) {
      return false;
    }
  }
#endif
  struct stat info;
  return fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
         info.st_uid == geteuid() &&
         (info.st_mode & 07777) == (S_IRUSR | S_IWUSR);
}

base::ScopedFD& PublishedFolder() {
  static base::NoDestructor<base::ScopedFD> folder;
  return *folder;
}

}

base::FilePath ControlFilePath() {
  base::FilePath dir;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &dir)) {
    return base::FilePath();
  }
  return dir.Append(kControlFileName);
}

void SetLiveGeneration(uint64_t generation) {
  base::AutoLock hold(PublishLock());
  g_live_generation = generation;
}

std::string WriteControlFile(const base::FilePath& path,
                             const std::string& contents,
                             uint64_t generation) {
  if (path.empty()) {
    return "Ardia has no data folder.";
  }
  const base::FilePath dir_path = path.DirName();
  base::ScopedFD dir(HANDLE_EINTR(
      open(dir_path.value().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC)));
  if (!dir.is_valid()) {
    return base::StrCat({"Couldn't open ", dir_path.value(), ": ", ErrnoText()});
  }
  if (std::string unsafe = UnsafeControlFolder(dir.get(), dir_path);
      !unsafe.empty()) {
    return unsafe;
  }
  const std::string name = path.BaseName().value();
  const std::string temp =
      "." + name + "." + base::HexEncode(base::RandBytesAsVector(8));
  const int fd = HANDLE_EINTR(
      openat(dir.get(), temp.c_str(),
             O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
  if (fd < 0) {
    return base::StrCat({"Couldn't write ", path.value(), ": ", ErrnoText()});
  }
  bool written = OnlyOwnerCanRead(fd);
  std::string error =
      written ? std::string() : "it couldn't be made readable only by you";
  if (written) {
    written = base::WriteFileDescriptor(fd, contents) && fsync(fd) == 0;
    error = written ? std::string() : ErrnoText();
  }
  if (IGNORE_EINTR(close(fd)) != 0 && written) {
    written = false;
    error = ErrnoText();
  }
  if (!written) {
    unlinkat(dir.get(), temp.c_str(), 0);
    return base::StrCat({"Couldn't write ", path.value(), ": ", error});
  }
  {
    base::AutoLock hold(PublishLock());
    if (g_live_generation != generation) {
      unlinkat(dir.get(), temp.c_str(), 0);
      return "The control server stopped.";
    }
    if (renameat(dir.get(), temp.c_str(), dir.get(), name.c_str()) != 0) {
      error = ErrnoText();
      unlinkat(dir.get(), temp.c_str(), 0);
      return base::StrCat({"Couldn't write ", path.value(), ": ", error});
    }
  }
  PublishedFolder() = std::move(dir);
  return std::string();
}

void DeleteStaleControlFile(const base::FilePath& path) {
  if (!path.empty() && unlink(path.value().c_str()) != 0 && errno != ENOENT &&
      errno != EISDIR && errno != EPERM) {
    PLOG(ERROR) << "[ardia] can't delete " << path;
  }
}

void DeleteControlFile(const base::FilePath& path) {
  base::ScopedFD published = std::move(PublishedFolder());
  if (path.empty() || !published.is_valid()) {
    return;
  }
  if (unlinkat(published.get(), path.BaseName().value().c_str(), 0) != 0 &&
      errno != ENOENT && errno != EISDIR && errno != EPERM) {
    PLOG(ERROR) << "[ardia] can't delete " << path;
  }
}

}
