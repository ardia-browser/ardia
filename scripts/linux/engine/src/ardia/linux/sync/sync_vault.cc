// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/sync/sync_vault.h"

#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <set>
#include <utility>

#include "ardia/linux/sync/sync_logins.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/posix/eintr_wrapper.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/types/expected_macros.h"

namespace ardia_linux::sync {

namespace {

constexpr char kLink[] = "the sync folder holds a link where sync data belongs";
constexpr char kUnreachable[] = "the sync folder isn't reachable";
constexpr char kFolderUnreadable[] = "ERR_SYNC_FOLDER_UNREADABLE";

enum class Kind { kDirectory, kAbsent, kOther, kError };

Kind KindOf(const base::FilePath& path) {
  struct stat facts;
  if (lstat(path.value().c_str(), &facts) != 0) {
    return errno == ENOENT || errno == ENOTDIR ? Kind::kAbsent : Kind::kError;
  }
  return S_ISDIR(facts.st_mode) ? Kind::kDirectory : Kind::kOther;
}

VaultError Failure(std::string message, std::string code = std::string()) {
  return VaultError{std::move(message), std::move(code)};
}

bool MakeDirectory(const base::FilePath& path) {
  return mkdir(path.value().c_str(), 0755) == 0 || errno == EEXIST;
}

}

base::DictValue Listing::ToDict() && {
  return base::DictValue()
      .Set("files", std::move(files))
      .Set("pending", std::move(pending))
      .Set("damaged", std::move(damaged))
      .Set("present", std::move(present));
}

bool HasSyncData(const base::FilePath& folder) {
  base::FileEnumerator entries(folder, false,
                               base::FileEnumerator::FILES |
                                   base::FileEnumerator::DIRECTORIES |
                                   base::FileEnumerator::SHOW_SYM_LINKS);
  for (base::FilePath entry = entries.Next(); !entry.empty();
       entry = entries.Next()) {
    if (IsTag(entry.BaseName().value())) {
      return true;
    }
  }
  return false;
}

FolderState StateOfFolder(const base::FilePath& folder) {
  FolderState state;
  state.exists = !folder.empty() && base::DirectoryExists(folder);
  if (!state.exists) {
    return state;
  }
  state.writable = access(folder.value().c_str(), W_OK | X_OK) == 0;
  state.has_sync_data = HasSyncData(folder);
  return state;
}

bool SaveFileDurably(const base::FilePath& path,
                     std::string_view bytes,
                     int mode) {
  if (!path.IsAbsolute() || path.BaseName().value().empty() ||
      path.EndsWithSeparator()) {
    return false;
  }
  const base::FilePath directory = path.DirName();
  const base::FilePath staging = directory.Append(
      base::StrCat({".", path.BaseName().value(), ".",
                    base::NumberToString(getpid()), ".tmp"}));
  {
    base::ScopedFD file(HANDLE_EINTR(
        open(staging.value().c_str(),
             O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode)));
    if (!file.is_valid()) {
      return false;
    }
    bool ok = base::WriteFileDescriptor(file.get(), bytes) &&
              HANDLE_EINTR(fsync(file.get())) == 0;
    if (!ok) {
      unlink(staging.value().c_str());
      return false;
    }
  }
  if (rename(staging.value().c_str(), path.value().c_str()) != 0) {
    unlink(staging.value().c_str());
    return false;
  }
  base::ScopedFD folder(HANDLE_EINTR(
      open(directory.value().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC)));
  if (folder.is_valid()) {
    HANDLE_EINTR(fsync(folder.get()));
  }
  return true;
}

Vault::Vault(base::FilePath folder, const Keys& keys)
    : folder_(std::move(folder)), keys_(keys) {}

VaultResult<Vault> Vault::At(std::string_view folder, const Keys& keys) {
  base::FilePath path(folder);
  if (folder.size() > 1) {
    path = path.StripTrailingSeparators();
  }
  if (!path.IsAbsolute() || path.ReferencesParent()) {
    return base::unexpected(Failure("not a sync folder path"));
  }
  return Vault(std::move(path), keys);
}

base::FilePath Vault::ChainPath() const {
  return folder_.Append(keys_->chain_tag());
}

base::FilePath Vault::ScopePath(std::string_view scope) const {
  return ChainPath().Append(keys_->ScopeTag(scope));
}

std::string Vault::ChainStatus() const {
  if (!base::DirectoryExists(folder_)) {
    return "unavailable";
  }
  switch (KindOf(ChainPath())) {
    case Kind::kDirectory:
      return "ok";
    case Kind::kAbsent:
      return "missing";
    default:
      return "unavailable";
  }
}

bool Vault::ChainExists() const {
  return KindOf(ChainPath()) == Kind::kDirectory;
}

VaultResult<bool> Vault::CreateChain() const {
  if (!base::CreateDirectory(folder_)) {
    return base::unexpected(Failure("the sync folder couldn't be created"));
  }
  if (!MakeDirectory(ChainPath())) {
    return base::unexpected(Failure("the sync data couldn't be created"));
  }
  if (KindOf(ChainPath()) != Kind::kDirectory) {
    return base::unexpected(Failure(kLink));
  }
  return true;
}

VaultResult<bool> Vault::DeleteChain() const {
  if (KindOf(ChainPath()) != Kind::kDirectory) {
    return true;
  }
  if (!base::DeletePathRecursively(ChainPath())) {
    return base::unexpected(Failure("the sync data couldn't be deleted"));
  }
  return true;
}

VaultResult<std::optional<base::FilePath>> Vault::ScopeDirectory(
    std::string_view scope,
    bool create) const {
  const Kind chain = KindOf(ChainPath());
  if (chain == Kind::kOther) {
    return base::unexpected(Failure(kLink));
  }
  if (chain != Kind::kDirectory) {
    return base::unexpected(Failure(kUnreachable));
  }
  const base::FilePath path = ScopePath(scope);
  const Kind kind = KindOf(path);
  if (kind == Kind::kOther) {
    return base::unexpected(Failure(kLink));
  }
  if (kind == Kind::kError) {
    return base::unexpected(Failure(kUnreachable));
  }
  if (kind == Kind::kAbsent) {
    if (!create) {
      return std::optional<base::FilePath>();
    }
    if (!MakeDirectory(path) || KindOf(path) != Kind::kDirectory) {
      return base::unexpected(Failure(kUnreachable));
    }
  }
  return std::optional<base::FilePath>(path);
}

VaultResult<std::string> Vault::Write(std::string_view scope,
                                      std::string_view payload) const {
  ASSIGN_OR_RETURN(std::optional<base::FilePath> directory,
                   ScopeDirectory(scope, true));
  if (!directory) {
    return base::unexpected(Failure(kUnreachable));
  }
  const std::string id = NewFileId();
  std::optional<Secret> restored = RestorePasswords(payload, *keys_);
  if (!restored) {
    return base::unexpected(
        Failure("a synced password in this document couldn't be opened"));
  }
  std::optional<std::string> sealed =
      keys_->Seal(restored->view(), keys_->ScopeTag(scope), id);
  if (!sealed) {
    return base::unexpected(Failure("the document couldn't be sealed"));
  }
  if (!SaveFileDurably(
          directory->Append(base::StrCat({id, kFileExtension})), *sealed,
          0644)) {
    return base::unexpected(Failure("the sync file couldn't be written"));
  }
  return id;
}

VaultResult<bool> Vault::Remove(std::string_view scope,
                                const std::vector<std::string>& ids) const {
  if (KindOf(ChainPath()) == Kind::kAbsent) {
    return true;
  }
  ASSIGN_OR_RETURN(std::optional<base::FilePath> directory,
                   ScopeDirectory(scope, false));
  if (!directory) {
    return true;
  }
  int failed = 0;
  for (const std::string& id : ids) {
    if (!IsTag(id)) {
      continue;
    }
    const base::FilePath file =
        directory->Append(base::StrCat({id, kFileExtension}));
    if (unlink(file.value().c_str()) != 0 && errno != ENOENT &&
        errno != ENOTDIR) {
      ++failed;
    }
  }
  if (failed) {
    return base::unexpected(Failure(base::StrCat(
        {"Couldn't remove ", base::NumberToString(failed), " sync file",
         failed == 1 ? "" : "s"})));
  }
  return true;
}

VaultResult<Listing> Vault::Read(std::string_view scope,
                                 const std::vector<std::string>& known,
                                 base::Time now) const {
  Listing listing;
  auto directory = ScopeDirectory(scope, false);
  if (!directory.has_value()) {
    return base::unexpected(Failure(
        base::StrCat({"The sync folder couldn't be read: ",
                      directory.error().message}),
        kFolderUnreadable));
  }
  if (!*directory) {
    return listing;
  }
  std::vector<std::string> names;
  base::FileEnumerator entries(**directory, false,
                               base::FileEnumerator::FILES |
                                   base::FileEnumerator::DIRECTORIES |
                                   base::FileEnumerator::SHOW_SYM_LINKS);
  for (base::FilePath entry = entries.Next(); !entry.empty();
       entry = entries.Next()) {
    names.push_back(entry.BaseName().value());
  }
  if (entries.GetError() != base::File::FILE_OK &&
      entries.GetError() != base::File::FILE_ERROR_NOT_FOUND) {
    return base::unexpected(Failure("The sync folder couldn't be read",
                                    kFolderUnreadable));
  }
  std::sort(names.begin(), names.end());
  const std::set<std::string> skip(known.begin(), known.end());
  std::set<std::string> seen;
  const std::string scope_tag = keys_->ScopeTag(scope);
  for (const std::string& name : names) {
    if (!name.ends_with(kFileExtension)) {
      continue;
    }
    const std::string id = name.substr(0, name.size() - kFileExtension.size());
    if (!IsTag(id) || !seen.insert(id).second) {
      continue;
    }
    if (skip.contains(id)) {
      listing.present.Append(id);
      continue;
    }
    const base::FilePath path = (*directory)->Append(name);
    struct stat facts;
    if (stat(path.value().c_str(), &facts) != 0) {
      if (errno == ENOENT || errno == ENOTDIR) {
        continue;
      }
      listing.present.Append(id);
      listing.damaged.Append(base::DictValue().Set("id", id).Set("age", 0));
      continue;
    }
    if (!S_ISREG(facts.st_mode)) {
      continue;
    }
    std::string bytes;
    if (!base::ReadFileToString(path, &bytes)) {
      listing.present.Append(id);
      listing.damaged.Append(base::DictValue().Set("id", id).Set("age", 0));
      continue;
    }
    listing.present.Append(id);
    const base::Time modified = base::Time::FromTimeT(facts.st_mtime) +
                                base::Nanoseconds(facts.st_mtim.tv_nsec);
    std::optional<Secret> plain = keys_->Open(bytes, scope_tag, id);
    if (!plain) {
      const double age =
          std::max(0.0, (now - modified).InMillisecondsF());
      listing.damaged.Append(base::DictValue().Set("id", id).Set("age", age));
      continue;
    }
    std::optional<std::string> hidden = HidePasswords(plain->view(), *keys_);
    if (!hidden) {
      listing.damaged.Append(base::DictValue().Set("id", id).Set("age", 0));
      continue;
    }
    if (!IsUtf8(*hidden)) {
      listing.damaged.Append(base::DictValue().Set("id", id).Set("age", 0));
      continue;
    }
    listing.files.Append(
        base::DictValue().Set("id", id).Set("payload", std::move(*hidden)));
  }
  return listing;
}

}
