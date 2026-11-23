#include "ardia/win/launch_guard.h"

#include <windows.h>

#include <knownfolders.h>
#include <share.h>
#include <shlobj.h>
#include <stdio.h>

#include <cwctype>
#include <string>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "base/win/win_util.h"
#include "chrome/common/chrome_switches.h"
#include "content/public/common/content_switches.h"

namespace ardia_win {

namespace {

constexpr const wchar_t* kRestoreStateFiles[] = {
    L"session.json",
    L"launch-look.json",
    L"switches-cache.json",
    L"bookmarks-cache.json",
};

constexpr const wchar_t* kGpuCaches[] = {
    L"GrShaderCache",          L"GraphiteDawnCache",
    L"ShaderCache",            L"GPUPersistentCache",
    L"Default\\GPUCache",      L"Default\\DawnGraphiteCache",
    L"Default\\DawnWebGPUCache",
};

constexpr char kWaitedForPreviousSwitch[] = "ardia-waited-for-previous-ms";
constexpr wchar_t kChromiumLockFile[] = L"lockfile";
constexpr int kLockFilePollMs = 100;
constexpr int kLockFileGraceMs = 2000;
constexpr int kOwnerStartWaitMs = 10000;
constexpr wchar_t kStartsFile[] = L"launch-starts.txt";
constexpr wchar_t kLogFolder[] = L"Logs";
constexpr wchar_t kLogFile[] = L"launch.log";
constexpr wchar_t kPreviousLogFile[] = L"launch.previous.log";

struct GuardState {
  HANDLE alive = nullptr;
  bool owns_alive = false;
  HANDLE exiting = nullptr;
  std::wstring exiting_name;
  bool settled = false;
  LaunchGuardFacts facts;
};

GuardState& State() {
  static base::NoDestructor<GuardState> state;
  return *state;
}

std::wstring Environment(const wchar_t* name) {
  std::wstring value(32768, L'\0');
  DWORD length = ::GetEnvironmentVariableW(name, value.data(),
                                          static_cast<DWORD>(value.size()));
  if (length == 0 || length >= value.size()) {
    return std::wstring();
  }
  value.resize(length);
  return value;
}

std::wstring Trimmed(std::wstring path) {
  while (!path.empty() && (path.back() == L'\\' || path.back() == L'/')) {
    path.pop_back();
  }
  return path;
}

std::wstring LocalAppData() {
  PWSTR raw = nullptr;
  std::wstring found;
  if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE,
                                       nullptr, &raw)) &&
      raw) {
    found = raw;
  }
  ::CoTaskMemFree(raw);
  if (found.empty()) {
    found = Environment(L"LOCALAPPDATA");
  }
  return Trimmed(found);
}

std::wstring Joined(const std::wstring& folder, const wchar_t* name) {
  return folder + L"\\" + name;
}

std::wstring ProfileKey(const std::wstring& chromium_user_data_dir) {
  uint64_t hash = 14695981039346656037ull;
  for (wchar_t c : Trimmed(chromium_user_data_dir)) {
    const wchar_t lower = static_cast<wchar_t>(std::towlower(c));
    hash ^= static_cast<uint64_t>(lower == L'/' ? L'\\' : lower);
    hash *= 1099511628211ull;
  }
  wchar_t text[17] = {};
  swprintf_s(text, L"%016llx", static_cast<unsigned long long>(hash));
  return text;
}

int ReadUnfinishedStarts(const std::wstring& path) {
  FILE* file = nullptr;
  if (_wfopen_s(&file, path.c_str(), L"rb") != 0 || !file) {
    return 0;
  }
  int value = 0;
  if (fscanf_s(file, "%d", &value) != 1) {
    value = 0;
  }
  fclose(file);
  return value < 0 ? 0 : value;
}

void WriteUnfinishedStarts(const std::wstring& path, int value) {
  const std::wstring temp = path + L".tmp";
  FILE* file = nullptr;
  if (_wfopen_s(&file, temp.c_str(), L"wb") != 0 || !file) {
    return;
  }
  fprintf(file, "%d\n", value);
  fclose(file);
  ::MoveFileExW(temp.c_str(), path.c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
}

std::wstring Stamp() {
  SYSTEMTIME now = {};
  ::GetLocalTime(&now);
  wchar_t text[32] = {};
  swprintf_s(text, L"%04u%02u%02u-%02u%02u%02u", now.wYear, now.wMonth,
             now.wDay, now.wHour, now.wMinute, now.wSecond);
  return text;
}

std::wstring SetRestoreStateAside(const std::wstring& data_dir) {
  const std::wstring recovery = Joined(data_dir, L"Recovery");
  const std::wstring folder = Joined(recovery, Stamp().c_str());
  ::CreateDirectoryW(recovery.c_str(), nullptr);
  ::CreateDirectoryW(folder.c_str(), nullptr);
  int moved = 0;
  for (const wchar_t* name : kRestoreStateFiles) {
    const std::wstring from = Joined(data_dir, name);
    if (::GetFileAttributesW(from.c_str()) == INVALID_FILE_ATTRIBUTES) {
      continue;
    }
    if (::MoveFileExW(from.c_str(), Joined(folder, name).c_str(),
                      MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED)) {
      moved++;
    }
  }
  return moved ? folder : std::wstring();
}

int ClearGpuCaches(const std::wstring& chromium_user_data_dir) {
  int cleared = 0;
  for (const wchar_t* name : kGpuCaches) {
    const base::FilePath cache =
        base::FilePath(chromium_user_data_dir).Append(name);
    if (base::PathExists(cache) && base::DeletePathRecursively(cache)) {
      cleared++;
    }
  }
  return cleared;
}

void AppendLog(const std::string& line) {
  const std::wstring path = LaunchLogPath();
  if (path.empty()) {
    return;
  }
  FILE* file = _wfsopen(path.c_str(), L"ab", _SH_DENYNO);
  if (!file) {
    return;
  }
  const std::string text = "engine 0 " + line + "\n";
  fwrite(text.data(), 1, text.size(), file);
  fclose(file);
}

bool Acquired(DWORD wait) {
  return wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED;
}

std::wstring ChromiumLockFile(const std::wstring& chromium_user_data_dir) {
  return Joined(Trimmed(chromium_user_data_dir), kChromiumLockFile);
}

bool LockFileHeld(const std::wstring& lock) {
  HANDLE file = ::CreateFileW(
      lock.c_str(), GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file != INVALID_HANDLE_VALUE) {
    ::CloseHandle(file);
    return false;
  }
  const DWORD error = ::GetLastError();
  return error == ERROR_SHARING_VIOLATION || error == ERROR_ACCESS_DENIED;
}

bool ProfileHeldByAnotherBrowser(const std::wstring& chromium_user_data_dir) {
  const std::wstring lock = ChromiumLockFile(chromium_user_data_dir);
  for (int waited = 0;; waited += kLockFilePollMs) {
    if (!LockFileHeld(lock)) {
      return false;
    }
    if (waited >= kLockFileGraceMs) {
      return true;
    }
    ::Sleep(kLockFilePollMs);
  }
}

void ResetLeftoverExiting(const std::wstring& name) {
  HANDLE leftover = ::OpenEventW(EVENT_MODIFY_STATE, FALSE, name.c_str());
  if (!leftover) {
    return;
  }
  ::ResetEvent(leftover);
  ::CloseHandle(leftover);
}

bool WaitForStartingOwner(const std::wstring& chromium_user_data_dir) {
  GuardState& state = State();
  const std::wstring lock = ChromiumLockFile(chromium_user_data_dir);
  const base::TimeTicks started = base::TimeTicks::Now();
  bool acquired = false;
  while (!LockFileHeld(lock) &&
         base::TimeTicks::Now() - started <
             base::Milliseconds(kOwnerStartWaitMs)) {
    if (Acquired(::WaitForSingleObject(state.alive, kLockFilePollMs))) {
      state.owns_alive = true;
      ResetLeftoverExiting(state.exiting_name);
      acquired = true;
      break;
    }
  }
  const int waited =
      static_cast<int>((base::TimeTicks::Now() - started).InMilliseconds());
  if (waited >= kLockFilePollMs) {
    const std::string line =
        "launch guard: waited " + std::to_string(waited) +
        " ms for the Ardia starting on this profile" +
        (acquired ? std::string(", then took its place")
                  : std::string(", then handed over to it"));
    LOG(WARNING) << "Ardia " << line;
    AppendLog(line);
  }
  return acquired;
}

bool WaitForExitingPredecessor(const std::wstring& key,
                               const std::wstring& chromium_user_data_dir) {
  GuardState& state = State();
  const std::wstring alive_name = L"Local\\ArdiaBrowser." + key + L".alive";
  state.exiting_name = L"Local\\ArdiaBrowser." + key + L".exiting";
  state.alive = ::CreateMutexW(nullptr, FALSE, alive_name.c_str());
  if (!state.alive) {
    return true;
  }
  DWORD owned = ::WaitForSingleObject(state.alive, 0);
  if (Acquired(owned)) {
    state.owns_alive = true;
    ResetLeftoverExiting(state.exiting_name);
    return true;
  }
  if (owned != WAIT_TIMEOUT) {
    return true;
  }
  HANDLE exiting = ::OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE,
                                state.exiting_name.c_str());
  if (!exiting) {
    return WaitForStartingOwner(chromium_user_data_dir);
  }
  const base::TimeTicks started = base::TimeTicks::Now();
  const base::TimeTicks deadline =
      started + base::Seconds(kPredecessorWaitSeconds);
  bool stayed = false;
  owned = WAIT_TIMEOUT;
  while (base::TimeTicks::Now() < deadline) {
    owned = ::WaitForSingleObject(state.alive, kPredecessorPollMs);
    if (Acquired(owned)) {
      state.owns_alive = true;
      break;
    }
    if (owned != WAIT_TIMEOUT) {
      break;
    }
    if (::WaitForSingleObject(exiting, 0) == WAIT_TIMEOUT) {
      stayed = true;
      break;
    }
  }
  if (state.owns_alive && !stayed) {
    ::ResetEvent(exiting);
  }
  ::CloseHandle(exiting);
  const int waited =
      static_cast<int>((base::TimeTicks::Now() - started).InMilliseconds());
  state.facts.predecessor_wait_ms = waited;
  std::string line;
  if (stayed) {
    line = "launch guard: another Ardia took over this profile after " +
           std::to_string(waited) + " ms";
  } else if (!state.owns_alive) {
    line = "launch guard: the previous Ardia on this profile was still "
           "exiting after " +
           std::to_string(waited) + " ms; starting anyway";
  } else {
    line = "launch guard: waited " + std::to_string(waited) +
           " ms for the previous Ardia on this profile to finish exiting";
  }
  LOG(WARNING) << "Ardia " << line;
  AppendLog(line);
  if (stayed) {
    return WaitForStartingOwner(chromium_user_data_dir);
  }
  return true;
}

}

namespace {

std::wstring& AppDataOverride() {
  static base::NoDestructor<std::wstring> directory;
  return *directory;
}

}

std::wstring AppDataDirectory() {
  if (!AppDataOverride().empty()) {
    return AppDataOverride();
  }
  const std::wstring requested = Trimmed(Environment(L"ARDIA_DATA_DIR"));
  if (!requested.empty()) {
    return requested;
  }
  const std::wstring local = LocalAppData();
  return local.empty() ? std::wstring() : Joined(local, L"Ardia");
}

void SetAppDataDirectory(const std::wstring& directory) {
  AppDataOverride() = Trimmed(directory);
}

std::wstring LaunchLogPath() {
  const std::wstring data_dir = AppDataDirectory();
  if (data_dir.empty()) {
    return std::wstring();
  }
  const std::wstring folder = Joined(data_dir, kLogFolder);
  ::CreateDirectoryW(data_dir.c_str(), nullptr);
  ::CreateDirectoryW(folder.c_str(), nullptr);
  return Joined(folder, kLogFile);
}

void RotateLaunchLog() {
  const std::wstring path = LaunchLogPath();
  if (path.empty()) {
    return;
  }
  WIN32_FILE_ATTRIBUTE_DATA data = {};
  if (!::GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data) ||
      (data.nFileSizeHigh == 0 && data.nFileSizeLow == 0)) {
    return;
  }
  const std::wstring previous =
      Joined(path.substr(0, path.find_last_of(L'\\')), kPreviousLogFile);
  ::MoveFileExW(path.c_str(), previous.c_str(), MOVEFILE_REPLACE_EXISTING);
}

int NextUnfinishedStarts(int recorded, bool* recover) {
  const bool again = recorded >= kUnfinishedStartsBeforeRecovery;
  if (recover) {
    *recover = again;
  }
  return again ? 1 : recorded + 1;
}

bool HandsOverToDeElevatedCopy(const base::CommandLine& command_line) {
  for (const char* name :
       {switches::kDoNotDeElevateOnLaunch, switches::kEnableAutomation,
        switches::kIsolated, switches::kTestType}) {
    if (command_line.HasSwitch(name)) {
      return false;
    }
  }
  return base::win::UserAccountIsUnnecessarilyElevated();
}

void GuardBrowserLaunch(const std::wstring& chromium_user_data_dir,
                        base::CommandLine* command_line) {
  GuardState& state = State();
  const bool primary =
      WaitForExitingPredecessor(ProfileKey(chromium_user_data_dir),
                                chromium_user_data_dir);
  int inherited = -1;
  if (base::StringToInt(
          command_line->GetSwitchValueASCII(kWaitedForPreviousSwitch),
          &inherited) &&
      inherited >= 0 && state.facts.predecessor_wait_ms < 0) {
    state.facts.predecessor_wait_ms = inherited;
  }
  command_line->RemoveSwitch(kWaitedForPreviousSwitch);
  if (!primary) {
    return;
  }
  if (HandsOverToDeElevatedCopy(*command_line)) {
    if (state.owns_alive) {
      ::ReleaseMutex(state.alive);
      state.owns_alive = false;
    }
    if (state.facts.predecessor_wait_ms >= 0) {
      command_line->AppendSwitchASCII(
          kWaitedForPreviousSwitch,
          base::NumberToString(state.facts.predecessor_wait_ms));
    }
    return;
  }
  if (!state.owns_alive) {
    const std::string line =
        "launch guard: this launch doesn't own the profile's guard; this "
        "start is not counted and nothing is recovered";
    LOG(WARNING) << "Ardia " << line;
    AppendLog(line);
    return;
  }
  if (ProfileHeldByAnotherBrowser(chromium_user_data_dir)) {
    state.facts.profile_held_by_another = true;
    const std::string line =
        "launch guard: another Ardia still holds this profile; this start "
        "is not counted and nothing is recovered";
    LOG(WARNING) << "Ardia " << line;
    AppendLog(line);
    return;
  }
  RotateLaunchLog();
  const std::wstring data_dir = AppDataDirectory();
  if (data_dir.empty()) {
    return;
  }
  ::CreateDirectoryW(data_dir.c_str(), nullptr);
  const std::wstring starts = Joined(data_dir, kStartsFile);
  const int recorded = ReadUnfinishedStarts(starts);
  state.facts.unfinished_starts_before = recorded;
  bool recover = false;
  const int next = NextUnfinishedStarts(recorded, &recover);
  if (recover) {
    state.facts.recovered_to = SetRestoreStateAside(data_dir);
    const int gpu_caches = ClearGpuCaches(chromium_user_data_dir);
    const std::string line =
        "launch guard: the last " + std::to_string(recorded) +
        " starts did not finish; " +
        (state.facts.recovered_to.empty()
             ? std::string("there was no restore state to set aside")
             : "the restore state was set aside in " +
                   base::WideToUTF8(state.facts.recovered_to)) +
        ", and " + std::to_string(gpu_caches) + " graphics caches were cleared";
    LOG(WARNING) << "Ardia " << line;
    AppendLog(line);
  }
  WriteUnfinishedStarts(starts, next);
}

void MarkExiting() {
  GuardState& state = State();
  if (state.exiting || state.exiting_name.empty()) {
    return;
  }
  state.exiting = ::CreateEventW(nullptr, TRUE, TRUE, state.exiting_name.c_str());
  if (state.exiting) {
    ::SetEvent(state.exiting);
  }
}

void ClaimGuard() {
  GuardState& state = State();
  if (state.owns_alive || !state.alive) {
    return;
  }
  if (Acquired(::WaitForSingleObject(state.alive, 0))) {
    state.owns_alive = true;
    ResetLeftoverExiting(state.exiting_name);
  }
}

bool OwnsGuard() {
  return State().owns_alive;
}

void ClearExiting() {
  GuardState& state = State();
  if (!state.exiting) {
    return;
  }
  ::ResetEvent(state.exiting);
  ::CloseHandle(state.exiting);
  state.exiting = nullptr;
}

void MarkStartSettled() {
  GuardState& state = State();
  if (state.settled) {
    return;
  }
  state.settled = true;
  const std::wstring data_dir = AppDataDirectory();
  if (!data_dir.empty()) {
    WriteUnfinishedStarts(Joined(data_dir, kStartsFile), 0);
  }
}

const LaunchGuardFacts& GuardFacts() {
  return State().facts;
}

}
