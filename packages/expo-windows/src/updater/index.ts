import { TurboModuleRegistry, type TurboModule } from "react-native";
import type { AppNative, ConfirmOptions, DialogsNative, DocumentsNative, UpdateChannel, UpdaterNative, UpdaterState } from "@ardia/shell";
import type { AppWindowsModule, WindowsUpdateConstants, WindowsUpdateModule } from "../nativeModuleTypes";
import { failureText, folderOf, megabytes, parseVerifiedUpdate, readBuild, type BuildIdentity } from "./manifest";
import { windowsUpdateCounts } from "./counts";

const PUBLISHED_UNDER = "https://github.com/ardia-browser/ardia/releases/download/";
const FEED = `${PUBLISHED_UNDER}windows-alpha/windows-update.json`;
const PREFERENCES = "windows-updates.json";
const FIRST_CHECK_AFTER_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type Preferences = Pick<Extract<UpdaterState, { available: true }>, "automaticChecks" | "automaticDownloads" | "lastCheck">;

const native = () => TurboModuleRegistry.get<WindowsUpdateModule>("ArdiaWindowsUpdate");
const constants = (): WindowsUpdateConstants => native()?.getConstants?.() ?? {};
const dialogs = () => TurboModuleRegistry.get<TurboModule & Pick<DialogsNative, "confirm">>("ArdiaDialogs");
const documents = () => TurboModuleRegistry.get<TurboModule & Pick<DocumentsNative, "readDocument" | "writeDocument">>("ArdiaDocuments");
const launch = () => TurboModuleRegistry.get<TurboModule & Pick<AppNative, "launchConfig">>("ArdiaApp")?.launchConfig?.();

let identityRead: BuildIdentity | null | undefined;
let preferencesRead: Preferences | undefined;
let checking = false;
let declinedBuild = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let firstCheck: ReturnType<typeof setTimeout> | undefined;

function identity(): BuildIdentity | null {
  if (identityRead === undefined) identityRead = typeof constants().buildFile === "string" ? readBuild(constants().buildFile as string) : null;
  return identityRead;
}

export function stampedSystemInfo(info: unknown): unknown {
  const stamped = identity();
  if (!stamped || typeof info !== "object" || info === null) return info;
  return { ...info, appVersion: stamped.version, appBuild: String(stamped.build) };
}

const feedOverride = () => (typeof constants().feedOverride === "string" ? (constants().feedOverride as string) : "");
const feed = () => feedOverride() || FEED;
const publishedUnder = () => (feedOverride() ? folderOf(feedOverride()) : PUBLISHED_UNDER);
const configured = () => !!native() && constants().installed === true && identity() !== null;
const named = (version: string, build: number) => `${version}, Windows alpha ${build}`;

function preferences(): Preferences {
  if (preferencesRead) return preferencesRead;
  const fresh: Preferences = { automaticChecks: true, automaticDownloads: true, lastCheck: null };
  try {
    const stored: unknown = JSON.parse(documents()?.readDocument(PREFERENCES) ?? "null");
    if (typeof stored === "object" && stored !== null) {
      const { automaticChecks, automaticDownloads, lastCheck } = stored as Record<string, unknown>;
      if (typeof automaticChecks === "boolean") fresh.automaticChecks = automaticChecks;
      if (typeof automaticDownloads === "boolean") fresh.automaticDownloads = automaticDownloads;
      if (typeof lastCheck === "number" && Number.isFinite(lastCheck)) fresh.lastCheck = lastCheck;
    }
  } catch {}
  preferencesRead = fresh;
  return fresh;
}

function remember(patch: Partial<Preferences>) {
  preferencesRead = { ...preferences(), ...patch };
  try {
    documents()?.writeDocument(PREFERENCES, JSON.stringify(preferencesRead));
  } catch {}
}

function checksByItself() {
  if (!configured() || !preferences().automaticChecks) return false;
  const config = launch();
  return !config?.background && !(config?.isolated && !feedOverride());
}

const ask = async (options: ConfirmOptions) => (await dialogs()?.confirm(options))?.confirmed === true;
const tell = (title: string, message: string) => ask({ title, message, confirmTitle: "OK", cancelTitle: "" });
const reason = (error: unknown) => failureText(error);

async function check(asked: boolean) {
  const current = identity();
  const update = native();
  if (checking || !update || !current || !configured()) return;
  if (!asked && !checksByItself()) return;
  checking = true;
  const startedEpoch = windowsUpdateCounts.consentEpoch();
  try {
    if (typeof update.fetchVerifiedManifest !== "function") {
      windowsUpdateCounts.note("verifier", startedEpoch);
      throw new Error("the update verifier is not available");
    }
    let rawAnswer: string;
    try {
      rawAnswer = await update.fetchVerifiedManifest(feed(), current.build);
    } catch (error) {
      windowsUpdateCounts.note("network", startedEpoch);
      throw error;
    }
    const verified = parseVerifiedUpdate(rawAnswer, publishedUnder(), current.build);
    if (verified.status === "notPublished") {
      if (feedOverride()) {
        windowsUpdateCounts.note("network", startedEpoch);
        throw new Error("the server answered 404");
      }
      console.info("[ardia windows] update check failed: the server answered 404");
      const keepsChecking = checksByItself() ? " Ardia keeps checking by itself." : "";
      if (asked) await tell("No Windows update published yet", `No Windows build of Ardia has been published for updates yet. You have ${named(current.version, current.build)}.${keepsChecking}`);
      return;
    }
    if (verified.status === "failed") {
      windowsUpdateCounts.note(verified.reason, startedEpoch);
      throw new Error(verified.message);
    }
    windowsUpdateCounts.note("verified", startedEpoch);
    remember({ lastCheck: Date.now() });
    if (verified.status === "upToDate") {
      if (asked) await tell("Ardia is up to date", `You have ${named(current.version, current.build)}.`);
      return;
    }
    const { installer } = verified;
    if (!asked && declinedBuild === verified.build) return;
    const newer = named(verified.version, verified.build);
    if (asked || !preferences().automaticDownloads) {
      const download = await ask({
        title: "A newer Ardia is available",
        message: `${newer} is available. You have ${named(current.version, current.build)}. Download it now (${megabytes(installer.bytes)} MB)?`,
        confirmTitle: "Download",
        cancelTitle: "Later",
      });
      if (!download) {
        declinedBuild = verified.build;
        return;
      }
    }
    const path = await update.download(installer.url, installer.sha256, installer.bytes);
    console.info(`[ardia windows] update ${verified.build} downloaded`);
    const install = await ask({
      title: "The update is ready to install",
      message: `Ardia closes, installs ${newer} and opens again.`,
      confirmTitle: "Install and Restart",
      cancelTitle: "Later",
    });
    if (!install) {
      declinedBuild = verified.build;
      return;
    }
    if (await update.install(path, installer.sha256)) {
      console.info(`[ardia windows] update ${verified.build} is installing`);
      await TurboModuleRegistry.get<TurboModule & Pick<AppWindowsModule, "quit">>("ArdiaAppWindows")?.quit();
    }
  } catch (error) {
    console.info(`[ardia windows] update check failed: ${reason(error)}`);
    if (asked) await tell("Ardia couldn't check for updates", reason(error));
  } finally {
    checking = false;
  }
}

function schedule() {
  if (timer !== undefined) clearInterval(timer);
  if (firstCheck !== undefined) clearTimeout(firstCheck);
  timer = undefined;
  firstCheck = undefined;
  if (checksByItself()) timer = setInterval(() => void check(false), CHECK_EVERY_MS);
}

export function startUpdateChecks() {
  schedule();
  if (timer !== undefined) firstCheck = setTimeout(() => void check(false), FIRST_CHECK_AFTER_MS);
}

export const windowsUpdater: UpdaterNative = {
  async updaterState(): Promise<UpdaterState> {
    if (!native()) return { available: false };
    const current = identity();
    const ready = configured();
    return {
      available: true,
      configured: ready,
      automaticChecks: preferences().automaticChecks,
      automaticDownloads: preferences().automaticDownloads,
      canCheck: ready,
      sessionInProgress: checking,
      feedURL: ready ? feed() : null,
      lastCheck: preferences().lastCheck,
      version: current?.version ?? "0.0.0",
      ...(current ? { displayVersion: named(current.version, current.build) } : {}),
    };
  },
  checkForUpdates: () => check(true),
  async setAutomaticUpdateChecks(on: boolean) {
    remember({ automaticChecks: on });
    schedule();
  },
  async setAutomaticUpdateDownloads(on: boolean) {
    remember({ automaticDownloads: on });
  },
  async setUpdateChannel(_channel: UpdateChannel) {},
};
