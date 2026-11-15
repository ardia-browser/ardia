// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/main.h"

#include <stdlib.h>

#include <memory>
#include <string>
#include <string_view>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/test_gate.h"
#include "base/base_switches.h"
#include "base/command_line.h"
#include "base/environment.h"
#include "base/files/file_path.h"
#include "base/no_destructor.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "chrome/common/chrome_switches.h"
#include "content/public/common/content_switches.h"
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

std::string Variable(base::Environment& env, std::string_view name) {
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

void AddInstanceSwitches(base::CommandLine* command_line,
                         const std::string& instance) {
  for (const std::string& entry : base::SplitString(
           instance, ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    const size_t equals = entry.find('=');
    const std::string key = base::ToLowerASCII(
        equals == std::string::npos ? entry : entry.substr(0, equals));
    if (key.empty() || !base::ContainsOnlyChars(
                           key, "abcdefghijklmnopqrstuvwxyz0123456789-")) {
      continue;
    }
    command_line->AppendSwitchASCII(
        "ardia-" + key,
        equals == std::string::npos ? "1" : entry.substr(equals + 1));
  }
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
    command_line->AppendSwitchPath(switches::kUserDataDir,
                                   base_dir.Append("ardia").Append("Chromium"));
  }
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
