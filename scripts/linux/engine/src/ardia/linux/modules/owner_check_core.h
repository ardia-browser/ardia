// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_OWNER_CHECK_CORE_H_
#define ARDIA_LINUX_MODULES_OWNER_CHECK_CORE_H_

#include <sys/types.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/containers/span.h"
#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/time/time.h"
#include "base/timer/timer.h"

namespace ardia_linux {

class SecretBytes {
 public:
  SecretBytes();
  explicit SecretBytes(base::span<const uint8_t> bytes);
  SecretBytes(SecretBytes&& other);
  SecretBytes& operator=(SecretBytes&& other);
  SecretBytes(const SecretBytes&) = delete;
  SecretBytes& operator=(const SecretBytes&) = delete;
  ~SecretBytes();

  static SecretBytes FromUtf16(std::u16string_view text);

  base::span<const uint8_t> bytes() const { return bytes_; }
  size_t size() const { return bytes_.size(); }
  bool empty() const { return bytes_.empty(); }
  void Wipe();

 private:
  std::vector<uint8_t> bytes_;
};

void WipeBytes(base::span<uint8_t> bytes);

struct HelperFileFacts {
  bool regular = false;
  bool directory = false;
  uid_t owner = 0;
  mode_t mode = 0;
};

using StatHelperFile =
    base::RepeatingCallback<std::optional<HelperFileFacts>(
        const base::FilePath&)>;

std::optional<HelperFileFacts> StatHelperFileOnDisk(const base::FilePath& path);

std::optional<base::FilePath> TrustedPasswordHelper(
    const base::FilePath& path,
    const StatHelperFile& stat);

std::vector<base::FilePath> PasswordHelperCandidates();

enum class HelperVerdict { kMatch, kMismatch, kFailed };

HelperVerdict VerdictForExit(std::optional<int> exit_code);

inline constexpr int kWrongPasswordExit = 7;
inline constexpr size_t kMaxPasswordBytes = 512;
inline constexpr base::TimeDelta kHelperDeadline = base::Seconds(15);
inline constexpr base::TimeDelta kGrantReuse = base::Seconds(60);

std::optional<std::string> UnusablePassword(base::span<const uint8_t> password);

HelperVerdict RunPasswordHelper(const base::FilePath& helper,
                                const std::string& user,
                                SecretBytes password,
                                base::TimeDelta deadline = kHelperDeadline);

class OwnerCheckThrottle {
 public:
  void NoteWrong(base::TimeTicks now);
  void NoteRight();
  base::TimeDelta Wait(base::TimeTicks now) const;
  int wrong_passwords() const { return wrong_passwords_; }

 private:
  int wrong_passwords_ = 0;
  base::TimeTicks retry_at_;
};

class OwnerPrompt {
 public:
  using Answered = base::OnceCallback<void(std::optional<SecretBytes>)>;

  virtual ~OwnerPrompt() = default;
  virtual void NextAnswer(Answered answered) = 0;
  virtual void Refuse(const std::string& message, base::TimeDelta retry) = 0;
  virtual void Focus() = 0;
};

class OwnerPromptUi {
 public:
  virtual ~OwnerPromptUi() = default;
  virtual std::unique_ptr<OwnerPrompt> Ask(const std::string& reason,
                                           base::TimeDelta retry) = 0;
  virtual void TellUnavailable(const std::string& reason,
                               base::OnceClosure dismissed) = 0;
};

class OwnerCheck {
 public:
  using Done = base::OnceCallback<void(bool granted)>;
  using HelperFound =
      base::OnceCallback<void(std::optional<base::FilePath>)>;
  using CheckPassword = base::RepeatingCallback<void(
      const base::FilePath& helper,
      SecretBytes password,
      base::OnceCallback<void(HelperVerdict)>)>;
  using Count = base::RepeatingCallback<void(std::string_view)>;
  using Log = base::RepeatingCallback<void(std::string_view)>;

  struct Delegate {
    Delegate();
    Delegate(Delegate&&);
    Delegate& operator=(Delegate&&);
    ~Delegate();

    base::RepeatingCallback<void(HelperFound)> find_helper;
    CheckPassword check_password;
    Count count;
    Log log;
    std::optional<std::string> test_answer;
    base::RepeatingCallback<base::TimeTicks()> now;
  };

  OwnerCheck(Delegate delegate, std::unique_ptr<OwnerPromptUi> ui);
  OwnerCheck(const OwnerCheck&) = delete;
  OwnerCheck& operator=(const OwnerCheck&) = delete;
  ~OwnerCheck();

  void Confirm(const std::string& reason, Done done);
  void OwnerWentAway();
  void RevokeGrant();
  int presence() const { return away_generation_; }
  bool StillPresent(int presence) const {
    return presence == away_generation_;
  }
  bool asking() const { return asking_; }
  void AddAwayListener(base::RepeatingClosure listener);

  const OwnerCheckThrottle& throttle() const { return throttle_; }

 private:
  static void DeliverReusedGrant(base::WeakPtr<OwnerCheck> check,
                                 int presence,
                                 Done done);
  base::TimeTicks Now() const;
  void Finish(bool granted);
  void HelperLocated(std::string reason,
                   std::optional<base::FilePath> helper);
  void WaitForAnswer();
  void Answered(int attempt, std::optional<SecretBytes> password);
  void Checked(int attempt, HelperVerdict verdict);

  Delegate delegate_;
  std::unique_ptr<OwnerPromptUi> ui_;
  std::unique_ptr<OwnerPrompt> prompt_;
  std::optional<base::FilePath> helper_;
  std::vector<Done> waiters_;
  std::vector<base::RepeatingClosure> away_listeners_;
  OwnerCheckThrottle throttle_;
  base::TimeTicks granted_at_;
  bool asking_ = false;
  bool prompted_ = false;
  int away_generation_ = 0;
  int asked_in_generation_ = 0;
  int attempt_ = 0;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<OwnerCheck> weak_factory_{this};
};

}

#endif
