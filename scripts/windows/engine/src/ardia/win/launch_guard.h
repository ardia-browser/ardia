#ifndef ARDIA_WIN_LAUNCH_GUARD_H_
#define ARDIA_WIN_LAUNCH_GUARD_H_

#include <string>

namespace base {
class CommandLine;
}

namespace ardia_win {

inline constexpr int kUnfinishedStartsBeforeRecovery = 2;
inline constexpr int kStartSettlesAfterSeconds = 15;
inline constexpr int kPredecessorWaitSeconds = 45;
inline constexpr int kPredecessorPollMs = 200;
inline constexpr int kClaimRetryMs = 250;
inline constexpr int kClaimAttempts = 240;

struct LaunchGuardFacts {
  int predecessor_wait_ms = -1;
  int unfinished_starts_before = 0;
  std::wstring recovered_to;
  bool profile_held_by_another = false;
};

std::wstring AppDataDirectory();

void SetAppDataDirectory(const std::wstring& directory);

std::wstring LaunchLogPath();

void RotateLaunchLog();

void GuardBrowserLaunch(const std::wstring& chromium_user_data_dir,
                        base::CommandLine* command_line);

void MarkExiting();

void ClearExiting();

void MarkStartSettled();

void ClaimGuard();

bool OwnsGuard();

const LaunchGuardFacts& GuardFacts();

int NextUnfinishedStarts(int recorded, bool* recover);

bool HandsOverToDeElevatedCopy(const base::CommandLine& command_line);

}

#endif
