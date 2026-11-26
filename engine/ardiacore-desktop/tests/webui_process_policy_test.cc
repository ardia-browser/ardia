#include "ardia/desktop/ac_desktop_webui_process_policy.h"

#include <cassert>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <string_view>

namespace {

namespace policy = ardia::desktop_webui_process;

using policy::RecoveryStep;
using policy::WindowState;

void TestTheShellSite() {
  assert(std::string_view(policy::kShellUrl) == "chrome://ardia/");
  assert(policy::kShellScheme == "chrome");
  assert(policy::kShellHost == "ardia");
}

void TestOnlyRegularWindowsShareTheRenderer() {
  static_assert(policy::SharedRendererFeature({}) == policy::kSharedShellRendererFeature);
  static_assert(!policy::SharedRendererFeature({.private_window = true}));
  static_assert(!policy::SharedRendererFeature({.off_the_record_profile = true}));
  static_assert(!policy::SharedRendererFeature({.private_window = true, .off_the_record_profile = true}));
  static_assert(policy::kSharedShellRendererFeature != 0);
  const policy::ShellWindow regular;
  const policy::ShellWindow little_ardia;
  assert(policy::SharedRendererFeature(regular) == policy::SharedRendererFeature(little_ardia));
}

void TestReloadBudget() {
  policy::ShellReloadBudget budget;
  for (size_t i = 0; i < policy::kShellReloadsAllowed; ++i) assert(budget.Allow(1 + static_cast<double>(i)));
  assert(!budget.Allow(10));
  assert(!budget.Allow(policy::kShellReloadWindowSeconds));
  assert(budget.Allow(1 + policy::kShellReloadWindowSeconds));
  assert(!budget.Allow(1.5 + policy::kShellReloadWindowSeconds));
  assert(budget.Allow(2 + policy::kShellReloadWindowSeconds));
  assert(budget.Allow(1000));
  assert(budget.recent() == 1);
}

void TestACrashReloadsAnOpenWindow() {
  policy::ShellRecoveryState state;
  assert(state.Next(0, WindowState::kOpen, true) == RecoveryStep::kNothing);
  state.RendererGone(false);
  assert(state.owed());
  assert(state.Next(1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  assert(!state.owed());
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

void TestANormalExitIsNotACrash() {
  policy::ShellRecoveryState state;
  state.RendererGone(true);
  assert(!state.owed());
  assert(state.Next(1, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

void TestACrashBeforeTheFirstCommitLoadsTheShell() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kOpen, false) == RecoveryStep::kLoadShellUrl);
}

void TestACrashWhilePausedWaitsWithoutSpendingTheBudget() {
  policy::ShellRecoveryState state;
  for (int crash = 0; crash < 10; ++crash) {
    state.RendererGone(false);
    assert(state.Next(crash, WindowState::kPaused, true) == RecoveryStep::kWaitForResume);
    assert(state.owed());
  }
  assert(state.recent_reloads() == 0);
  assert(state.Next(11, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  assert(state.recent_reloads() == 1);
}

void TestAClosedOrQuittingWindowNeverReloads() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kGone, true) == RecoveryStep::kNothing);
  assert(!state.owed());
  assert(state.recent_reloads() == 0);
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

void TestANewDocumentSettlesARecovery() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kPaused, true) == RecoveryStep::kWaitForResume);
  state.DocumentCommitted();
  assert(!state.owed());
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

void TestACrashLoopStops() {
  policy::ShellRecoveryState state;
  size_t reloads = 0;
  for (int crash = 0; crash < 100; ++crash) {
    state.RendererGone(false);
    if (state.Next(crash * 0.1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument) ++reloads;
    assert(!state.owed());
  }
  assert(reloads == policy::kShellReloadsAllowed);
  state.RendererGone(false);
  assert(state.Next(10 + policy::kShellReloadWindowSeconds, WindowState::kOpen, true) ==
         RecoveryStep::kReloadDocument);
}

void TestEveryWindowOfASharedRendererRecovers() {
  constexpr int kWindows = 8;
  policy::ShellRecoveryState windows[kWindows];
  for (policy::ShellRecoveryState& window : windows) window.RendererGone(false);
  for (policy::ShellRecoveryState& window : windows) {
    assert(window.Next(5, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  }
}

void TestAQuitInProgressPausesAndShutdownEnds() {
  static_assert(policy::ShellWindowState(false, false, WindowState::kOpen) == WindowState::kOpen);
  static_assert(policy::ShellWindowState(false, true, WindowState::kOpen) == WindowState::kPaused);
  static_assert(policy::ShellWindowState(false, true, WindowState::kPaused) == WindowState::kPaused);
  static_assert(policy::ShellWindowState(true, true, WindowState::kOpen) == WindowState::kGone);
  static_assert(policy::ShellWindowState(true, false, WindowState::kOpen) == WindowState::kGone);
  static_assert(policy::ShellWindowState(false, true, WindowState::kGone) == WindowState::kGone);
  static_assert(policy::ShellWindowState(false, false, WindowState::kPaused) == WindowState::kPaused);

  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, policy::ShellWindowState(false, true, WindowState::kOpen), true) == RecoveryStep::kWaitForResume);
  assert(state.owed() && state.recent_reloads() == 0);
  assert(state.Next(2, policy::ShellWindowState(false, false, WindowState::kOpen), true) == RecoveryStep::kReloadDocument);
}

void TestARecoveryThatNeverCommitsIsRetriedWithinTheBudget() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  assert(state.in_flight() && !state.owed());
  state.NavigationEndedWithoutCommit();
  assert(!state.in_flight() && state.owed());
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  state.NavigationEndedWithoutCommit();
  assert(state.Next(3, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  state.NavigationEndedWithoutCommit();
  assert(state.owed());
  assert(state.Next(4, WindowState::kOpen, true) == RecoveryStep::kGaveUp);
  assert(!state.owed() && !state.in_flight() && !state.recovering());
}

void TestAnUncommittedNavigationOnlyRearmsARecoveryInFlight() {
  policy::ShellRecoveryState idle;
  idle.NavigationEndedWithoutCommit();
  assert(!idle.owed());

  policy::ShellRecoveryState live;
  live.RendererGone(false);
  assert(live.Next(1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  live.NavigationEndedWithoutCommit();
  assert(live.owed() && !live.in_flight());
  assert(live.Next(2, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);

  policy::ShellRecoveryState committed;
  committed.RendererGone(false);
  assert(committed.Next(1, WindowState::kOpen, false) == RecoveryStep::kLoadShellUrl);
  committed.DocumentCommitted();
  assert(!committed.in_flight());
  committed.NavigationEndedWithoutCommit();
  assert(!committed.owed());
}

void TestAQuitIsPolledOnlyWhileItCanStillBeCancelled() {
  static_assert(policy::kQuitPollMilliseconds == 250);
  static_assert(policy::QuitMayStillBeCancelled(false, true));
  static_assert(!policy::QuitMayStillBeCancelled(true, true));
  static_assert(!policy::QuitMayStillBeCancelled(false, false));
  static_assert(!policy::QuitMayStillBeCancelled(true, false));
}

void TestARecoveryBeforeTheFirstBootstrapIsNotAStartup() {
  policy::LaunchBootstrap launch(true);
  launch.Served("index.html");
  launch.NoteRecovery();
  assert(!launch.startup());
  launch.Served(policy::kShellBootstrapAsset);
  assert(!launch.startup());

  policy::LaunchBootstrap cold(true);
  launch.NoteRecovery();
  assert(cold.startup());
  cold.Served(policy::kShellBootstrapAsset);
  assert(!cold.startup());
  cold.NoteRecovery();
  assert(!cold.startup());
}

void TestOnlyTheLaunchWindowsFirstBootstrapSaysStartup() {
  static_assert(policy::kShellBootstrapAsset == "host-bootstrap.js");
  policy::LaunchBootstrap launch(true);
  assert(launch.startup());
  launch.Served("index.html");
  launch.Served("assets/app.js");
  launch.Served("HOST-BOOTSTRAP.JS");
  assert(launch.startup());
  launch.Served(policy::kShellBootstrapAsset);
  assert(!launch.startup());
  launch.Served(policy::kShellBootstrapAsset);
  assert(!launch.startup());

  policy::LaunchBootstrap other(false);
  assert(!other.startup());
  other.Served(policy::kShellBootstrapAsset);
  assert(!other.startup());
}

void TestAnInitialLoadThatNeverCommitsIsRecovered() {
  policy::ShellRecoveryState state;
  state.InitialLoadStarted();
  assert(state.in_flight() && !state.owed() && !state.recovering());
  state.NavigationEndedWithoutCommit();
  assert(state.owed() && !state.in_flight());
  assert(state.Next(1, WindowState::kOpen, false) == RecoveryStep::kLoadShellUrl);
  assert(state.recovering());
  assert(state.DocumentCommitted());
  assert(!state.recovering() && !state.in_flight() && !state.owed());
}

void TestAnInitialLoadThatCommitsIsNotARecovery() {
  policy::ShellRecoveryState state;
  state.InitialLoadStarted();
  assert(!state.DocumentCommitted());
  assert(!state.in_flight());
  state.NavigationEndedWithoutCommit();
  assert(!state.owed());
}

void TestOnlyARecoveryThatCommitsCountsAsRecovered() {
  policy::ShellRecoveryState state;
  assert(!state.DocumentCommitted());
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  state.NavigationEndedWithoutCommit();
  assert(state.recovering());
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  assert(state.DocumentCommitted());
  assert(!state.DocumentCommitted());
}

void TestTheTallyCountsAndSerializesOutcomes() {
  policy::ShellRecoveryTally tally;
  assert(tally.Json() == "{\"attempts\":0,\"recovered\":0,\"exhausted\":0}\n");
  tally.Record(policy::RecoveryOutcome::kAttempted);
  tally.Record(policy::RecoveryOutcome::kAttempted);
  tally.Record(policy::RecoveryOutcome::kRecovered);
  tally.Record(policy::RecoveryOutcome::kExhausted);
  assert(tally.attempts == 2 && tally.recovered == 1 && tally.exhausted == 1);
  assert(tally.Json() == "{\"attempts\":2,\"recovered\":1,\"exhausted\":1}\n");
  tally.attempts = 4294967295u;
  tally.Record(policy::RecoveryOutcome::kAttempted);
  assert(tally.attempts == 4294967295u);
  static_assert(std::string_view(policy::kShellRecoveryDocument) == "shell-recovery.json");
  static_assert(std::string_view(policy::kPreviousShellRecoveryDocument) == "shell-recovery-previous.json");
  static_assert(std::string_view(policy::kNoShellRecoveries) == "{}\n");
  static_assert(policy::ShellRecoveryDocument("shell-recovery.json"));
  static_assert(policy::ShellRecoveryDocument("shell-recovery-previous.json"));
  static_assert(!policy::ShellRecoveryDocument("Shell-Recovery.json"));
  static_assert(!policy::ShellRecoveryDocument("shell-recovery.json.tmp"));
  static_assert(!policy::ShellRecoveryDocument("launch-guard.json"));
}

void TestGivingUpIsReportedOnlyWhenTheBudgetRefuses() {
  policy::ShellRecoveryState gone;
  gone.RendererGone(false);
  assert(gone.Next(1, WindowState::kGone, true) == RecoveryStep::kNothing);
  policy::ShellRecoveryState spent;
  for (int crash = 0; crash < 3; ++crash) {
    spent.RendererGone(false);
    assert(spent.Next(crash, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  }
  spent.RendererGone(false);
  assert(spent.Next(4, WindowState::kOpen, true) == RecoveryStep::kGaveUp);
  assert(spent.Next(5, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

struct FakeFolder {
  std::map<std::string, std::string> files;
  std::set<std::string> unwritable;
  bool reads_fail = false;
  int writes = 0;

  auto Read() {
    return [this](const std::string& name) {
      if (reads_fail) return policy::RecoveryDocumentRead{ardia::desktop_policy::StoredRead::kFailed, {}};
      const auto found = files.find(name);
      if (found == files.end()) return policy::RecoveryDocumentRead{ardia::desktop_policy::StoredRead::kMissing, {}};
      return policy::RecoveryDocumentRead{ardia::desktop_policy::StoredRead::kFound, found->second};
    };
  }

  auto Write() {
    return [this](const std::string& name, const std::string& contents) {
      ++writes;
      if (unwritable.count(name)) return false;
      files[name] = contents;
      return true;
    };
  }

  std::string At(const std::string& name) const {
    const auto found = files.find(name);
    return found == files.end() ? std::string("<missing>") : found->second;
  }
};

const std::string kLastRun = "{\"attempts\":2,\"recovered\":1,\"exhausted\":1}\n";
const std::string kThisRun = "{\"attempts\":1,\"recovered\":0,\"exhausted\":0}\n";

void TestRotationArchivesTheLastRunAndStartsAFreshTally() {
  FakeFolder folder;
  folder.files[policy::kShellRecoveryDocument] = kLastRun;
  policy::RecoveryDocuments documents;
  documents.Rotate(folder.Read(), folder.Write());
  assert(documents.archived());
  assert(folder.At(policy::kPreviousShellRecoveryDocument) == kLastRun);
  assert(folder.At(policy::kShellRecoveryDocument) == policy::kNoShellRecoveries);
  assert(documents.Save(folder.Read(), folder.Write(), kThisRun));
  assert(folder.At(policy::kShellRecoveryDocument) == kThisRun);
  assert(folder.At(policy::kPreviousShellRecoveryDocument) == kLastRun);
}

void TestAFirstRunArchivesAnEmptyTally() {
  FakeFolder folder;
  policy::RecoveryDocuments documents;
  documents.Rotate(folder.Read(), folder.Write());
  assert(documents.archived());
  assert(folder.At(policy::kPreviousShellRecoveryDocument) == policy::kNoShellRecoveries);
  assert(folder.At(policy::kShellRecoveryDocument) == policy::kNoShellRecoveries);
}

void TestAFailedArchiveKeepsTheLastRunsTallyUntilARetryWorks() {
  FakeFolder folder;
  folder.files[policy::kShellRecoveryDocument] = kLastRun;
  folder.files[policy::kPreviousShellRecoveryDocument] = "{\"attempts\":9,\"recovered\":9,\"exhausted\":0}\n";
  folder.unwritable.insert(policy::kPreviousShellRecoveryDocument);
  policy::RecoveryDocuments documents;
  documents.Rotate(folder.Read(), folder.Write());
  assert(!documents.archived());
  assert(folder.At(policy::kShellRecoveryDocument) == kLastRun);
  assert(!documents.Save(folder.Read(), folder.Write(), kThisRun));
  assert(!documents.archived());
  assert(folder.At(policy::kShellRecoveryDocument) == kLastRun);
  folder.unwritable.clear();
  assert(documents.Save(folder.Read(), folder.Write(), kThisRun));
  assert(documents.archived());
  assert(folder.At(policy::kPreviousShellRecoveryDocument) == kLastRun);
  assert(folder.At(policy::kShellRecoveryDocument) == kThisRun);
}

void TestAnUnreadableTallyIsNeitherArchivedNorOverwritten() {
  FakeFolder folder;
  folder.files[policy::kShellRecoveryDocument] = kLastRun;
  folder.reads_fail = true;
  policy::RecoveryDocuments documents;
  documents.Rotate(folder.Read(), folder.Write());
  assert(!documents.archived() && folder.writes == 0);
  assert(!documents.Save(folder.Read(), folder.Write(), kThisRun));
  assert(folder.writes == 0);
  assert(folder.At(policy::kShellRecoveryDocument) == kLastRun);
  assert(folder.At(policy::kPreviousShellRecoveryDocument) == "<missing>");
  folder.reads_fail = false;
  assert(documents.Save(folder.Read(), folder.Write(), kThisRun));
  assert(folder.At(policy::kPreviousShellRecoveryDocument) == kLastRun);
  assert(folder.At(policy::kShellRecoveryDocument) == kThisRun);
}

void TestAFailedResetAfterArchivingIsOverwrittenByTheNextSave() {
  FakeFolder folder;
  folder.files[policy::kShellRecoveryDocument] = kLastRun;
  policy::RecoveryDocuments documents;
  folder.unwritable.insert(policy::kShellRecoveryDocument);
  documents.Rotate(folder.Read(), folder.Write());
  assert(documents.archived());
  assert(folder.At(policy::kPreviousShellRecoveryDocument) == kLastRun);
  folder.unwritable.clear();
  const int writes = folder.writes;
  assert(documents.Save(folder.Read(), folder.Write(), kThisRun));
  assert(folder.writes == writes + 1);
  assert(folder.At(policy::kShellRecoveryDocument) == kThisRun);
}

}

int main() {
  TestRotationArchivesTheLastRunAndStartsAFreshTally();
  TestAFirstRunArchivesAnEmptyTally();
  TestAFailedArchiveKeepsTheLastRunsTallyUntilARetryWorks();
  TestAnUnreadableTallyIsNeitherArchivedNorOverwritten();
  TestAFailedResetAfterArchivingIsOverwrittenByTheNextSave();
  TestAnInitialLoadThatNeverCommitsIsRecovered();
  TestAnInitialLoadThatCommitsIsNotARecovery();
  TestOnlyARecoveryThatCommitsCountsAsRecovered();
  TestTheTallyCountsAndSerializesOutcomes();
  TestGivingUpIsReportedOnlyWhenTheBudgetRefuses();
  TestAQuitInProgressPausesAndShutdownEnds();
  TestARecoveryThatNeverCommitsIsRetriedWithinTheBudget();
  TestAnUncommittedNavigationOnlyRearmsARecoveryInFlight();
  TestOnlyTheLaunchWindowsFirstBootstrapSaysStartup();
  TestAQuitIsPolledOnlyWhileItCanStillBeCancelled();
  TestARecoveryBeforeTheFirstBootstrapIsNotAStartup();
  TestTheShellSite();
  TestOnlyRegularWindowsShareTheRenderer();
  TestReloadBudget();
  TestACrashReloadsAnOpenWindow();
  TestANormalExitIsNotACrash();
  TestACrashBeforeTheFirstCommitLoadsTheShell();
  TestACrashWhilePausedWaitsWithoutSpendingTheBudget();
  TestAClosedOrQuittingWindowNeverReloads();
  TestANewDocumentSettlesARecovery();
  TestACrashLoopStops();
  TestEveryWindowOfASharedRendererRecovers();
  std::puts("webui_process_policy_test: all assertions passed");
  return 0;
}
