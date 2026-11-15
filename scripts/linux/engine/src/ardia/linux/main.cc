// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/main.h"

#include <fcntl.h>
#include <poll.h>
#include <stdlib.h>
#include <unistd.h>

#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/test_gate.h"
#include "base/base_switches.h"
#include "base/command_line.h"
#include "base/environment.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/json/json_reader.h"
#include "base/posix/eintr_wrapper.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/time/time.h"
#include "base/values.h"
#include "base/no_destructor.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "chrome/common/chrome_switches.h"
#include "content/public/common/content_switches.h"
#include "media/base/media_switches.h"
#include "sandbox/policy/switches.h"

namespace ardia_linux {

namespace {

struct Gate {
  std::string refusal = "no scratch ARDIA_DATA_DIR";
  bool asked = false;
};

Gate& TheGate() {
  static base::NoDestructor<Gate> gate;
  return *gate;
}

std::string Variable(base::Environment& env, const std::string& name) {
  return env.GetVar(name).value_or(std::string());
}

bool Set(const std::string& value) {
  return !value.empty() && value != "0" && value != "off" && value != "false";
}

base::FilePath ChosenDataDir(base::Environment& env) {
  std::string data_dir = Variable(env, "ARDIA_DATA_DIR");
  while (data_dir.size() > 1 && data_dir.back() == '/') {
    data_dir.pop_back();
  }
  return base::FilePath(data_dir);
}

constexpr const char* kSwitchesThatOpenTheProfile[] = {
    "allow-insecure-localhost",
    "auto-open-devtools-for-tabs",
    "browser-subprocess-path",
    "custom-devtools-frontend",
    "devtools-flags",
    "disable-extensions-except",
    "disable-web-security",
    "enable-automation",
    "enable-ui-devtools",
    "extensions-on-chrome-urls",
    "extensions-on-extension-urls",
    "gpu-launcher",
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
    "renderer-cmd-prefix",
    "silent-debugger-extension-api",
    "ssl-key-log-file",
    "unsafely-treat-insecure-origin-as-secure",
    "utility-cmd-prefix",
    "webtransport-developer-mode",
};

void KeepRealProfileClosed(base::CommandLine* command_line) {
  if (TheGate().refusal.empty()) {
    return;
  }
  for (const char* name : kSwitchesThatOpenTheProfile) {
    command_line->RemoveSwitch(name);
  }
  if (!command_line->HasSwitch(kSandboxDecisionSwitch)) {
    command_line->RemoveSwitch(sandbox::policy::switches::kNoSandbox);
  }
  unsetenv("SSLKEYLOGFILE");
}

std::string Kebab(std::string_view key) {
  std::string kebab;
  for (char c : key) {
    if (base::IsAsciiUpper(c)) {
      if (!kebab.empty()) {
        kebab.push_back('-');
      }
      kebab.push_back(base::ToLowerASCII(c));
    } else {
      kebab.push_back(c);
    }
  }
  return kebab;
}

void AddInstanceSwitches(base::CommandLine* command_line,
                         const std::string& instance) {
  for (const auto& [key, value] : ParseInstanceEntries(instance, nullptr)) {
    command_line->AppendSwitchNative("ardia-" + Kebab(key), value);
  }
}

bool ChoseThinScrollBars(const base::FilePath& data_dir) {
  std::string text;
  if (!base::ReadFileToStringWithMaxSize(data_dir.Append("scroll-bars.json"),
                                         &text, 4096)) {
    return false;
  }
  std::optional<base::DictValue> saved = base::JSONReader::ReadDict(text, base::JSON_PARSE_RFC);
  const std::string* choice = saved ? saved->FindString("pageScrollBars") : nullptr;
  return choice && *choice == "thin";
}

std::optional<std::string> GnomeOverlayScrolling() {
  int fds[2];
  if (pipe2(fds, O_CLOEXEC) != 0) {
    return std::nullopt;
  }
  base::ScopedFD read_end(fds[0]);
  base::ScopedFD write_end(fds[1]);
  base::LaunchOptions options;
  options.fds_to_remap.emplace_back(write_end.get(), STDOUT_FILENO);
  base::Process process = base::LaunchProcess(
      {"gsettings", "get", "org.gnome.desktop.interface", "overlay-scrolling"},
      options);
  write_end.reset();
  if (!process.IsValid()) {
    return std::nullopt;
  }
  std::string output;
  const base::TimeTicks deadline =
      base::TimeTicks::Now() + base::Milliseconds(300);
  while (true) {
    const int left = static_cast<int>(
        (deadline - base::TimeTicks::Now()).InMilliseconds());
    struct pollfd watched = {read_end.get(), POLLIN, 0};
    if (left <= 0 || HANDLE_EINTR(poll(&watched, 1, left)) <= 0) {
      process.Terminate(0, false);
      break;
    }
    char buffer[64];
    const ssize_t got = HANDLE_EINTR(read(read_end.get(), buffer, sizeof(buffer)));
    if (got <= 0) {
      break;
    }
    output.append(buffer, static_cast<size_t>(got));
  }
  int exit_code = 0;
  process.WaitForExitWithTimeout(base::Milliseconds(50), &exit_code);
  return std::string(base::TrimWhitespaceASCII(output, base::TRIM_ALL));
}

bool DesktopPrefersOverlay(base::Environment& env) {
  if (Variable(env, "GTK_OVERLAY_SCROLLING") == "0") {
    return false;
  }
  return GnomeOverlayScrolling().value_or(std::string()) != "false";
}

void AddScrollBars(base::CommandLine* command_line,
                   base::Environment& env,
                   const base::FilePath& data_dir) {
  const bool overlay = ChoseThinScrollBars(data_dir) || DesktopPrefersOverlay(env);
  std::string features =
      command_line->GetSwitchValueASCII(switches::kEnableFeatures);
  if (!features.empty()) {
    features.push_back(',');
  }
  features.append(overlay ? "OverlayScrollbar:mode/overlay"
                          : "OverlayScrollbar:mode/classic");
  command_line->AppendSwitchASCII(switches::kEnableFeatures, features);
}

void DecideTestGate(base::CommandLine* command_line, base::Environment& env) {
  for (const char* forbidden :
       {switches::kRemoteDebuggingPort, switches::kRemoteDebuggingPipe,
        "remote-allow-origins", kTestInstanceSwitch, ardiacore::kTestSwitch,
        ardiacore::kTraceSwitch, ardiacore::kDataDirSwitch, kUiDirSwitch}) {
    command_line->RemoveSwitch(forbidden);
  }
  const base::FilePath data_dir = ChosenDataDir(env);
  const std::string port = Variable(env, "ARDIA_REMOTE_DEBUGGING_PORT");
  const std::string test = Variable(env, "ARDIA_TEST");
  const std::string trace = Variable(env, "ARDIA_TRACE");
  const std::string ui_dir = Variable(env, "ARDIA_UI_DIR");
  Gate& gate = TheGate();
  gate.refusal = TestGateRefusal(data_dir);
  if (gate.refusal.empty()) {
    gate.refusal = HoldScratchFolders(data_dir);
  }
  gate.asked = !port.empty() || !test.empty() || !trace.empty() ||
               !ui_dir.empty();
  KeepRealProfileClosed(command_line);
  if (!gate.refusal.empty()) {
    return;
  }
  command_line->AppendSwitch(kTestInstanceSwitch);
  if (!port.empty()) {
    command_line->AppendSwitchASCII(switches::kRemoteDebuggingPort, port);
    command_line->AppendSwitchASCII("remote-allow-origins", "*");
  }
  if (!test.empty()) {
    command_line->AppendSwitchASCII(ardiacore::kTestSwitch, test);
  }
  if (!trace.empty()) {
    command_line->AppendSwitchASCII(ardiacore::kTraceSwitch, trace);
  }
  if (!ui_dir.empty()) {
    command_line->AppendSwitchPath(kUiDirSwitch, base::FilePath(ui_dir));
  }
}

void AddLaunchSwitches(base::CommandLine* command_line,
                       base::Environment& env) {
  command_line->AppendSwitch(switches::kNoStartupWindow);
  command_line->AppendSwitch(switches::kNoFirstRun);
  command_line->AppendSwitch(switches::kNoDefaultBrowserCheck);
  command_line->AppendSwitch(switches::kHideCrashRestoreBubble);
  command_line->RemoveSwitch(switches::kMakeDefaultBrowser);
  if (!command_line->HasSwitch("class")) {
    command_line->AppendSwitchASCII("class", "ardia");
  }
  const base::FilePath data_dir = ChosenDataDir(env);
  base::FilePath data_folder = data_dir;
  if (!data_dir.empty()) {
    command_line->AppendSwitchPath(ardiacore::kDataDirSwitch, data_dir);
    command_line->AppendSwitchPath(switches::kUserDataDir,
                                   data_dir.Append("Chromium"));
  } else {
    std::string data_home = Variable(env, "XDG_DATA_HOME");
    base::FilePath base_dir = data_home.empty() || data_home[0] != '/'
                                  ? base::FilePath(Variable(env, "HOME"))
                                        .Append(".local/share")
                                  : base::FilePath(data_home);
    data_folder = base_dir.Append("ardia");
    command_line->AppendSwitchPath(switches::kUserDataDir,
                                   data_folder.Append("Chromium"));
  }
  AddScrollBars(command_line, env, data_folder);
  if (Set(Variable(env, "ARDIA_BACKGROUND"))) {
    command_line->AppendSwitch(ardiacore::kBackgroundSwitch);
    command_line->AppendSwitch(switches::kMuteAudio);
    command_line->AppendSwitch(switches::kUseFakeDeviceForMediaStream);
  }
  const std::string app_switches = Variable(env, "ARDIA_SWITCHES");
  if (!app_switches.empty()) {
    command_line->AppendSwitchASCII(ardiacore::kSwitchesSwitch, app_switches);
  }
  const std::string instance = Variable(env, "ARDIA_INSTANCE");
  if (!instance.empty()) {
    AddInstanceSwitches(command_line, instance);
  }
  const std::string feedback = Variable(env, "ARDIA_FEEDBACK_URL");
  if (!feedback.empty()) {
    command_line->AppendSwitchASCII(kFeedbackUrlSwitch, feedback);
  }
}

}

void BeforeChromeMain() {
  base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (!command_line->GetSwitchValueASCII(switches::kProcessType).empty()) {
    return;
  }
  std::unique_ptr<base::Environment> env = base::Environment::Create();
  command_line->RemoveSwitch(switches::kUserDataDir);
  DecideTestGate(command_line, *env);
  AddLaunchSwitches(command_line, *env);
}

const char* TestGateDecision() {
  return TheGate().refusal.c_str();
}

bool TestGateAsked() {
  return TheGate().asked;
}

}
