import type { UpdateChannel, UpdaterState } from "../../../packages/shell/src/updater";
import type { ArdiaHost } from "./host";
import { hostSupports, invokeHost } from "./host.ts";
import { SELF_UPDATE_METHODS } from "./hostCapabilities.ts";
import { hostLaunchConfig } from "./hostLaunchConfig.ts";
import { channelOf, compareVersions, isAppVersion, linuxReleases, newestRelease, type Release } from "./updateReleases.ts";
import {
  UPDATE_INSTALL_FAILURES,
  UPDATE_DOWNLOAD_FAILURES,
  noteUpdateCheck,
  noteUpdateDownloadFailed,
  noteUpdateDownloadFinished,
  noteUpdateDownloadStarted,
  noteUpdateInstallFailed,
  noteUpdateInstalled,
  noteUpdatePageOpened,
  noteUpdateRestart,
  type UpdateInstallKind,
} from "../../browser/src/state/telemetry/updateCounts.ts";
import { consentToken, type ConsentToken } from "../../browser/src/state/telemetry/consentPeriod";

export const UPDATE_METHODS = ["updaterState", "checkForUpdates", "setAutomaticUpdateChecks", "setAutomaticUpdateDownloads", "setUpdateChannel"] as const;
export const RELEASES_METHOD = "ArdiaUpdates.releases";
export const [, UPDATE_METHOD, STATUS_METHOD, CLAIM_METHOD, RESTART_METHOD] = SELF_UPDATE_METHODS;
export const KILL_SWITCHES_METHOD = "ArdiaShell.fetchKillSwitches";
export const UPDATE_PREFERENCES = "linux-updates.json";
export const RELEASES_PAGE = "https://github.com/ardia-browser/ardia/releases";
export const FIRST_CHECK_AFTER_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const WATCH_EVERY_MS = 30_000;
export const FOLLOW_RUN_EVERY_MS = 2_000;
export const FOLLOW_RUN_FOR_MS = 75 * 60 * 1000;
export const UPDATE_CHECK_LOCK = "ardia.linux.update-checks";
export const UPDATE_PREFERENCES_LOCK = "ardia.linux.update-preferences";
export const AUR_UPDATE_COMMAND = "yay -Syu ardia-bin";

export type InstallKind = UpdateInstallKind | "managed" | "unsupported";
type Phase = "idle" | "downloading" | "installing" | "ready" | "failed";
export type EngineStatus = { phase: Phase; version: string | null; reason: string | null; kind: InstallKind; run: number };
type Preferences = { automaticChecks: boolean; automaticDownloads: boolean; lastCheck: number | null; channel: UpdateChannel | null; notified: string | null; failed: string | null };
type Fetched = { status: number; body: string };
type SwitchCheck = NonNullable<Extract<UpdaterState, { available: true }>["switchCheck"]>;
type StartedFrom = "asked" | "automatic" | "accepted";
type OwnRun = { release: Release; from: StartedFrom };

export type UpdateLocks = { request(name: string, callback: () => Promise<unknown>): Promise<unknown> };

export type UpdateDeps = {
  host: ArdiaHost;
  appVersion: () => string | null;
  read: (name: string) => string | null;
  write: (name: string, contents: string) => unknown;
  refresh?: (name: string) => Promise<unknown>;
  ask: (release: Release, current: string, failed: boolean) => Promise<boolean>;
  tell: (title: string, message: string) => Promise<void>;
  offer: (release: Release, failed: boolean) => void;
  offerInstall: (release: Release, install: () => void) => void;
  ready: (version: string, restart: () => void) => void;
  managed: (release: Release, current: string, asked: boolean) => Promise<void>;
  open: (url: string) => void;
  showsToasts?: boolean;
  locks?: UpdateLocks;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULTS: Preferences = { automaticChecks: true, automaticDownloads: true, lastCheck: null, channel: null, notified: null, failed: null };
const INSTALLABLE: ReadonlySet<string> = new Set<UpdateInstallKind>(["deb", "tarball", "appimage"]);
const PHASES: ReadonlySet<string> = new Set<Phase>(["idle", "downloading", "installing", "ready", "failed"]);
const ONLY_INSTALL_FAILURES: ReadonlySet<string> = new Set(UPDATE_INSTALL_FAILURES.filter((reason) => !(UPDATE_DOWNLOAD_FAILURES as readonly string[]).includes(reason)));

export const installs = (kind: InstallKind | null | undefined): kind is UpdateInstallKind => !!kind && INSTALLABLE.has(kind);
export const updateBusy = (status: EngineStatus | null | undefined) => status?.phase === "downloading" || status?.phase === "installing";
const finished = (status: EngineStatus) => status.run > 0 && (status.phase === "ready" || status.phase === "failed");

export function readInstallKind(line: unknown): InstallKind {
  return line === "managed" || (typeof line === "string" && INSTALLABLE.has(line)) ? (line as InstallKind) : "unsupported";
}

export function readEngineStatus(answer: unknown): EngineStatus | null {
  if (!answer || typeof answer !== "object") return null;
  const { phase, version, reason, kind, run } = answer as Record<string, unknown>;
  if (typeof phase !== "string" || !PHASES.has(phase) || typeof run !== "number" || !Number.isSafeInteger(run) || run < 0) return null;
  return { phase: phase as Phase, version: isAppVersion(version) ? version : null, reason: typeof reason === "string" ? reason : null, kind: readInstallKind(kind), run };
}

const knownKinds = new WeakMap<ArdiaHost, InstallKind>();
export const installsUpdates = (host: ArdiaHost | undefined) => !!host && installs(knownKinds.get(host));
export const selfUpdateAvailable = (host: ArdiaHost) => SELF_UPDATE_METHODS.every((method) => hostSupports(method, host));
const releasePage = (version: string): Release => ({ version, url: `${RELEASES_PAGE}/tag/v${version}`, prerelease: channelOf(version) === "nightly" });

function readPreferences(read: UpdateDeps["read"]): Preferences {
  try {
    const saved = JSON.parse(read(UPDATE_PREFERENCES) ?? "null") as Partial<Preferences> | null;
    if (!saved || typeof saved !== "object") return { ...DEFAULTS };
    return {
      automaticChecks: typeof saved.automaticChecks === "boolean" ? saved.automaticChecks : true,
      automaticDownloads: typeof saved.automaticDownloads === "boolean" ? saved.automaticDownloads : true,
      lastCheck: typeof saved.lastCheck === "number" ? saved.lastCheck : null,
      channel: saved.channel === "stable" || saved.channel === "nightly" ? saved.channel : null,
      notified: typeof saved.notified === "string" ? saved.notified : null,
      failed: isAppVersion(saved.failed) ? saved.failed : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function linuxUpdater(deps: UpdateDeps) {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let checking = false;
  let switchCheck: SwitchCheck | null = null;
  let settledRun = 0;
  let sightedRun = 0;
  let shownReady = false;
  const installingRuns = new Set<number>();
  const preferences = async () => {
    await deps.refresh?.(UPDATE_PREFERENCES).catch(() => {});
    return readPreferences(deps.read);
  };
  const remember = async (patch: Partial<Preferences>): Promise<void> => {
    const merge = async () => {
      await deps.write(UPDATE_PREFERENCES, JSON.stringify({ ...(await preferences()), ...patch }));
    };
    await (deps.locks ? deps.locks.request(UPDATE_PREFERENCES_LOCK, merge) : merge());
  };
  const version = () => {
    const current = deps.appVersion();
    return isAppVersion(current) ? current : null;
  };
  const channel = (saved: Preferences, current: string | null): UpdateChannel => saved.channel ?? (current ? channelOf(current) : "stable");

  async function engineStatus(): Promise<EngineStatus | null> {
    if (!selfUpdateAvailable(deps.host)) return null;
    const status = readEngineStatus(await invokeHost<unknown>(STATUS_METHOD, { args: [] }, deps.host).catch(() => null));
    if (status) {
      knownKinds.set(deps.host, status.kind);
      if (status.phase === "installing") installingRuns.add(status.run);
    }
    return status;
  }

  async function claim(run: number): Promise<boolean | null> {
    const answer = await invokeHost<unknown>(CLAIM_METHOD, { args: [run] }, deps.host).then(
      (claimed) => claimed === true,
      () => null,
    );
    if (answer !== null) settledRun = Math.max(settledRun, run);
    return answer;
  }

  async function restart(consent: ConsentToken | null) {
    const status = await engineStatus();
    if (status?.phase === "ready" && status.run > settledRun && (await claim(status.run))) countOutcome(status, consent);
    noteUpdateRestart(consent);
    await invokeHost(RESTART_METHOD, { args: [] }, deps.host).catch((error: unknown) => console.info(`[ardia linux] Ardia couldn't restart: ${String(error)}`));
  }
  const restartToUpdate = () => void restart(consentToken());

  async function newest(wanted: UpdateChannel): Promise<Release | null> {
    const fetched = await invokeHost<Fetched>(RELEASES_METHOD, { args: [] }, deps.host);
    if (!fetched || fetched.status !== 200 || typeof fetched.body !== "string") throw new Error(`GitHub answered ${fetched?.status ?? 0}`);
    return newestRelease(linuxReleases(fetched.body), wanted);
  }

  async function offeredOnce(release: Release) {
    if ((await preferences()).notified === release.version) return false;
    await remember({ notified: release.version });
    return true;
  }

  function countOutcome(status: EngineStatus, consent: ConsentToken | null) {
    noteUpdateDownloadStarted(consent);
    if (status.phase === "ready") {
      noteUpdateDownloadFinished(consent);
      if (installs(status.kind)) noteUpdateInstalled(status.kind, consent);
      return;
    }
    if (installingRuns.has(status.run) || ONLY_INSTALL_FAILURES.has(status.reason ?? "")) {
      noteUpdateDownloadFinished(consent);
      noteUpdateInstallFailed(status.reason, consent);
    } else {
      noteUpdateDownloadFailed(status.reason, consent);
    }
  }

  async function fallBack(release: Release, from: StartedFrom, consent: ConsentToken | null) {
    const current = version();
    switchCheck = { phase: "found", channel: switchCheck?.channel ?? channelOf(release.version), version: release.version };
    if (from === "asked" && current) {
      if (await deps.ask(release, current, true)) {
        noteUpdatePageOpened(consent);
        deps.open(release.url);
      }
      return;
    }
    if ((await preferences()).failed === release.version) return;
    await remember({ notified: release.version, failed: release.version });
    deps.offer(release, true);
  }

  async function settle(status: EngineStatus, consent: ConsentToken | null, own: OwnRun | null) {
    if (!finished(status) || status.run <= settledRun) return;
    if (status.phase === "ready" && deps.showsToasts === false) return;
    if (!(await claim(status.run))) return;
    countOutcome(status, consent);
    const target = status.version ?? own?.release.version;
    if (!target) return;
    if (status.phase === "ready") return deps.ready(target, restartToUpdate);
    console.info(`[ardia linux] the update to ${target} failed: ${status.reason ?? "unknown"}`);
    await fallBack(own?.release.version === target ? own.release : releasePage(target), own?.from ?? "automatic", consent);
  }

  async function followRun(started: EngineStatus, own: OwnRun, consent: ConsentToken | null) {
    const until = now() + FOLLOW_RUN_FOR_MS;
    let status: EngineStatus | null = started;
    while (status && updateBusy(status) && now() < until) {
      await wait(FOLLOW_RUN_EVERY_MS);
      status = (await engineStatus()) ?? status;
    }
    await settle(status, consent, own);
  }

  async function startRun(release: Release, from: StartedFrom, consent: ConsentToken | null) {
    const started = readEngineStatus(await invokeHost<unknown>(UPDATE_METHOD, { args: [release.version] }, deps.host).catch(() => null));
    if (!started) {
      noteUpdateDownloadStarted(consent);
      noteUpdateDownloadFailed("other", consent);
      return fallBack(release, from, consent);
    }
    if (started.phase === "installing") installingRuns.add(started.run);
    void followRun(started, { release, from }, consent).catch((error: unknown) => console.info(`[ardia linux] the update to ${release.version} stopped: ${String(error)}`));
  }

  async function deliver(release: Release, current: string, asked: boolean, saved: Preferences, consent: ConsentToken | null) {
    const status = await engineStatus();
    if (status?.kind === "managed") {
      if (asked) return deps.managed(release, current, true);
      if (await offeredOnce(release)) await deps.managed(release, current, false);
      return;
    }
    if (status && installs(status.kind)) {
      if (status.phase === "ready") {
        if (asked && status.version) deps.ready(status.version, restartToUpdate);
        return;
      }
      if (!asked && saved.failed === release.version) return;
      if (asked || (await preferences()).automaticDownloads) return startRun(release, asked ? "asked" : "automatic", consent);
      if (await offeredOnce(release)) deps.offerInstall(release, () => installOffered(release));
      return;
    }
    if (asked) {
      if (await deps.ask(release, current, false)) {
        noteUpdatePageOpened(consent);
        deps.open(release.url);
      }
      return;
    }
    if (await offeredOnce(release)) deps.offer(release, false);
  }

  async function check(asked: boolean, taken?: ConsentToken | null): Promise<void> {
    const consent = taken === undefined ? consentToken() : taken;
    const current = version();
    if (checking || !current) return;
    checking = true;
    let wanted: UpdateChannel = channelOf(current);
    try {
      const saved = await preferences();
      if (!asked && !saved.automaticChecks) return;
      wanted = channel(saved, current);
      const engine = asked ? await engineStatus() : null;
      if (engine?.phase === "ready" && engine.version && installs(engine.kind)) return deps.ready(engine.version, restartToUpdate);
      switchCheck = { phase: "checking", channel: wanted };
      let release: Release | null;
      try {
        release = await newest(wanted);
        await remember({ lastCheck: now() });
      } catch (error) {
        noteUpdateCheck(asked, "failed", consent);
        switchCheck = { phase: "failed", channel: wanted };
        console.info(`[ardia linux] the update check failed: ${String(error)}`);
        if (asked) await deps.tell("Ardia couldn't check for updates", `Try again later, or see ${RELEASES_PAGE}.`);
        return;
      }
      const newer = !!release && compareVersions(release.version, current) > 0;
      noteUpdateCheck(asked, newer ? "found" : "upToDate", consent);
      switchCheck = newer ? { phase: "found", channel: wanted, version: release!.version } : { phase: "upToDate", channel: wanted };
      if (!newer) {
        if (asked) await deps.tell("Ardia is up to date", `You have Ardia ${current}, the newest ${wanted === "nightly" ? "Nightly" : "Stable"} build for Linux.`);
        return;
      }
      await deliver(release!, current, asked, saved, consent).catch((error: unknown) => console.info(`[ardia linux] the update to ${release!.version} stopped: ${String(error)}`));
    } finally {
      checking = false;
    }
  }

  const installOffered = (release: Release) => {
    const consent = consentToken();
    void startRun(release, "accepted", consent).catch((error: unknown) => console.info(`[ardia linux] the update to ${release.version} stopped: ${String(error)}`));
  };

  async function checkOrRestart(consent: ConsentToken | null, restartOffered: boolean) {
    const status = restartOffered ? await engineStatus() : null;
    if (status?.phase === "ready" && installs(status.kind)) return restart(consent);
    return check(true, consent);
  }

  async function watch(taken?: ConsentToken | null) {
    const consent = taken === undefined ? consentToken() : taken;
    const status = await engineStatus();
    if (!status || !finished(status) || status.run <= settledRun) return;
    if (sightedRun !== status.run) {
      sightedRun = status.run;
      return;
    }
    await settle(status, consent, null);
  }

  async function menuItem(): Promise<"check" | "restart"> {
    const status = await engineStatus();
    return status?.phase === "ready" && installs(status.kind) ? "restart" : "check";
  }

  const methods = {
    updaterState: async (): Promise<UpdaterState> => {
      const current = version();
      const saved = await preferences();
      const status = current ? await engineStatus() : null;
      const selfUpdates = installs(status?.kind);
      const wanted = channel(saved, current);
      const busy = selfUpdates && updateBusy(status);
      const engineCheck: SwitchCheck | null =
        selfUpdates && status?.version && (busy || status.phase === "ready") ? { phase: status.phase as SwitchCheck["phase"], channel: wanted, version: status.version } : null;
      const shownCheck = checking && switchCheck ? switchCheck : (engineCheck ?? switchCheck);
      shownReady = shownCheck?.phase === "ready";
      return {
        available: true,
        configured: !!current,
        automaticChecks: saved.automaticChecks,
        automaticDownloads: selfUpdates && saved.automaticDownloads,
        canCheck: !checking && !busy,
        sessionInProgress: checking || busy,
        feedURL: RELEASES_PAGE,
        lastCheck: saved.lastCheck,
        version: current ?? deps.appVersion() ?? "",
        channel: wanted,
        buildChannel: current ? channelOf(current) : "stable",
        switchCheck: shownCheck,
      };
    },
    checkForUpdates: () => checkOrRestart(consentToken(), shownReady),
    setAutomaticUpdateChecks: async (on: unknown) => remember({ automaticChecks: on === true }),
    setAutomaticUpdateDownloads: async (on: unknown) => remember({ automaticDownloads: on === true }),
    setUpdateChannel: async (next: unknown) => {
      await remember({ channel: next === "nightly" ? "nightly" : "stable", notified: null });
      await check(true);
    },
  };

  const checksByItself = async () => {
    const launch = hostLaunchConfig(deps.host);
    return !!version() && !launch.background && !launch.isolated && (await preferences()).automaticChecks;
  };

  const restartWhenReady = () => checkOrRestart(consentToken(), true);

  return { methods, check, checksByItself, watch, menuItem, restartWhenReady };
}

export type LinuxUpdater = ReturnType<typeof linuxUpdater>;

export function scheduleUpdateChecks(updater: LinuxUpdater, options: { locks?: { request(name: string, callback: () => Promise<void>): Promise<unknown> }; timers?: { setTimeout: typeof setTimeout; setInterval: typeof setInterval } }) {
  const timers = options.timers ?? globalThis;
  const run = () => void updater.checksByItself().then((checks) => {
    if (checks) return updater.check(false);
  });
  const watch = () => void updater.watch().catch(() => {});
  const lead = () => new Promise<void>(() => {
    timers.setTimeout(run, FIRST_CHECK_AFTER_MS);
    timers.setInterval(run, CHECK_EVERY_MS);
    timers.setInterval(watch, WATCH_EVERY_MS);
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
