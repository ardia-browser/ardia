#include "ardia/win/main.h"

#include <windows.h>

#include <share.h>
#include <stdio.h>
#include <cstdlib>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_hooks.h"
#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/api.h"
#include "ardia/win/external_apps.h"
#include "ardia/win/frame_view.h"
#include "ardia/win/hooks.h"
#include "ardia/win/host.h"
#include "ardia/win/kept_pages.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/test_gate.h"
#include "base/base_switches.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/process/process.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/devtools/chrome_devtools_manager_delegate.h"
#include "chrome/browser/headless/headless_mode_util.h"
#include "chrome/install_static/user_data_dir.h"
#include "chrome/browser/chrome_browser_main.h"
#include "chrome/browser/chrome_browser_main_extra_parts.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/lifetime/application_lifetime_desktop.h"
#include "chrome/browser/lifetime/browser_shutdown.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/win/chrome_process_finder.h"
#include "chrome/common/chrome_result_codes.h"
#include "chrome/common/chrome_switches.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"
#include "components/url_formatter/url_fixer.h"
#include "content/public/common/content_switches.h"
#include "media/base/media_switches.h"
#include "url/gurl.h"

namespace base {
extern bool (*g_ardia_pre_translate_message)(const MSG& msg);
}

namespace ardia_win {

namespace {

struct App {
  HMODULE module = nullptr;
  ArdiaAppPreTranslateFunction pre_translate = nullptr;
  ArdiaAppStopFunction stop = nullptr;
  ArdiaAppLaunchArrivingFunction launch_arriving = nullptr;
  ArdiaAppLaunchDeliveredFunction launch_delivered = nullptr;
  ArdiaAppAfterLaunchArrivingFunction after_launch_arriving = nullptr;
  bool started = false;
};

App& TheApp() {
  static App app;
  return app;
}

struct Gate {
  std::string refusal = "no scratch ARDIA_DATA_DIR";
  bool asked = false;
  std::string port;
};

Gate& TheGate() {
  static base::NoDestructor<Gate> gate;
  return *gate;
}

std::unique_ptr<ScopedKeepAlive>& KeepAlive() {
  static base::NoDestructor<std::unique_ptr<ScopedKeepAlive>> keep_alive;
  return *keep_alive;
}

constexpr int kHandOffHoldMostMs = 20000;
constexpr char kUserQuit[] = "user";
constexpr char kUpdateQuit[] = "update";

struct QuitState {
  bool asking = false;
  bool past_no_return = false;
  bool engine_quit_started = false;
  std::string reason = kUserQuit;
  int cancelled_by_launch = 0;
};

QuitState& TheQuit() {
  static base::NoDestructor<QuitState> quit;
  return *quit;
}

struct OwnStart {
  std::wstring directory;
  std::vector<wchar_t> environment;
};

OwnStart& TheStart() {
  static base::NoDestructor<OwnStart> start;
  return *start;
}

void RememberOwnStart() {
  OwnStart& start = TheStart();
  const DWORD needed = ::GetCurrentDirectoryW(0, nullptr);
  if (needed > 0) {
    start.directory.resize(needed);
    const DWORD written =
        ::GetCurrentDirectoryW(needed, start.directory.data());
    start.directory.resize(written > 0 && written < needed ? written : 0);
  }
  wchar_t* block = ::GetEnvironmentStringsW();
  if (!block) {
    return;
  }
  const wchar_t* const first = block;
  const wchar_t* end = first;
  while (*end) {
    end += wcslen(end) + 1;
  }
  start.environment.assign(first, end + 1);
  ::FreeEnvironmentStringsW(block);
}

std::wstring_view EnvironmentName(std::wstring_view entry) {
  const size_t equals = entry.find(L'=', 1);
  return equals == std::wstring_view::npos ? entry : entry.substr(0, equals);
}

bool SameEnvironmentName(std::wstring_view a, std::wstring_view b) {
  return ::CompareStringOrdinal(a.data(), static_cast<int>(a.size()), b.data(),
                                static_cast<int>(b.size()),
                                TRUE) == CSTR_EQUAL;
}

bool EnvironmentNameBefore(const std::wstring& a, const std::wstring& b) {
  const std::wstring_view left = EnvironmentName(a);
  const std::wstring_view right = EnvironmentName(b);
  return ::CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
                                right.data(), static_cast<int>(right.size()),
                                TRUE) == CSTR_LESS_THAN;
}

std::vector<wchar_t> EnvironmentForRestart() {
  const std::vector<wchar_t>& block = TheStart().environment;
  std::vector<std::wstring> entries;
  for (size_t at = 0; at < block.size() && block[at];) {
    std::wstring entry(&block[at]);
    at += entry.size() + 1;
    if (!SameEnvironmentName(EnvironmentName(entry),
                             kRestartedAfterRefusalVariable)) {
      entries.push_back(std::move(entry));
    }
  }
  entries.push_back(std::wstring(kRestartedAfterRefusalVariable) + L"=1");
  std::stable_sort(entries.begin(), entries.end(), &EnvironmentNameBefore);
  std::vector<wchar_t> restart;
  for (const std::wstring& entry : entries) {
    restart.insert(restart.end(), entry.begin(), entry.end());
    restart.push_back(L'\0');
  }
  restart.push_back(L'\0');
  return restart;
}

std::wstring OwnExecutable() {
  std::wstring path(MAX_PATH, L'\0');
  while (true) {
    const DWORD length = ::GetModuleFileNameW(
        nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (length == 0) {
      return std::wstring();
    }
    if (length < path.size()) {
      path.resize(length);
      return path;
    }
    if (path.size() >= 32768) {
      return std::wstring();
    }
    path.resize(path.size() * 2);
  }
}

bool StartAgain(DWORD* process_id, DWORD* error) {
  *process_id = 0;
  *error = 0;
  const std::wstring executable = OwnExecutable();
  if (executable.empty()) {
    *error = ::GetLastError();
    return false;
  }
  std::wstring command_line(::GetCommandLineW());
  std::vector<wchar_t> environment = EnvironmentForRestart();
  const OwnStart& start = TheStart();
  STARTUPINFOW startup = {sizeof(startup)};
  PROCESS_INFORMATION started = {};
  if (!::CreateProcessW(
          executable.c_str(), command_line.data(), nullptr, nullptr, FALSE,
          CREATE_UNICODE_ENVIRONMENT, environment.data(),
          start.directory.empty() ? nullptr : start.directory.c_str(),
          &startup, &started)) {
    *error = ::GetLastError();
    return false;
  }
  *process_id = started.dwProcessId;
  ::CloseHandle(started.hThread);
  ::CloseHandle(started.hProcess);
  return true;
}

std::wstring AppLibraryPath() {
  std::wstring path(MAX_PATH, L'\0');
  DWORD length = ::GetModuleFileNameW(nullptr, path.data(),
                                      static_cast<DWORD>(path.size()));
  path.resize(length);
  size_t slash = path.find_last_of(L'\\');
  if (slash == std::wstring::npos) {
    return std::wstring();
  }
  path.resize(slash + 1);
  path.append(L"ArdiaApp.dll");
  return path;
}

bool AppLibraryPresent() {
  std::wstring path = AppLibraryPath();
  return !path.empty() &&
         ::GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
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

bool Set(const std::wstring& value) {
  return !value.empty() && value != L"0";
}

std::string TestEntryFromEnvironment(std::string_view key) {
  const std::string entries = base::WideToUTF8(Environment(L"ARDIA_TEST"));
  for (std::string_view entry : base::SplitStringPiece(
           entries, ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    const size_t equals = entry.find('=');
    if (equals != std::string_view::npos &&
        base::TrimWhitespaceASCII(entry.substr(0, equals), base::TRIM_ALL) ==
            key) {
      return std::string(base::TrimWhitespaceASCII(entry.substr(equals + 1),
                                                   base::TRIM_ALL));
    }
  }
  return std::string();
}

void AddFeatures(base::CommandLine* command_line,
                 const char* switch_name,
                 std::string_view features) {
  std::string all = command_line->GetSwitchValueASCII(switch_name);
  if (!all.empty()) {
    all.push_back(',');
  }
  all.append(features);
  command_line->AppendSwitchASCII(switch_name, all);
}

constexpr const char* kSwitchesThatOpenTheProfile[] = {
    "allow-insecure-localhost",
    "auto-open-devtools-for-tabs",
    "custom-devtools-frontend",
    "devtools-flags",
    "disable-extensions-except",
    "disable-web-security",
    "enable-automation",
    "enable-ui-devtools",
    "extensions-on-chrome-urls",
    "extensions-on-extension-urls",
    "host-resolver-rules",
    "host-rules",
    "ignore-certificate-errors",
    "ignore-certificate-errors-spki-list",
    "load-apps",
    "load-extension",
    "log-net-log",
    "net-log-capture-mode",
    "proxy-pac-url",
    "proxy-server",
    "remote-allow-origins",
    "remote-debugging-address",
    "remote-debugging-io-pipes",
    "remote-debugging-pipe",
    "remote-debugging-port",
    "remote-debugging-socket-name",
    "remote-debugging-targets",
    "silent-debugger-extension-api",
    "ssl-key-log-file",
    "unsafely-treat-insecure-origin-as-secure",
    "webtransport-developer-mode",
};

bool BrowserProcess(const base::CommandLine& command_line) {
  return command_line.GetSwitchValueNative(switches::kProcessType).empty();
}

std::wstring ChromiumUserDataDir() {
  std::wstring user_data_dir;
  std::wstring invalid;
  if (!install_static::GetUserDataDirectory(&user_data_dir, &invalid) ||
      !invalid.empty()) {
    return std::wstring();
  }
  return user_data_dir;
}

constexpr const char* kWindowsSwitchesThatOpenTheProfile[] = {
    "browser-subprocess-path",
    "gpu-launcher",
    "no-sandbox",
    "renderer-cmd-prefix",
    "utility-cmd-prefix",
};

void KeepRealProfileClosed(base::CommandLine* command_line) {
  if (TheGate().refusal.empty()) {
    return;
  }
  for (const char* name : kSwitchesThatOpenTheProfile) {
    command_line->RemoveSwitch(name);
  }
  for (const char* name : kWindowsSwitchesThatOpenTheProfile) {
    command_line->RemoveSwitch(name);
  }
  ::SetEnvironmentVariableW(L"SSLKEYLOGFILE", nullptr);
  if (::GetEnvironmentVariableW(L"SSLKEYLOGFILE", nullptr, 0) != 0) {
    LOG(ERROR) << "Ardia engine: SSLKEYLOGFILE could not be cleared outside "
                  "a test instance; not starting";
    base::Process::TerminateCurrentProcessImmediately(1);
  }
}

void DecideTestGate(base::CommandLine* command_line) {
  for (const char* forbidden :
       {switches::kRemoteDebuggingPort, switches::kRemoteDebuggingPipe,
        "remote-allow-origins", kTestInstanceSwitch, ardiacore::kTestSwitch,
        ardiacore::kTraceSwitch, ardiacore::kDataDirSwitch}) {
    command_line->RemoveSwitch(forbidden);
  }
  std::wstring data_dir = Environment(L"ARDIA_DATA_DIR");
  while (!data_dir.empty() &&
         (data_dir.back() == L'\\' || data_dir.back() == L'/')) {
    data_dir.pop_back();
  }
  const std::wstring port = Environment(L"ARDIA_REMOTE_DEBUGGING_PORT");
  const std::wstring test = Environment(L"ARDIA_TEST");
  const std::wstring trace = Environment(L"ARDIA_TRACE");
  Gate& gate = TheGate();
  std::wstring refusal = TestGateRefusal(data_dir, ChromiumUserDataDir());
  if (refusal.empty()) {
    refusal = HoldScratchFolders(data_dir, ChromiumUserDataDir());
  }
  gate.refusal = base::WideToUTF8(refusal);
  gate.asked = !port.empty() || !test.empty() || !trace.empty();
  KeepRealProfileClosed(command_line);
  if (!gate.refusal.empty()) {
    return;
  }
  command_line->AppendSwitch(kTestInstanceSwitch);
  if (!port.empty()) {
    command_line->AppendSwitchNative(switches::kRemoteDebuggingPort, port);
    command_line->AppendSwitchASCII("remote-allow-origins", "*");
    gate.port = base::WideToUTF8(port);
  }
  if (!test.empty()) {
    command_line->AppendSwitchNative(ardiacore::kTestSwitch, test);
  }
  if (!trace.empty()) {
    command_line->AppendSwitchNative(ardiacore::kTraceSwitch, trace);
  }
}

void AddLaunchSwitches(base::CommandLine* command_line) {
  command_line->AppendSwitch(switches::kNoStartupWindow);
  command_line->AppendSwitch(switches::kNoFirstRun);
  command_line->AppendSwitch(switches::kNoDefaultBrowserCheck);
  command_line->AppendSwitch(switches::kHideCrashRestoreBubble);
  command_line->AppendSwitch("keep-old-history");
  AddFeatures(command_line, switches::kDisableFeatures,
              "CalculateNativeWinOcclusion,SettingsGlowupJourneys");
  AddFeatures(command_line, switches::kEnableFeatures, "WebContentsDiscard");
  std::wstring data_dir = Environment(L"ARDIA_DATA_DIR");
  while (!data_dir.empty() &&
         (data_dir.back() == L'\\' || data_dir.back() == L'/')) {
    data_dir.pop_back();
  }
  const bool background = Set(Environment(L"ARDIA_BACKGROUND"));
  if (!data_dir.empty()) {
    command_line->AppendSwitchNative(ardiacore::kDataDirSwitch, data_dir);
    command_line->AppendSwitchNative(switches::kUserDataDir,
                                     data_dir + L"\\Chromium");
  }
  if (background) {
    command_line->AppendSwitch(ardiacore::kBackgroundSwitch);
    command_line->AppendSwitch(switches::kMuteAudio);
    command_line->AppendSwitch(switches::kUseFakeDeviceForMediaStream);
  }
  std::wstring app_switches = Environment(L"ARDIA_SWITCHES");
  if (!app_switches.empty()) {
    command_line->AppendSwitchNative(ardiacore::kSwitchesSwitch, app_switches);
  }
}

HANDLE& LaunchLogHandle() {
  static HANDLE handle = INVALID_HANDLE_VALUE;
  return handle;
}

void CloseLaunchLog() {
  HANDLE& handle = LaunchLogHandle();
  if (handle != INVALID_HANDLE_VALUE) {
    CloseHandle(handle);
    handle = INVALID_HANDLE_VALUE;
  }
}

HANDLE OpenLaunchLog() {
  std::wstring path =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueNative("log-file");
  if (path.empty()) {
    path = LaunchLogPath();
  }
  if (path.empty()) {
    return INVALID_HANDLE_VALUE;
  }
  HANDLE handle = CreateFileW(
      path.c_str(), FILE_APPEND_DATA,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle != INVALID_HANDLE_VALUE) {
    LaunchLogHandle() = handle;
    std::atexit(&CloseLaunchLog);
  }
  return handle;
}

void WriteLaunchLog(const std::string& line) {
  static const HANDLE handle = OpenLaunchLog();
  if (handle == INVALID_HANDLE_VALUE) {
    return;
  }
  const std::string text = LaunchLogLine(line);
  DWORD wrote = 0;
  WriteFile(handle, text.data(), static_cast<DWORD>(text.size()), &wrote,
            nullptr);
}

void CopyLastQuit(const base::DictValue& last_quit, base::DictValue* facts) {
  const std::optional<int> wait_ms = last_quit.FindInt("waitMs");
  if (wait_ms && *wait_ms >= 0) {
    facts->Set("lastQuitWaitMs", *wait_ms);
  }
  if (const std::string* answer = last_quit.FindString("answer")) {
    facts->Set("lastQuitAnswer", *answer);
  }
  if (const std::string* reason = last_quit.FindString("reason")) {
    facts->Set("lastQuitReason", *reason);
  }
  const std::optional<int> cancelled = last_quit.FindInt("cancelledByLaunch");
  if (cancelled && *cancelled >= 0) {
    facts->Set("quitsCancelledByLaunch", *cancelled);
  }
}

void SaveLaunchGuardFacts(const LaunchGuardFacts& facts,
                          int refused_starts_before,
                          const base::DictValue& last_quit) {
  const std::wstring data_dir = AppDataDirectory();
  if (data_dir.empty()) {
    return;
  }
  base::DictValue saved;
  saved.Set("waitedForPreviousMs",
            facts.predecessor_wait_ms < 0 ? 0 : facts.predecessor_wait_ms);
  saved.Set("unfinishedStartsBefore", facts.unfinished_starts_before);
  saved.Set("restoreStateSetAside", !facts.recovered_to.empty());
  saved.Set("profileHeldByAnother", facts.profile_held_by_another);
  saved.Set("refusedStartsBefore", refused_starts_before);
  saved.Set("restartedAfterRefusal", facts.restarted_after_refusal);
  CopyLastQuit(last_quit, &saved);
  const std::string json = base::WriteJson(saved).value_or("{}") + "\n";
  FILE* file = nullptr;
  if (_wfopen_s(&file, (data_dir + L"\\launch-guard.json").c_str(), L"wb") !=
          0 ||
      !file) {
    return;
  }
  fwrite(json.data(), 1, json.size(), file);
  fclose(file);
}

void NoteLaunchGuard() {
  const LaunchGuardFacts& facts = GuardFacts();
  const int refused = TakeRefusedStarts();
  const base::DictValue last_quit =
      base::JSONReader::ReadDict(TakeLastQuit(), base::JSON_PARSE_RFC)
          .value_or(base::DictValue());
  SaveLaunchGuardFacts(facts, refused, last_quit);
  const std::optional<int> quit_wait_ms = last_quit.FindInt("waitMs");
  const std::string* quit_answer = last_quit.FindString("answer");
  WriteLaunchLog(
      "launch guard: waited " +
      std::to_string(facts.predecessor_wait_ms < 0 ? 0
                                                   : facts.predecessor_wait_ms) +
      " ms for a previous Ardia, " +
      std::to_string(facts.unfinished_starts_before) +
      " unfinished starts before this one, restore state " +
      (facts.recovered_to.empty() ? "kept" : "set aside") +
      (facts.restarted_after_refusal
           ? std::string(", started again after the closing Ardia turned "
                         "the last launch away")
           : std::string()) +
      (refused ? ", " + std::to_string(refused) +
                     " refused starts since the last one"
               : std::string()) +
      (quit_wait_ms && quit_answer
           ? ", the last quit's answer: " + *quit_answer + " after " +
                 std::to_string(*quit_wait_ms) + " ms"
           : std::string()));
}

void PassPointOfNoReturn() {
  QuitState& quit = TheQuit();
  quit.asking = false;
  if (quit.past_no_return) {
    return;
  }
  quit.past_no_return = true;
  MarkExiting();
  WriteLaunchLog(
      "relaunch: past the quit's point of no return; a new launch waits for "
      "this Ardia to end, and one already on its way is turned away and "
      "starts again after it");
}

void SaveQuitFacts(int wait_ms, std::string_view answer) {
  const QuitState& quit = TheQuit();
  base::DictValue facts;
  facts.Set("waitMs", std::max(wait_ms, 0));
  facts.Set("answer", answer == "yes" || answer == "timeout" ? std::string(answer)
                                                              : std::string("none"));
  facts.Set("reason", quit.reason);
  facts.Set("cancelledByLaunch", quit.cancelled_by_launch);
  SaveLastQuit(base::WriteJson(facts).value_or("{}"));
}

void NoteTestGate() {
  const Gate& gate = TheGate();
  if (!gate.refusal.empty() && !gate.asked) {
    return;
  }
  const std::string facts =
      std::string("; ardiacore test instance: ") +
      (ardiacore::TestInstance() ? "yes" : "no") +
      "; reauth=granted honoured: " +
      (ardiacore::TestValue("reauth") == "granted" ? "yes" : "no");
  std::string line =
      gate.refusal.empty()
          ? "test gate: a test instance; remote debugging port: " +
                (gate.port.empty() ? std::string("none") : gate.port) + facts
          : "test gate: ARDIA_REMOTE_DEBUGGING_PORT, ARDIA_TEST and "
            "ARDIA_TRACE ignored: not a test instance (" +
                gate.refusal + ")" + facts;
  LOG(WARNING) << "Ardia engine " << line;
  WriteLaunchLog(line);
}

bool ForEngineWindow(const MSG& msg) {
  constexpr wchar_t kPrefix[] = L"Chrome_";
  constexpr int kPrefixLength = 7;
  if (!msg.hwnd) {
    return false;
  }
  wchar_t name[kPrefixLength + 2] = {};
  int length = ::GetClassNameW(msg.hwnd, name, kPrefixLength + 2);
  return length >= kPrefixLength &&
         std::wstring_view(name, kPrefixLength) == kPrefix;
}

FILE*& InputTrace() {
  static FILE* trace = nullptr;
  return trace;
}

bool Traced(const MSG& msg) {
  return (msg.message >= WM_MOUSEFIRST && msg.message <= WM_MOUSELAST) ||
         (msg.message >= WM_NCMOUSEMOVE && msg.message <= WM_NCXBUTTONDBLCLK) ||
         (msg.message >= WM_KEYFIRST && msg.message <= WM_KEYLAST) ||
         (msg.message >= WM_NCPOINTERUPDATE && msg.message <= WM_POINTERHWHEEL);
}

void Trace(const MSG& msg, bool engine_window, bool taken) {
  FILE* trace = InputTrace();
  if (!trace || !Traced(msg)) {
    return;
  }
  static int moves = 0;
  if (msg.message == WM_MOUSEMOVE || msg.message == WM_POINTERUPDATE ||
      msg.message == WM_NCMOUSEMOVE || msg.message == WM_NCPOINTERUPDATE) {
    if (++moves > 40) {
      return;
    }
  }
  wchar_t name[64] = {};
  ::GetClassNameW(msg.hwnd, name, 64);
  fprintf(trace, "%lu msg=0x%04x hwnd=%p class=%ls engine=%d taken=%d\n",
          static_cast<unsigned long>(::GetTickCount()), msg.message,
          static_cast<void*>(msg.hwnd), name, engine_window ? 1 : 0,
          taken ? 1 : 0);
  fflush(trace);
}

bool PreTranslate(const MSG& msg) {
  if (TakeTopEdgePress(msg)) {
    return true;
  }
  App& app = TheApp();
  const bool engine_window = ForEngineWindow(msg);
  bool taken = false;
  if (app.started && app.pre_translate && !engine_window) {
    taken = app.pre_translate(&msg) != 0;
  }
  Trace(msg, engine_window, taken);
  return taken;
}

bool Background() {
  return Set(Environment(L"ARDIA_BACKGROUND")) ||
         base::CommandLine::ForCurrentProcess()->HasSwitch(
             ardiacore::kBackgroundSwitch);
}

void ShowStartFailure(const std::wstring& reason, const std::wstring& advice) {
  if (Background()) {
    return;
  }
  const std::wstring log = LaunchLogPath();
  std::wstring text = L"Ardia couldn't start.\n\n" + reason + L"\n\n" + advice;
  if (!log.empty()) {
    text += L" The details are in " + log + L".";
  }
  ::MessageBoxW(nullptr, text.c_str(), L"Ardia",
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TASKMODAL |
                    MB_TOPMOST);
}

void ShowStartFailureAndQuit(const std::wstring& reason) {
  ShowStartFailure(reason,
                   L"Installing Ardia again from ardia.dev usually fixes this.");
  QuitApp();
}

void FailStart(const std::wstring& reason) {
  MarkStartSettled();
  LOG(ERROR) << "Ardia: the app did not start: " << base::WideToUTF8(reason);
  WriteLaunchLog("app start failed: " + base::WideToUTF8(reason));
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&ShowStartFailureAndQuit, reason));
}

std::wstring AppRefusal(HMODULE module, int result) {
  auto failure = reinterpret_cast<ArdiaAppStartFailureFunction>(
      ::GetProcAddress(module, "ArdiaAppStartFailure"));
  const wchar_t* text = failure ? failure() : nullptr;
  std::wstring reason = text && *text ? std::wstring(text)
                                      : std::wstring(L"The app stopped while starting");
  return reason + L" (code " + std::to_wstring(result) + L").";
}

void ShowRecoveryNotice(const std::wstring& folder) {
  if (Background()) {
    return;
  }
  const std::wstring text =
      L"Ardia didn't finish starting the last few times, so it opened "
      L"without your last session.\n\nYour bookmarks, history and "
      L"passwords are untouched. The session it set aside is in " +
      folder + L".";
  ::MessageBoxW(nullptr, text.c_str(), L"Ardia",
                MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
}

void ClaimGuardUntilOwned(int attempts_left) {
  ClaimGuard();
  if (OwnsGuard() || attempts_left <= 0) {
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&ClaimGuardUntilOwned, attempts_left - 1),
      base::Milliseconds(kClaimRetryMs));
}

bool StartApp() {
  App& app = TheApp();
  std::wstring path = AppLibraryPath();
  app.module =
      ::LoadLibraryExW(path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!app.module) {
    const DWORD error = ::GetLastError();
    FailStart(error == ERROR_MOD_NOT_FOUND
                  ? L"A file Ardia needs is missing from its folder "
                    L"(Windows error 126)."
                  : L"Ardia's app library could not be loaded (Windows "
                    L"error " +
                        std::to_wstring(error) + L").");
    return false;
  }
  auto start = reinterpret_cast<ArdiaAppStartFunction>(
      ::GetProcAddress(app.module, "ArdiaAppStart"));
  app.pre_translate = reinterpret_cast<ArdiaAppPreTranslateFunction>(
      ::GetProcAddress(app.module, "ArdiaAppPreTranslateMessage"));
  app.stop = reinterpret_cast<ArdiaAppStopFunction>(
      ::GetProcAddress(app.module, "ArdiaAppStop"));
  app.launch_arriving = reinterpret_cast<ArdiaAppLaunchArrivingFunction>(
      ::GetProcAddress(app.module, "ArdiaAppLaunchArriving"));
  app.launch_delivered = reinterpret_cast<ArdiaAppLaunchDeliveredFunction>(
      ::GetProcAddress(app.module, "ArdiaAppLaunchDelivered"));
  app.after_launch_arriving =
      reinterpret_cast<ArdiaAppAfterLaunchArrivingFunction>(
          ::GetProcAddress(app.module, "ArdiaAppAfterLaunchArriving"));
  if (!start) {
    FailStart(L"Ardia's app library doesn't match its engine.");
    return false;
  }
  std::wstring traced = Environment(L"ARDIA_INPUT_TRACE");
  if (!traced.empty()) {
    _wfopen_s(&InputTrace(), traced.c_str(), L"w");
  }
  int result = start(EngineApi());
  if (result != 0) {
    FailStart(AppRefusal(app.module, result));
    return false;
  }
  app.started = true;
  base::g_ardia_pre_translate_message = &PreTranslate;
  return true;
}

void StopApp() {
  App& app = TheApp();
  base::g_ardia_pre_translate_message = nullptr;
  if (app.started && app.stop) {
    app.stop();
  }
  app.started = false;
}

class MainParts : public ChromeBrowserMainExtraParts {
 public:
  MainParts() = default;
  MainParts(const MainParts&) = delete;
  MainParts& operator=(const MainParts&) = delete;
  ~MainParts() override = default;

  void PreEarlyInitialization() override {
    KeepRealProfileClosed(base::CommandLine::ForCurrentProcess());
  }

  void PreBrowserStart() override {
    KeepAlive() = std::make_unique<ScopedKeepAlive>(
        KeepAliveOrigin::APP_CONTROLLER, KeepAliveRestartOption::DISABLED);
  }

  void PostBrowserStart() override {
    NoteBecameBrowser();
    NoteTestGate();
    NoteLaunchGuard();
    PublishOwnerIfOwned();
    ClaimGuardUntilOwned(kClaimAttempts);
    Host::Get()->Start();
    WatchEngineEvents();
    if (!StartApp()) {
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&MarkStartSettled),
        base::Seconds(kStartSettlesAfterSeconds));
    const std::wstring recovered = GuardFacts().recovered_to;
    if (!recovered.empty()) {
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&ShowRecoveryNotice, recovered));
    }
  }

  void PostMainMessageLoopRun() override {
    PassPointOfNoReturn();
    StopApp();
    KeepAlive().reset();
  }
};

void AddMainParts(ChromeBrowserMainParts* main_parts) {
  main_parts->AddParts(std::make_unique<MainParts>());
}

bool KeepsWindowWithoutTabs(const BrowserWindowInterface* browser) {
  return Host::Get()->Keeps(browser);
}

std::vector<std::string> LaunchLinks(const base::CommandLine& command_line,
                                     const base::FilePath& cur_dir) {
  std::vector<std::string> links;
  for (const base::CommandLine::StringType& argument :
       command_line.GetArgs()) {
    GURL url(base::WideToUTF8(argument));
    if (!url.is_valid()) {
      url = url_formatter::FixupRelativeFile(cur_dir,
                                             base::FilePath(argument));
    }
    if (url.is_valid() && (url.SchemeIsHTTPOrHTTPS() || url.SchemeIsFile())) {
      links.push_back(url.spec());
    }
  }
  return links;
}

void EmitRelaunch(const std::vector<std::string>& links) {
  base::ListValue urls;
  for (const std::string& link : links) {
    urls.Append(link);
  }
  base::DictValue payload;
  payload.Set("urls", std::move(urls));
  Emit("relaunch", std::move(payload));
}

void WriteLaunchLogLater(const std::string& line) {
  if (base::SequencedTaskRunner::HasCurrentDefault() &&
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&WriteLaunchLog, line))) {
    return;
  }
  WriteLaunchLog(line);
}

int TestMillisecondsFromEnvironment(std::string_view key, int most) {
  if (!TheGate().refusal.empty()) {
    return 0;
  }
  int value = 0;
  if (!base::StringToInt(TestEntryFromEnvironment(key), &value) || value <= 0) {
    return 0;
  }
  return std::min(value, most);
}

void DeliverLaunch(const base::CommandLine& command_line,
                   const base::FilePath& cur_dir) {
  App& app = TheApp();
  if (app.started && app.launch_delivered) {
    app.launch_delivered();
  }
  EmitRelaunch(LaunchLinks(command_line, cur_dir));
}

void PostLaunchDelivery(const base::CommandLine& command_line,
                        const base::FilePath& cur_dir) {
  const int held_ms =
      TestMillisecondsFromEnvironment("handOffDeliveryHoldMs", kHandOffHoldMostMs);
  if (held_ms) {
    WriteLaunchLogLater("test: a launch this Ardia took reaches the app " +
                        std::to_string(held_ms) + " ms late");
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&DeliverLaunch, command_line, cur_dir),
      base::Milliseconds(held_ms));
}

bool Relaunched(const base::CommandLine& command_line,
                const base::FilePath& cur_dir) {
  EmitRelaunch(LaunchLinks(command_line, cur_dir));
  return true;
}

bool IsLaunch(const base::CommandLine& command_line) {
  const base::CommandLine& own = *base::CommandLine::ForCurrentProcess();
  return !command_line.HasSwitch(switches::kUninstall) &&
         !command_line.HasSwitch(switches::kEnableAutomation) &&
         !own.HasSwitch(switches::kEnableAutomation) &&
         !headless::IsHeadlessMode() && !command_line.HasSwitch("headless");
}

void AfterLaunchTaken(int answer) {
  if (answer == ARDIA_APP_LAUNCH_KEPT_BY_CANCELLING_QUIT) {
    WriteLaunchLog("relaunch: a launch cancels the quit; this Ardia keeps "
                   "running and opens it");
  } else if (answer == ARDIA_APP_LAUNCH_LEFT_FOR_UPDATE) {
    WriteLaunchLog(
        "relaunch: a launch during an update's quit is taken and left for "
        "the installer, which opens Ardia again");
  }
  App& app = TheApp();
  if (app.started && app.after_launch_arriving) {
    app.after_launch_arriving();
  }
}

ArdiaHandOff AnswersHandOff(const base::CommandLine& command_line,
                            const base::FilePath& cur_dir) {
  if (!IsLaunch(command_line)) {
    return ArdiaHandOff::kNotOurs;
  }
  QuitState& quit = TheQuit();
  if (quit.reason == kUpdateQuit && (quit.asking || quit.past_no_return)) {
    WriteLaunchLogLater(
        "relaunch: a launch during an update's quit is taken and left for "
        "the installer, which opens Ardia again");
    return ArdiaHandOff::kTaken;
  }
  if (quit.past_no_return || browser_shutdown::HasShutdownStarted()) {
    WriteLaunchLogLater(
        "relaunch: turned a launch away: this Ardia is past its quit's point "
        "of no return, so that launch starts Ardia again once this one has "
        "ended");
    return ArdiaHandOff::kTurnedAway;
  }
  App& app = TheApp();
  const int answer = app.started && app.launch_arriving
                         ? app.launch_arriving()
                         : ARDIA_APP_LAUNCH_KEPT;
  if (answer == ARDIA_APP_LAUNCH_TURNED_AWAY) {
    WriteLaunchLogLater(
        "relaunch: turned a launch away: the app is past its quit's point of "
        "no return");
    return ArdiaHandOff::kTurnedAway;
  }
  if (answer == ARDIA_APP_LAUNCH_KEPT_BY_CANCELLING_QUIT) {
    quit.asking = false;
    quit.cancelled_by_launch++;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&AfterLaunchTaken, answer));
  if (answer != ARDIA_APP_LAUNCH_LEFT_FOR_UPDATE) {
    PostLaunchDelivery(command_line, cur_dir);
  }
  return ArdiaHandOff::kTaken;
}

int FailTurnedAwayLaunch(int exit_code,
                         const std::wstring& reason,
                         const std::wstring& advice) {
  CountRefusedStart();
  WriteLaunchLog("app start failed: " + base::WideToUTF8(reason) +
                 " (Chromium's profile-in-use exit, code " +
                 std::to_string(exit_code) + ")");
  ShowStartFailure(reason, advice);
  return exit_code;
}

int AnswerTurnedAwayLaunch(int exit_code) {
  NoteTurnedAway();
  if (UpdateUnderWay()) {
    WriteLaunchLog(
        "launch guard: Ardia is closing for an update; this launch ends here "
        "and the installer opens Ardia again");
    return 0;
  }
  if (GuardFacts().restarted_after_refusal) {
    return FailTurnedAwayLaunch(
        exit_code,
        L"Ardia started itself again after it was turned away, and was "
        L"turned away a second time: another copy of Ardia, another program "
        L"or another computer is using its profile folder.",
        L"Close the program using it, or restart Windows, then open Ardia "
        L"again.");
  }
  QuittingOwner owner;
  const bool owner_found = FindQuittingOwner(&owner);
  const bool successor_running = owner_found && !owner.exiting;
  if (owner_found && owner.exiting) {
    WriteLaunchLog("launch guard: the closing Ardia (" +
                   std::to_string(owner.process_id) +
                   ") turned this launch away; it starts again by itself once "
                   "that one has ended");
    const int already_waited = std::max(GuardFacts().predecessor_wait_ms, 0);
    int waited = 0;
    const bool ended = WaitForOwnerToEnd(
        owner, kPredecessorWaitSeconds * 1000 - already_waited, &waited);
    CloseOwner(&owner);
    if (!ended) {
      return FailTurnedAwayLaunch(
          exit_code,
          L"The copy of Ardia that was closing hadn't finished after " +
              std::to_wstring((already_waited + waited) / 1000) +
              L" seconds, so this one couldn't open your profile.",
          L"Wait a moment, then open Ardia again. Restarting Windows ends a "
          L"copy that is stuck.");
    }
  } else {
    const DWORD successor = owner.process_id;
    CloseOwner(&owner);
    WriteLaunchLog(
        owner_found
            ? "launch guard: this launch was turned away, and the Ardia now on "
              "the profile (" +
                  std::to_string(successor) +
                  ") isn't closing; it starts again once to reach it"
            : "launch guard: this launch was turned away, and the Ardia that "
              "held the profile is gone; it starts again once");
  }
  if (!successor_running) {
    WaitForLockFileFree(kLockFileFreeWaitMs);
  }
  LetGoOfGuard();
  DWORD process_id = 0;
  DWORD error = 0;
  if (StartAgain(&process_id, &error)) {
    WriteLaunchLog("launch guard: started again as Ardia " +
                   std::to_string(process_id));
    return 0;
  }
  return FailTurnedAwayLaunch(
      exit_code,
      L"Ardia couldn't start itself again after it was turned away (Windows "
      L"error " +
          std::to_wstring(error) + L").",
      L"Open Ardia again.");
}

void ShortenHandOffTimeoutForTest() {
  const int timeout_ms =
      TestMillisecondsFromEnvironment("handOffTimeoutMs", kHandOffHoldMostMs);
  if (!timeout_ms) {
    return;
  }
  SetNotificationTimeoutForTesting(base::Milliseconds(timeout_ms));
  WriteLaunchLog("test: this launch waits at most " +
                 std::to_string(timeout_ms) +
                 " ms for a running Ardia to answer");
}

void HoldHandOffForTest() {
  const int hold_ms =
      TestMillisecondsFromEnvironment("handOffHoldMs", kHandOffHoldMostMs);
  if (!hold_ms) {
    return;
  }
  WriteLaunchLog("test: this launch waits " + std::to_string(hold_ms) +
                 " ms before it looks for a running Ardia");
  ::Sleep(static_cast<DWORD>(hold_ms));
}

}

void NoteForTest(const std::string& line) {
  if (ardiacore::TestInstance()) {
    WriteLaunchLog(line);
  }
}

void BeforeChromeMain() {
  base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (!BrowserProcess(*command_line)) {
    return;
  }
  RememberOwnStart();
  if (!Environment(kRestartedAfterRefusalVariable).empty() ||
      command_line->HasSwitch(kRestartedAfterRefusalSwitch)) {
    ::SetEnvironmentVariableW(kRestartedAfterRefusalVariable, nullptr);
    command_line->RemoveSwitch(kRestartedAfterRefusalSwitch);
    NoteRestartedAfterRefusal();
  }
  command_line->RemoveSwitch(switches::kProcessType);
  DecideTestGate(command_line);
  if (!AppLibraryPresent()) {
    return;
  }
  std::wstring data_dir = Environment(L"ARDIA_DATA_DIR");
  while (!data_dir.empty() &&
         (data_dir.back() == L'\\' || data_dir.back() == L'/')) {
    data_dir.pop_back();
  }
  GuardBrowserLaunch(
      data_dir.empty() ? ChromiumUserDataDir() : data_dir + L"\\Chromium",
      command_line);
  if (GuardFacts().update_under_way) {
    WriteLaunchLog(
        "launch guard: Ardia is closing for an update; this launch ends here "
        "and the installer opens Ardia again");
    base::Process::TerminateCurrentProcessImmediately(0);
  }
  AddLaunchSwitches(command_line);
  HoldHandOffForTest();
  ShortenHandOffTimeoutForTest();
  ardia_win::AskBeforeDiscards();
  g_ardia_win_hosts_normal_windows = true;
  content::g_ardia_win_keep_media_session_players = true;
  g_ardia_win_frame_view = &CreateHostedFrameView;
  g_ardia_win_add_main_parts = &AddMainParts;
  g_ardia_win_relaunched = &Relaunched;
  g_ardia_win_answers_hand_off = &AnswersHandOff;
  InstallExternalAppAsks();
  g_ardia_keeps_window_without_tabs = &KeepsWindowWithoutTabs;
}

void AfterChromeMain(int exit_code) {
  if (!g_ardia_win_add_main_parts) {
    return;
  }
  if (exit_code == CHROME_RESULT_CODE_PROFILE_IN_USE) {
    exit_code = AnswerTurnedAwayLaunch(exit_code);
  }
  base::Process::TerminateCurrentProcessImmediately(exit_code);
}

const char* TestGateDecision() {
  return TheGate().refusal.c_str();
}

void AppQuitting(std::string_view phase,
                 std::string_view reason,
                 int wait_ms,
                 std::string_view answer) {
  QuitState& quit = TheQuit();
  if (quit.past_no_return) {
    return;
  }
  if (phase == "asking") {
    quit.asking = true;
    quit.reason = reason == kUpdateQuit ? kUpdateQuit : kUserQuit;
    if (quit.reason == kUpdateQuit) {
      MarkUpdating();
    }
  } else if (phase == "cancelled") {
    quit.asking = false;
  } else if (phase == "final") {
    PassPointOfNoReturn();
    SaveQuitFacts(wait_ms, answer);
  }
}

void QuitApp() {
  PassPointOfNoReturn();
  QuitState& quit = TheQuit();
  if (quit.engine_quit_started) {
    return;
  }
  quit.engine_quit_started = true;
  MarkStartSettled();
  KeepAlive().reset();
  ChromeDevToolsManagerDelegate::AllowBrowserToClose();
  chrome::ExitIgnoreUnloadHandlers();
}

}
