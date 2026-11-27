#ifndef ARDIA_WIN_WEBUI_WEBUI_SESSION_END_POLICY_H_
#define ARDIA_WIN_WEBUI_WEBUI_SESSION_END_POLICY_H_

#include <cstddef>
#include <string>
#include <string_view>
#include <utility>

namespace ardia_win::webui_window {

inline constexpr char kSessionEndingEvent[] = "shell.sessionEnding";
inline constexpr char kSessionResumedEvent[] = "shell.sessionResumed";
inline constexpr char kSessionEndedCall[] = "ArdiaShell.sessionEnded";
inline constexpr int kSessionEndDeadlineMs = 3000;
inline constexpr int kQuitWatchIntervalMs = 1000;
inline constexpr size_t kSessionTokenLimit = 64;

enum class SessionEndStep { kAsk, kJoin, kProceed };

constexpr bool ValidSessionToken(std::string_view token) {
  if (token.empty() || token.size() > kSessionTokenLimit) {
    return false;
  }
  for (const char c : token) {
    const bool allowed = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
                         (c >= 'A' && c <= 'Z') || c == '-';
    if (!allowed) {
      return false;
    }
  }
  return true;
}

constexpr bool ClosingEndsSession(size_t other_open_browser_windows) {
  return other_open_browser_windows == 0;
}

constexpr bool CloseStillInFlight(bool closing,
                                  bool close_committed,
                                  bool close_started,
                                  bool unload_running,
                                  bool modal_dialog_open) {
  if (closing) {
    return true;
  }
  if (!close_committed) {
    return false;
  }
  return !close_started || unload_running || modal_dialog_open;
}

constexpr bool SwallowsSystemClose(bool close_committed, bool close_started) {
  return close_committed && !close_started;
}

constexpr bool RoutesSystemClose(bool utility, bool companions_hold_tabs) {
  return !utility || companions_hold_tabs;
}

class SessionEnd {
 public:
  SessionEndStep Begin(std::string token) {
    if (state_ == State::kEnding) {
      return SessionEndStep::kJoin;
    }
    if (state_ == State::kEnded) {
      return SessionEndStep::kProceed;
    }
    state_ = State::kEnding;
    token_ = std::move(token);
    return SessionEndStep::kAsk;
  }

  bool Settle(std::string_view token) {
    if (state_ != State::kEnding || token != token_) {
      return false;
    }
    state_ = State::kEnded;
    return true;
  }

  std::string Resume(bool trying_to_quit, size_t open_browser_windows) {
    if (state_ != State::kEnded || trying_to_quit ||
        open_browser_windows == 0) {
      return std::string();
    }
    state_ = State::kOpen;
    return std::exchange(token_, std::string());
  }

  bool Acknowledge(std::string_view token) {
    return ValidSessionToken(token) && Settle(token);
  }

  bool ended() const { return state_ == State::kEnded; }
  bool ending() const { return state_ == State::kEnding; }
  const std::string& token() const { return token_; }

 private:
  enum class State { kOpen, kEnding, kEnded };
  State state_ = State::kOpen;
  std::string token_;
};

}

#endif
