// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_SYNC_SYNC_VAULT_H_
#define ARDIA_LINUX_SYNC_SYNC_VAULT_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "ardia/linux/sync/sync_crypto.h"
#include "base/files/file_path.h"
#include "base/memory/raw_ref.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "base/values.h"

namespace ardia_linux::sync {

struct VaultError {
  std::string message;
  std::string code;
};

template <typename T>
using VaultResult = base::expected<T, VaultError>;

struct FolderState {
  bool exists = false;
  bool writable = false;
  bool has_sync_data = false;
};

FolderState StateOfFolder(const base::FilePath& folder);

bool HasSyncData(const base::FilePath& folder);

bool SaveFileDurably(const base::FilePath& path,
                     std::string_view bytes,
                     int mode);

struct Listing {
  base::ListValue files;
  base::ListValue pending;
  base::ListValue damaged;
  base::ListValue present;

  base::DictValue ToDict() &&;
};

class Vault {
 public:
  static VaultResult<Vault> At(std::string_view folder, const Keys& keys);

  base::FilePath ChainPath() const;
  base::FilePath ScopePath(std::string_view scope) const;

  std::string ChainStatus() const;
  bool ChainExists() const;
  VaultResult<bool> CreateChain() const;
  VaultResult<bool> DeleteChain() const;
  VaultResult<std::string> Write(std::string_view scope,
                                 std::string_view payload) const;
  VaultResult<bool> Remove(std::string_view scope,
                           const std::vector<std::string>& ids) const;
  VaultResult<Listing> Read(std::string_view scope,
                            const std::vector<std::string>& known,
                            base::Time now) const;

 private:
  Vault(base::FilePath folder, const Keys& keys);

  VaultResult<std::optional<base::FilePath>> ScopeDirectory(
      std::string_view scope,
      bool create) const;

  base::FilePath folder_;
  raw_ref<const Keys> keys_;
};

}

#endif
