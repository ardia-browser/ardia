// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/document_store.h"

#include <algorithm>
#include <utility>

#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/task_runner.h"

namespace ardia_linux {

namespace {

constexpr int kLongestRetrySteps = 5;
constexpr int kMostRetryUnits = 60;

std::string ValidUtf8(std::string text) {
  if (base::IsStringUTF8AllowingNoncharacters(text)) {
    return text;
  }
  return base::UTF16ToUTF8(base::UTF8ToUTF16(text));
}

void SettleAll(std::vector<DocumentStore::Settled> waiters,
               const std::optional<std::string>& error) {
  for (DocumentStore::Settled& waiter : waiters) {
    std::move(waiter).Run(error);
  }
}

}

DocumentStore::Latest::Latest() = default;

DocumentStore::Latest::~Latest() = default;

void DocumentStore::Latest::Set(const std::string& key, int64_t generation) {
  base::AutoLock hold(lock_);
  generations_[key] = generation;
}

bool DocumentStore::Latest::Is(const std::string& key, int64_t generation) {
  base::AutoLock hold(lock_);
  auto found = generations_.find(key);
  return found != generations_.end() && found->second == generation;
}

DocumentStore::DocumentStore(base::FilePath folder,
                             scoped_refptr<base::SequencedTaskRunner> disk)
    : folder_(std::move(folder)),
      disk_(std::move(disk)),
      latest_(base::MakeRefCounted<Latest>()) {}

DocumentStore::~DocumentStore() = default;

std::optional<std::string> DocumentStore::KeyOf(std::string_view name) {
  std::string forward(name);
  std::replace(forward.begin(), forward.end(), '\\', '/');
  const size_t slash = forward.find_last_of('/');
  std::string last =
      slash == std::string::npos ? forward : forward.substr(slash + 1);
  if (last.empty() || last == "." || last == "..") {
    return std::nullopt;
  }
  for (char c : last) {
    if (static_cast<unsigned char>(c) < 0x20) {
      return std::nullopt;
    }
  }
  return last;
}

DocumentStore::Loaded DocumentStore::ReadFolder(const base::FilePath& folder) {
  Loaded loaded;
  base::FileEnumerator files(folder, false, base::FileEnumerator::FILES);
  for (base::FilePath path = files.Next(); !path.empty(); path = files.Next()) {
    const std::string key = path.BaseName().value();
    if (files.GetInfo().GetSize() > kMostLoadedBytes) {
      loaded.unloaded.insert(key);
      continue;
    }
    std::string contents;
    if (!base::ReadFileToStringWithMaxSize(path, &contents,
                                           kMostLoadedBytes)) {
      loaded.unloaded.insert(key);
      continue;
    }
    loaded.contents[key] = ValidUtf8(std::move(contents));
  }
  return loaded;
}

void DocumentStore::Load(base::OnceClosure loaded) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  disk_->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&DocumentStore::ReadFolder, folder_),
      base::BindOnce(&DocumentStore::DidLoad, weak_factory_.GetWeakPtr(),
                     std::move(loaded)));
}

void DocumentStore::DidLoad(base::OnceClosure loaded, Loaded result) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  for (auto& [key, contents] : result.contents) {
    if (!touched_before_load_.contains(key)) {
      contents_[key] = std::move(contents);
    }
  }
  for (const std::string& key : result.unloaded) {
    if (!touched_before_load_.contains(key)) {
      unloaded_.insert(key);
    }
  }
  touched_before_load_.clear();
  loaded_ = true;
  std::move(loaded).Run();
}

base::expected<std::optional<std::string>, std::string> DocumentStore::Read(
    std::string_view name) const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const std::optional<std::string> key = KeyOf(name);
  if (!key) {
    return std::nullopt;
  }
  if (auto found = contents_.find(*key); found != contents_.end()) {
    return std::optional<std::string>(found->second);
  }
  if (!loaded_) {
    return base::unexpected("documents are still loading");
  }
  if (unloaded_.contains(*key)) {
    return base::unexpected("this document can't be read synchronously");
  }
  return std::nullopt;
}

void DocumentStore::Touch(const std::string& key) {
  if (!loaded_) {
    touched_before_load_.insert(key);
  }
  unloaded_.erase(key);
}

bool DocumentStore::Write(std::string_view name,
                          std::string contents,
                          Settled settled) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const std::optional<std::string> key = KeyOf(name);
  if (!key || closed_) {
    if (settled) {
      std::move(settled).Run(key ? "Documents are closed"
                                 : "Invalid document name");
    }
    return false;
  }
  const int64_t mine = ++generation_;
  latest_->Set(*key, mine);
  Touch(*key);
  contents_[*key] = contents;
  Slot& slot = staged_[*key];
  slot.generation = mine;
  slot.contents = std::move(contents);
  slot.attempt = 0;
  if (settled) {
    slot.waiters.push_back(std::move(settled));
  }
  if (!slot.in_flight) {
    Land(*key);
  }
  return true;
}

void DocumentStore::Land(const std::string& key) {
  auto found = staged_.find(key);
  if (found == staged_.end()) {
    return;
  }
  Slot& slot = found->second;
  slot.in_flight = true;
  disk_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&DocumentStore::WriteOnDisk, latest_, folder_.Append(key),
                     key, slot.generation, slot.contents),
      base::BindOnce(&DocumentStore::Landed, weak_factory_.GetWeakPtr(), key,
                     slot.generation));
}

std::optional<std::string> DocumentStore::WriteOnDisk(
    scoped_refptr<Latest> latest,
    base::FilePath path,
    std::string key,
    int64_t generation,
    std::string contents) {
  if (!latest->Is(key, generation)) {
    return std::nullopt;
  }
  if (!base::CreateDirectory(path.DirName())) {
    return "the data folder can't be made";
  }
  if (!base::ImportantFileWriter::WriteFileAtomically(path, contents)) {
    return base::StrCat({"writing ", key, " failed"});
  }
  return std::nullopt;
}

void DocumentStore::Landed(std::string key,
                           int64_t generation,
                           std::optional<std::string> error) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  auto found = staged_.find(key);
  if (found == staged_.end()) {
    return;
  }
  Slot& slot = found->second;
  slot.in_flight = false;
  if (slot.generation != generation) {
    Land(key);
    return;
  }
  if (!error) {
    std::vector<Settled> waiters = std::move(slot.waiters);
    staged_.erase(found);
    SettleAll(std::move(waiters), std::nullopt);
    return;
  }
  std::vector<Settled> waiters = std::exchange(slot.waiters, {});
  const int units =
      std::min(kMostRetryUnits, 2 << std::min(slot.attempt, kLongestRetrySteps));
  ++slot.attempt;
  if (!closed_) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&DocumentStore::Retry, weak_factory_.GetWeakPtr(), key,
                       generation),
        retry_base_ * units);
  }
  SettleAll(std::move(waiters), error);
}

void DocumentStore::Retry(std::string key, int64_t generation) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  auto found = staged_.find(key);
  if (found == staged_.end() || found->second.generation != generation ||
      found->second.in_flight) {
    return;
  }
  Land(key);
}

bool DocumentStore::Remove(std::string_view name) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const std::optional<std::string> key = KeyOf(name);
  if (!key || closed_) {
    return false;
  }
  const int64_t mine = ++generation_;
  latest_->Set(*key, mine);
  Touch(*key);
  contents_.erase(*key);
  std::vector<Settled> waiters;
  if (auto found = staged_.find(*key); found != staged_.end()) {
    waiters = std::move(found->second.waiters);
    staged_.erase(found);
  }
  disk_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&DocumentStore::RemoveOnDisk, latest_,
                     folder_.Append(*key), *key, mine),
      base::BindOnce(&DocumentStore::Removed, weak_factory_.GetWeakPtr(),
                     std::move(waiters)));
  return true;
}

std::optional<std::string> DocumentStore::RemoveOnDisk(
    scoped_refptr<Latest> latest,
    base::FilePath path,
    std::string key,
    int64_t generation) {
  if (!latest->Is(key, generation)) {
    return std::nullopt;
  }
  if (!base::DeleteFile(path)) {
    return base::StrCat({"removing ", key, " failed"});
  }
  return std::nullopt;
}

void DocumentStore::Removed(std::vector<Settled> waiters,
                            std::optional<std::string> error) {
  SettleAll(std::move(waiters), error);
}

void DocumentStore::WhenSaved(std::string_view name, Settled settled) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const std::optional<std::string> key = KeyOf(name);
  if (!key) {
    std::move(settled).Run("Invalid document name");
    return;
  }
  auto found = staged_.find(*key);
  if (found == staged_.end()) {
    std::move(settled).Run(std::nullopt);
    return;
  }
  found->second.waiters.push_back(std::move(settled));
}

void DocumentStore::Flush() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  closed_ = true;
  for (auto& [key, slot] : staged_) {
    if (!slot.in_flight) {
      Land(key);
    }
  }
}

}
