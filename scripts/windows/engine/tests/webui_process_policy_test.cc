#include "ardia/desktop/ac_desktop_webui_process_policy.h"

#include <cassert>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

namespace {

namespace policy = ardia::desktop_webui_process;

using policy::RecoveryStep;
using policy::WindowState;

struct ShellWindow {
  std::string page_profile;
  bool browser = true;
  bool closing = false;

  bool private_window() const {
    return page_profile.rfind("private", 0) == 0;
  }

  WindowState State() const {
    return browser && !closing ? WindowState::kOpen : WindowState::kGone;
  }
};

void TestPrivateWindowShellsGetTheirOwnRenderer() {
  const std::vector<ShellWindow> windows = {
      {"default"}, {"work"}, {"private:1"}, {"private:2"}};
  std::vector<std::optional<int32_t>> features;
  for (const ShellWindow& window : windows) {
    features.push_back(policy::SharedRendererFeature(
        {.private_window = window.private_window()}));
  }
  assert(features[0] == policy::kSharedShellRendererFeature);
  assert(features[1] == features[0]);
  assert(!features[2]);
  assert(!features[3]);
}

void TestAWindowsCloseIsFinal() {
  ShellWindow window{"default"};
  window.closing = true;
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, window.State(), true) == RecoveryStep::kNothing);
  assert(!state.owed());
  assert(state.recent_reloads() == 0);
}

void TestADetachedWindowNeverReloads() {
  ShellWindow window{"default"};
  window.browser = false;
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, window.State(), true) == RecoveryStep::kNothing);
}

void TestASharedRendererCrashReloadsEveryOpenWindow() {
  std::vector<ShellWindow> windows = {{"default"}, {"work"}, {"default"}};
  std::vector<policy::ShellRecoveryState> states(windows.size());
  for (policy::ShellRecoveryState& state : states) state.RendererGone(false);
  for (size_t i = 0; i < windows.size(); ++i) {
    assert(states[i].Next(10, windows[i].State(), true) ==
           RecoveryStep::kReloadDocument);
  }
}

void TestACrashBeforeTheFirstCommitLoadsTheShellUrl() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kOpen, false) ==
         RecoveryStep::kLoadShellUrl);
}

void TestACrashLoopStopsReloading() {
  policy::ShellRecoveryState state;
  int reloads = 0;
  for (int crash = 0; crash < 50; ++crash) {
    state.RendererGone(false);
    if (state.Next(crash * 0.5, WindowState::kOpen, true) ==
        RecoveryStep::kReloadDocument) {
      ++reloads;
    }
  }
  assert(reloads == static_cast<int>(policy::kShellReloadsAllowed));
  state.RendererGone(false);
  assert(state.Next(24.5 + policy::kShellReloadWindowSeconds,
                    WindowState::kOpen, true) ==
         RecoveryStep::kReloadDocument);
}

void TestACancelledQuitResumesRecovery() {
  ShellWindow window{"default"};
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, policy::ShellWindowState(false, true, window.State()),
                    true) == RecoveryStep::kWaitForResume);
  assert(state.owed());
  assert(state.Next(2, policy::ShellWindowState(false, false, window.State()),
                    true) == RecoveryStep::kReloadDocument);
}

void TestAStartedShutdownDropsRecovery() {
  ShellWindow window{"default"};
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, policy::ShellWindowState(true, true, window.State()),
                    true) == RecoveryStep::kNothing);
  assert(!state.owed());
}

void TestAQuitClearedWithoutACallbackIsFoundByPolling() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  bool trying_to_quit = true;
  int polls = 0;
  for (; polls < 8; ++polls) {
    const RecoveryStep step = state.Next(
        polls, policy::ShellWindowState(false, trying_to_quit, WindowState::kOpen),
        true);
    if (step != RecoveryStep::kWaitForResume) {
      break;
    }
    assert(policy::QuitMayStillBeCancelled(false, trying_to_quit));
    if (polls == 3) {
      trying_to_quit = false;
    }
  }
  assert(polls == 4);
  assert(state.recent_reloads() == 1);
}

void TestARecoveryNavigationWithALiveSwappedFrameStillRetries() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kOpen, true) ==
         RecoveryStep::kReloadDocument);
  state.NavigationEndedWithoutCommit();
  assert(state.Next(2, WindowState::kOpen, true) ==
         RecoveryStep::kReloadDocument);
}

void TestOnlyTheFirstBootstrapOfTheLaunchWindowIsAStartup() {
  policy::LaunchBootstrap launch(true);
  launch.Served("index.html");
  assert(launch.startup());
  launch.Served("host-bootstrap.js");
  assert(!launch.startup());
  policy::LaunchBootstrap second(false);
  assert(!second.startup());
  policy::LaunchBootstrap crashed_early(true);
  crashed_early.NoteRecovery();
  crashed_early.Served("host-bootstrap.js");
  assert(!crashed_early.startup());
}

void TestAnErrorPageInitialLoadIsRetriedAsAFailure() {
  policy::ShellRecoveryState state;
  state.InitialLoadStarted();
  state.NavigationEndedWithoutCommit();
  assert(state.Next(1, WindowState::kOpen, false) ==
         RecoveryStep::kLoadShellUrl);
  policy::ShellRecoveryTally tally;
  tally.Record(policy::RecoveryOutcome::kAttempted);
  if (state.DocumentCommitted()) {
    tally.Record(policy::RecoveryOutcome::kRecovered);
  }
  assert(tally.Json() ==
         "{\"attempts\":1,\"recovered\":1,\"exhausted\":0}\n");
}

}

int main() {
  TestAnErrorPageInitialLoadIsRetriedAsAFailure();
  TestACancelledQuitResumesRecovery();
  TestAStartedShutdownDropsRecovery();
  TestOnlyTheFirstBootstrapOfTheLaunchWindowIsAStartup();
  TestAQuitClearedWithoutACallbackIsFoundByPolling();
  TestARecoveryNavigationWithALiveSwappedFrameStillRetries();
  TestPrivateWindowShellsGetTheirOwnRenderer();
  TestAWindowsCloseIsFinal();
  TestADetachedWindowNeverReloads();
  TestASharedRendererCrashReloadsEveryOpenWindow();
  TestACrashBeforeTheFirstCommitLoadsTheShellUrl();
  TestACrashLoopStopsReloading();
  std::cout << "webui_process_policy_test: all assertions passed\n";
  return 0;
}
