import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = (name) => read(`../../windows/Ardia/${name}`);
const engine = (name) => read(`../../../../scripts/windows/engine/src/ardia/win/${name}`);
const engineInput = (name) => read(`../../../../scripts/windows/engine/${name}`);
const script = (name) => read(`../../../../scripts/windows/${name}`);

const body = (source, signature) => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is missing`);
  let depth = 0;
  for (let at = source.indexOf("{", start); at < source.length; at++) {
    if (source[at] === "{") depth++;
    if (source[at] === "}" && --depth === 0) return source.slice(start, at + 1);
  }
  throw new Error(`${signature} has no end`);
};

const before = (source, first, second, why) => {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a >= 0, `${first} is missing`);
  assert.ok(b >= 0, `${second} is missing`);
  assert.ok(a < b, why ?? `${first} comes after ${second}`);
};

test("the app tells the engine each phase of a quit: asking before willQuit, cancelled before quitCancelled, final before the unload", () => {
  const windows = app("WindowManager.h");
  before(body(windows, "void Quit(std::string_view reason) noexcept {"), 'TellEngineQuitting("asking")', 'EmitApp("willQuit")');
  before(body(windows, "void AnnounceCancelledQuit(bool byLaunch) noexcept {"), 'TellEngineQuitting("cancelled")', 'EmitApp("quitCancelled")');
  before(body(windows, "void Finish() noexcept {"), "TellEngineFinal()", "UnloadInstance()");
  assert.match(body(windows, "void TellEngineFinal() const noexcept {"), /"\{\\"phase\\":\\"final\\",\\"reason\\":\\""[\s\S]*\\"waitMs\\":[\s\S]*\\"answer\\":\\"/);
});

test("inside the hand-off message the app only reads and sets plain state; the rest runs after the message from a posted task", () => {
  const windows = app("WindowManager.h");
  const arriving = body(windows, "int LaunchArriving() noexcept {");
  before(arriving, "m_quitReason == kUpdateQuit && (m_quitting || m_finished)", "if (m_finished) return ARDIA_APP_LAUNCH_TURNED_AWAY;", "an update's quit turns a launch away into a waiting launch after Finish()");
  before(arriving, "m_launchesUndelivered++", "m_quitGeneration++");
  assert.match(arriving, /return ARDIA_APP_LAUNCH_KEPT_BY_CANCELLING_QUIT;/);
  for (const call of ["LaunchLog::", "After(", "Emit", "TellEngine", "Open(", "TryEnqueue", "Stop(", "CancelQuit(", "HoldQuitForLaunch(", "NoteQuitWait(", "Host::", "m_launchHoldSince"]) {
    assert.ok(!arriving.includes(call), `LaunchArriving calls or sets ${call} inside the sent message`);
  }
  const after = body(windows, "void AfterLaunchArriving() noexcept {");
  before(after, "AnnounceCancelledQuit(true)", "ArmLaunchHold()");
  assert.match(body(windows, "void AnnounceCancelledQuit(bool byLaunch) noexcept {"), /TellEngineQuitting\("cancelled"\);\s*EmitApp\("quitCancelled"\);\s*if \(!byLaunch && NoWindowStays\(\)\) HoldQuitForLaunch\(\);/);
  assert.match(body(app("Ardia.cpp"), "__declspec(dllexport) int ArdiaAppLaunchArriving(void) {"), /WindowManager::Shared\(\)\.LaunchArriving\(\)/);
  assert.match(body(app("Ardia.cpp"), "__declspec(dllexport) void ArdiaAppAfterLaunchArriving(void) {"), /WindowManager::Shared\(\)\.AfterLaunchArriving\(\)/);
  assert.ok(!app("EngineHostModule.h").includes("LaunchArrived"), "the quit is still cancelled only when the relaunch event reaches the app");
  const answers = body(engine("main.cc"), "ArdiaHandOff AnswersHandOff(");
  before(answers, "base::BindOnce(&AfterLaunchTaken, answer)", "PostLaunchDelivery(command_line, cur_dir);", "the launch reaches the app before the cancelled quit is announced");
  assert.ok(!answers.includes("WriteLaunchLog("), "the engine writes the log inside the sent message");
  assert.match(body(engine("main.cc"), "void AfterLaunchTaken(int answer) {"), /app\.after_launch_arriving\(\);/);
  const open = body(windows, "void Open(OpenWindowRequest const &request, bool heldForTest = false) noexcept {");
  before(open, "if (m_quitting) {", "Find(request.id)", "Open() reaches a window before its quit check");
  assert.match(body(open, "if (m_quitting) {"), /m_opensDuringQuit\.push_back\(request\)/);
  assert.match(body(windows, "void Finish() noexcept {"), /m_opensDuringQuit\.clear\(\);/);
});

test("one hook answers every launch first: turned away, taken and delivered by our own task, or left to Chromium", () => {
  const patch = engineInput("patches/chromium-win-hand-off-asks-the-app.patch");
  assert.match(patch, /^\+\+\+ b\/chrome\/browser\/chrome_browser_main\.cc$/m);
  assert.match(patch, /^\+ArdiaHandOff \(\*g_ardia_win_answers_hand_off\)\($/m);
  assert.match(patch, /^\+  if \(g_ardia_win_answers_hand_off\) \{\n\+    switch \(g_ardia_win_answers_hand_off\(command_line, current_directory\)\) \{\n\+      case ArdiaHandOff::kTurnedAway:\n\+        return false;\n\+      case ArdiaHandOff::kTaken:\n\+        return true;\n\+      case ArdiaHandOff::kNotOurs:\n\+        break;\n\+    \}\n\+  \}\n\+#endif\n   \/\/ Drop the request if the browser process is already shutting down\./m, "the hook must come before Chromium's own drops, and a taken launch must not be posted to Chromium's callback");
  assert.ok(!patch.includes("takes_hand_off") && !patch.includes("drops_hand_off"));
  assert.match(engineInput("series-win"), /^chromium chromium-win-hand-off-asks-the-app\.patch$/m);
  assert.match(engine("hooks.h"), /enum class ArdiaHandOff \{ kTurnedAway, kTaken, kNotOurs \};/);
  const main = engine("main.cc");
  assert.match(body(main, "void BeforeChromeMain() {"), /g_ardia_win_answers_hand_off = &AnswersHandOff;/);
  const answers = body(main, "ArdiaHandOff AnswersHandOff(");
  before(answers, "if (!IsLaunch(command_line)) {", "quit.reason == kUpdateQuit");
  before(answers, "quit.reason == kUpdateQuit && (quit.asking || quit.past_no_return)", "if (quit.past_no_return || browser_shutdown::HasShutdownStarted()) {", "an update's quit turns a launch away into a waiting launch");
  before(answers, "quit.past_no_return || browser_shutdown::HasShutdownStarted()", "app.launch_arriving()");
  assert.match(answers, /if \(answer != ARDIA_APP_LAUNCH_LEFT_FOR_UPDATE\) \{\s*PostLaunchDelivery\(command_line, cur_dir\);/);
  assert.match(body(main, "bool IsLaunch(const base::CommandLine& command_line) {"), /switches::kUninstall[\s\S]*switches::kEnableAutomation/);
  assert.match(body(main, "bool IsLaunch(const base::CommandLine& command_line) {"), /!headless::IsHeadlessMode\(\) && !command_line\.HasSwitch\("headless"\)/, "a launch sent to a headless engine skips Chromium's headless refusal");
  assert.match(body(main, "void PostLaunchDelivery("), /PostDelayedTask\(\s*FROM_HERE, base::BindOnce\(&DeliverLaunch, command_line, cur_dir\)/);
  const deliver = body(main, "void DeliverLaunch(");
  before(deliver, "app.launch_delivered()", "EmitRelaunch(");
  assert.ok(!main.includes("it is lost"), "a taken launch can still be lost");
  assert.ok(!main.includes("answers.pop_front") && !main.includes("TakesHandOff") && !main.includes("DropsHandOff"));
  assert.match(body(main, "void AppQuitting("), /if \(quit\.reason == kUpdateQuit\) \{\s*MarkUpdating\(\);/);
  const startup = body(main, "void BeforeChromeMain() {");
  assert.match(startup, /if \(GuardFacts\(\)\.update_under_way\) \{[\s\S]*?TerminateCurrentProcessImmediately\(0\);/);
  before(body(main, "int AnswerTurnedAwayLaunch(int exit_code) {"), "if (UpdateUnderWay()) {", "FindQuittingOwner(");
  before(body(engine("launch_guard.cc"), "void GuardBrowserLaunch("), "if (UpdateUnderWay()) {", "WaitForExitingPredecessor(", "a launch waits in the guard during an update's quit");
  assert.ok(!main.includes("ClearExiting") && !engine("launch_guard.h").includes("ClearExiting"), "something still clears the exiting mark");
  assert.match(body(main, "void AppQuitting("), /phase == "final"\) \{\s*PassPointOfNoReturn\(\);/);
});

test("a hung Ardia is never killed: the launch reads its profile as in use and waits for it", () => {
  const patch = engineInput("patches/chromium-win-hung-predecessor-not-killed.patch");
  assert.match(patch, /^\+\+\+ b\/chrome\/browser\/process_singleton_win\.cc$/m);
  assert.match(patch, /^     case NotifyChromeResult::kWindowHung:\n(\+.*\n)*\+      if \(g_ardia_win_answers_hand_off\) \{\n\+        remote_window_ = NULL;\n\+        return PROFILE_IN_USE;\n\+      \}\n       \/\/ Fall through and potentially terminate the hung browser\./m);
  assert.match(patch, /^\+    if \(result == PROFILE_IN_USE\) \{\n\+      return result;\n\+    \}\n     if \(result == PROCESS_NOTIFIED \|\| result == LOCK_ERROR\) \{/m, "a hung Ardia is retried into the kill");
  assert.match(engineInput("series-win"), /^chromium chromium-win-hung-predecessor-not-killed\.patch$/m);
  assert.match(engineInput("accepted-patches.txt"), /^chromium-win-hung-predecessor-not-killed\.patch$/m);
  const shorten = body(engine("main.cc"), "void ShortenHandOffTimeoutForTest() {");
  before(shorten, 'TestMillisecondsFromEnvironment("handOffTimeoutMs"', "SetNotificationTimeoutForTesting(");
});

test("no quit begins while a taken launch hasn't reached the app, and the 5 s for its window count from its delivery", () => {
  const windows = app("WindowManager.h");
  before(body(windows, "void Quit(std::string_view reason) noexcept {"), "if (m_launchesUndelivered > 0) {", "m_quitting = true;");
  assert.match(body(windows, "void HoldQuitForLaunch() noexcept {"), /if \(!m_launchHoldSince\) m_launchHoldSince = GetTickCount64\(\);/, "a later launch extends the hold");
  const arm = body(windows, "void ArmLaunchHold() noexcept {");
  assert.match(arm, /if \(!since \|\| m_launchHoldArmedFor == since\) return;/);
  assert.match(arm, /\[this, since\]\(\) noexcept \{ LaunchHoldEnded\(since\); \}/);
  const ended = body(windows, "void LaunchHoldEnded(ULONGLONG since) noexcept {");
  before(ended, "if (m_launchHoldSince != since) return;", "Quit(kUserQuit)");
  assert.match(ended, /if \(m_launchesUndelivered > 0 \|\| m_quitting \|\| m_finished \|\| !m_hadWindow \|\| !NoWindowStays\(\)\) return;/);
  assert.ok(!ended.includes("m_launchesUndelivered = 0"), "the deadline drops a launch that hasn't reached the app");
  assert.match(body(windows, "void LaunchDelivered() noexcept {"), /m_launchesUndelivered--;\s*if \(NoWindowStays\(\)\) HoldQuitForLaunch\(\);/);
  assert.match(body(windows, "bool LaunchHoldsQuit() const noexcept {"), /if \(m_launchesUndelivered > 0\) return true;/);
  assert.match(body(windows, "void Closed(std::string const &id) noexcept {"), /QuitWhenWindowless\(\)/);
  before(body(windows, "void QuitWhenWindowless() noexcept {"), "if (LaunchHoldsQuit()) {", "Quit(WindowlessQuitReason())");
  assert.match(windows, /kLaunchWindowWaitMs = 5000;/);
});

test("the app counts the answers it owes, so an answer to a cancelled quit never finishes a later one", () => {
  const windows = app("WindowManager.h");
  before(body(windows, "void Quit(std::string_view reason) noexcept {"), "m_answersOwed++", 'EmitApp("willQuit")');
  const reply = body(windows, "void ReplyToTerminate(bool ok) noexcept {");
  before(reply, "if (m_answersOwed > 0) m_answersOwed--;", "Finish()");
  before(reply, "if (m_answersOwed > 0) {", "Finish()", "an earlier quit's answer can finish this one");
  assert.match(body(windows, "void Attach("), /m_answersOwed = 0;/);
  assert.match(body(app("WindowsModule.h"), "void replyToTerminate("), /AnswerTerminate\(ok\)/);
  assert.match(read("../state/app/nativeSync.ts"), /void answerQuitAfterSaves\(QUIT_SAVES_WAIT_MS, \(\) => replyToTerminate\(true\), Date\.now\(\) - flushing\);/, "the willQuit branch answers once, with yes");
  assert.match(read("../state/app/quit.ts"), /\.catch\(reportFailure\)\s*\.then\(\(\) => void answer\(\)\);/, "a willQuit can go unanswered");
});

test("a process that never becomes the browser writes refused lines with its pid and never 'process ending'; the app's first line carries the pid", () => {
  const guard = engine("launch_guard.cc");
  const line = body(guard, "std::string LaunchLogLine(const std::string& text) {");
  before(line, "(state.owns_alive || state.became_browser) && !state.turned_away", '"engine 0 "');
  assert.match(line, /return "refused " \+ std::to_string\(since_start\) \+ " pid=" \+\s*std::to_string\(::GetCurrentProcessId\(\)\) \+ " " \+ text \+ "\\n";/);
  assert.match(body(guard, "void AppendLog("), /LaunchLogLine\(line\)/);
  const main = engine("main.cc");
  assert.match(body(main, "void WriteLaunchLog("), /LaunchLogLine\(line\)/);
  assert.match(body(main, "void PostBrowserStart() override {"), /^\s*void PostBrowserStart\(\) override \{\s*NoteBecameBrowser\(\);/);
  assert.match(body(main, "int AnswerTurnedAwayLaunch(int exit_code) {"), /^int AnswerTurnedAwayLaunch\(int exit_code\) \{\s*NoteTurnedAway\(\);/);
  const cpp = app("Ardia.cpp");
  assert.match(cpp, /L"process started inside the engine" : L"process started"\)\.append\(L" pid="\)/);
  assert.match(cpp, /LaunchLog::Write\(L"launch", L"process ending"\);/, "the line the reopen checks count changed");
});

test("the engine's quit closes every tab without asking it, and nothing forces the process down", () => {
  const main = engine("main.cc");
  const quit = body(main, "void QuitApp() {");
  assert.match(quit, /chrome::ExitIgnoreUnloadHandlers\(\);/);
  assert.ok(!quit.includes("CloseAllBrowsersAndQuit"), "the quit can still be cancelled by a page");
  assert.ok(!main.includes("EndStalledQuit") && !quit.includes("PostDelayedTask("), "a forced exit can end the process before Chromium's own data is written");
});

test("a turned-away launch starts itself once: after the closing Ardia ends, at once when that Ardia is gone or a healthy one holds the profile", () => {
  const main = engine("main.cc");
  assert.match(body(main, "void AfterChromeMain(int exit_code) {"), /exit_code == CHROME_RESULT_CODE_PROFILE_IN_USE\) \{\s*exit_code = AnswerTurnedAwayLaunch\(exit_code\);/);
  const turned = body(main, "int AnswerTurnedAwayLaunch(int exit_code) {");
  before(turned, "GuardFacts().restarted_after_refusal", "StartAgain(", "a restarted launch can restart again");
  before(turned, "if (owner_found && owner.exiting) {", "WaitForOwnerToEnd(");
  assert.equal((turned.match(/FailTurnedAwayLaunch\(/g) ?? []).length, 3, "only a second refusal, a wait that ran out and a failed start end in an error");
  assert.ok(!turned.includes("Another program or another computer is using Ardia's profile folder, so Ardia couldn't open it."), "a launch whose predecessor is gone still ends in an error");
  const again = body(main, "bool StartAgain(DWORD* process_id, DWORD* error) {");
  assert.match(again, /std::wstring command_line\(::GetCommandLineW\(\)\);/);
  assert.match(again, /CREATE_UNICODE_ENVIRONMENT, environment\.data\(\),\s*start\.directory\.empty\(\) \? nullptr : start\.directory\.c_str\(\)/);
  assert.match(body(main, "std::vector<wchar_t> EnvironmentForRestart() {"), /kRestartedAfterRefusalVariable\) \+ L"=1"/);
  const startup = body(main, "void BeforeChromeMain() {");
  before(startup, "RememberOwnStart()", "DecideTestGate(");
  before(startup, "command_line->RemoveSwitch(kRestartedAfterRefusalSwitch);", "GuardBrowserLaunch(");
  const guard = body(engine("launch_guard.cc"), "void GuardBrowserLaunch(");
  assert.match(guard, /if \(de_elevates && state\.facts\.restarted_after_refusal\) \{\s*command_line->AppendSwitch\(kRestartedAfterRefusalSwitch\);/);
  before(guard, "command_line->AppendSwitch(kRestartedAfterRefusalSwitch);", "if (!primary) {", "the restart bound is lost when a launch that isn't the guard's owner de-elevates");
});

test("the guard publishes the owner only once its launch has started, and writes its wait after the log rotation", () => {
  const guard = engine("launch_guard.cc");
  const launch = body(guard, "void GuardBrowserLaunch(");
  assert.ok(!launch.includes("PublishOwner"), "a launch that fails publishes itself as the profile's owner");
  before(launch, "RotateLaunchLog();\n  WriteWaitingLines();", "WriteUnfinishedStarts(starts, next)");
  assert.ok(!body(guard, "bool WaitForExitingPredecessor(").includes("AppendLog("), "the guard's wait is written into the closing Ardia's log");
  assert.match(body(engine("main.cc"), "void PostBrowserStart() override {"), /PublishOwnerIfOwned\(\);/);
  assert.match(body(guard, "void ClaimGuard() {"), /PublishOwner\(\);/);
  const owner = body(guard, "bool FindQuittingOwner(QuittingOwner* owner) {");
  assert.match(owner, /ProcessCreated\(process\) != record\.created/);
  assert.match(owner, /owner->exiting = ::WaitForSingleObject\(exiting, 0\) == WAIT_OBJECT_0;/);
});

test("the quit's stretches are test-only keys, the update installer quits with its reason, and close-and-reopen runs every case", () => {
  const config = app("LaunchConfig.h");
  for (const key of ["quitWaitMs", "quitUnloadHoldMs", "quitFlushHoldMs", "handOffHoldMs", "handOffDeliveryHoldMs", "handOffTimeoutMs", "lastWindowWaitMs", "windowOpenHoldMs", "quitReason", "quitByMessage", "quitAnswerHoldMs"]) {
    assert.ok(body(config, "TestKeys() noexcept {").includes(`"${key}"`), key);
  }
  assert.match(body(engine("main.cc"), "int TestMillisecondsFromEnvironment("), /if \(!TheGate\(\)\.refusal\.empty\(\)\) \{\s*return 0;/);
  assert.match(read("../../../../packages/expo-windows/src/updater/index.ts"), /\?\.quit\("update"\)/);
  assert.match(body(app("WindowsModule.h"), "void quit(std::string reason, Promise promise) noexcept {"), /Quit\(reason\)/);
  const check = script("relaunch-check.ps1");
  assert.match(check, /\. \(Join-Path \$PSScriptRoot "relaunch-during-quit\.ps1"\)/);
  assert.match(check, /\n  Test-LaunchesDuringQuit\n/);
  const during = script("relaunch-during-quit.ps1");
  const steps = [
    "Test-LaunchBeforeTheQuitBegins",
    "Test-LaunchAtTheQuitSeam",
    "Test-LaunchDuringTheQuitWait",
    "Test-LaunchTakenInTheTurnOfTheAnswer",
    "Test-LaunchDuringAnUpdateQuit",
    "Test-LateAnswerAfterACancelledQuit",
    "Test-CancelWhoseWindowNeverOpens",
    "Test-LaunchAfterThePointOfNoReturn",
    "Test-LaunchTurnedAwayAfterThePointOfNoReturn",
    "Test-HungPredecessorIsNotKilled",
    "Test-TurnedAwayWhosePredecessorIsGone",
    "Test-QuitWithABeforeUnloadPage",
    "Test-TurnedAwayLaunchKeepsItsUserDataDir",
    "Test-LaunchRefusedForGood",
    "Test-HiddenQuitWithADownloadIsLogged",
    "Test-LaunchWhileTheDownloadsQuestionShows",
  ];
  for (const step of steps) assert.match(during, new RegExp(`\\n    "${step}",?\\n`), step);
  assert.equal((during.match(/\n    "Test-[A-Za-z]+",?(?=\n)/g) ?? []).length, steps.length, "every case in the list is checked");
  assert.match(during, /foreach \(\$case in \$cases\) \{/, "every case runs on its own");
  assert.match(during, /\$script:QuitFailures \+= /, "a failed case is recorded and the next one runs");
  assert.match(during, /if \(\$Visible\) \{ Remove-Item -Path Env:ARDIA_BACKGROUND/, "a shown launch drops ARDIA_BACKGROUND, which answers every question unseen");
  assert.match(during, /\$old = Open-QuitInstance \$what "appDialog" -Visible/, "the downloads question case runs a shown Ardia");
  assert.match(during, /Assert-NoQuitLine '\\\[quit\\\] not asked on a hidden instance'/, "the shown Ardia never logs itself as a hidden instance that didn't ask");
  assert.match(during, /if \(\$downloadAsks\.Count -ne \$answers -or \$askedLines\.Count -ne \$answers\)/, "the shown Ardia logs exactly one '[quit] asked: 1 download in progress ...; answered quit' line per question the case answered");
  assert.match(during, /\$notAsked\.Count -ne 1/, "a hidden Ardia's quit with a held download logs that it saw the download and didn't ask");
  assert.equal((during.match(/ -Visible$/gm) ?? []).length, 3, "only the downloads question case's three launches run shown");
  assert.match(during, /\[QuitPages\]::LoadsOf\(\$name\)/, "a link counts as opened by its loads on the test server");
});
