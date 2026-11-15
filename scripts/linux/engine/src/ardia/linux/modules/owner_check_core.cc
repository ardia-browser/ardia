// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/owner_check_core.h"

#include <fcntl.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <utility>

#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/functional/bind.h"
#include "base/posix/eintr_wrapper.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "third_party/boringssl/src/include/openssl/mem.h"

namespace ardia_linux {

namespace {

constexpr std::array<const char*, 4> kPasswordHelpers = {
    "/usr/sbin/unix_chkpwd",
    "/sbin/unix_chkpwd",
    "/usr/bin/unix_chkpwd",
    "/run/wrappers/bin/unix_chkpwd",
};

constexpr std::array<base::TimeDelta, 6> kRetryDelays = {
    base::Seconds(0), base::Seconds(0),  base::Seconds(2),
    base::Seconds(5), base::Seconds(30), base::Seconds(60),
};

constexpr mode_t kWritableByOthers = 0022;

bool WriteAll(int fd, base::span<const uint8_t> bytes) {
  while (!bytes.empty()) {
    ssize_t written =
        HANDLE_EINTR(send(fd, bytes.data(), bytes.size(), MSG_NOSIGNAL));
    if (written <= 0) {
      return false;
    }
    bytes = bytes.subspan(static_cast<size_t>(written));
  }
  return true;
}

}

void WipeBytes(base::span<uint8_t> bytes) {
  if (!bytes.empty()) {
    OPENSSL_cleanse(bytes.data(), bytes.size());
  }
}

SecretBytes::SecretBytes() = default;

SecretBytes::SecretBytes(base::span<const uint8_t> bytes)
    : bytes_(bytes.begin(), bytes.end()) {}

SecretBytes::SecretBytes(SecretBytes&& other)
    : bytes_(std::move(other.bytes_)) {
  other.bytes_.clear();
}

SecretBytes& SecretBytes::operator=(SecretBytes&& other) {
  if (this != &other) {
    Wipe();
    bytes_ = std::move(other.bytes_);
    other.bytes_.clear();
  }
  return *this;
}

SecretBytes::~SecretBytes() {
  Wipe();
}

SecretBytes SecretBytes::FromUtf16(std::u16string_view text) {
  std::string utf8 = base::UTF16ToUTF8(text);
  SecretBytes secret(base::as_byte_span(utf8));
  WipeBytes(base::as_writable_byte_span(utf8));
  return secret;
}

void SecretBytes::Wipe() {
  WipeBytes(bytes_);
  bytes_.clear();
}

std::optional<HelperFileFacts> StatHelperFileOnDisk(
    const base::FilePath& path) {
  struct stat facts;
  if (stat(path.value().c_str(), &facts) != 0) {
    return std::nullopt;
  }
  HelperFileFacts result;
  result.regular = S_ISREG(facts.st_mode);
  result.directory = S_ISDIR(facts.st_mode);
  result.owner = facts.st_uid;
  result.mode = facts.st_mode;
  return result;
}

std::optional<base::FilePath> TrustedPasswordHelper(
    const base::FilePath& path,
    const StatHelperFile& stat) {
  base::FilePath real = base::MakeAbsoluteFilePath(path);
  if (real.empty()) {
    return std::nullopt;
  }
  std::optional<HelperFileFacts> file = stat.Run(real);
  if (!file || !file->regular || file->owner != 0 ||
      (file->mode & kWritableByOthers) || !(file->mode & 0111)) {
    return std::nullopt;
  }
  for (base::FilePath folder = real.DirName();; folder = folder.DirName()) {
    std::optional<HelperFileFacts> facts = stat.Run(folder);
    if (!facts || !facts->directory || facts->owner != 0 ||
        (facts->mode & kWritableByOthers)) {
      return std::nullopt;
    }
    if (folder == folder.DirName()) {
      return real;
    }
  }
}

std::vector<base::FilePath> PasswordHelperCandidates() {
  std::vector<base::FilePath> paths;
  for (const char* path : kPasswordHelpers) {
    paths.emplace_back(path);
  }
  return paths;
}

HelperVerdict VerdictForExit(std::optional<int> exit_code) {
  if (exit_code == 0) {
    return HelperVerdict::kMatch;
  }
  if (exit_code == kWrongPasswordExit) {
    return HelperVerdict::kMismatch;
  }
  return HelperVerdict::kFailed;
}

std::optional<std::string> UnusablePassword(
    base::span<const uint8_t> password) {
  if (password.size() > kMaxPasswordBytes) {
    return "That password is too long to check.";
  }
  if (std::ranges::find(password, 0) != password.end()) {
    return "That password can't be checked.";
  }
  return std::nullopt;
}

HelperVerdict RunPasswordHelper(const base::FilePath& helper,
                                const std::string& user,
                                SecretBytes password,
                                base::TimeDelta deadline) {
  std::vector<uint8_t> secret(password.size() + 1, 0);
  std::ranges::copy(password.bytes(), secret.begin());
  password.Wipe();
  int socket_ends[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, socket_ends) != 0) {
    WipeBytes(secret);
    return HelperVerdict::kFailed;
  }
  base::ScopedFD read_end(socket_ends[0]);
  base::ScopedFD write_end(socket_ends[1]);
  base::ScopedFD nowhere(HANDLE_EINTR(open("/dev/null", O_RDWR | O_CLOEXEC)));
  base::LaunchOptions options;
  options.clear_environment = true;
  options.allow_new_privs = true;
  options.fds_to_remap.emplace_back(read_end.get(), STDIN_FILENO);
  if (nowhere.is_valid()) {
    options.fds_to_remap.emplace_back(nowhere.get(), STDOUT_FILENO);
    options.fds_to_remap.emplace_back(nowhere.get(), STDERR_FILENO);
  }
  base::Process child =
      base::LaunchProcess({helper.value(), user, "nonull"}, options);
  read_end.reset();
  nowhere.reset();
  if (!child.IsValid()) {
    WipeBytes(secret);
    return HelperVerdict::kFailed;
  }
  WriteAll(write_end.get(), secret);
  WipeBytes(secret);
  shutdown(write_end.get(), SHUT_WR);
  write_end.reset();
  int exit_code = -1;
  if (!child.WaitForExitWithTimeout(deadline, &exit_code)) {
    kill(child.Pid(), SIGKILL);
    child.WaitForExit(&exit_code);
    return HelperVerdict::kFailed;
  }
  return VerdictForExit(exit_code);
}

void OwnerCheckThrottle::NoteWrong(base::TimeTicks now) {
  ++wrong_passwords_;
  size_t index = std::min<size_t>(wrong_passwords_, kRetryDelays.size()) - 1;
  retry_at_ = now + kRetryDelays[index];
}

void OwnerCheckThrottle::NoteRight() {
  wrong_passwords_ = 0;
  retry_at_ = base::TimeTicks();
}

base::TimeDelta OwnerCheckThrottle::Wait(base::TimeTicks now) const {
  if (retry_at_.is_null() || retry_at_ <= now) {
    return base::TimeDelta();
  }
  return retry_at_ - now;
}

OwnerCheck::Delegate::Delegate() = default;
OwnerCheck::Delegate::Delegate(Delegate&&) = default;
OwnerCheck::Delegate& OwnerCheck::Delegate::operator=(Delegate&&) = default;
OwnerCheck::Delegate::~Delegate() = default;

OwnerCheck::OwnerCheck(Delegate delegate, std::unique_ptr<OwnerPromptUi> ui)
    : delegate_(std::move(delegate)), ui_(std::move(ui)) {}

OwnerCheck::~OwnerCheck() = default;

base::TimeTicks OwnerCheck::Now() const {
  return delegate_.now ? delegate_.now.Run() : base::TimeTicks::Now();
}

void OwnerCheck::AddAwayListener(base::RepeatingClosure listener) {
  away_listeners_.push_back(std::move(listener));
}

void OwnerCheck::RevokeGrant() {
  granted_at_ = base::TimeTicks();
}

void OwnerCheck::Confirm(const std::string& reason, Done done) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!granted_at_.is_null() && Now() - granted_at_ < kGrantReuse) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(done), true));
    return;
  }
  waiters_.push_back(std::move(done));
  if (asking_) {
    if (prompt_) {
      prompt_->Focus();
    }
    return;
  }
  asking_ = true;
  asked_in_generation_ = away_generation_;
  if (delegate_.test_answer) {
    const bool granted = *delegate_.test_answer != "denied";
    if (delegate_.log) {
      delegate_.log.Run("device owner check (" + reason +
                        ") in a test instance: " +
                        (granted ? "granted" : "denied"));
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&OwnerCheck::Finish,
                                  weak_factory_.GetWeakPtr(), granted));
    return;
  }
  delegate_.find_helper.Run(base::BindOnce(
      &OwnerCheck::HelperLocated, weak_factory_.GetWeakPtr(), reason));
}

void OwnerCheck::HelperLocated(std::string reason,
                             std::optional<base::FilePath> helper) {
  if (!asking_) {
    return;
  }
  if (!StillPresent(asked_in_generation_)) {
    Finish(false);
    return;
  }
  if (!helper) {
    delegate_.count.Run("owner_check_unavailable");
    if (delegate_.log) {
      delegate_.log.Run("device owner check (" + reason +
                        "): no trusted unix_chkpwd on this system, so nothing "
                        "can check the login password; denied");
    }
    ui_->TellUnavailable(reason,
                         base::BindOnce(&OwnerCheck::Finish,
                                        weak_factory_.GetWeakPtr(), false));
    return;
  }
  delegate_.count.Run("owner_check_asked");
  helper_ = std::move(helper);
  prompted_ = true;
  prompt_ = ui_->Ask(reason, throttle_.Wait(Now()));
  WaitForAnswer();
}

void OwnerCheck::WaitForAnswer() {
  if (!prompt_) {
    return;
  }
  if (!StillPresent(asked_in_generation_)) {
    Finish(false);
    return;
  }
  const int attempt = ++attempt_;
  prompt_->NextAnswer(base::BindOnce(&OwnerCheck::Answered,
                                     weak_factory_.GetWeakPtr(), attempt));
}

void OwnerCheck::Answered(int attempt, std::optional<SecretBytes> password) {
  if (attempt != attempt_ || !asking_ || !prompt_) {
    return;
  }
  if (!password || password->empty() ||
      !StillPresent(asked_in_generation_)) {
    Finish(false);
    return;
  }
  base::TimeDelta wait = throttle_.Wait(Now());
  if (wait.is_positive()) {
    delegate_.count.Run("owner_check_throttled");
    prompt_->Refuse(std::string(), wait);
    WaitForAnswer();
    return;
  }
  if (std::optional<std::string> unusable =
          UnusablePassword(password->bytes())) {
    prompt_->Refuse(*unusable, base::TimeDelta());
    WaitForAnswer();
    return;
  }
  delegate_.check_password.Run(
      *helper_, std::move(*password),
      base::BindOnce(&OwnerCheck::Checked, weak_factory_.GetWeakPtr(),
                     attempt));
}

void OwnerCheck::Checked(int attempt, HelperVerdict verdict) {
  if (attempt != attempt_ || !asking_ || !prompt_) {
    return;
  }
  switch (verdict) {
    case HelperVerdict::kMatch:
      throttle_.NoteRight();
      Finish(StillPresent(asked_in_generation_));
      return;
    case HelperVerdict::kFailed:
      delegate_.count.Run("owner_check_helper_failures");
      prompt_->Refuse("Ardia couldn't check the password.", base::TimeDelta());
      WaitForAnswer();
      return;
    case HelperVerdict::kMismatch:
      delegate_.count.Run("owner_check_wrong_passwords");
      throttle_.NoteWrong(Now());
      prompt_->Refuse("Wrong password.", throttle_.Wait(Now()));
      WaitForAnswer();
      return;
  }
}

void OwnerCheck::Finish(bool granted) {
  if (!asking_) {
    return;
  }
  asking_ = false;
  ++attempt_;
  helper_.reset();
  std::unique_ptr<OwnerPrompt> prompt = std::move(prompt_);
  prompt.reset();
  granted = granted && StillPresent(asked_in_generation_);
  if (prompted_) {
    prompted_ = false;
    delegate_.count.Run(granted ? "owner_check_granted"
                                : "owner_check_cancelled");
  }
  if (granted) {
    granted_at_ = Now();
  }
  std::vector<Done> waiters = std::move(waiters_);
  waiters_.clear();
  for (Done& done : waiters) {
    std::move(done).Run(granted);
  }
}

void OwnerCheck::OwnerWentAway() {
  ++away_generation_;
  RevokeGrant();
  if (asking_ && prompt_) {
    Finish(false);
  }
  std::vector<base::RepeatingClosure> listeners = away_listeners_;
  for (const base::RepeatingClosure& listener : listeners) {
    listener.Run();
  }
}

}
