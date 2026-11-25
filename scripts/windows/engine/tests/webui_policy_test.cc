#include "ardia/desktop/ac_desktop_telemetry_policy.h"
#include "ardia/desktop/generated/ac_desktop_routes.h"
#include "ardia/win/webui/webui_policy.h"

#include <cassert>
#include <iostream>
#include <string>
#include <vector>

namespace {

using namespace ardia_win;

void TestDocumentNames() {
  assert(ValidWindowsDocumentName("telemetry.json"));
  assert(ValidWindowsDocumentName("rnw-migration-attempt.json"));
  assert(ValidWindowsDocumentName("rnw-migration-reported.json"));
  assert(ValidWindowsDocumentName("rnw-migration.json"));
  assert(ValidWindowsDocumentName("sync-state.nns"));
  assert(ValidWindowsDocumentName("perf-probe"));
  assert(ValidWindowsDocumentName("dev-console.log"));
  assert(ValidWindowsDocumentName("a_b-c.1.json"));
  assert(ValidWindowsDocumentName(std::string(kWindowsDocumentNameLimit, 'a')));

  assert(!ValidWindowsDocumentName(""));
  assert(!ValidWindowsDocumentName(std::string(kWindowsDocumentNameLimit + 1, 'a')));
  assert(!ValidWindowsDocumentName("."));
  assert(!ValidWindowsDocumentName(".."));
  assert(!ValidWindowsDocumentName("a..b.json"));
  assert(!ValidWindowsDocumentName(".hidden.json"));
  assert(!ValidWindowsDocumentName("trailing."));
  assert(!ValidWindowsDocumentName(" leading.json"));
  assert(!ValidWindowsDocumentName("trailing.json "));
  assert(!ValidWindowsDocumentName("has space.json"));
  assert(!ValidWindowsDocumentName("a/b.json"));
  assert(!ValidWindowsDocumentName("a\\b.json"));
  assert(!ValidWindowsDocumentName("..\\escape.json"));
  assert(!ValidWindowsDocumentName("../escape.json"));
  assert(!ValidWindowsDocumentName("foo:bar.json"));
  assert(!ValidWindowsDocumentName("foo.json:$DATA"));
  assert(!ValidWindowsDocumentName(std::string("a\0b.json", 8)));
  assert(!ValidWindowsDocumentName("a\nb.json"));
  assert(!ValidWindowsDocumentName("a\rb.json"));
  assert(!ValidWindowsDocumentName("a\tb.json"));
  assert(!ValidWindowsDocumentName("a*b.json"));
  assert(!ValidWindowsDocumentName("a?b.json"));

  for (const char* device : {
           "CON", "con", "Con.json", "CON.tar.gz", "PRN", "prn.txt", "AUX",
           "aux.json", "NUL", "nul.json", "COM0", "COM1", "com9.json", "LPT0",
           "LPT1", "lpt9.json", "CONIN$", "CONOUT$",
       }) {
    assert(!ValidWindowsDocumentName(device));
  }
  assert(ValidWindowsDocumentName("console.json"));
  assert(ValidWindowsDocumentName("com10.json"));
  assert(ValidWindowsDocumentName("lpt10.json"));
  assert(ValidWindowsDocumentName("null.json"));

  assert(ReservedWindowsDocumentName("session.json"));
  assert(ReservedWindowsDocumentName("SESSION.JSON"));
  assert(ReservedWindowsDocumentName("live.json"));
  assert(ReservedWindowsDocumentName("LIVE.JSON"));
  assert(ReservedWindowsDocumentName("live.canonical.json"));
  assert(ReservedWindowsDocumentName("Live.Canonical.Json"));
  assert(ReservedWindowsDocumentName("rnw-migration.lock"));
  assert(ReservedWindowsDocumentName("RNW-MIGRATION.LOCK"));
  assert(ReservedWindowsDocumentName("rnw-migration.json"));
  assert(ReservedWindowsDocumentName("RNW-Migration.JSON"));
  assert(ReservedWindowsDocumentName("launch-starts.txt"));
  assert(ReservedWindowsDocumentName("LAUNCH-STARTS.TXT"));
  assert(ReservedWindowsDocumentName("Launch-Starts.txt"));
  assert(ReservedWindowsDocumentName("launch-starts.txt.tmp"));
  assert(ReservedWindowsDocumentName("LAUNCH-STARTS.TXT.TMP"));
  assert(ReservedWindowsDocumentName("window-placement.txt"));
  assert(ReservedWindowsDocumentName("Window-Placement.TXT"));
  assert(!BootstrapDocumentEligible("window-placement.txt"));
  assert(!ReservedWindowsDocumentName("rnw-migration-attempt.json"));
  assert(!ReservedWindowsDocumentName("rnw-migration-reported.json"));
  assert(!ReservedWindowsDocumentName("launch-guard.json"));
  assert(!ReservedWindowsDocumentName("launch-starts.json"));
  assert(!ReservedWindowsDocumentName("launch-look.json"));
  for (const char* owned : {"launch-guard.json", "LAUNCH-GUARD.JSON",
                            "Launch-Guard.Json"}) {
    assert(ValidWindowsDocumentName(owned));
    assert(!ReservedWindowsDocumentName(owned));
    assert(EngineOwnedWindowsDocumentName(owned));
    assert(!WritableWindowsDocumentName(owned));
    assert(BootstrapDocumentEligible(owned));
  }
  assert(!EngineOwnedWindowsDocumentName("launch-guard.json.tmp"));
  assert(!EngineOwnedWindowsDocumentName("launch-guard.jsonx"));
  assert(WritableWindowsDocumentName("launch-look.json"));
  assert(WritableWindowsDocumentName("telemetry.json"));
  assert(!WritableWindowsDocumentName("session.json"));
  assert(!WritableWindowsDocumentName("launch-starts.txt"));
  assert(!WritableWindowsDocumentName("../launch-guard.json"));
  assert(!ReservedWindowsDocumentName("__proto__"));
  assert(!ReservedWindowsDocumentName("constructor"));
  for (const char* accepted : {"__proto__", "constructor", "prototype",
                               "toString", "hasOwnProperty", "1", "true",
                               "null", "undefined", "NaN"}) {
    assert(ValidWindowsDocumentName(accepted));
    assert(!ReservedWindowsDocumentName(accepted));
    assert(BootstrapDocumentEligible(accepted));
  }

  assert(BootstrapDocumentEligible("rnw-migration-attempt.json"));
  assert(BootstrapDocumentEligible("telemetry.json"));
  assert(!BootstrapDocumentEligible("session.json"));
  assert(!BootstrapDocumentEligible("live.json"));
  assert(!BootstrapDocumentEligible("live.canonical.json"));
  assert(!BootstrapDocumentEligible("rnw-migration.lock"));
  assert(!BootstrapDocumentEligible("sync-state.nns"));
  assert(!BootstrapDocumentEligible("SYNC-STATE.NNS"));
  assert(!BootstrapDocumentEligible("Sync-State.nns"));
  assert(!BootstrapDocumentEligible("sync-state.NNS"));
  assert(BootstrapDocumentEligible("sync-state.nns.json"));
  assert(!BootstrapDocumentEligible("rnw-migration.json"));
  assert(!BootstrapDocumentEligible("launch-starts.txt"));
  assert(!BootstrapDocumentEligible("Launch-Starts.TXT"));
  assert(!BootstrapDocumentEligible("staging.tmp"));
  assert(!BootstrapDocumentEligible("staging.TMP"));
  assert(!BootstrapDocumentEligible("staging.partial"));
  assert(!BootstrapDocumentEligible("CON.json"));

  assert(WindowsDocumentLimit("telemetry.json") == kWindowsDocumentDefaultLimit);
  assert(WindowsDocumentLimit("sync-state.nns") == kWindowsSyncStateDocumentLimit);
  assert(WindowsDocumentLimit("SYNC-STATE.NNS") == kWindowsSyncStateDocumentLimit);
  assert(WindowsDocumentLimit("Sync-State.nns") == kWindowsSyncStateDocumentLimit);
  assert(WindowsDocumentLimit("sync-state.nns.bak") == kWindowsDocumentDefaultLimit);
  assert(IsWindowsSyncStateDocument("sYnC-sTaTe.NnS"));
  assert(!IsWindowsSyncStateDocument("sync-state.nn"));

  static_assert(kMigratorDocumentNameLimit == 200);
  static_assert(kMigratorDocumentLimit == 64 * 1024 * 1024);
  static_assert(kWindowsDocumentNameLimit >= kMigratorDocumentNameLimit);
  static_assert(kWindowsDocumentReadLimit >= kMigratorDocumentLimit);
  static_assert(kWindowsDocumentReadLimit >= kWindowsSyncStateDocumentLimit);
  static_assert(kWindowsDocumentReadLimit >= kWindowsDocumentDefaultLimit);
  assert(ValidWindowsDocumentName(std::string(kMigratorDocumentNameLimit, 'm')));
  assert(ValidWindowsDocumentName(std::string(129, 'm') + ".json"));
  assert(!ValidWindowsDocumentName(std::string(kMigratorDocumentNameLimit + 1, 'm')));

  assert(ValidWindowsAssetPath("index.html"));
  assert(ValidWindowsAssetPath("assets/index-123.js"));
  assert(!ValidWindowsAssetPath(""));
  assert(!ValidWindowsAssetPath("/index.html"));
  assert(!ValidWindowsAssetPath("assets/"));
  assert(!ValidWindowsAssetPath("assets//index.js"));
  assert(!ValidWindowsAssetPath("../secret.json"));
  assert(!ValidWindowsAssetPath("assets/../secret.json"));
  assert(!ValidWindowsAssetPath("assets\\index.js"));
  assert(!ValidWindowsAssetPath("CON/index.html"));
  assert(!ValidWindowsAssetPath("assets/NUL.json"));
}

void TestBootstrapBudget() {
  assert(BootstrapDocumentFits(0, 0, 0));
  assert(BootstrapDocumentFits(0, 0, kBootstrapDocumentMaxBytes));
  assert(!BootstrapDocumentFits(0, 0, kBootstrapDocumentMaxBytes + 1));
  assert(BootstrapDocumentFits(kBootstrapDocumentMaxCount - 1, 0, 1));
  assert(!BootstrapDocumentFits(kBootstrapDocumentMaxCount, 0, 0));
  assert(!BootstrapDocumentFits(kBootstrapDocumentMaxCount + 5, 0, 0));
  assert(BootstrapDocumentFits(3, kBootstrapDocumentMaxBytes - 10, 10));
  assert(!BootstrapDocumentFits(3, kBootstrapDocumentMaxBytes - 10, 11));
  assert(BootstrapDocumentFits(3, kBootstrapDocumentMaxBytes, 0));
  assert(!BootstrapDocumentFits(3, kBootstrapDocumentMaxBytes + 1, 0));
  assert(!BootstrapDocumentFits(3, 1, static_cast<size_t>(-1)));
}

void TestBootstrapScript() {
  assert(JsonStringLiteral("") == "\"\"");
  assert(JsonStringLiteral("abc") == "\"abc\"");
  assert(JsonStringLiteral("a\"b\\c") == "\"a\\\"b\\\\c\"");
  assert(JsonStringLiteral("a\nb\tc") == "\"a\\u000ab\\u0009c\"");
  assert(JsonStringLiteral(std::string("a\0b", 3)) == "\"a\\u0000b\"");
  assert(JsonStringLiteral("</script>") == "\"\\u003c/script>\"");
  assert(JsonStringLiteral("x\xe2\x80\xa8y\xe2\x80\xa9z") ==
         "\"x\\u2028y\\u2029z\"");
  assert(JsonStringLiteral("caf\xc3\xa9") == "\"caf\xc3\xa9\"");

  const std::string script = BootstrapAssignmentScript(
      "{\"documents\":{\"__proto__\":\"{\\\"polluted\\\":true}\",\"ok.json\":\"1\"}}");
  assert(script ==
         "globalThis.__ardiaBootstrap=JSON.parse(\"{\\\"documents\\\":{\\\"__proto__"
         "\\\":\\\"{\\\\\\\"polluted\\\\\\\":true}\\\",\\\"ok.json\\\":\\\"1\\\"}}\");");
  assert(script.starts_with("globalThis.__ardiaBootstrap=JSON.parse(\""));
  assert(script.ends_with("\");"));
  assert(script.find("={") == std::string::npos);
}

void TestDownloadCommands() {
  assert(DownloadCommandForRoute("downloads.cancel") == "cancel");
  assert(DownloadCommandForRoute("downloads.pause") == "pause");
  assert(DownloadCommandForRoute("downloads.resume") == "resume");
  assert(DownloadCommandForRoute("downloads.keep") == "keep");
  assert(DownloadCommandForRoute("downloads.settings").empty());
  assert(DownloadCommandForRoute("downloads.setSettings").empty());
  assert(DownloadCommandForRoute("downloads.Resume").empty());
  assert(DownloadCommandForRoute("downloads.resume ").empty());
  assert(DownloadCommandForRoute("history.query").empty());
  assert(DownloadCommandForRoute("").empty());
  size_t command_routes = 0;
  for (const auto& route : ardia::desktop_routes::kRoutes) {
    const bool command_service = route.service == "ac_downloads_command";
    assert(command_service == !DownloadCommandForRoute(route.name).empty());
    command_routes += command_service ? 1 : 0;
  }
  assert(command_routes == 4);
}

void TestShellSelection() {
  static_assert(WebUIShellSelected(L"", L"", false, false));
  static_assert(WebUIShellSelected(L"", L"webui", false, false));
  static_assert(WebUIShellSelected(L"", L"webui", false, true));
  static_assert(!WebUIShellSelected(L"", L"rnw", false, false));
  static_assert(!WebUIShellSelected(L"", L"rnw", false, true));
  static_assert(!WebUIShellSelected(L"", L"", false, true));
  static_assert(!WebUIShellSelected(L"", L"", true, false));
  static_assert(!WebUIShellSelected(L"", L"", true, true));
  static_assert(WebUIShellSelected(L"", L"webui", true, false));
  static_assert(WebUIShellSelected(L"", L"webui", true, true));
  static_assert(!WebUIShellSelected(L"", L"rnw", true, false));
  assert(WebUIShellSelected(L"", L"RNW", false, false));
  assert(!WebUIShellSelected(L"", L"RNW", false, true));
  assert(!WebUIShellSelected(L"", L"RNW", true, false));
  assert(WebUIShellSelected(L"", L"rnw ", false, false));
  assert(WebUIShellSelected(L"", L" rnw", false, false));
  assert(WebUIShellSelected(L"", L"WebUI", false, false));
  assert(!WebUIShellSelected(L"", L"WebUI", false, true));
  assert(!WebUIShellSelected(L"", L"WebUI", true, false));
  assert(WebUIShellSelected(L"", L"anything", false, false));
  assert(!WebUIShellSelected(L"renderer", L"", false, false));
  assert(!WebUIShellSelected(L"gpu-process", L"webui", false, false));
  assert(!WebUIShellSelected(L"crashpad-handler", L"rnw", false, true));
  assert(!WebUIShellSelected(L"utility", L"webui", false, true));
  assert(!WebUIShellSelected(L"utility", L"webui", true, false));
}

void TestStartupMigrationGate() {
  using Outcome = StartupMigrationOutcome;
  static_assert(kStartupMigrationTimeoutMs == 60000);
  static_assert(kStartupMigrationIncompleteExitCode != 0);
  assert(StartupMigrationAllowsShell({Outcome::kNotRequested}));
  assert(StartupMigrationAllowsShell({Outcome::kMigratorAbsent}));
  assert(StartupMigrationAllowsShell({Outcome::kExited, 0}));
  assert(StartupMigrationAllowsShell(StartupMigrationResult{}));
  for (const unsigned long code : {1ul, 2ul, 3ul, 64ul, 255ul, 0xC0000005ul}) {
    assert(!StartupMigrationAllowsShell({Outcome::kExited, code}));
  }
  assert(!StartupMigrationAllowsShell({Outcome::kTimedOut}));
  assert(!StartupMigrationAllowsShell({Outcome::kWaitFailed, 6}));
  assert(!StartupMigrationAllowsShell({Outcome::kLaunchFailed, 5}));
  assert(!StartupMigrationAllowsShell({Outcome::kMigratorUnsafe}));
  assert(!StartupMigrationAllowsShell({Outcome::kLookupFailed}));
  assert(!StartupMigrationAllowsShell({Outcome::kIncompleteArguments}));
  assert(std::string_view(StartupMigrationOutcomeName(Outcome::kTimedOut)) ==
         "timed_out");
  assert(std::string_view(StartupMigrationOutcomeName(Outcome::kExited)) ==
         "exited");
  assert(std::string_view(StartupMigrationOutcomeName(Outcome::kMigratorAbsent)) ==
         "migrator_absent");
}

void TestCanonicalPathContainment() {
  assert(NormalizeWinFinalPath(L"\\\\?\\C:\\app\\ardia-ui") ==
         L"C:\\app\\ardia-ui");
  assert(NormalizeWinFinalPath(L"\\\\?\\C:\\app\\ardia-ui\\") ==
         L"C:\\app\\ardia-ui");
  assert(NormalizeWinFinalPath(L"\\\\?\\C:\\") == L"C:\\");
  assert(NormalizeWinFinalPath(L"\\\\?\\UNC\\server\\share\\ardia-ui\\") ==
         L"\\\\server\\share\\ardia-ui");
  assert(NormalizeWinFinalPath(L"\\\\?\\unc\\server\\share") ==
         L"\\\\server\\share");
  assert(NormalizeWinFinalPath(
             L"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\ui\\") ==
         L"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\ui");

  assert(!NormalizeWinFinalPath(L""));
  assert(!NormalizeWinFinalPath(L"relative\\path"));
  assert(!NormalizeWinFinalPath(L"\\rooted-without-drive"));
  assert(!NormalizeWinFinalPath(L"C:relative"));
  assert(!NormalizeWinFinalPath(L"\\\\?\\"));
  assert(!NormalizeWinFinalPath(L"\\\\?\\UNC\\"));
  assert(!NormalizeWinFinalPath(L"\\\\?\\UNC\\server"));
  assert(!NormalizeWinFinalPath(L"\\\\.\\PhysicalDrive0"));
  assert(!NormalizeWinFinalPath(L"\\\\server"));
  assert(!NormalizeWinFinalPath(L"C:\\app\\..\\secret"));
  assert(!NormalizeWinFinalPath(L"C:\\app\\.\\index.html"));
  assert(!NormalizeWinFinalPath(L"C:\\app\\\\index.html"));
  assert(!NormalizeWinFinalPath(std::wstring_view(L"C:\\app\0evil", 11)));

  assert(IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                      L"\\\\?\\C:\\app\\ardia-ui\\index.html"));
  assert(IsStrictlyWithinWinDirectory(
      L"\\\\?\\C:\\app\\ardia-ui\\",
      L"\\\\?\\c:\\app\\ardia-ui\\assets\\app.js"));
  assert(IsStrictlyWithinWinDirectory(L"c:\\App\\ardia-ui",
                                      L"C:\\App\\ardia-ui\\a.png"));
  assert(!IsStrictlyWithinWinDirectory(L"C:\\App\\ardia-ui",
                                       L"C:\\App\\ARDIA-UI\\a.png"));
  assert(!IsStrictlyWithinWinDirectory(
      L"\\\\?\\C:\\app\\ardia-ui\\",
      L"\\\\?\\c:\\APP\\ARDIA-UI\\assets\\app.js"));
  assert(IsStrictlyWithinWinDirectory(
      L"\\\\?\\UNC\\files\\ardia\\ui",
      L"\\\\?\\UNC\\FILES\\ARDIA\\ui\\assets\\app.js"));
  assert(!IsStrictlyWithinWinDirectory(
      L"\\\\?\\UNC\\files\\ardia\\ui",
      L"\\\\?\\UNC\\FILES\\ARDIA\\UI\\assets\\app.js"));
  assert(IsStrictlyWithinWinDirectory(
      L"\\\\?\\Volume{abcdef01-1111-1111-1111-111111111111}\\ui",
      L"\\\\?\\Volume{ABCDEF01-1111-1111-1111-111111111111}\\ui\\a.js"));
  assert(!IsStrictlyWithinWinDirectory(
      L"\\\\?\\Volume{abcdef01-1111-1111-1111-111111111111}\\ui",
      L"\\\\?\\Volume{abcdef01-1111-1111-1111-111111111111}\\UI\\a.js"));
  assert(IsStrictlyWithinWinDirectory(L"C:\\", L"C:\\index.html"));
  assert(IsStrictlyWithinWinDirectory(
      L"\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\",
      L"\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\a\\b.js"));

  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\C:\\app\\ardia-ui"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\C:\\app\\ardia-ui\\"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\C:\\app\\ardia-ui-evil\\x.js"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\C:\\elsewhere\\secret.json"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\D:\\app\\ardia-ui\\index.html"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\UNC\\srv\\share",
                                       L"\\\\?\\UNC\\srv\\share-evil\\x.js"));
  assert(!IsStrictlyWithinWinDirectory(L"C:\\", L"C:\\"));
  assert(!IsStrictlyWithinWinDirectory(L"", L"C:\\a"));
  assert(!IsStrictlyWithinWinDirectory(L"C:\\a", L""));

  assert(IsDirectChildOfWinDirectory(L"\\\\?\\C:\\data",
                                     L"\\\\?\\C:\\data\\telemetry.json"));
  assert(!IsDirectChildOfWinDirectory(L"\\\\?\\C:\\data",
                                      L"\\\\?\\C:\\data\\sub\\telemetry.json"));
  assert(!IsDirectChildOfWinDirectory(L"\\\\?\\C:\\data",
                                      L"\\\\?\\C:\\data-evil\\telemetry.json"));
  assert(!IsDirectChildOfWinDirectory(L"\\\\?\\C:\\data", L"\\\\?\\C:\\data"));
  assert(IsDirectChildOfWinDirectory(L"\\\\?\\c:\\Data",
                                     L"\\\\?\\C:\\Data\\telemetry.json"));
  assert(!IsDirectChildOfWinDirectory(L"\\\\?\\C:\\Data",
                                      L"\\\\?\\C:\\DATA\\telemetry.json"));
  assert(!IsDirectChildOfWinDirectory(L"C:\\", L"C:\\"));
  assert(IsDirectChildOfWinDirectory(L"C:\\", L"c:\\telemetry.json"));
  assert(WinFinalPathRootLength(L"C:\\a") == 2);
  assert(WinFinalPathRootLength(L"\\\\server\\share\\a") == 14);
  assert(WinFinalPathRootLength(L"\\\\server") == 8);
  assert(WinFinalPathRootLength(L"relative") == 0);
}

void TestStartupMigrationPolicy() {
  assert(StartupMigrationRequestIncomplete({true, false, true, false}));
  assert(!StartupMigrationRequestIncomplete({true, false, true, true}));
  assert(!StartupMigrationRequestIncomplete({false, false, true, false}));
  assert(!StartupMigrationRequestIncomplete({false, false, true, true}));
  assert(!StartupMigrationRequestIncomplete({true, true, true, false}));
  assert(!StartupMigrationRequestIncomplete({true, false, false, false}));
  assert(!StartupMigrationRequestIncomplete({false, false, false, false}));
  assert(!StartupMigrationAllowsShell(
      {StartupMigrationOutcome::kIncompleteArguments}));
  assert(ShouldRunStartupMigration({false, false, false, false}));
  assert(ShouldRunStartupMigration({true, false, false, false}));
  assert(ShouldRunStartupMigration({false, false, false, true}));
  assert(!ShouldRunStartupMigration({false, false, true, false}));
  assert(!ShouldRunStartupMigration({true, false, true, false}));
  assert(!ShouldRunStartupMigration({false, false, true, true}));
  assert(ShouldRunStartupMigration({true, false, true, true}));
  assert(!ShouldRunStartupMigration({false, true, false, false}));
  assert(!ShouldRunStartupMigration({true, true, false, false}));
  assert(!ShouldRunStartupMigration({true, true, true, true}));

  const std::optional<std::vector<std::wstring>> standard_args =
      BuildStartupMigrationArguments(false, L"", L"", false);
  assert(standard_args.has_value());
  assert(*standard_args == std::vector<std::wstring>({L"--from-rnw"}));

  const std::optional<std::vector<std::wstring>> test_args =
      BuildStartupMigrationArguments(false, L"", L"", true);
  assert(test_args.has_value());
  assert(*test_args ==
         std::vector<std::wstring>({L"--from-rnw", L"--test-instance"}));

  assert(!BuildStartupMigrationArguments(true, L"", L"", false).has_value());
  assert(!BuildStartupMigrationArguments(true, L"", L"C:\\webui", false)
              .has_value());
  assert(!BuildStartupMigrationArguments(true, L"C:\\rnw", L"", false)
              .has_value());
  assert(!BuildStartupMigrationArguments(false, L"C:\\rnw", L"", false)
              .has_value());
  assert(!BuildStartupMigrationArguments(false, L"", L"C:\\webui", false)
              .has_value());

  const std::optional<std::vector<std::wstring>> custom_args =
      BuildStartupMigrationArguments(true, L"C:\\rnw data", L"C:\\webui data",
                                     true);
  assert(custom_args.has_value());
  assert(*custom_args == std::vector<std::wstring>({
                             L"--from-rnw",
                             L"--rnw-data",
                             L"C:\\rnw data",
                             L"--webui-data",
                             L"C:\\webui data",
                             L"--test-instance",
                         }));

  assert(QuoteWinCommandArg(L"--from-rnw") == L"--from-rnw");
  assert(QuoteWinCommandArg(L"C:\\Program Files\\Ardia\\bin.exe") ==
         L"\"C:\\Program Files\\Ardia\\bin.exe\"");
  assert(QuoteWinCommandArg(L"C:\\dir with space\\") ==
         L"\"C:\\dir with space\\\\\"");
  assert(QuoteWinCommandArg(L"") == L"\"\"");
  assert(BuildWinCommandLine(L"C:\\Program Files\\Ardia\\ardia-webui-migrate.exe",
                             *custom_args) ==
         L"\"C:\\Program Files\\Ardia\\ardia-webui-migrate.exe\" --from-rnw "
         L"--rnw-data \"C:\\rnw data\" --webui-data \"C:\\webui data\" "
         L"--test-instance");
}

void TestWinRenameHelpers() {
  assert(ValidWinRenameLeafName(L"telemetry.json"));
  assert(ValidWinRenameLeafName(L"a"));
  assert(!ValidWinRenameLeafName(L""));
  assert(!ValidWinRenameLeafName(L"."));
  assert(!ValidWinRenameLeafName(L".."));
  assert(!ValidWinRenameLeafName(L"a\\b.json"));
  assert(!ValidWinRenameLeafName(L"a/b.json"));
  assert(!ValidWinRenameLeafName(L"a:b.json"));
  assert(!ValidWinRenameLeafName(std::wstring_view(L"a\0b", 3)));
  assert(!ValidWinRenameLeafName(
      std::wstring(kWindowsDocumentNameLimit + 1, L'a')));

  assert(WinFileRenameInfoBufferBytes(20, 24, 1) == 24);
  assert(WinFileRenameInfoBufferBytes(20, 24, 2) == 24);
  assert(WinFileRenameInfoBufferBytes(20, 24, 3) == 26);
  assert(WinFileRenameInfoBufferBytes(20, 24, 14) == 48);
}

void TestDesktopTelemetryPolicy() {
  namespace telemetry = ardia::desktop_telemetry_policy;
  const std::string valid_key = "ak_app_0123456789abcdef01234567";
  assert(telemetry::IngestKeyAcceptable(valid_key));
  assert(!telemetry::IngestKeyAcceptable(""));
  assert(!telemetry::IngestKeyAcceptable("bad_key"));
  assert(!telemetry::IngestKeyAcceptable("ak_app_0123456789ABCDEF01234567"));
  assert(!telemetry::IngestKeyAcceptable(valid_key + "\r\nX-Injected: 1"));
  assert(telemetry::BodyAcceptable("{\"resourceLogs\":[]}"));
  assert(!telemetry::BodyAcceptable(""));
  assert(!telemetry::BodyAcceptable("[]"));
  assert(!telemetry::BodyAcceptable("{" + std::string(telemetry::kMaxBodyBytes, 'a')));
  assert(telemetry::PostAcceptable("{\"ok\":true}", valid_key));
  assert(!telemetry::PostAcceptable("not-json", valid_key));
  assert(!telemetry::PostAcceptable("{}", "invalid"));
  assert(telemetry::AdmitPost(0));
  assert(telemetry::AdmitPost(telemetry::kMaxInFlight - 1));
  assert(!telemetry::AdmitPost(telemetry::kMaxInFlight));
  assert(!telemetry::AdmitPost(-1));
  assert(telemetry::ReportedStatus(true, 200) == 200);
  assert(telemetry::ReportedStatus(true, 503) == 503);
  assert(telemetry::ReportedStatus(true, 302) == 0);
  assert(telemetry::ReportedStatus(false, 200) == 0);
}

void TestMaximizeButtonStateMachine() {
  using State = MaximizeButtonVisualState;
  MaximizeButtonStateMachine machine;
  assert(machine.state() == (State{false, false}));

  assert(!machine.OnPointerChecked(false, false));
  assert(machine.OnPointerChecked(true, false));
  assert(machine.state() == (State{true, false}));
  assert(!machine.OnPointerChecked(true, true));
  assert(machine.state() == (State{true, false}));

  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.state() == (State{true, true}));
  assert(!machine.OnNcLeftButtonDown(true));
  assert(!machine.OnPointerChecked(true, true));
  assert(machine.state() == (State{true, true}));

  assert(machine.OnNcLeftButtonUp(true));
  assert(machine.state() == (State{true, false}));
  assert(!machine.OnNcLeftButtonUp(true));

  assert(machine.OnNcMouseLeave());
  assert(machine.state() == (State{false, false}));
  assert(!machine.OnNcMouseLeave());

  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.OnNcLeftButtonUp(false));
  assert(machine.state() == (State{false, false}));

  assert(machine.OnPointerChecked(true, false));
  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.Reset());
  assert(machine.state() == (State{false, false}));
  assert(!machine.Reset());
}

void TestMaximizeCaptureLossKeepsHoverOnly() {
  using State = MaximizeButtonVisualState;
  MaximizeButtonStateMachine machine;
  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.OnPressCancelled(true));
  assert(machine.state() == (State{true, false}));
  assert(!machine.OnPressCancelled(true));

  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.OnPressCancelled(false));
  assert(machine.state() == (State{false, false}));
  assert(!machine.OnPressCancelled(false));
}

void TestMaximizeReleaseOutsideThenReturn() {
  using State = MaximizeButtonVisualState;
  MaximizeButtonStateMachine machine;
  assert(machine.OnNcLeftButtonDown(true));
  assert(!machine.OnPointerChecked(true, true));
  assert(machine.state() == (State{true, true}));
  assert(machine.OnPointerChecked(true, false));
  assert(machine.state() == (State{true, false}));
  assert(!machine.OnPointerChecked(true, true));
  assert(machine.state() == (State{true, false}));
}

void TestMaximizeLeavingClearsBoth() {
  using State = MaximizeButtonVisualState;
  MaximizeButtonStateMachine machine;
  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.OnPointerChecked(false, true));
  assert(machine.state() == (State{false, false}));
  assert(machine.OnPointerChecked(true, true));
  assert(machine.state() == (State{true, false}));
  assert(machine.OnPointerChecked(false, false));
  assert(machine.state() == (State{false, false}));
}

void TestMaximizeDeactivationClearsBoth() {
  using State = MaximizeButtonVisualState;
  MaximizeButtonStateMachine machine;
  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.Reset());
  assert(machine.state() == (State{false, false}));
  assert(machine.OnPointerChecked(true, false));
  assert(machine.Reset());
  assert(machine.state() == (State{false, false}));
}

void TestMaximizeClick() {
  assert(MaximizeClickCompletes(true, true, 0));
  assert(MaximizeClickCompletes(true, true, kMaximizeClickLimitMs));
  assert(!MaximizeClickCompletes(true, true, kMaximizeClickLimitMs + 1));
  assert(!MaximizeClickCompletes(false, true, 10));
  assert(!MaximizeClickCompletes(true, false, 10));
  assert(!MaximizeClickCompletes(true, true, 0xffffffffu));

  MaximizeButtonStateMachine machine;
  assert(machine.OnPointerChecked(true, false));
  assert(machine.OnNcLeftButtonDown(true));
  assert(!machine.OnPointerChecked(true, true));
  const bool was_pressed = machine.state().pressed;
  assert(machine.OnNcLeftButtonUp(true));
  assert(MaximizeClickCompletes(was_pressed, true, 60));
  assert(machine.state() == (MaximizeButtonVisualState{true, false}));
}

}

int main() {
  TestDocumentNames();
  TestBootstrapBudget();
  TestBootstrapScript();
  TestDownloadCommands();
  TestCanonicalPathContainment();
  TestStartupMigrationPolicy();
  TestStartupMigrationGate();
  TestShellSelection();
  TestWinRenameHelpers();
  TestDesktopTelemetryPolicy();
  TestMaximizeButtonStateMachine();
  TestMaximizeCaptureLossKeepsHoverOnly();
  TestMaximizeReleaseOutsideThenReturn();
  TestMaximizeLeavingClearsBoth();
  TestMaximizeDeactivationClearsBoth();
  TestMaximizeClick();
  std::cout << "webui_policy_test: all assertions passed\n";
  return 0;
}
