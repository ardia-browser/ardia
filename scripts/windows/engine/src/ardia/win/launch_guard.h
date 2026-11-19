#ifndef ARDIA_WIN_LAUNCH_GUARD_H_
#define ARDIA_WIN_LAUNCH_GUARD_H_

#include <string>

#include "base/win/windows_types.h"

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
inline constexpr int kLockFileFreeWaitMs = 5000;
inline constexpr wchar_t kRestartedAfterRefusalVariable[] =
    L"ARDIA_RESTARTED_AFTER_REFUSAL";
inline constexpr char kRestartedAfterRefusalSwitch[] =
    "ardia-restarted-after-refusal";

struct LaunchGuardFacts {
  int predecessor_wait_ms = -1;
  int unfinished_starts_before = 0;
  std::wstring recovered_to;
  bool profile_held_by_another = false;
  bool restarted_after_refusal = false;
  bool update_under_way = false;
};

struct QuittingOwner {
  HANDLE process = nullptr;
  DWORD process_id = 0;
  bool exiting = false;
};

std::wstring AppDataDirectory();

std::wstring LaunchLogPath();

void RotateLaunchLog();

void GuardBrowserLaunch(const std::wstring& chromium_user_data_dir,
                        base::CommandLine* command_line);

void MarkExiting();

void MarkStartSettled();

void ClaimGuard();

bool OwnsGuard();

void PublishOwnerIfOwned();

void LetGoOfGuard();

void NoteRestartedAfterRefusal();

void MarkUpdating();

bool UpdateUnderWay();

void NoteBecameBrowser();

void NoteTurnedAway();

std::string LaunchLogLine(const std::string& text);

const LaunchGuardFacts& GuardFacts();

bool FindQuittingOwner(QuittingOwner* owner);

bool WaitForOwnerToEnd(const QuittingOwner& owner, int budget_ms, int* waited_ms);

void CloseOwner(QuittingOwner* owner);

bool WaitForLockFileFree(int most_ms);

void CountRefusedStart();

int TakeRefusedStarts();

void SaveLastQuit(const std::string& json);

std::string TakeLastQuit();

int NextUnfinishedStarts(int recorded, bool* recover);

bool HandsOverToDeElevatedCopy(const base::CommandLine& command_line);

}

#endif
