#ifndef ARDIA_DESKTOP_AC_DESKTOP_WEBUI_PROCESS_POLICY_H_
#define ARDIA_DESKTOP_AC_DESKTOP_WEBUI_PROCESS_POLICY_H_

#include <cstddef>
#include <cstdint>
#include <deque>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "ardia/desktop/ac_desktop_policy.h"

namespace ardia::desktop_webui_process {

inline constexpr std::string_view kShellScheme = "chrome";
inline constexpr std::string_view kShellHost = "ardia";
inline constexpr char kShellUrl[] = "chrome://ardia/";

inline constexpr int32_t kSharedShellRendererFeature = 0x41726469;

struct ShellWindow {
  bool private_window = false;
  bool off_the_record_profile = false;
};

inline constexpr std::optional<int32_t> SharedRendererFeature(const ShellWindow& window) {
  if (window.private_window || window.off_the_record_profile) return std::nullopt;
  return kSharedShellRendererFeature;
}

inline constexpr size_t kShellReloadsAllowed = 3;
inline constexpr double kShellReloadWindowSeconds = 60;

class ShellReloadBudget {
 public:
  bool Allow(double now_seconds) {
    while (!reloads_.empty() && now_seconds - reloads_.front() >= kShellReloadWindowSeconds) reloads_.pop_front();
    if (reloads_.size() >= kShellReloadsAllowed) return false;
    reloads_.push_back(now_seconds);
    return true;
  }

  size_t recent() const { return reloads_.size(); }

 private:
  std::deque<double> reloads_;
};

enum class WindowState { kOpen, kPaused, kGone };

inline constexpr WindowState ShellWindowState(bool shutdown_started, bool trying_to_quit, WindowState window) {
  if (shutdown_started || window == WindowState::kGone) return WindowState::kGone;
  if (trying_to_quit) return WindowState::kPaused;
  return window;
}

inline constexpr int kQuitPollMilliseconds = 250;

inline constexpr bool QuitMayStillBeCancelled(bool shutdown_started, bool trying_to_quit) {
  return trying_to_quit && !shutdown_started;
}

enum class RecoveryStep { kNothing, kWaitForResume, kReloadDocument, kLoadShellUrl, kGaveUp };

class ShellRecoveryState {
 public:
  void RendererGone(bool normal_exit) {
    if (!normal_exit) owed_ = true;
  }

  void InitialLoadStarted() { in_flight_ = true; }

  bool DocumentCommitted() {
    const bool recovered = recovering_;
    owed_ = false;
    in_flight_ = false;
    recovering_ = false;
    return recovered;
  }

  void NavigationEndedWithoutCommit() {
    if (!in_flight_) return;
    in_flight_ = false;
    owed_ = true;
  }

  RecoveryStep Next(double now_seconds, WindowState window, bool committed_shell_document) {
    if (!owed_) return RecoveryStep::kNothing;
    if (window == WindowState::kPaused) return RecoveryStep::kWaitForResume;
    owed_ = false;
    if (window == WindowState::kGone) {
      recovering_ = false;
      return RecoveryStep::kNothing;
    }
    if (!budget_.Allow(now_seconds)) {
      recovering_ = false;
      return RecoveryStep::kGaveUp;
    }
    in_flight_ = true;
    recovering_ = true;
    return committed_shell_document ? RecoveryStep::kReloadDocument : RecoveryStep::kLoadShellUrl;
  }

  bool owed() const { return owed_; }
  bool in_flight() const { return in_flight_; }
  bool recovering() const { return recovering_; }
  size_t recent_reloads() const { return budget_.recent(); }

 private:
  bool owed_ = false;
  bool in_flight_ = false;
  bool recovering_ = false;
  ShellReloadBudget budget_;
};

enum class RecoveryOutcome { kAttempted, kRecovered, kExhausted };

inline constexpr char kShellRecoveryDocument[] = "shell-recovery.json";
inline constexpr char kPreviousShellRecoveryDocument[] = "shell-recovery-previous.json";
inline constexpr char kNoShellRecoveries[] = "{}\n";

inline constexpr bool ShellRecoveryDocument(std::string_view name) {
  return name == kShellRecoveryDocument || name == kPreviousShellRecoveryDocument;
}

struct ShellRecoveryTally {
  uint32_t attempts = 0;
  uint32_t recovered = 0;
  uint32_t exhausted = 0;

  void Record(RecoveryOutcome outcome) {
    uint32_t& count = outcome == RecoveryOutcome::kAttempted   ? attempts
                      : outcome == RecoveryOutcome::kRecovered ? recovered
                                                               : exhausted;
    if (count < std::numeric_limits<uint32_t>::max()) ++count;
  }

  std::string Json() const {
    return "{\"attempts\":" + std::to_string(attempts) + ",\"recovered\":" + std::to_string(recovered) +
           ",\"exhausted\":" + std::to_string(exhausted) + "}\n";
  }
};

inline constexpr std::string_view kShellBootstrapAsset = "host-bootstrap.js";

struct RecoveryDocumentRead {
  desktop_policy::StoredRead outcome = desktop_policy::StoredRead::kFailed;
  std::string contents;
};

class RecoveryDocuments {
 public:
  template <typename Read, typename Write>
  void Rotate(Read&& read, Write&& write) {
    const RecoveryDocumentRead current = read(kShellRecoveryDocument);
    if (current.outcome == desktop_policy::StoredRead::kFailed) return;
    const std::string archived =
        current.outcome == desktop_policy::StoredRead::kFound ? current.contents : std::string(kNoShellRecoveries);
    if (!write(kPreviousShellRecoveryDocument, archived)) return;
    archived_ = true;
    write(kShellRecoveryDocument, std::string(kNoShellRecoveries));
  }

  template <typename Read, typename Write>
  bool Save(Read&& read, Write&& write, const std::string& tally) {
    if (!archived_) Rotate(read, write);
    return archived_ && write(kShellRecoveryDocument, tally);
  }

  bool archived() const { return archived_; }

 private:
  bool archived_ = false;
};

class LaunchBootstrap {
 public:
  explicit LaunchBootstrap(bool launch_window) : pending_(launch_window) {}

  bool startup() const { return pending_; }

  void Served(std::string_view asset) {
    if (asset == kShellBootstrapAsset) pending_ = false;
  }

  void NoteRecovery() { pending_ = false; }

 private:
  bool pending_;
};

}

#endif
