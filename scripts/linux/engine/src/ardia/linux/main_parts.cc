// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/main_parts.h"

#include <string>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/api.h"
#include "ardia/linux/app_lifetime.h"
#include "ardia/linux/host/host.h"
#include "ardia/linux/host/key_map.h"
#include "ardia/linux/log.h"
#include "ardia/linux/main.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/ui_host/ui_host_parts.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/command_line.h"
#include "content/public/common/content_switches.h"

namespace ardia_linux {

namespace {

void NoteTestGate() {
  const std::string refusal = TestGateDecision();
  if (!refusal.empty() && !TestGateAsked()) {
    Note("launch", "test gate: not a test instance (" + refusal + ")");
    return;
  }
  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  if (refusal.empty()) {
    const std::string port =
        command_line.GetSwitchValueASCII(switches::kRemoteDebuggingPort);
    Note("launch", std::string("test gate: a test instance; ardiacore test "
                               "instance: ") +
                       (ardiacore::TestInstance() ? "yes" : "no") +
                       "; remote debugging port: " +
                       (port.empty() ? std::string("none") : port));
    return;
  }
  Note("launch",
       "test gate: ARDIA_REMOTE_DEBUGGING_PORT, ARDIA_TEST, ARDIA_TRACE and "
       "ARDIA_UI_DIR ignored: not a test instance (" +
           refusal + ")");
}

}

MainParts::MainParts() = default;

MainParts::~MainParts() = default;

void MainParts::PreBrowserStart() {
  AppLifetime::Get().HoldKeepAlive();
}

void MainParts::PostBrowserStart() {
  NoteTestGate();
  registry_ = std::make_unique<ModuleRegistry>();
  RegisterAppModules(*registry_);
  RegisterEngineHostModule(*registry_);
  AppWindows::Get().Register(*registry_);
  KeyMap::Get().Register(*registry_);
  Host::Get()->Start();
  ardia_win::WatchEngineEvents();
  AppLifetime::Get().WatchSignals();
  StartUiHost();
}

void MainParts::PostMainMessageLoopRun() {
  StopUiHost();
  AppWindows::Get().CloseAll();
  AppLifetime::Get().Release();
  registry_.reset();
}

}
