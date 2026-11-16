import type { UpdateChannel, UpdaterState } from "../../../packages/shell/src/updater";
import type { ArdiaHost } from "./host";
import { hostSupports, invokeHost } from "./host.ts";
import { hostLaunchConfig } from "./hostLaunchConfig.ts";
import { channelOf, compareVersions, isAppVersion, linuxReleases, newestRelease, type Release } from "./updateReleases.ts";
import { noteUpdateCheck, noteUpdatePageOpened } from "../../browser/src/state/telemetry/updateCounts.ts";

export const UPDATE_METHODS = ["updaterState", "checkForUpdates", "setAutomaticUpdateChecks", "setAutomaticUpdateDownloads", "setUpdateChannel"] as const;
export const RELEASES_METHOD = "ArdiaUpdates.releases";
export const KILL_SWITCHES_METHOD = "ArdiaShell.fetchKillSwitches";
export const UPDATE_PREFERENCES = "linux-updates.json";
export const RELEASES_PAGE = "https://github.com/ardia-browser/ardia/releases";
export const FIRST_CHECK_AFTER_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_LOCK = "ardia.linux.update-checks";

type Preferences = { automaticChecks: boolean; lastCheck: number | null; channel: UpdateChannel | null; notified: string | null };
type Fetched = { status: number; body: string };
type SwitchCheck = NonNullable<Extract<UpdaterState, { available: true }>["switchCheck"]>;

export type UpdateDeps = {
  host: ArdiaHost;
  appVersion: () => string | null;
  read: (name: string) => string | null;
  write: (name: string, contents: string) => unknown;
  refresh?: (name: string) => Promise<unknown>;
  ask: (release: Release, current: string) => Promise<boolean>;
  tell: (title: string, message: string) => Promise<void>;
  offer: (release: Release) => void;
  open: (url: string) => void;
  now?: () => number;
};

const DEFAULTS: Preferences = { automaticChecks: true, lastCheck: null, channel: null, notified: null };

function readPreferences(read: UpdateDeps["read"]): Preferences {
  try {
    const saved = JSON.parse(read(UPDATE_PREFERENCES) ?? "null") as Partial<Preferences> | null;
    if (!saved || typeof saved !== "object") return { ...DEFAULTS };
    return {
      automaticChecks: typeof saved.automaticChecks === "boolean" ? saved.automaticChecks : true,
      lastCheck: typeof saved.lastCheck === "number" ? saved.lastCheck : null,
      channel: saved.channel === "stable" || saved.channel === "nightly" ? saved.channel : null,
      notified: typeof saved.notified === "string" ? saved.notified : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function linuxUpdater(deps: UpdateDeps) {
  const now = deps.now ?? Date.now;
  let checking = false;
  let switchCheck: SwitchCheck | null = null;
  const preferences = async () => {
    await deps.refresh?.(UPDATE_PREFERENCES).catch(() => {});
    return readPreferences(deps.read);
  };
  const remember = async (patch: Partial<Preferences>) => {
    await deps.write(UPDATE_PREFERENCES, JSON.stringify({ ...(await preferences()), ...patch }));
  };
  const version = () => {
    const current = deps.appVersion();
    return isAppVersion(current) ? current : null;
  };
  const channel = (saved: Preferences, current: string | null): UpdateChannel => saved.channel ?? (current ? channelOf(current) : "stable");

  async function newest(wanted: UpdateChannel): Promise<Release | null> {
    const fetched = await invokeHost<Fetched>(RELEASES_METHOD, { args: [] }, deps.host);
    if (!fetched || fetched.status !== 200 || typeof fetched.body !== "string") throw new Error(`GitHub answered ${fetched?.status ?? 0}`);
    return newestRelease(linuxReleases(fetched.body), wanted);
  }

  async function check(asked: boolean): Promise<void> {
    const current = version();
    if (checking || !current) return;
    checking = true;
    let wanted: UpdateChannel = channelOf(current);
    try {
      const saved = await preferences();
      if (!asked && !saved.automaticChecks) return;
      wanted = channel(saved, current);
      switchCheck = { phase: "checking", channel: wanted };
      const release = await newest(wanted);
      await remember({ lastCheck: now() });
      const newer = !!release && compareVersions(release.version, current) > 0;
      noteUpdateCheck(asked, newer ? "found" : "upToDate");
      switchCheck = newer ? { phase: "found", channel: wanted, version: release!.version } : { phase: "upToDate", channel: wanted };
      if (!newer) {
        if (asked) await deps.tell("Ardia is up to date", `You have Ardia ${current}, the newest ${wanted === "nightly" ? "Nightly" : "Stable"} build for Linux.`);
        return;
      }
      if (asked) {
        if (await deps.ask(release!, current)) {
          noteUpdatePageOpened();
          deps.open(release!.url);
        }
        return;
      }
      if ((await preferences()).notified === release!.version) return;
      await remember({ notified: release!.version });
      deps.offer(release!);
    } catch (error) {
      noteUpdateCheck(asked, "failed");
      switchCheck = { phase: "failed", channel: wanted };
      console.info(`[ardia linux] the update check failed: ${String(error)}`);
      if (asked) await deps.tell("Ardia couldn't check for updates", `Try again later, or see ${RELEASES_PAGE}.`);
    } finally {
      checking = false;
    }
  }

  const methods = {
    updaterState: async (): Promise<UpdaterState> => {
      const current = version();
      const saved = await preferences();
      return {
        available: true,
        configured: !!current,
        automaticChecks: saved.automaticChecks,
        automaticDownloads: false,
        canCheck: !checking,
        sessionInProgress: checking,
        feedURL: RELEASES_PAGE,
        lastCheck: saved.lastCheck,
        version: current ?? deps.appVersion() ?? "",
        channel: channel(saved, current),
        buildChannel: current ? channelOf(current) : "stable",
        switchCheck,
      };
    },
    checkForUpdates: () => check(true),
    setAutomaticUpdateChecks: async (on: unknown) => remember({ automaticChecks: on === true }),
    setAutomaticUpdateDownloads: async () => {},
    setUpdateChannel: async (next: unknown) => {
      await remember({ channel: next === "nightly" ? "nightly" : "stable", notified: null });
      await check(true);
    },
  };

  const checksByItself = async () => {
    const launch = hostLaunchConfig(deps.host);
    return !!version() && !launch.background && !launch.isolated && (await preferences()).automaticChecks;
  };

  return { methods, check, checksByItself };
}

export type LinuxUpdater = ReturnType<typeof linuxUpdater>;

export function scheduleUpdateChecks(updater: LinuxUpdater, options: { locks?: { request(name: string, callback: () => Promise<void>): Promise<unknown> }; timers?: { setTimeout: typeof setTimeout; setInterval: typeof setInterval } }) {
  const timers = options.timers ?? globalThis;
  const run = () => void updater.checksByItself().then((checks) => {
    if (checks) return updater.check(false);
  });
  const lead = () => new Promise<void>(() => {
    timers.setTimeout(run, FIRST_CHECK_AFTER_MS);
    timers.setInterval(run, CHECK_EVERY_MS);
  });
  if (!options.locks) return;
  void options.locks.request(UPDATE_CHECK_LOCK, lead).catch(() => {});
}

export const updatesAvailable = (host: ArdiaHost) => hostSupports(RELEASES_METHOD, host);
export const killSwitchesAvailable = (host: ArdiaHost) => hostSupports(KILL_SWITCHES_METHOD, host);

export function linuxSwitchesFetch(host: ArdiaHost, original: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://ardia.dev/switches.json") return original(input, init);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const fetched = await invokeHost<Fetched>(KILL_SWITCHES_METHOD, { args: [] }, host);
    if (!fetched || !fetched.status || typeof fetched.body !== "string") throw new TypeError("Failed to fetch");
    return new Response(fetched.body, { status: fetched.status });
  };
}
