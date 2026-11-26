#include "ardia/win/webui/webui_update_policy.h"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <vector>

namespace {

using namespace ardia_win::webui_update;

const std::string kSha(64, 'a');
const std::string kInstaller =
    "https://github.com/ardia-browser/ardia/releases/download/windows-alpha/Ardia-Setup-x64.exe";

const std::vector<std::string> kHostileValues = {
    "",
    " ",
    "\n",
    std::string("nul\0byte", 8),
    "../../../../Windows/System32/cmd.exe",
    "..\\..\\evil.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "\\\\server\\share\\evil.exe",
    "javascript:alert(1)",
    "file:///C:/Windows/System32/cmd.exe",
    "https://evil.example/Ardia-Setup-x64.exe",
    "https://github.com.evil.example/ardia-browser/ardia/releases/download/x.exe",
    "https://github.com/ardia-browser/ardia/releases/download/../../evil.exe",
    "https://github.com/ardia-browser/ardia/releases/download/a%2f..%2fevil.exe",
    "https://github.com/ardia-browser/ardia/releases/download/a?b=c.exe",
    "https://github.com/ardia-browser/ardia/releases/download/a#b.exe",
    "https://user@github.com/ardia-browser/ardia/releases/download/a.exe",
    "https://github.com/ardia-browser/ardia/releases/download//a.exe",
    "https://github.com/ardia-browser/ardia/releases/download/./a.exe",
    "https://github.com/ardia-browser/ardia/releases/download/a b.exe",
    "https://github.com/ardia-browser/ardia/releases/download/\"quoted\".exe",
    "https://github.com/ardia-browser/ardia/releases/download/caf\xc3\xa9.exe",
    "__proto__",
    "constructor",
    "1e309",
    "-1",
    "NaN",
    std::string(kUrlLimit + 1, 'a'),
};

void TestVersionsAndBuilds() {
  assert(ValidVersion("0.2.46"));
  assert(ValidVersion("0.2.47-nightly.3"));
  assert(ValidVersion("1.0.0+build.7"));
  assert(!ValidVersion(""));
  assert(!ValidVersion("v1.0.0"));
  assert(!ValidVersion("1.0 0"));
  assert(!ValidVersion("1.0.0\n"));
  assert(!ValidVersion(std::string(kVersionLimit + 1, '1')));
  assert(ValidBuild(1));
  assert(ValidBuild(kLargestBuild));
  assert(!ValidBuild(0));
  assert(!ValidBuild(kLargestBuild + 1));
  assert(ValidSha256(kSha));
  assert(!ValidSha256(std::string(64, 'A')));
  assert(!ValidSha256(std::string(63, 'a')));
  assert(!ValidSha256(std::string(64, 'g')));
  assert(ParseCount("42") == 42u);
  assert(!ParseCount("042"));
  assert(!ParseCount("0"));
  assert(!ParseCount("4 2"));
  assert(!ParseCount("12345678901234567"));
}

void TestFeedsAndUrls() {
  assert(ValidPublishedUnder(kReleasesUnder));
  assert(ValidPublishedUnder("http://127.0.0.1:8123/feed/"));
  assert(ValidPublishedUnder("http://localhost/feed/"));
  assert(ValidPublishedUnder("https://example.test/updates/"));
  assert(!ValidPublishedUnder("http://example.test/updates/"));
  assert(!ValidPublishedUnder("http://127.0.0.1:0/feed/"));
  assert(!ValidPublishedUnder("http://127.0.0.1:65536/feed/"));
  assert(!ValidPublishedUnder("https://example.test/updates"));
  assert(!ValidPublishedUnder("https:///updates/"));
  assert(!ValidPublishedUnder("https://.example.test/updates/"));
  assert(!ValidPublishedUnder("ftp://example.test/updates/"));
  assert(!ValidPublishedUnder("https://example.test//updates/"));
  assert(!ValidPublishedUnder("https://example.test/../updates/"));
  assert(!ValidPublishedUnder("https://user@example.test/updates/"));

  assert(ValidFeedUrl(kReleaseFeed));
  assert(ValidFeedUrl("http://127.0.0.1:8123/feed/windows-update.json"));
  assert(!ValidFeedUrl("http://127.0.0.1:8123/feed/windows-update.txt"));
  assert(!ValidFeedUrl("http://203.0.113.9/feed/windows-update.json"));
  assert(!ValidFeedUrl("http://127.0.0.1:8123/feed/.json"));
  assert(!ValidFeedUrl("http://127.0.0.1:8123/feed/windows-update.json?x=1"));

  const Feed release = ReleaseFeed();
  assert(release.release);
  assert(release.manifest == kReleaseFeed);
  assert(release.signature == std::string(kReleaseFeed) + ".sig");
  assert(release.published_under == kReleasesUnder);
  const std::optional<Feed> test = TestFeed("http://127.0.0.1:8123/feed/windows-update.json");
  assert(test && !test->release && test->published_under == "http://127.0.0.1:8123/feed/");
  assert(!TestFeed("https://evil.example/feed/windows-update.json?"));

  assert(ValidInstallerUrl(kInstaller, kReleasesUnder));
  assert(ValidInstallerUrl("http://127.0.0.1:8123/feed/Ardia-Setup-arm64.exe", "http://127.0.0.1:8123/feed/"));
  assert(!ValidInstallerUrl(kInstaller, "http://127.0.0.1:8123/feed/"));
  assert(!ValidInstallerUrl(std::string(kReleasesUnder) + "windows-alpha/Ardia-Setup.msi", kReleasesUnder));
  assert(!ValidInstallerUrl(std::string(kReleasesUnder) + "windows-alpha/.exe", kReleasesUnder));
  assert(!ValidInstallerUrl(std::string(kReleasesUnder) + "windows-alpha/-x.exe", kReleasesUnder));
  for (const std::string& hostile : kHostileValues) {
    assert(!ValidInstallerUrl(hostile, kReleasesUnder));
    assert(!ValidFeedUrl(hostile));
    assert(!TestFeed(hostile));
  }

  assert(AllowedRedirect("https", "objects.githubusercontent.com", 443, true));
  assert(AllowedRedirect("https", "release-assets.githubusercontent.com", 443, true));
  assert(AllowedRedirect("https", "github.com", 443, true));
  assert(!AllowedRedirect("http", "objects.githubusercontent.com", 80, true));
  assert(!AllowedRedirect("https", "objects.githubusercontent.com", 8443, true));
  assert(!AllowedRedirect("https", "evil.example", 443, true));
  assert(!AllowedRedirect("https", "objects.githubusercontent.com.evil.example", 443, true));
  assert(!AllowedRedirect("https", "objects.githubusercontent.com", 443, false));
}

void TestInstanceValues() {
  assert(InstanceValue("updateFeed=http://127.0.0.1:1/f/w.json", "updateFeed") ==
         std::optional<std::string>("http://127.0.0.1:1/f/w.json"));
  assert(InstanceValue("allowAudio, updateKey = C:\\keys\\test.pem ,updateFeed=x", "updateKey") ==
         std::optional<std::string>("C:\\keys\\test.pem"));
  assert(!InstanceValue("updateFeedX=1", "updateFeed"));
  assert(!InstanceValue("updateFeed=", "updateFeed"));
  assert(!InstanceValue("", "updateFeed"));
  assert(!InstanceValue(std::string(kInstanceLimit + 1, 'a'), "updateFeed"));
  assert(InstanceValue("updateFeed=a,updateFeed=b", "updateFeed") == std::optional<std::string>("b"));
}

void TestVerifierAnswers() {
  const std::string ok = "ok 0.3.0 120 " + kInstaller + " " + kSha + " 1048576\n";
  VerifierAnswer answer = ReadVerifierAnswer(true, 0, "noise\r\n" + ok, 100, kReleasesUnder);
  assert(answer.verdict == Verdict::kOk);
  assert(answer.offer.version == "0.3.0" && answer.offer.build == 120 && answer.offer.url == kInstaller);
  assert(answer.offer.sha256 == kSha && answer.offer.bytes == 1048576);
  assert(answer.reason.empty());

  assert(ReadVerifierAnswer(true, 0, ok, 120, kReleasesUnder).verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, ok, 100, "http://127.0.0.1:8123/feed/").verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 1, ok, 100, kReleasesUnder).verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(false, 0, ok, 100, kReleasesUnder).verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + kInstaller + " " + kSha + " 1048576 extra", 100,
                            kReleasesUnder)
             .verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + kInstaller + " " + kSha + " 0", 100, kReleasesUnder)
             .verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + kInstaller + " " + kSha + " 1073741825", 100,
                            kReleasesUnder)
             .verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + kInstaller + " " + std::string(64, 'A') + " 1", 100,
                            kReleasesUnder)
             .verdict == Verdict::kFailed);
  for (const std::string& hostile : kHostileValues) {
    const VerifierAnswer refused =
        ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + hostile + " " + kSha + " 1", 100, kReleasesUnder);
    assert(refused.verdict == Verdict::kFailed && refused.reason == kVerifierReason);
    assert(ValidVersion(hostile) ||
           ReadVerifierAnswer(true, 0, "ok " + hostile + " 120 " + kInstaller + " " + kSha + " 1", 100,
                              kReleasesUnder)
                   .verdict == Verdict::kFailed);
  }

  assert(ReadVerifierAnswer(true, 1, "failed notNewer\n", 100, kReleasesUnder).verdict == Verdict::kUpToDate);
  assert(ReadVerifierAnswer(true, 1, "failed kind", 100, kReleasesUnder).verdict == Verdict::kUpToDate);
  assert(ReadVerifierAnswer(true, 1, "failed signature", 100, kReleasesUnder).reason == kSignatureReason);
  assert(ReadVerifierAnswer(true, 1, "failed manifest", 100, kReleasesUnder).reason == kManifestReason);
  assert(ReadVerifierAnswer(true, 1, "failed version", 100, kReleasesUnder).reason == kManifestReason);
  assert(ReadVerifierAnswer(true, 1, "failed missing", 100, kReleasesUnder).reason == kMissingReason);
  assert(ReadVerifierAnswer(true, 1, "failed checksum", 100, kReleasesUnder).reason == kChecksumReason);
  assert(ReadVerifierAnswer(true, 2, "failed usage", 100, kReleasesUnder).reason == kVerifierReason);
  assert(ReadVerifierAnswer(true, 0, "failed notNewer", 100, kReleasesUnder).verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 1, "", 100, kReleasesUnder).reason == kVerifierReason);
}

void TestStagingNames() {
  assert(InstallerFileName(kSha) == "Ardia-Setup-aaaaaaaaaaaaaaaa.exe");
  assert(StagingFileName(kSha, 0x0123456789abcdefull) == "Ardia-Setup-aaaaaaaaaaaaaaaa-0123456789abcdef.part");
  assert(StagingFileName(kSha, 1) != StagingFileName(kSha, 2));
  assert(InstallerFileName("..\\evil").empty());
  assert(StagingFileName("", 1).empty());
  assert(StagingFileName("..\\evil", 1).empty());
  assert(IsInstallerLeftover("Ardia-Setup-0123456789abcdef.exe"));
  assert(IsInstallerLeftover(StagingFileName(kSha, 42)));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef.exe.part"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef-0123456789ABCDEF.part"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef_0123456789abcdef.part"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef-0123456789abcde.part"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789ABCDEF.exe"));
  assert(!IsInstallerLeftover("Ardia-Setup-x64.exe"));
  assert(!IsInstallerLeftover("session.json"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef.exe:stream"));
  assert(IsScratchName(ScratchName(4321, 7)));
  assert(ScratchName(0, 0) == "verify-1-1");
  assert(!IsScratchName("verify-1"));
  assert(!IsScratchName("verify-a-1"));
  assert(!IsScratchName("Updates"));
}

void TestCommands() {
  assert(QuoteArgument(L"C:\\Program Files\\Ardia\\x.exe") == L"\"C:\\Program Files\\Ardia\\x.exe\"");
  assert(QuoteArgument(L"C:\\dir\\") == L"\"C:\\dir\\\\\"");
  assert(QuoteArgument(L"a\"b") == L"\"a\\\"b\"");
  const VerifierPaths paths{L"C:\\A\\ardia-update-verify.exe", L"C:\\A\\windows-update.pem",
                            L"C:\\D\\Updates\\verify-1-1\\windows-update.json",
                            L"C:\\D\\Updates\\verify-1-1\\windows-update.json.sig", L""};
  const std::optional<std::wstring> manifest = VerifierCommand(paths, kReleasesUnder, "x64", 100);
  assert(manifest);
  assert(*manifest ==
         L"\"C:\\A\\ardia-update-verify.exe\" windows-manifest --key \"C:\\A\\windows-update.pem\" --manifest "
         L"\"C:\\D\\Updates\\verify-1-1\\windows-update.json\" --signature "
         L"\"C:\\D\\Updates\\verify-1-1\\windows-update.json.sig\" --published-under "
         L"\"https://github.com/ardia-browser/ardia/releases/download/\" --cpu x64 --current-build 100");
  VerifierPaths package = paths;
  package.package = L"C:\\D\\Updates\\Ardia-Setup-aaaaaaaaaaaaaaaa.exe";
  const std::optional<std::wstring> packaged = VerifierCommand(package, kReleasesUnder, "arm64", 0);
  assert(packaged && packaged->find(L" windows-package ") != std::wstring::npos &&
         packaged->ends_with(L" --package \"C:\\D\\Updates\\Ardia-Setup-aaaaaaaaaaaaaaaa.exe\""));
  assert(!VerifierCommand(paths, kReleasesUnder, "x86", 100));
  assert(!VerifierCommand(paths, "https://evil.example/x", "x64", 100));
  assert(!VerifierCommand(paths, kReleasesUnder, "x64", kLargestBuild + 1));
  VerifierPaths quoted = paths;
  quoted.manifest = L"C:\\D\\\"x";
  assert(!VerifierCommand(quoted, kReleasesUnder, "x64", 100));
  VerifierPaths broken = paths;
  broken.key = L"C:\\D\\a\nb";
  assert(!VerifierCommand(broken, kReleasesUnder, "x64", 100));
  assert(InstallerCommand(L"C:\\D\\Updates\\Ardia-Setup-aaaaaaaaaaaaaaaa.exe") ==
         L"\"C:\\D\\Updates\\Ardia-Setup-aaaaaaaaaaaaaaaa.exe\" /SILENT /SUPPRESSMSGBOXES /NORESTART "
         L"/CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS /relaunch=1");
  assert(!InstallerCommand(L""));
  assert(!InstallerCommand(L"C:\\a\"b.exe"));
  const uint8_t bytes[] = {0x00, 0x0f, 0xa0, 0xff};
  assert(HexLower(bytes, 4) == "000fa0ff");
}

void TestDataDirectories() {
  const std::wstring production = L"C:\\Users\\Ada\\AppData\\Local\\Ardia WebUI";
  assert(!ScratchDataDirectory(production, production));
  assert(!ScratchDataDirectory(L"c:\\users\\ada\\appdata\\local\\ARDIA WEBUI\\", production));
  assert(!ScratchDataDirectory(L"C:/Users/Ada/AppData/Local/Ardia WebUI", production));
  assert(!ScratchDataDirectory(L"\\\\?\\C:\\Users\\Ada\\AppData\\Local\\Ardia WebUI", production));
  assert(!ScratchDataDirectory(L"  C:\\Users\\Ada\\AppData\\Local\\Ardia WebUI  ", production));
  assert(!ScratchDataDirectory(L"C:\\Users\\Ada\\AppData\\Local\\Ardia WebUI\\.", production));
  assert(!ScratchDataDirectory(L"C:\\Users\\Ada\\AppData\\Local\\Ardia WebUI\\.\\", production));
  assert(!ScratchDataDirectory(L"C:\\Users\\Ada\\.\\AppData\\Local\\.\\Ardia WebUI", production));
  assert(!ScratchDataDirectory(L"C:/Users/Ada/AppData/Local/Ardia WebUI/./", production));
  assert(ScratchDataDirectory(L"C:\\Users\\Ada\\AppData\\Local\\Ardia WebUI\\..", production));
  assert(ScratchDataDirectory(L"C:\\Users\\Ada\\AppData\\Local\\Ardia WebUI.", production));
  assert(ScratchDataDirectory(L"C:\\Temp\\ardia-scratch-41", production));
  assert(ScratchDataDirectory(L"C:\\Users\\Ada\\AppData\\Local\\Ardia WebUI\\nested", production));
  assert(ScratchDataDirectory(L"C:\\Users\\Ada\\AppData\\Local\\Ardia", production));
  assert(ScratchDataDirectory(L"", production));
  assert(ScratchDataDirectory(production, L""));
  assert(FoldedPath(L"C:\\") == L"c:\\");
}

void TestHeldInstallerHandle() {
  assert(HeldInstallerLetsItRun(kHeldInstallerAccess, kHeldInstallerShare));
  assert((kHeldInstallerAccess & kDeleteAccess) == 0);
  assert(kHeldInstallerShare == kFileShareRead);
  assert(!HeldInstallerLetsItRun(kHeldInstallerAccess | kDeleteAccess, kHeldInstallerShare));
  assert(!HeldInstallerLetsItRun(kHeldInstallerAccess | 0x00000002, kHeldInstallerShare));
  assert(!HeldInstallerLetsItRun(kHeldInstallerAccess, kFileShareRead | 0x00000002));
  assert(!HeldInstallerLetsItRun(kHeldInstallerAccess, kFileShareRead | 0x00000004));
}

const char* const kUpdateMethods[] = {"ArdiaUpdates.installKind", "ArdiaUpdates.status", "ArdiaUpdates.check",
                                      "ArdiaUpdates.update", "ArdiaUpdates.claimOutcome", "ArdiaUpdates.restart"};

CallCheck Call(std::string_view method, std::vector<CallArgument> args, ArgumentsShape shape = ArgumentsShape::kList) {
  return CheckUpdateCall(method, shape, args);
}

void TestUpdateCalls() {
  const CallArgument build{ArgumentKind::kInt, 120};
  for (const char* method : kUpdateMethods) {
    assert(ParseUpdateCall(method));
    assert(!Call(method, {}, ArgumentsShape::kNotList).request);
    assert(!Call(method, {build, build}).request);
  }
  assert(!ParseUpdateCall("ArdiaUpdates.releases"));
  assert(!ParseUpdateCall("ardiaupdates.check"));
  assert(Call("ArdiaUpdates.nope", {}).refusal == "Unknown update method");
  for (const char* method : {"ArdiaUpdates.installKind", "ArdiaUpdates.status", "ArdiaUpdates.check", "ArdiaUpdates.restart"}) {
    assert(Call(method, {}).request);
    assert(Call(method, {}, ArgumentsShape::kOmitted).request);
    assert(!Call(method, {build}).request);
    assert(!Call(method, {CallArgument{}}).request);
  }
  const CallCheck update = Call("ArdiaUpdates.update", {build});
  assert(update.request && update.request->call == UpdateCall::kUpdate && update.request->build == 120);
  assert(Call("ArdiaUpdates.update", {CallArgument{ArgumentKind::kDouble, 9007199254740991.0}}).request);
  assert(Call("ArdiaUpdates.claimOutcome", {CallArgument{ArgumentKind::kInt, 3}}).request->run == 3);
  assert(Call("ArdiaUpdates.claimOutcome", {CallArgument{ArgumentKind::kInt, 0}}).request);
  const double infinity = std::numeric_limits<double>::infinity();
  const double refused_numbers[] = {0.0, -1.0, 0.5, 9007199254740993.0, infinity, -infinity};
  for (const double number : refused_numbers) {
    assert(!Call("ArdiaUpdates.update", {CallArgument{ArgumentKind::kDouble, number}}).request);
  }
  assert(!Call("ArdiaUpdates.update", {CallArgument{ArgumentKind::kDouble, std::nan("")}}).request);
  for (const double number : {-1.0, 0.5, 1e10, infinity}) {
    assert(!Call("ArdiaUpdates.claimOutcome", {CallArgument{ArgumentKind::kDouble, number}}).request);
  }
  for (const ArgumentKind kind : {ArgumentKind::kNull, ArgumentKind::kBool, ArgumentKind::kString, ArgumentKind::kList, ArgumentKind::kDict}) {
    assert(!Call("ArdiaUpdates.update", {CallArgument{kind, 120}}).request);
    assert(!Call("ArdiaUpdates.claimOutcome", {CallArgument{kind, 1}}).request);
  }
  assert(!Call("ArdiaUpdates.update", {}).request);
  assert(!Call("ArdiaUpdates.update", {}, ArgumentsShape::kOmitted).request);
  assert(!Call("ArdiaUpdates.claimOutcome", {}).request);
}

void TestInstallKinds() {
  assert(InstallKind({true, true, true, true}) == kInstallerKind);
  assert(InstallKind({true, true, true, false}) == kPortableKind);
  assert(InstallKind({false, true, true, true}) == kUnsupportedKind);
  assert(InstallKind({true, false, true, true}) == kUnsupportedKind);
  assert(InstallKind({true, true, false, true}) == kUnsupportedKind);
}

void TestStateMachine() {
  const Offer offer{"0.3.0", 120, kInstaller, kSha, 1048576};
  UpdateState state;
  assert(PhaseName(state.phase) == "idle");
  assert(!BeginDownload(state, 120));
  const std::optional<int> check = BeginCheck(state);
  assert(check == 1 && PhaseName(state.phase) == "checking");
  assert(!BeginCheck(state));
  CheckFinished(state, *check + 1, Verdict::kOk, offer, "");
  assert(state.phase == Phase::kChecking);
  CheckFinished(state, *check, Verdict::kOk, offer, "");
  assert(state.phase == Phase::kAvailable && state.offer && SameOffer(*state.offer, offer));

  assert(!BeginDownload(state, 119));
  assert(!BeginDownload(state, 0));
  const std::optional<int> run = BeginDownload(state, 120);
  assert(run == 1 && state.phase == Phase::kDownloading);
  assert(!BeginCheck(state));
  assert(!BeginDownload(state, 120));
  assert(!ClaimOutcome(state, *run));
  DownloadFinished(state, *run + 1, true, "");
  assert(state.phase == Phase::kDownloading);
  DownloadFinished(state, *run, true, "");
  assert(ReadyToInstall(state));
  assert(!BeginCheck(state));
  assert(ClaimOutcome(state, *run));
  assert(!ClaimOutcome(state, *run));
  assert(!ClaimOutcome(state, 0));

  assert(BeginInstall(state) == InstallStart::kStarted);
  assert(state.installing);
  assert(BeginInstall(state) == InstallStart::kInstalling);
  assert(BeginInstall(state) == InstallStart::kInstalling);
  assert(!BeginCheck(state));
  assert(!BeginDownload(state, 120));
  InstallRefused(state, *run, kChecksumReason);
  assert(state.phase == Phase::kFailed && state.reason == kChecksumReason && !ReadyToInstall(state));
  assert(!state.installing);
  assert(BeginInstall(state) == InstallStart::kNotReady);
  assert(ClaimOutcome(state, *run));

  const std::optional<int> again = BeginCheck(state);
  assert(again == 2);
  CheckFinished(state, *again, Verdict::kUpToDate, Offer{}, "");
  assert(state.phase == Phase::kUpToDate && !state.offer && state.reason.empty());

  const std::optional<int> failing = BeginCheck(state);
  CheckFinished(state, *failing, Verdict::kFailed, Offer{}, kSignatureReason);
  assert(state.phase == Phase::kIdle && state.reason == kSignatureReason && !state.offer);

  const std::optional<int> third = BeginCheck(state);
  CheckFinished(state, *third, Verdict::kOk, offer, "");
  const std::optional<int> second_run = BeginDownload(state, 120);
  assert(second_run == 2);
  DownloadFinished(state, *second_run, false, "");
  assert(state.phase == Phase::kFailed && state.reason == kOtherReason && !state.claimed);
  assert(ClaimOutcome(state, *second_run));
  DownloadFinished(state, *second_run, true, "");
  assert(state.phase == Phase::kFailed);
  assert(PhaseName(Phase::kUpToDate) == "upToDate" && PhaseName(Phase::kAvailable) == "available" &&
         PhaseName(Phase::kDownloading) == "downloading" && PhaseName(Phase::kReady) == "ready" &&
         PhaseName(Phase::kFailed) == "failed");
}

bool ReachesDownload(const VerifierAnswer& answer, Offer* reached) {
  UpdateState state;
  const std::optional<int> check = BeginCheck(state);
  CheckFinished(state, *check, answer.verdict, answer.offer, answer.reason);
  if (!state.offer) {
    assert(!BeginDownload(state, answer.offer.build));
    return false;
  }
  const std::optional<int> run = BeginDownload(state, state.offer->build);
  assert(run);
  DownloadFinished(state, *run, true, "");
  assert(BeginInstall(state) == InstallStart::kStarted);
  *reached = *state.offer;
  return true;
}

void CheckReachedOffer(const Offer& offer) {
  assert(ValidVersion(offer.version));
  assert(ValidBuild(offer.build) && offer.build > 100);
  assert(ValidInstallerUrl(offer.url, kReleasesUnder));
  assert(ValidSha256(offer.sha256));
  assert(offer.bytes >= 1 && offer.bytes <= kInstallerLimit);
  for (const char c : offer.url + offer.version) {
    assert(c > 0x20 && c < 0x7f && c != '"' && c != '\\' && c != '%' && c != '?' && c != '#' && c != '@');
  }
}

std::optional<std::string> Unhex(std::string_view hex) {
  if (hex.size() % 2 != 0) {
    return std::nullopt;
  }
  std::string bytes;
  for (size_t i = 0; i < hex.size(); i += 2) {
    const auto digit = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      return -1;
    };
    const int high = digit(hex[i]);
    const int low = digit(hex[i + 1]);
    if (high < 0 || low < 0) {
      return std::nullopt;
    }
    bytes.push_back(static_cast<char>(high * 16 + low));
  }
  return bytes;
}

std::optional<CallArgument> ParseArgument(std::string_view description, std::optional<std::string>* text) {
  if (description.size() < 2 || description[1] != ':') {
    return std::nullopt;
  }
  const std::string payload(description.substr(2));
  switch (description[0]) {
    case 's':
      *text = Unhex(payload);
      return text->has_value() ? std::optional<CallArgument>(CallArgument{ArgumentKind::kString, 0}) : std::nullopt;
    case 'i':
      return CallArgument{ArgumentKind::kInt, std::stod(payload)};
    case 'd':
      return CallArgument{ArgumentKind::kDouble, std::stod(payload)};
    case 'b':
      return CallArgument{ArgumentKind::kBool, 0};
    case 'z':
      return CallArgument{ArgumentKind::kNull, 0};
    case 'a':
      return CallArgument{ArgumentKind::kList, 0};
    case 'o':
      return CallArgument{ArgumentKind::kDict, 0};
  }
  return std::nullopt;
}

bool ReachesCallSink(const CallCheck& checked) {
  if (!checked.request) {
    return false;
  }
  UpdateState state;
  const std::optional<int> check = BeginCheck(state);
  CheckFinished(state, *check, Verdict::kOk, Offer{"0.3.0", 120, kInstaller, kSha, 1048576}, "");
  switch (checked.request->call) {
    case UpdateCall::kUpdate:
      return BeginDownload(state, checked.request->build).has_value();
    case UpdateCall::kClaimOutcome: {
      const std::optional<int> run = BeginDownload(state, 120);
      DownloadFinished(state, *run, true, "");
      return ClaimOutcome(state, checked.request->run);
    }
    case UpdateCall::kRestart: {
      const std::optional<int> run = BeginDownload(state, 120);
      DownloadFinished(state, *run, true, "");
      const bool started = BeginInstall(state) == InstallStart::kStarted;
      assert(BeginInstall(state) == InstallStart::kInstalling);
      return started;
    }
    case UpdateCall::kInstallKind:
    case UpdateCall::kStatus:
    case UpdateCall::kCheck:
      return true;
  }
  return false;
}

bool ValidWholeArgument(const CallArgument& argument, double low, double high) {
  return (argument.kind == ArgumentKind::kInt || argument.kind == ArgumentKind::kDouble) &&
         std::isfinite(argument.number) && std::floor(argument.number) == argument.number && argument.number >= low &&
         argument.number <= high;
}

bool ExpectedWholeArgs(UpdateCall call, ArgumentsShape shape, const std::vector<CallArgument>& args) {
  if (shape == ArgumentsShape::kNotList) {
    return false;
  }
  switch (call) {
    case UpdateCall::kInstallKind:
    case UpdateCall::kStatus:
    case UpdateCall::kCheck:
    case UpdateCall::kRestart:
      return args.empty();
    case UpdateCall::kUpdate:
      return args.size() == 1 && ValidWholeArgument(args[0], 1, static_cast<double>(kLargestBuild));
    case UpdateCall::kClaimOutcome:
      return args.size() == 1 && ValidWholeArgument(args[0], 0, kLargestRun);
  }
  return false;
}

size_t CheckHostileCall(const CallArgument& value, ArgumentsShape shape, const std::vector<CallArgument>& as_args) {
  size_t reached = 0;
  for (const char* method : kUpdateMethods) {
    const CallCheck single = CheckUpdateCall(method, ArgumentsShape::kList, std::vector<CallArgument>{value});
    if (single.request) {
      assert(single.request->call == UpdateCall::kUpdate || single.request->call == UpdateCall::kClaimOutcome);
      assert(value.kind == ArgumentKind::kInt || value.kind == ArgumentKind::kDouble);
      assert(std::isfinite(value.number) && std::floor(value.number) == value.number);
      if (single.request->call == UpdateCall::kUpdate) {
        assert(ValidBuild(single.request->build));
      } else {
        assert(single.request->run >= 0 && single.request->run <= kLargestRun);
      }
    }
    if (ReachesCallSink(single)) {
      ++reached;
      assert(single.request->call != UpdateCall::kUpdate || single.request->build == 120);
      assert(single.request->call != UpdateCall::kClaimOutcome || single.request->run == 1);
    }
    assert(!CheckUpdateCall(method, ArgumentsShape::kList, std::vector<CallArgument>{value, value}).request);
    const CallCheck whole = CheckUpdateCall(method, shape, as_args);
    const UpdateCall call = *ParseUpdateCall(method);
    assert(whole.request.has_value() == ExpectedWholeArgs(call, shape, as_args));
    if (shape == ArgumentsShape::kNotList) {
      assert(whole.refusal == "args must be a list");
    } else if (!whole.request) {
      assert(!whole.refusal.empty() && whole.refusal != "Unknown update method" && whole.refusal != "args must be a list");
    }
    if (!as_args.empty() && call != UpdateCall::kUpdate && call != UpdateCall::kClaimOutcome) {
      assert(!whole.request && whole.refusal == "this update call takes no arguments");
    }
    if (as_args.size() > 1) {
      assert(!whole.request);
    }
  }
  return reached;
}

int RunHostileCorpus(const char* path) {
  std::ifstream input(path);
  assert(input);
  const std::string sha = kSha;
  const std::string url = kInstaller;
  const std::string control = "ok 0.3.0 120 " + url + " " + sha + " 1048576";
  Offer reached;
  assert(ReachesDownload(ReadVerifierAnswer(true, 0, control, 100, kReleasesUnder), &reached));
  CheckReachedOffer(reached);
  assert(ReachesCallSink(CheckUpdateCall("ArdiaUpdates.update", ArgumentsShape::kList,
                                         std::vector<CallArgument>{{ArgumentKind::kInt, 120}})));
  assert(ReachesCallSink(CheckUpdateCall("ArdiaUpdates.claimOutcome", ArgumentsShape::kList,
                                         std::vector<CallArgument>{{ArgumentKind::kInt, 1}})));
  assert(ReachesCallSink(CheckUpdateCall("ArdiaUpdates.restart", ArgumentsShape::kList, std::vector<CallArgument>{})));
  assert(ReachesCallSink(CheckUpdateCall("ArdiaUpdates.restart", ArgumentsShape::kOmitted, std::vector<CallArgument>{})));
  assert(!CheckUpdateCall("ArdiaUpdates.restart", ArgumentsShape::kList, std::vector<CallArgument>{{ArgumentKind::kInt, 1}}).request);
  size_t values = 0;
  size_t strings = 0;
  size_t answers = 0;
  size_t downloads = 0;
  size_t calls = 0;
  size_t call_sinks = 0;
  std::string line;
  while (std::getline(input, line)) {
    const size_t bar = line.find('|');
    assert(bar != std::string::npos);
    std::optional<std::string> text;
    const std::optional<CallArgument> value = ParseArgument(std::string_view(line).substr(0, bar), &text);
    assert(value);
    ++values;
    const std::string_view whole = std::string_view(line).substr(bar + 1);
    assert(!whole.empty());
    ArgumentsShape shape = ArgumentsShape::kOmitted;
    std::vector<CallArgument> as_args;
    if (whole[0] == 'N') {
      shape = ArgumentsShape::kNotList;
    } else if (whole[0] == 'L') {
      shape = ArgumentsShape::kList;
      std::string_view rest = whole.substr(1);
      while (!rest.empty()) {
        const size_t comma = rest.find(',');
        std::optional<std::string> element_text;
        const std::optional<CallArgument> element = ParseArgument(rest.substr(0, comma), &element_text);
        assert(element);
        as_args.push_back(*element);
        rest = comma == std::string_view::npos ? std::string_view() : rest.substr(comma + 1);
      }
    } else {
      assert(whole[0] == 'O');
    }
    calls += std::size(kUpdateMethods) * 3;
    call_sinks += CheckHostileCall(*value, shape, as_args);
    if (!text) {
      continue;
    }
    ++strings;
    const std::string& h = *text;
    assert(!ParseUpdateCall(h) || std::string_view(h).starts_with("ArdiaUpdates."));
    assert(!TestFeed(h) || ValidFeedUrl(h));
    assert(!ValidPublishedUnder(h) || h.starts_with("https://") || h.starts_with("http://"));
    assert(!ValidInstallerUrl(h, kReleasesUnder) || h.starts_with(kReleasesUnder));
    assert(!InstanceValue(h, "updateFeed") || h.size() <= kInstanceLimit);
    const std::wstring wide(h.begin(), h.end());
    if (const std::optional<std::wstring> command = InstallerCommand(wide)) {
      assert(command->front() == L'"' && command->find(L'\n') == std::wstring::npos);
    }
    const std::vector<std::string> lines = {
        h,
        "ok " + h,
        "failed " + h,
        "ok " + h + " 120 " + url + " " + sha + " 1",
        "ok 0.3.0 " + h + " " + url + " " + sha + " 1",
        "ok 0.3.0 120 " + h + " " + sha + " 1",
        "ok 0.3.0 120 " + std::string(kReleasesUnder) + "windows-alpha/" + h + ".exe " + sha + " 1",
        "ok 0.3.0 120 " + url + " " + h + " 1",
        "ok 0.3.0 120 " + url + " " + sha + " " + h,
        control + "\n" + h,
        h + "\n" + control,
    };
    for (const std::string& candidate : lines) {
      for (const int exit_code : {0, 1, 2}) {
        ++answers;
        if (ReachesDownload(ReadVerifierAnswer(true, exit_code, candidate, 100, kReleasesUnder), &reached)) {
          ++downloads;
          CheckReachedOffer(reached);
          assert(exit_code == 0);
        }
      }
    }
  }
  assert(values > 0 && strings > 0);
  std::cout << "webui_update_policy_test hostile: " << values << " values, " << strings << " strings, " << answers
            << " answers, " << downloads << " reached the download gate with a valid offer, " << calls << " calls, "
            << call_sinks << " reached a call sink with a valid request, controls reached them\n";
  return 0;
}

}

int main(int argc, char** argv) {
  if (argc == 3 && std::string_view(argv[1]) == "--hostile") {
    return RunHostileCorpus(argv[2]);
  }
  TestVersionsAndBuilds();
  TestFeedsAndUrls();
  TestInstanceValues();
  TestVerifierAnswers();
  TestStagingNames();
  TestCommands();
  TestDataDirectories();
  TestHeldInstallerHandle();
  TestUpdateCalls();
  TestInstallKinds();
  TestStateMachine();
  std::cout << "webui_update_policy_test: all assertions passed\n";
  return 0;
}
