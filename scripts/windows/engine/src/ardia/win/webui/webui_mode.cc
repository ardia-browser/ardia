#include "ardia/win/webui/webui_mode.h"

#include <windows.h>

#include <optional>
#include <string>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/main.h"
#include "ardia/win/webui/webui_policy.h"
#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/logging.h"
#include "base/path_service.h"
#include "base/strings/string_number_conversions.h"
#include "chrome/install_static/user_data_dir.h"

namespace ardia_win {

namespace {

std::wstring Trimmed(std::wstring path) {
  while (!path.empty() && (path.back() == L'\\' || path.back() == L'/')) {
    path.pop_back();
  }
  return path;
}

std::wstring ReadEnv(const wchar_t* name) {
  std::wstring value(32768, L'\0');
  const DWORD length =
      ::GetEnvironmentVariableW(name, value.data(), static_cast<DWORD>(value.size()));
  if (length == 0 || length >= value.size()) {
    return std::wstring();
  }
  value.resize(length);
  return value;
}

std::optional<std::wstring> FinalPathForHandle(HANDLE handle) {
  constexpr DWORD kFlags = VOLUME_NAME_DOS | FILE_NAME_NORMALIZED;
  const DWORD size = ::GetFinalPathNameByHandleW(handle, nullptr, 0, kFlags);
  if (size == 0) {
    return std::nullopt;
  }
  std::wstring value(size, L'\0');
  const DWORD written =
      ::GetFinalPathNameByHandleW(handle, value.data(), size, kFlags);
  if (written == 0 || written >= size) {
    return std::nullopt;
  }
  value.resize(written);
  return value;
}

enum class MigratorLookup { kReady, kMissing, kUnsafe };

MigratorLookup VerifyMigratorBinary(const base::FilePath& exe_dir,
                                    const base::FilePath& binary) {
  HANDLE dir_handle = ::CreateFileW(
      exe_dir.value().c_str(), FILE_LIST_DIRECTORY | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (dir_handle == INVALID_HANDLE_VALUE) {
    return MigratorLookup::kUnsafe;
  }
  const std::optional<std::wstring> dir_final = FinalPathForHandle(dir_handle);
  ::CloseHandle(dir_handle);
  if (!dir_final) {
    return MigratorLookup::kUnsafe;
  }
  HANDLE file_handle = ::CreateFileW(
      binary.value().c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file_handle == INVALID_HANDLE_VALUE) {
    const DWORD error = ::GetLastError();
    return (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
               ? MigratorLookup::kMissing
               : MigratorLookup::kUnsafe;
  }
  const DWORD file_type = ::GetFileType(file_handle);
  BY_HANDLE_FILE_INFORMATION info{};
  const bool info_ok = ::GetFileInformationByHandle(file_handle, &info) != FALSE;
  const std::optional<std::wstring> file_final = FinalPathForHandle(file_handle);
  ::CloseHandle(file_handle);
  if (file_type != FILE_TYPE_DISK || !info_ok || !file_final ||
      (info.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return MigratorLookup::kUnsafe;
  }
  return IsDirectChildOfWinDirectory(*dir_final, *file_final)
             ? MigratorLookup::kReady
             : MigratorLookup::kUnsafe;
}

}

bool WebUIShellRequested(const base::CommandLine& command_line) {
  const std::wstring shell = command_line.GetSwitchValueNative(kShellSwitch);
  const bool headless = command_line.HasSwitch(kHeadlessSwitch);
  return WebUIShellSelected(
      command_line.GetSwitchValueNative(kProcessTypeSwitch), shell, headless,
      shell != kWebUIShell && shell != kReactNativeShell && !headless &&
          install_static::ReactNativeAppLibraryBesideExe());
}

std::wstring WebUIAppDataDirectory(const std::wstring& ardia_data_dir,
                                   const std::wstring& local_app_data) {
  const std::wstring scratch = Trimmed(ardia_data_dir);
  if (!scratch.empty()) {
    return scratch;
  }
  const std::wstring local = Trimmed(local_app_data);
  if (local.empty()) {
    return std::wstring();
  }
  return local + L"\\" + kWebUIAppDataFolder;
}

std::wstring WebUIUserDataDirectory(const std::wstring& app_data_dir) {
  if (app_data_dir.empty()) {
    return std::wstring();
  }
  return Trimmed(app_data_dir) + L"\\" + kWebUIChromiumFolder;
}

bool ShouldRunWebUIStartupMigration(const base::CommandLine& command_line,
                                    const std::wstring& ardia_data_dir_env) {
  return ShouldRunStartupMigration(StartupMigrationPolicyInput{
      .has_migrate_switch = command_line.HasSwitch(kMigrateFromRnwSwitch),
      .has_no_migrate_switch = command_line.HasSwitch(kNoMigrateSwitch),
      .has_custom_data_dir = !Trimmed(ardia_data_dir_env).empty(),
      .has_migrate_rnw_data =
          !Trimmed(command_line.GetSwitchValueNative(kMigrateRnwDataSwitch))
               .empty(),
  });
}

namespace {

StartupMigrationResult LaunchWebUIStartupMigration(
    const base::CommandLine& command_line) {
  const std::wstring env_data_dir = ReadEnv(L"ARDIA_DATA_DIR");
  const bool has_custom_data_dir = !Trimmed(env_data_dir).empty();
  const std::wstring rnw_data_dir =
      Trimmed(command_line.GetSwitchValueNative(kMigrateRnwDataSwitch));
  const StartupMigrationPolicyInput policy{
      .has_migrate_switch = command_line.HasSwitch(kMigrateFromRnwSwitch),
      .has_no_migrate_switch = command_line.HasSwitch(kNoMigrateSwitch),
      .has_custom_data_dir = has_custom_data_dir,
      .has_migrate_rnw_data = !rnw_data_dir.empty(),
  };
  if (StartupMigrationRequestIncomplete(policy)) {
    LOG(WARNING) << "Ardia WebUI shell: --ardia-migrate-from-rnw with "
                    "ARDIA_DATA_DIR needs --ardia-migrate-rnw-data=<dir>";
    NoteForTest("webui shell: startup migration refused (missing rnw-data)");
    return {StartupMigrationOutcome::kIncompleteArguments};
  }
  if (!ShouldRunStartupMigration(policy)) {
    return {StartupMigrationOutcome::kNotRequested};
  }
  base::FilePath exe_dir;
  if (!base::PathService::Get(base::DIR_EXE, &exe_dir) || exe_dir.empty()) {
    LOG(WARNING) << "Ardia WebUI shell: startup migration could not find the "
                    "executable directory";
    NoteForTest("webui shell: startup migration lookup failed (no executable directory)");
    return {StartupMigrationOutcome::kLookupFailed};
  }
  const base::FilePath binary = exe_dir.Append(kMigratorBinaryName);
  const MigratorLookup lookup = VerifyMigratorBinary(exe_dir, binary);
  if (lookup == MigratorLookup::kMissing) {
    LOG(INFO) << "Ardia WebUI shell: startup migrator not present beside chrome.exe; continuing";
    NoteForTest("webui shell: startup migrator absent");
    return {StartupMigrationOutcome::kMigratorAbsent};
  }
  if (lookup == MigratorLookup::kUnsafe) {
    LOG(WARNING) << "Ardia WebUI shell: startup migrator failed binary containment check";
    NoteForTest("webui shell: startup migrator refused");
    return {StartupMigrationOutcome::kMigratorUnsafe};
  }
  const std::wstring webui_data_dir = Trimmed(AppDataDirectory());
  const std::optional<std::vector<std::wstring>> args =
      BuildStartupMigrationArguments(
          has_custom_data_dir, rnw_data_dir,
          rnw_data_dir.empty() ? std::wstring() : webui_data_dir,
          ardiacore::TestInstance());
  if (!args) {
    LOG(WARNING) << "Ardia WebUI shell: startup migration has incomplete migration paths";
    NoteForTest("webui shell: startup migration skipped (incomplete paths)");
    return {StartupMigrationOutcome::kIncompleteArguments};
  }
  std::wstring command_text = BuildWinCommandLine(binary.value(), *args);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!::CreateProcessW(binary.value().c_str(), command_text.data(), nullptr,
                        nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr,
                        &startup, &process)) {
    const DWORD error = ::GetLastError();
    LOG(WARNING) << "Ardia WebUI shell: startup migrator failed to launch (error "
                 << error << ")";
    NoteForTest("webui shell: startup migrator launch failed " +
                base::NumberToString(error));
    return {StartupMigrationOutcome::kLaunchFailed, error};
  }
  StartupMigrationResult result;
  const DWORD waited =
      ::WaitForSingleObject(process.hProcess, kStartupMigrationTimeoutMs);
  if (waited == WAIT_TIMEOUT) {
    ::TerminateProcess(process.hProcess, 1);
    ::WaitForSingleObject(process.hProcess, 2000);
    LOG(WARNING) << "Ardia WebUI shell: startup migrator timed out after "
                 << kStartupMigrationTimeoutMs << " ms and was terminated";
    NoteForTest("webui shell: startup migrator timed out");
    result = {StartupMigrationOutcome::kTimedOut};
  } else if (waited == WAIT_OBJECT_0) {
    DWORD exit_code = 1;
    if (::GetExitCodeProcess(process.hProcess, &exit_code)) {
      if (exit_code == 0) {
        LOG(INFO) << "Ardia WebUI shell: startup migrator finished with exit 0";
      } else {
        LOG(WARNING) << "Ardia WebUI shell: startup migrator exited with code "
                     << exit_code;
      }
      NoteForTest("webui shell: startup migrator exit " +
                  base::NumberToString(exit_code));
      result = {StartupMigrationOutcome::kExited, exit_code};
    } else {
      const DWORD error = ::GetLastError();
      LOG(WARNING) << "Ardia WebUI shell: startup migrator exit code unreadable "
                      "(error "
                   << error << ")";
      NoteForTest("webui shell: startup migrator exit unreadable " +
                  base::NumberToString(error));
      result = {StartupMigrationOutcome::kWaitFailed, error};
    }
  } else {
    const DWORD error = ::GetLastError();
    LOG(WARNING) << "Ardia WebUI shell: startup migrator wait failed (error "
                 << error << ")";
    NoteForTest("webui shell: startup migrator wait failed " +
                base::NumberToString(error));
    result = {StartupMigrationOutcome::kWaitFailed, error};
  }
  ::CloseHandle(process.hThread);
  ::CloseHandle(process.hProcess);
  return result;
}

}

StartupMigrationResult RunWebUIStartupMigration(
    const base::CommandLine& command_line) {
  static std::optional<StartupMigrationResult> result;
  if (!result) {
    result = LaunchWebUIStartupMigration(command_line);
  }
  return *result;
}

}
