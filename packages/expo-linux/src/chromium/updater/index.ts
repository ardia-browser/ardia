import { APP_VERSION, RELEASES_PAGE, UPDATE_REPOSITORY } from "../build";
import { callMain, callMainSync } from "../../bridge";
import { compareVersions, newestOf, type Channel, type Release } from "./versions";

type Preferences = { automaticChecks: boolean; lastCheck: number | null; channel: Channel | null; declined: string | null };
type Confirmed = { confirmed?: boolean } | boolean | null | undefined;
type LaunchFacts = { background?: boolean; isolated?: boolean };
type SystemFacts = { inApplicationsFolder?: boolean };

const PREFERENCES = "linux-updates.json";
const FIRST_CHECK_AFTER_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const buildChannel = (): Channel => (/nightly/.test(APP_VERSION) ? "nightly" : "stable");

let preferencesRead: Preferences | null = null;
let checking = false;
let timer: ReturnType<typeof setInterval> | undefined;
let firstCheck: ReturnType<typeof setTimeout> | undefined;

function preferences(): Preferences {
  if (preferencesRead) return preferencesRead;
  const fresh: Preferences = { automaticChecks: true, lastCheck: null, channel: null, declined: null };
  try {
    const text = callMainSync<string | null>("ArdiaDocuments", "readDocument", PREFERENCES);
    if (text) Object.assign(fresh, JSON.parse(text));
  } catch {}
  return (preferencesRead = fresh);
}

function remember(patch: Partial<Preferences>): void {
  preferencesRead = { ...preferences(), ...patch };
  callMainSync("ArdiaDocuments", "writeDocument", PREFERENCES, JSON.stringify(preferencesRead));
}

const channel = () => preferences().channel ?? buildChannel();

async function newestRelease(): Promise<Release | null> {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return newestOf((await response.json()) as Release[], channel());
}

async function confirmWithUser(options: { title: string; message: string; confirmTitle: string; cancelTitle: string }): Promise<boolean> {
  const answer = await callMain<Confirmed>("ArdiaDialogs", "confirm", options).catch(() => null);
  return typeof answer === "boolean" ? answer : !!answer?.confirmed;
}

const note = (line: string) => console.info(`[ardia updater] ${line}`);

async function check(asked: boolean): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const release = await newestRelease();
    remember({ lastCheck: Date.now() });
    const version = release?.tag_name.replace(/^(linux-)?v/, "") ?? null;
    if (!release || !version || compareVersions(version, APP_VERSION) <= 0) {
      if (asked) await confirmWithUser({ title: "Ardia is up to date", message: `You have Ardia ${APP_VERSION}. Linux builds come from ${RELEASES_PAGE}.`, confirmTitle: "OK", cancelTitle: "" });
      return;
    }
    if (!asked && preferences().declined === version) return;
    const open = await confirmWithUser({
      title: "A newer Ardia is available",
      message: `Ardia ${version} is available. You have ${APP_VERSION}. Ardia on Linux doesn't update itself yet: download the AppImage or .deb from the release page.`,
      confirmTitle: "Open Release Page",
      cancelTitle: "Later",
    });
    if (open) await callMain("ArdiaApp", "openExternalURL", release.html_url);
    else remember({ declined: version });
  } catch (error) {
    note(`the update check failed: ${String(error)}`);
    if (asked) await confirmWithUser({ title: "Ardia couldn't check for updates", message: String(error instanceof Error ? error.message : error), confirmTitle: "OK", cancelTitle: "" });
  } finally {
    checking = false;
  }
}

const packaged = () => callMainSync<SystemFacts>("ArdiaApp", "systemInfo")?.inApplicationsFolder === true;

function checksByItself(): boolean {
  const launch = callMainSync<LaunchFacts>("ArdiaApp", "launchConfig") ?? {};
  return packaged() && preferences().automaticChecks && !launch.background && !launch.isolated;
}

function schedule(): void {
  clearInterval(timer);
  clearTimeout(firstCheck);
  timer = undefined;
  if (!checksByItself()) return;
  timer = setInterval(() => void check(false), CHECK_EVERY_MS);
  firstCheck = setTimeout(() => void check(false), FIRST_CHECK_AFTER_MS);
}

let scheduled = false;

export function startUpdater() {
  if (scheduled) return;
  scheduled = true;
  schedule();
}

export const updaterModules: Record<string, Record<string, unknown>> = {
  ArdiaUpdater: {
    updaterState: async () => ({
      available: true,
      configured: packaged(),
      automaticChecks: preferences().automaticChecks,
      automaticDownloads: false,
      canCheck: !checking,
      sessionInProgress: checking,
      feedURL: RELEASES_PAGE,
      lastCheck: preferences().lastCheck,
      version: APP_VERSION,
      displayVersion: APP_VERSION,
      channel: channel(),
      buildChannel: buildChannel(),
      switchCheck: null,
    }),
    checkForUpdates: async () => void check(true),
    setAutomaticUpdateChecks: async (on: boolean) => {
      remember({ automaticChecks: !!on });
      schedule();
    },
    setAutomaticUpdateDownloads: async () => {},
    setUpdateChannel: async (next: Channel) => remember({ channel: next === "nightly" ? "nightly" : "stable", declined: null }),
  },
};
