// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_DOCUMENT_STORE_H_
#define ARDIA_LINUX_MODULES_DOCUMENT_STORE_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/synchronization/lock.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/types/expected.h"

namespace ardia_linux {

class DocumentStore {
 public:
  using Settled = base::OnceCallback<void(std::optional<std::string> error)>;
  using Contents = std::map<std::string, std::string, std::less<>>;

  struct Loaded {
    Contents contents;
    std::set<std::string, std::less<>> unloaded;
  };

  static constexpr int64_t kMostLoadedBytes = 32 << 20;

  DocumentStore(base::FilePath folder,
                scoped_refptr<base::SequencedTaskRunner> disk);
  DocumentStore(const DocumentStore&) = delete;
  DocumentStore& operator=(const DocumentStore&) = delete;
  ~DocumentStore();

  static std::optional<std::string> KeyOf(std::string_view name);
  static Loaded ReadFolder(const base::FilePath& folder);

  void Load(base::OnceClosure loaded);
  bool loaded() const { return loaded_; }
  bool closed() const { return closed_; }

  base::expected<std::optional<std::string>, std::string> Read(
      std::string_view name) const;
  bool Write(std::string_view name, std::string contents,
             Settled settled = Settled());
  bool Remove(std::string_view name);
  void WhenSaved(std::string_view name, Settled settled);
  void Flush();

  size_t staged_count() const { return staged_.size(); }
  void set_retry_base_for_testing(base::TimeDelta delay) {
    retry_base_ = delay;
  }

 private:
  struct Slot {
    int64_t generation = 0;
    std::string contents;
    std::vector<Settled> waiters;
    int attempt = 0;
    bool in_flight = false;
  };

  class Latest : public base::RefCountedThreadSafe<Latest> {
   public:
    Latest();
    void Set(const std::string& key, int64_t generation);
    bool Is(const std::string& key, int64_t generation);

   private:
    friend class base::RefCountedThreadSafe<Latest>;
    ~Latest();

    base::Lock lock_;
    std::map<std::string, int64_t> generations_;
  };

  static std::optional<std::string> WriteOnDisk(scoped_refptr<Latest> latest,
                                                base::FilePath path,
                                                std::string key,
                                                int64_t generation,
                                                std::string contents);
  static std::optional<std::string> RemoveOnDisk(scoped_refptr<Latest> latest,
                                                 base::FilePath path,
                                                 std::string key,
                                                 int64_t generation);

  void Touch(const std::string& key);
  void Land(const std::string& key);
  void Landed(std::string key,
              int64_t generation,
              std::optional<std::string> error);
  void Removed(std::vector<Settled> waiters, std::optional<std::string> error);
  void Retry(std::string key, int64_t generation);
  void DidLoad(base::OnceClosure loaded, Loaded result);

  const base::FilePath folder_;
  scoped_refptr<base::SequencedTaskRunner> disk_;
  scoped_refptr<Latest> latest_;
  Contents contents_;
  std::set<std::string, std::less<>> unloaded_;
  std::set<std::string, std::less<>> touched_before_load_;
  std::map<std::string, Slot, std::less<>> staged_;
  int64_t generation_ = 0;
  bool loaded_ = false;
  bool closed_ = false;
  base::TimeDelta retry_base_ = base::Seconds(1);
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<DocumentStore> weak_factory_{this};
};

}

#endif
