import { AppState, Platform } from "react-native";
import { act } from "react-test-renderer";
import { pages } from "@ardia/phone-native";
import { AboutPage } from "../components/settings/DataPages";
import { downloads } from "../platform/downloads";
import { fetchGitHubJson, fetchReleaseChecksum } from "../platform/releases";
import { copyLink, openExternal } from "../platform/system";
import { installDownloadedPackage, openUpdate, startUpdateChecks, UPDATE_DOWNLOAD_KEY, UPDATE_NEXT_CHECK_KEY, UPDATE_OFFERED_KEY, UPDATE_SEEN_KEY, useAppUpdate } from "../state/appUpdate/store";
import { readPreference, writePreference } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import { useSettingsNav } from "../state/settings/nav";
import { useToasts } from "../state/toasts/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

jest.mock("../platform/releases", () => ({ fetchGitHubJson: jest.fn(), fetchReleaseChecksum: jest.fn() }));
jest.mock("../platform/system", () => ({ ...jest.requireActual("../platform/system"), openExternal: jest.fn(() => Promise.resolve()), copyLink: jest.fn(() => Promise.resolve()) }));

const fetched = fetchGitHubJson as jest.MockedFunction<typeof fetchGitHubJson>;
const checksum = fetchReleaseChecksum as jest.MockedFunction<typeof fetchReleaseChecksum>;
const opened = openExternal as jest.MockedFunction<typeof openExternal>;
const copied = copyLink as jest.MockedFunction<typeof copyLink>;
const releaseBuild = Platform.OS === "android" && !__DEV__;
const APK = (version: string) => `https://github.com/ardia-browser/ardia/releases/download/android-v${version}/Ardia-${version}.apk`;
const SHA = "9f1eca24627f7475f34591c3738ca6b6418f08dec4929774d72158e7dfc1a5ca";
const offerOf = (version: string) => ({ version, downloadUrl: APK(version), checksumUrl: `${APK(version)}.sha256`, sha256: null });

jest.spyOn(pages, "appRelease").mockReturnValue({ releaseVersion: "1.0.3", build: "100003999", receiptName: null });
jest.spyOn(downloads, "handsOffAppUpdates").mockReturnValue(true);
const handedOff = jest.spyOn(downloads, "handOffAppUpdate");
const statusOf = jest.spyOn(downloads, "appUpdateStatus");
const verified = jest.spyOn(downloads, "verifyAppUpdate");
const installed = jest.spyOn(downloads, "installVerifiedUpdate");
const notified = jest.spyOn(downloads, "notifyUpdateReady");
const installRequest = jest.spyOn(downloads, "takeInstallRequest");
jest.spyOn(downloads, "takeInstallStatus").mockReturnValue(null);
const counted = jest.spyOn(telemetry, "countUsage");
let installStatusEvent: (event: unknown) => void = () => undefined;
jest.spyOn(downloads, "addInstallStatusListener").mockImplementation((listener) => {
  installStatusEvent = listener;
  return { remove: () => undefined };
});
jest.spyOn(downloads, "askForUpdateNotifications").mockResolvedValue(undefined);
const discarded = jest.spyOn(downloads, "discardAppUpdate");
const canInstall = jest.spyOn(downloads, "canInstallPackages");
const permission = jest.spyOn(downloads, "openInstallPermission");
const installedFile = jest.spyOn(downloads, "installDownloadedFile");
const progressOf = jest.spyOn(downloads, "appUpdateProgress");
let completed: (event: { id: string }) => void = () => undefined;
jest.spyOn(downloads, "addAppUpdateListener").mockImplementation((listener) => {
  completed = listener;
  return { remove: () => undefined };
});

let appState = "active";
Object.defineProperty(AppState, "currentState", { configurable: true, get: () => appState });
const stateListeners: ((next: string) => void)[] = [];
jest.spyOn(AppState, "addEventListener").mockImplementation(((type: string, listener: (next: string) => void) => {
  if (type === "change") stateListeners.push(listener);
  return { remove: () => undefined };
}) as never);

let withDigest = false;

const publishedAnswers = (version: string) => async (url: string) => {
  if (url.endsWith("/git/matching-refs/tags/android-v")) return { kind: "json" as const, body: [{ ref: "refs/tags/android-v1.0.3" }, { ref: `refs/tags/android-v${version}` }, { ref: "refs/tags/android-v1.0.5-nightly.1" }] };
  if (url.endsWith(`/releases/tags/android-v${version}`)) {
    return {
      kind: "json" as const,
      body: {
        tag_name: `android-v${version}`,
        draft: false,
        published_at: "2026-11-26T01:00:00Z",
        assets: [
          { name: `Ardia-${version}.apk`, state: "uploaded", browser_download_url: APK(version), ...(withDigest ? { digest: `sha256:${SHA}` } : {}) },
          { name: `Ardia-${version}.apk.sha256`, state: "uploaded", browser_download_url: `${APK(version)}.sha256` },
        ],
      },
    };
  }
  return { kind: "missing" as const };
};

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => Promise.resolve());
};

const foreground = async () => {
  await act(async () => stateListeners.forEach((listener) => listener("active")));
  await settle();
};

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  fetched.mockReset();
  checksum.mockReset();
  checksum.mockResolvedValue({ kind: "text", text: `${SHA}  Ardia-1.0.4.apk\n` });
  opened.mockClear();
  copied.mockClear();
  progressOf.mockReset();
  progressOf.mockResolvedValue(-1);
  handedOff.mockReset();
  handedOff.mockResolvedValue({ handoff: "notifications", id: "41" });
  statusOf.mockReset();
  statusOf.mockResolvedValue("running");
  verified.mockReset();
  verified.mockResolvedValue("verified");
  installed.mockReset();
  installed.mockResolvedValue({ result: "committed", session: "7" });
  notified.mockReset();
  notified.mockResolvedValue(true);
  discarded.mockReset();
  discarded.mockResolvedValue(true);
  canInstall.mockReset();
  canInstall.mockReturnValue(true);
  permission.mockReset();
  permission.mockResolvedValue(true);
  installedFile.mockReset();
  installedFile.mockResolvedValue("committed");
  installRequest.mockReset();
  installRequest.mockReturnValue(false);
  counted.mockClear();
  writePreference(browserDatabase(), "app_update_committed", null);
  appState = "active";
  withDigest = false;
  useAppUpdate.setState({ status: "idle", offer: null, handoff: null, progress: null, seenVersion: null });
  useToasts.setState({ toast: null });
  useSettingsNav.setState({ open: false, stack: [] });
  for (const key of [UPDATE_OFFERED_KEY, UPDATE_DOWNLOAD_KEY, UPDATE_SEEN_KEY, "app_update_unpublished"]) writePreference(browserDatabase(), key, null);
  writePreference(browserDatabase(), UPDATE_NEXT_CHECK_KEY, String(Date.now() + 3_600_000));
  startUpdateChecks();
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const pressRow = async (root: ReturnType<typeof renderSurface>, label: RegExp) => {
  const row = root.root.findAll((node) => typeof node.props.accessibilityLabel === "string" && label.test(node.props.accessibilityLabel) && typeof node.props.onPress === "function")[0]!;
  await act(async () => {
    row.props.onPress();
    await Promise.resolve();
  });
  await settle();
};

const offeredAbout = async () => {
  fetched.mockImplementation(publishedAnswers("1.0.4"));
  const root = renderSurface(<AboutPage />);
  await settle();
  await pressRow(root, /^Check for updates/);
  return root;
};

const AVAILABLE = /^Ardia 1\.0\.4 is available/;
const READY = /^Ardia 1\.0\.4 is ready to install/;
const READY_TITLE = "Ardia 1.0.4 is ready to install";

const noToast = () => expect(useToasts.getState().toast).toBeNull();

test("Check for updates sits in About only on Android release builds", () => {
  const root = renderSurface(<AboutPage />);
  if (releaseBuild) expect(textOf(root)).toContain("Check for updates");
  else expect(textOf(root)).not.toContain("Check for updates");
  unmount(root);
});

test("a newer release turns the row into its download, handed to the system's download manager, with no toast at any step", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  expect(fetched.mock.calls.map(([url]) => url)).toEqual(["https://api.github.com/repos/ardia-browser/ardia/git/matching-refs/tags/android-v", "https://api.github.com/repos/ardia-browser/ardia/releases/tags/android-v1.0.4"]);
  expect(textOf(root)).toContain("Ardia 1.0.4 is available");
  expect(textOf(root)).toContain("Download");
  noToast();
  await pressRow(root, AVAILABLE);
  expect(handedOff).toHaveBeenCalledWith(APK("1.0.4"), "Ardia 1.0.4");
  expect(counted).toHaveBeenCalledWith("app_update_offers_opened");
  expect(opened).not.toHaveBeenCalled();
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "41", offer: { version: "1.0.4" } });
  expect(textOf(root)).toContain("Downloading Ardia 1.0.4…");
  noToast();
  unmount(root);
});

test("while it downloads the row shows how far it got, read from the download manager every second", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  progressOf.mockResolvedValue(0.25);
  await pressRow(root, AVAILABLE);
  expect(progressOf).toHaveBeenCalledWith("41");
  expect(textOf(root)).toContain("25%");
  progressOf.mockResolvedValue(0.6);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await settle();
  expect(textOf(root)).toContain("60%");
  progressOf.mockResolvedValue(Number.NaN);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await settle();
  expect(textOf(root)).not.toContain("%");
  unmount(root);
});

const completeDownload = async () => {
  statusOf.mockResolvedValue("successful");
  await act(async () => completed({ id: "41" }));
  await settle();
};

test("when the download completes Ardia checks it against the release's SHA-256, the row offers Install, and one notification says it's ready, in front or not", async () => {
  if (!releaseBuild) return;
  for (const state of ["active", "background"]) {
    useAppUpdate.setState({ status: "idle", offer: null, handoff: null });
    writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, null);
    notified.mockClear();
    verified.mockClear();
    statusOf.mockResolvedValue("running");
    const root = await offeredAbout();
    await pressRow(root, AVAILABLE);
    appState = state;
    await completeDownload();
    appState = "active";
    expect(checksum).toHaveBeenCalledWith(`${APK("1.0.4")}.sha256`, expect.anything());
    expect(verified).toHaveBeenCalledWith("41", SHA, "Ardia-1.0.4.apk");
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledWith("Ardia-1.0.4.apk", READY_TITLE, "Tap to install.");
    expect(installed).not.toHaveBeenCalled();
    expect(textOf(root)).toContain(READY_TITLE);
    expect(textOf(root)).toContain("Install");
    noToast();
    await foreground();
    expect(notified).toHaveBeenCalledTimes(1);
    noToast();
    unmount(root);
  }
});

test("Install opens Android's installer on the checked copy and the row says to confirm there", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  await pressRow(root, READY);
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk", SHA, "41");
  expect(verified).toHaveBeenCalledTimes(1);
  expect(textOf(root)).toContain("Confirm in Android’s installer.");
  await act(async () => completed({ id: "99" }));
  await settle();
  expect(verified).toHaveBeenCalledTimes(1);
  noToast();
  unmount(root);
});

test("no notification is posted for an update that's only available", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  expect(notified).not.toHaveBeenCalled();
  unmount(root);
});

test("a download that doesn't match, or a release without a readable checksum, is deleted and never reaches the installer", async () => {
  if (!releaseBuild) return;
  for (const [answer, verifies] of [
    [{ kind: "text", text: `${SHA}  Ardia-1.0.4.apk\n` }, "mismatch"],
    [{ kind: "missing" }, "verified"],
    [{ kind: "text", text: "<html>Not Found</html>" }, "verified"],
    [{ kind: "text", text: `${SHA}  Ardia-1.0.5.apk\n` }, "verified"],
  ] as const) {
    useAppUpdate.setState({ status: "idle", offer: null, handoff: null });
    writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, null);
    checksum.mockResolvedValue(answer as never);
    verified.mockReset();
    verified.mockResolvedValue(verifies);
    discarded.mockClear();
    statusOf.mockResolvedValue("running");
    const root = await offeredAbout();
    await pressRow(root, AVAILABLE);
    await completeDownload();
    expect(verified.mock.calls.length).toBe(verifies === "mismatch" ? 1 : 0);
    expect(installed).not.toHaveBeenCalled();
    expect(notified).not.toHaveBeenCalled();
    expect(discarded).toHaveBeenCalledWith("41");
    expect(textOf(root)).toContain("The download didn’t match the release");
    expect(textOf(root)).toContain("Try again");
    expect(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY)).toBe("");
    noToast();
    unmount(root);
  }
});

test("no connection while checking the download keeps the file, and Try again checks it again", async () => {
  if (!releaseBuild) return;
  checksum.mockResolvedValue({ kind: "unreachable" });
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  expect(verified).not.toHaveBeenCalled();
  expect(discarded).not.toHaveBeenCalled();
  expect(textOf(root)).toContain("Couldn’t check the download");
  noToast();
  checksum.mockResolvedValue({ kind: "text", text: `${SHA}  Ardia-1.0.4.apk\n` });
  await pressRow(root, /^Couldn’t check the download/);
  expect(verified).toHaveBeenCalledWith("41", SHA, "Ardia-1.0.4.apk");
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk", SHA, "41");
  unmount(root);
});

test("round 3 P2: a copy that fails keeps the original download and its id, and Try again prepares and installs it", async () => {
  if (!releaseBuild) return;
  verified.mockResolvedValue("copy_failed");
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  expect(discarded).not.toHaveBeenCalled();
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "41" });
  expect(textOf(root)).toContain("Couldn’t prepare the update");
  noToast();
  verified.mockResolvedValue("verified");
  await pressRow(root, /^Couldn’t prepare the update/);
  expect(verified).toHaveBeenCalledTimes(2);
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk", SHA, "41");
  unmount(root);
});

test("when the checksum file can't be reached, GitHub's digest of the APK stands in", async () => {
  if (!releaseBuild) return;
  withDigest = true;
  checksum.mockResolvedValue({ kind: "unreachable" });
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  expect(verified).toHaveBeenCalledWith("41", SHA, "Ardia-1.0.4.apk");
  expect(discarded).not.toHaveBeenCalled();
  unmount(root);
});

test("a checksum file that disagrees with GitHub's digest deletes the download", async () => {
  if (!releaseBuild) return;
  withDigest = true;
  checksum.mockResolvedValue({ kind: "text", text: `${"0".repeat(64)}  Ardia-1.0.4.apk\n` });
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  expect(verified).not.toHaveBeenCalled();
  expect(discarded).toHaveBeenCalledWith("41");
  expect(textOf(root)).toContain("The download didn’t match the release");
  unmount(root);
});

test("without the install permission the row asks for it, opens its settings page, and installs when you come straight back with it allowed", async () => {
  if (!releaseBuild) return;
  canInstall.mockReturnValue(false);
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  await pressRow(root, READY);
  expect(permission).toHaveBeenCalledTimes(1);
  expect(textOf(root)).toContain("Allow Ardia to install apps");
  expect(textOf(root)).toContain("Open settings");
  noToast();
  canInstall.mockReturnValue(true);
  await foreground();
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk", SHA, "41");
  unmount(root);
});

test("round 3 P2: backing out of the permission page ends the resume; Open settings opens it again; allowing it later shows Install and waits for a tap", async () => {
  if (!releaseBuild) return;
  canInstall.mockReturnValue(false);
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  await pressRow(root, READY);
  expect(permission).toHaveBeenCalledTimes(1);
  await foreground();
  expect(installed).not.toHaveBeenCalled();
  expect(textOf(root)).toContain("Allow Ardia to install apps");
  await pressRow(root, /^Allow Ardia to install apps/);
  expect(permission).toHaveBeenCalledTimes(2);
  permission.mockResolvedValue(false);
  await pressRow(root, /^Allow Ardia to install apps/);
  canInstall.mockReturnValue(true);
  await foreground();
  expect(installed).not.toHaveBeenCalled();
  expect(textOf(root)).toContain(READY_TITLE);
  await pressRow(root, READY);
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk", SHA, "41");
  unmount(root);
});

test("round 3 P2: after a restart within the throttle, About reads the kept download and offers Install without a new GitHub check", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "41", offer: offerOf("1.0.4") }));
  statusOf.mockResolvedValue("successful");
  const root = renderSurface(<AboutPage />);
  await settle();
  expect(fetched).not.toHaveBeenCalled();
  expect(statusOf).toHaveBeenCalledWith("41");
  expect(textOf(root)).toContain(READY_TITLE);
  statusOf.mockResolvedValue("running");
  useAppUpdate.setState({ status: "idle", offer: null, handoff: null });
  unmount(root);
  const again = renderSurface(<AboutPage />);
  await settle();
  expect(textOf(again)).toContain("Downloading Ardia 1.0.4…");
  unmount(again);
});

test("a kept download that the installed version has caught up with is deleted", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "40", offer: offerOf("1.0.3") }));
  const root = renderSurface(<AboutPage />);
  await settle();
  expect(discarded).toHaveBeenCalledWith("40");
  expect(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY)).toBe("");
  expect(textOf(root)).toContain("Check for updates");
  unmount(root);
});

test("round 2 P2: a transfer that fails after enqueue doesn't leave About on Downloading, and Try again starts it again", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  expect(textOf(root)).toContain("Downloading Ardia 1.0.4…");
  statusOf.mockResolvedValue("failed");
  await foreground();
  expect(textOf(root)).not.toContain("Downloading Ardia");
  expect(textOf(root)).toContain("The download didn’t finish");
  expect(discarded).toHaveBeenCalledWith("41");
  handedOff.mockResolvedValue({ handoff: "notifications", id: "42" });
  statusOf.mockResolvedValue("running");
  await pressRow(root, /^The download didn’t finish/);
  expect(handedOff).toHaveBeenCalledTimes(2);
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "42", offer: { version: "1.0.4" } });
  unmount(root);
});

test("a download removed outside Ardia puts the row back to Download, and the row asks the download manager when it shows", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  unmount(root);
  statusOf.mockClear();
  statusOf.mockResolvedValue("gone");
  const again = renderSurface(<AboutPage />);
  await settle();
  expect(statusOf).toHaveBeenCalledWith("41");
  expect(textOf(again)).toContain("Ardia 1.0.4 is available");
  expect(textOf(again)).not.toContain("Downloading");
  unmount(again);
});

test("when nothing on the phone can download it, the row offers to copy the release page's link instead of a dead end", async () => {
  if (!releaseBuild) return;
  handedOff.mockResolvedValue({ handoff: "unavailable" });
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  expect(counted).toHaveBeenCalledWith("app_update_handoffs_failed");
  expect(textOf(root)).toContain("Couldn’t start the download");
  expect(textOf(root)).toContain("Copy link");
  noToast();
  await pressRow(root, /^Couldn’t start the download/);
  expect(copied).toHaveBeenCalledWith("https://github.com/ardia-browser/ardia/releases/tag/android-v1.0.4");
  unmount(root);
});

test("a rate limit or no connection says it couldn't check, and nothing opens", async () => {
  if (!releaseBuild) return;
  fetched.mockResolvedValue({ kind: "refused", retryAt: null });
  const root = renderSurface(<AboutPage />);
  await pressRow(root, /^Check for updates/);
  expect(textOf(root)).toContain("Couldn’t check for updates");
  fetched.mockResolvedValue({ kind: "json", body: [{ ref: "refs/tags/android-v1.0.3" }] });
  await pressRow(root, /^Couldn’t check for updates/);
  expect(textOf(root)).toContain("Ardia is up to date");
  expect(opened).not.toHaveBeenCalled();
  expect(handedOff).not.toHaveBeenCalled();
  noToast();
  unmount(root);
});

test("the download action hands off only this repo's exact APK and checksum addresses: hostile offers stop before the sink", async () => {
  if (!releaseBuild) return;
  const hostile: { id: string; value: unknown }[] = [
    { id: "lineBreak", value: `${APK("1.0.4")}\n` },
    { id: "javascript", value: "javascript:alert(1)" },
    { id: "intent", value: "intent://github.com/#Intent;scheme=https;end" },
    { id: "file", value: "file:///sdcard/Download/Ardia-1.0.4.apk" },
    { id: "prototype", value: "__proto__" },
    { id: "object", value: { toString: () => APK("1.0.4") } },
    { id: "number", value: 7 },
    { id: "null", value: null },
  ];
  for (const { id, value } of hostile) {
    for (const offer of [{ ...offerOf("1.0.4"), downloadUrl: value }, { ...offerOf("1.0.4"), version: value }, { ...offerOf("1.0.4"), checksumUrl: value }, { ...offerOf("1.0.4"), downloadUrl: `${APK("1.0.4")}${typeof value === "string" ? value : ""}` }]) {
      if (offer.downloadUrl === APK("1.0.4") && offer.version === "1.0.4" && offer.checksumUrl === `${APK("1.0.4")}.sha256`) continue;
      for (const handoff of [null, "unavailable"] as const) {
        act(() => useAppUpdate.setState({ status: "available", offer: offer as never, handoff }));
        await act(async () => openUpdate());
        expect([id, handedOff.mock.calls.length, opened.mock.calls.length, copied.mock.calls.length]).toEqual([id, 0, 0, 0]);
      }
    }
  }
  act(() => useAppUpdate.setState({ status: "available", offer: offerOf("1.0.4"), handoff: null }));
  await act(async () => openUpdate());
  expect(handedOff).toHaveBeenCalledTimes(1);
});

test("an APK Ardia downloaded opens through the same installer path, asking for the permission first when it's missing, on every Android build", async () => {
  if (Platform.OS !== "android") return;
  installedFile.mockResolvedValueOnce("needs_permission");
  await act(async () => installDownloadedPackage("content://media/external/downloads/7"));
  await settle();
  expect(permission).toHaveBeenCalledTimes(1);
  expect(installedFile).toHaveBeenCalledTimes(1);
  canInstall.mockReturnValue(true);
  await foreground();
  expect(installedFile).toHaveBeenCalledTimes(2);
  expect(installedFile).toHaveBeenLastCalledWith("content://media/external/downloads/7");
});

test("the launch check waits for the front, then finds the update quietly: no toast, the dot's offer is counted once per version, and seeing About keeps it away", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_NEXT_CHECK_KEY, null);
  fetched.mockImplementation(publishedAnswers("1.0.4"));
  appState = "background";
  await act(async () => {
    jest.advanceTimersByTime(20_000);
  });
  await settle();
  expect(fetched).not.toHaveBeenCalled();
  appState = "active";
  await foreground();
  expect(fetched).toHaveBeenCalled();
  expect(useAppUpdate.getState()).toMatchObject({ status: "available", offer: { version: "1.0.4" }, seenVersion: null });
  noToast();
  expect(notified).not.toHaveBeenCalled();
  expect(counted.mock.calls.filter(([name]) => name === "app_update_offers_shown")).toHaveLength(1);
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_OFFERED_KEY) ?? "[]")).toEqual(["1.0.4"]);
  writePreference(browserDatabase(), UPDATE_NEXT_CHECK_KEY, null);
  await foreground();
  expect(counted.mock.calls.filter(([name]) => name === "app_update_offers_shown")).toHaveLength(1);
  const root = renderSurface(<AboutPage />);
  await settle();
  expect(useAppUpdate.getState().seenVersion).toBe("1.0.4");
  expect(readPreference(browserDatabase(), UPDATE_SEEN_KEY)).toBe("1.0.4");
  unmount(root);
});

test("a check run from About never counts a dot that couldn't show", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  expect(counted).not.toHaveBeenCalledWith("app_update_offers_shown");
  expect(useAppUpdate.getState().seenVersion).toBe("1.0.4");
  unmount(root);
});

test("an unanswered check clears an older deadline, so the next launch tries again", async () => {
  if (!releaseBuild) return;
  fetched.mockResolvedValue({ kind: "unreachable" });
  const root = renderSurface(<AboutPage />);
  await pressRow(root, /^Check for updates/);
  expect(textOf(root)).toContain("Couldn’t check for updates");
  expect(readPreference(browserDatabase(), UPDATE_NEXT_CHECK_KEY)).toBe("");
  unmount(root);
});

test("cleaning up a failed download never clears a newer download that replaced it meanwhile", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  statusOf.mockResolvedValue("failed");
  discarded.mockImplementation(async () => {
    writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "42", offer: offerOf("1.0.4") }));
    return true;
  });
  await foreground();
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "42", offer: { version: "1.0.4" } });
  unmount(root);
});

test("round 4 P1: Install hands the checked copy and its SHA-256 to Android's session installer, and the row follows what the installer reports", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  await pressRow(root, READY);
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk", SHA, "41");
  expect(textOf(root)).toContain("Confirm in Android’s installer.");
  await act(async () => installStatusEvent({ kind: "update", status: "confirming", session: "7", download: "41" }));
  expect(textOf(root)).toContain("Confirm in Android’s installer.");
  await act(async () => installStatusEvent({ kind: "update", status: "aborted", session: "7", download: "41" }));
  await settle();
  expect(textOf(root)).toContain(READY_TITLE);
  expect(textOf(root)).not.toContain("Confirm in Android’s installer.");
  await pressRow(root, READY);
  expect(installed).toHaveBeenCalledTimes(2);
  await act(async () => installStatusEvent({ kind: "update", status: "failure", session: "7", download: "41" }));
  await settle();
  expect(textOf(root)).toContain("Couldn’t install the update");
  noToast();
  for (const bad of [null, "failure", { kind: "update" }, { kind: "x", status: "failure", session: "7", download: "41" }, { kind: "update", status: "done", session: "7", download: "41" }, { kind: "update", status: "failure" }]) await act(async () => installStatusEvent(bad));
  installed.mockResolvedValueOnce("mismatch");
  await pressRow(root, /^Couldn’t install the update/);
  expect(discarded).toHaveBeenCalledWith("41");
  expect(textOf(root)).toContain("The download didn’t match the release");
  unmount(root);
});

test("round 4 P1: tapping the ready notification opens About and installs the checked copy, once per token", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  appState = "background";
  await completeDownload();
  expect(notified).toHaveBeenCalled();
  unmount(root);
  installRequest.mockReturnValueOnce(true);
  appState = "active";
  await foreground();
  expect(useSettingsNav.getState()).toMatchObject({ open: true, stack: [{ page: "root" }, { page: "about" }] });
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk", SHA, "41");
  noToast();
  installRequest.mockReturnValueOnce(false);
  await foreground();
  expect(installed).toHaveBeenCalledTimes(1);
});

test("round 4 P2: a download that finished while Ardia was gone is checked when Ardia comes back, and its notification is posted once", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "51", offer: offerOf("1.0.4") }));
  statusOf.mockResolvedValue("successful");
  const root = renderSurface(<AboutPage />);
  await settle();
  expect(fetched).not.toHaveBeenCalled();
  expect(verified).toHaveBeenCalledWith("51", SHA, "Ardia-1.0.4.apk");
  expect(notified).toHaveBeenCalledTimes(1);
  expect(textOf(root)).toContain(READY_TITLE);
  noToast();
  await foreground();
  expect(verified).toHaveBeenCalledTimes(1);
  expect(notified).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("a download that finishes while Android's notification prompt is still open posts its notification once the prompt is answered", async () => {
  if (!releaseBuild) return;
  notified.mockResolvedValue(false);
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  expect(notified).toHaveBeenCalledTimes(1);
  notified.mockResolvedValue(true);
  await foreground();
  expect(notified).toHaveBeenCalledTimes(2);
  await foreground();
  expect(notified).toHaveBeenCalledTimes(2);
  expect(textOf(root)).toContain(READY_TITLE);
  unmount(root);
});

test("round 4 P2: with notifications or the App updates channel off, the row still holds Install and nothing else pops up", async () => {
  if (!releaseBuild) return;
  notified.mockResolvedValue(false);
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  appState = "background";
  await completeDownload();
  appState = "active";
  await foreground();
  noToast();
  expect(textOf(root)).toContain(READY_TITLE);
  unmount(root);
});

test("round 4 P2: a check that finishes after a newer download replaced its own never touches the newer one", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  verified.mockImplementation(async () => {
    writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "42", offer: offerOf("1.0.4") }));
    return "mismatch";
  });
  await completeDownload();
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "42" });
  expect(textOf(root)).not.toContain("didn’t match the release");
  expect(installed).not.toHaveBeenCalled();
  unmount(root);
});

test("round 5: a late result from an older install session never touches the newer one, and the newer session's own result is applied", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, AVAILABLE);
  await completeDownload();
  await pressRow(root, READY);
  expect(textOf(root)).toContain("Confirm in Android’s installer.");
  installed.mockResolvedValueOnce({ result: "committed", session: "8" });
  await pressRow(root, READY);
  await act(async () => installStatusEvent({ kind: "update", status: "aborted", session: "7", download: "41" }));
  await settle();
  expect(textOf(root)).toContain("Confirm in Android’s installer.");
  expect(counted).not.toHaveBeenCalledWith("app_update_installs_cancelled");
  await act(async () => installStatusEvent({ kind: "update", status: "failure", session: "8", download: "99" }));
  await settle();
  expect(textOf(root)).toContain("Confirm in Android’s installer.");
  await act(async () => installStatusEvent({ kind: "update", status: "failure", session: "8", download: "41" }));
  await settle();
  expect(textOf(root)).toContain("Couldn’t install the update");
  expect(counted).toHaveBeenCalledWith("app_update_installs_failed");
  unmount(root);
});

test("round 5: a finished install is counted only when the new version matches a session Ardia committed", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "60", offer: offerOf("1.0.3") }));
  let root = renderSurface(<AboutPage />);
  await settle();
  expect(counted).not.toHaveBeenCalledWith("app_update_installs_completed");
  unmount(root);
  writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "61", offer: offerOf("1.0.3") }));
  writePreference(browserDatabase(), "app_update_committed", JSON.stringify({ version: "1.0.3", session: "9" }));
  root = renderSurface(<AboutPage />);
  await settle();
  expect(counted).toHaveBeenCalledWith("app_update_installs_completed");
  expect(readPreference(browserDatabase(), "app_update_committed")).toBe("");
  unmount(root);
});
