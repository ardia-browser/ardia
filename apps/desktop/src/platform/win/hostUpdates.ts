import type { UpdateChannel, UpdaterState } from "../../../../../packages/shell/src/updater";
import type { ArdiaHost } from "../../host";
import { hostSupports, invokeHost } from "../../host.ts";
import { SELF_UPDATE_METHODS } from "../../hostCapabilities.ts";
import {
  UPDATE_DOWNLOAD_FAILURES,
  UPDATE_INSTALL_FAILURES,
  noteUpdateCheck,
  noteUpdateDownloadFailed,
  noteUpdateDownloadFinished,
  noteUpdateDownloadStarted,
  noteUpdateInstallFailed,
  noteUpdateRestart,
} from "../../../../browser/src/state/telemetry/updateCounts.ts";
import { consentToken, type ConsentToken } from "../../../../browser/src/state/telemetry/consentPeriod";
import { WINDOWS_UPDATE_VERIFY_FAILURES, windowsUpdateCounts, type WindowsUpdateVerifyKey } from "../../../../browser/src/platform/windowsUpdateCounts.win.ts";

export const UPDATE_METHODS = ["updaterState", "checkForUpdates", "setAutomaticUpdateChecks", "setAutomaticUpdateDownloads", "setUpdateChannel"] as const;
export const CHECK_METHOD = "ArdiaUpdates.check";
export const WINDOWS_UPDATE_METHODS = [...SELF_UPDATE_METHODS, CHECK_METHOD] as const;
export const [, UPDATE_METHOD, STATUS_METHOD, CLAIM_METHOD, RESTART_METHOD] = SELF_UPDATE_METHODS;
export const UPDATE_PREFERENCES = "windows-updates.json";
export const WINDOWS_RELEASE_PAGE = "https://github.com/ardia-browser/ardia/releases/tag/windows-alpha";
export const FIRST_CHECK_AFTER_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const WATCH_EVERY_MS = 30_000;
const FOLLOW_RUN_EVERY_MS = 2_000;
const FOLLOW_RUN_FOR_MS = 75 * 60 * 1000;
export const UPDATE_CHECK_LOCK = "ardia.windows.update-checks";
const UPDATE_PREFERENCES_LOCK = "ardia.windows.update-preferences";
export const UPDATE_RUN_LOCK = "ardia.windows.update-runs";
const LARGEST_INSTALLER_BYTES = 2 ** 30;
const LARGEST_REASON = 200;

type InstallKind = "installer" | "portable" | "unsupported";
type Phase = "idle" | "checking" | "upToDate" | "available" | "downloading" | "ready" | "failed";
export type WindowsBuild = { version: string; build: number };
export type WindowsUpdate = WindowsBuild & { bytes: number };
export type EngineStatus = {
  phase: Phase;
  kind: InstallKind;
  reason: string | null;
  run: number;
  offer: WindowsUpdate | null;
  current: WindowsBuild | null;
  background: boolean;
  isolated: boolean;
  testFeed: boolean;
};
export type CheckAnswer =
  | ({ status: "ok" } & WindowsUpdate)
  | { status: "upToDate" }
  | { status: "notPublished" }
  | { status: "busy" }
  | { status: "failed"; reason: Exclude<WindowsUpdateVerifyKey, "verified">; message: string };
type StartedRun = { run: number; build: number; consent: string | null };
type Preferences = { automaticChecks: boolean; automaticDownloads: boolean; lastCheck: number | null; notified: number | null; failed: number | null; started: StartedRun | null };
type SwitchCheck = NonNullable<Extract<UpdaterState, { available: true }>["switchCheck"]>;
type StartedFrom = "asked" | "automatic" | "accepted";
type OwnRun = { update: WindowsUpdate; from: StartedFrom };

export type UpdateLocks = { request(name: string, callback: () => Promise<unknown>): Promise<unknown> };

export type WindowsUpdateDeps = {
  host: ArdiaHost;
  read: (name: string) => string | null;
  write: (name: string, contents: string) => unknown;
  refresh?: (name: string) => Promise<unknown>;
  pointToRelease: (title: string, message: string) => void;
  tell: (title: string, message: string) => Promise<void>;
  offer: (update: WindowsUpdate, failed: boolean) => void;
  offerInstall: (update: WindowsUpdate, install: () => void) => void;
  ready: (update: WindowsUpdate, restart: () => void) => void;
  open: (url: string) => void;
  showsToasts?: boolean;
  locks?: UpdateLocks;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULTS: Preferences = { automaticChecks: true, automaticDownloads: true, lastCheck: null, notified: null, failed: null, started: null };
const PHASES: ReadonlySet<string> = new Set<Phase>(["idle", "checking", "upToDate", "available", "downloading", "ready", "failed"]);
const KINDS: ReadonlySet<string> = new Set<InstallKind>(["installer", "portable", "unsupported"]);
const CHECK_FAILURES: ReadonlySet<string> = new Set(WINDOWS_UPDATE_VERIFY_FAILURES);
const ONLY_INSTALL_FAILURES: ReadonlySet<string> = new Set(UPDATE_INSTALL_FAILURES.filter((reason) => !(UPDATE_DOWNLOAD_FAILURES as readonly string[]).includes(reason)));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isVersion = (value: unknown): value is string => typeof value === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value);
const isBuild = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isBytes = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= LARGEST_INSTALLER_BYTES;
const ENGINE_REASONS: ReadonlySet<string> = new Set(["network", "tooLarge", "disk", "version", "busy", "checksum", "signature", "manifest", "missing", "verifier", "kind", "install", "other"]);
const isReason = (value: unknown): value is string => typeof value === "string" && ENGINE_REASONS.has(value);
const plainMessage = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= LARGEST_REASON && [...value].every((character) => character.charCodeAt(0) >= 0x20 && character !== "\u007f");

function readBuild(value: unknown): WindowsBuild | null {
  if (!isRecord(value) || !isVersion(value.version) || !isBuild(value.build)) return null;
  return { version: value.version, build: value.build };
}

export function readEngineStatus(answer: unknown): EngineStatus | null {
  if (!isRecord(answer)) return null;
  const { phase, kind, reason, run, version, build, bytes, current, background, isolated, testFeed } = answer;
  if (typeof phase !== "string" || !PHASES.has(phase) || typeof run !== "number" || !Number.isSafeInteger(run) || run < 0) return null;
  const running = readBuild(current);
  const offer = running && isVersion(version) && isBuild(build) && build > running.build && isBytes(bytes) ? { version, build, bytes } : null;
  return {
    phase: phase as Phase,
    kind: typeof kind === "string" && KINDS.has(kind) ? (kind as InstallKind) : "unsupported",
    reason: isReason(reason) ? reason : reason == null ? null : "other",
    run,
    offer,
    current: running,
    background: background === true,
    isolated: isolated === true,
    testFeed: testFeed === true,
  };
}

export function readCheckAnswer(answer: unknown, current: WindowsBuild | null): CheckAnswer | null {
  if (!isRecord(answer) || typeof answer.status !== "string") return null;
  switch (answer.status) {
    case "upToDate":
    case "notPublished":
    case "busy":
      return { status: answer.status };
    case "ok": {
      const { version, build, bytes } = answer;
      if (!isVersion(version) || !isBuild(build) || !isBytes(bytes) || (current && build <= current.build)) return null;
      return { status: "ok", version, build, bytes };
    }
    case "failed": {
      const reason = typeof answer.reason === "string" && CHECK_FAILURES.has(answer.reason) ? (answer.reason as Exclude<WindowsUpdateVerifyKey, "verified">) : "other";
      const message = plainMessage(answer.message) ? answer.message : "the update check failed";
      return { status: "failed", reason, message };
    }
  }
  return null;
}

function readStartedRun(value: unknown): StartedRun | null {
  if (!isRecord(value) || !isBuild(value.run) || !isBuild(value.build)) return null;
  const { consent } = value;
  if (consent !== null && !(typeof consent === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(consent))) return null;
  return { run: value.run, build: value.build, consent };
}

function readPreferences(read: WindowsUpdateDeps["read"]): Preferences {
  try {
    const saved: unknown = JSON.parse(read(UPDATE_PREFERENCES) ?? "null");
    if (!isRecord(saved)) return { ...DEFAULTS };
    const build = (value: unknown) => (isBuild(value) ? value : null);
    return {
      automaticChecks: typeof saved.automaticChecks === "boolean" ? saved.automaticChecks : true,
      automaticDownloads: typeof saved.automaticDownloads === "boolean" ? saved.automaticDownloads : true,
      lastCheck: typeof saved.lastCheck === "number" && Number.isFinite(saved.lastCheck) ? saved.lastCheck : null,
      notified: build(saved.notified),
      failed: build(saved.failed),
      started: readStartedRun(saved.started),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const windowsChannel = (version: string): UpdateChannel => (/-nightly\./.test(version) ? "nightly" : "stable");
export const named = (build: WindowsBuild) => `${build.version}, Windows alpha ${build.build}`;
const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

const knownKinds = new WeakMap<ArdiaHost, InstallKind>();
export const installsUpdates = (host: ArdiaHost | undefined) => !!host && knownKinds.get(host) === "installer";
export const updatesAvailable = (host: ArdiaHost) => WINDOWS_UPDATE_METHODS.every((method) => hostSupports(method, host));

const updateBusy = (status: EngineStatus | null | undefined) => status?.phase === "checking" || status?.phase === "downloading";
const finished = (status: EngineStatus) => status.run > 0 && (status.phase === "ready" || status.phase === "failed");
const installs = (status: EngineStatus | null | undefined) => status?.kind === "installer";

export function windowsUpdater(deps: WindowsUpdateDeps) {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let checking = false;
  let settledRun = 0;
  let sightedRun = 0;
  let shownReady = false;
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

  async function engineStatus(): Promise<EngineStatus | null> {
    if (!updatesAvailable(deps.host)) return null;
    const status = readEngineStatus(await invokeHost<unknown>(STATUS_METHOD, { args: [] }, deps.host).catch(() => null));
    if (status) knownKinds.set(deps.host, status.kind);
    return status;
  }

  const runConsents = new Map<number, ConsentToken | null>();
  const readyShown = new Set<number>();
  const showReady = (run: number, update: WindowsUpdate) => {
    readyShown.add(run);
    deps.ready(update, restartToUpdate);
  };
  const serialized = <T,>(work: () => Promise<T>): Promise<T> => (deps.locks ? (deps.locks.request(UPDATE_RUN_LOCK, work) as Promise<T>) : work());

  async function claim(run: number): Promise<EngineStatus | null> {
    const answer = await invokeHost<unknown>(CLAIM_METHOD, { args: [run] }, deps.host).then(
      (claimed) => ({ claimed }),
      () => null,
    );
    if (!answer) return null;
    settledRun = Math.max(settledRun, run);
    const claimed = answer.claimed === false ? null : readEngineStatus(answer.claimed);
    return claimed && claimed.run === run && finished(claimed) ? claimed : null;
  }

  async function startConsent(status: EngineStatus): Promise<ConsentToken | null | undefined> {
    if (runConsents.has(status.run)) return runConsents.get(status.run);
    const started = (await preferences()).started;
    return started && started.run === status.run && started.build === status.offer?.build ? (started.consent as ConsentToken | null) : undefined;
  }

  const claimAndCount = (run: number) =>
    serialized(async () => {
      const claimed = await claim(run);
      if (claimed) await countOutcome(claimed);
      return claimed;
    });

  async function countOutcome(status: EngineStatus) {
    const consent = await startConsent(status);
    runConsents.delete(status.run);
    if (!consent) return;
    noteUpdateDownloadStarted(consent);
    if (status.phase === "ready") return noteUpdateDownloadFinished(consent);
    if (ONLY_INSTALL_FAILURES.has(status.reason ?? "")) {
      noteUpdateDownloadFinished(consent);
      noteUpdateInstallFailed(status.reason, consent);
    } else {
      noteUpdateDownloadFailed(status.reason, consent);
    }
  }

  async function restart(consent: ConsentToken | null) {
    const status = await engineStatus();
    if (status?.phase !== "ready" || !installs(status)) return check(true, consent);
    if (status.run > settledRun) await claimAndCount(status.run);
    noteUpdateRestart(consent);
    const launched = await invokeHost<unknown>(RESTART_METHOD, { args: [] }, deps.host).catch(() => false);
    if (launched === true || launched === "busy") return;
    const after = await engineStatus();
    if (after?.phase === "failed" && after.run === status.run && (await claim(after.run))?.phase === "failed") noteUpdateInstallFailed(after.reason ?? "install", consent);
    console.info(`[ardia windows] the installer didn't start: ${after?.reason ?? "unknown"}`);
    await deps.tell("Ardia couldn't install the update", `The installer didn't start. Try again, or download the newest build from ${WINDOWS_RELEASE_PAGE}.`);
  }
  const restartToUpdate = () => void restart(consentToken());

  async function noticeReady(status: EngineStatus) {
    if (!status.offer) return;
    if (deps.showsToasts !== false && status.run > settledRun) {
      const claimed = await claimAndCount(status.run);
      if (claimed && claimed.phase !== "ready") return;
      if (!claimed && readyShown.has(status.run)) return;
    }
    showReady(status.run, status.offer);
  }

  async function offeredOnce(update: WindowsUpdate) {
    if ((await preferences()).notified === update.build) return false;
    await remember({ notified: update.build });
    return true;
  }

  async function fallBack(update: WindowsUpdate, from: StartedFrom) {
    if (from === "asked") {
      deps.pointToRelease("Ardia couldn't install the update", `Ardia couldn't download ${named(update)} by itself. Download the installer from its release page instead.`);
      return;
    }
    if ((await preferences()).failed === update.build) return;
    await remember({ notified: update.build, failed: update.build });
    deps.offer(update, true);
  }

  async function settle(status: EngineStatus, own: OwnRun | null) {
    if (!finished(status) || status.run <= settledRun) return;
    if (status.phase === "ready" && deps.showsToasts === false) return;
    const claimed = await claimAndCount(status.run);
    if (!claimed) return;
    const target = claimed.offer ?? own?.update;
    if (!target) return;
    if (claimed.phase === "ready") return showReady(claimed.run, target);
    console.info(`[ardia windows] the update to ${named(target)} failed: ${claimed.reason ?? "unknown"}`);
    await fallBack(target, own?.from ?? "automatic");
  }

  async function followRun(started: EngineStatus, own: OwnRun) {
    const until = now() + FOLLOW_RUN_FOR_MS;
    let status: EngineStatus | null = started;
    while (status && status.phase === "downloading" && now() < until) {
      await wait(FOLLOW_RUN_EVERY_MS);
      const next = await engineStatus();
      if (next && next.run !== started.run) return;
      status = next ?? status;
    }
    if (status && status.run === started.run) await settle(status, own);
  }

  async function startRun(update: WindowsUpdate, from: StartedFrom, consent: ConsentToken | null) {
    const answer = await serialized(async () => {
      const reply = await invokeHost<unknown>(UPDATE_METHOD, { args: [update.build] }, deps.host).catch(() => null);
      const status = readEngineStatus(reply);
      if (status && isRecord(reply) && reply.started === true && status.offer?.build === update.build) {
        runConsents.set(status.run, consent);
        await remember({ started: { run: status.run, build: update.build, consent } }).catch(() => {});
      }
      return { reply, status };
    });
    const started = answer.status;
    const joins = !!started && (started.phase === "downloading" || started.phase === "ready") && started.offer?.build === update.build;
    if (!joins && started && isRecord(answer.reply) && answer.reply.started === false) {
      console.info(`[ardia windows] the engine declined ${named(update)}: it is ${started.phase}${started.offer ? ` with ${named(started.offer)}` : ""}`);
      if (started.phase === "checking") {
        if ((await preferences()).notified === update.build) await remember({ notified: null }).catch(() => {});
        await deps.tell("Ardia is checking for updates", "Try Update again once the check finishes.");
        return;
      }
      if (from === "asked" && (started.phase === "downloading" || started.phase === "ready")) await deps.tell("Ardia is already updating", "It tells you when the update is ready to install.");
      return;
    }
    if (!started || !joins) {
      noteUpdateDownloadStarted(consent);
      noteUpdateDownloadFailed("other", consent);
      return fallBack(update, from);
    }
    void followRun(started, { update, from }).catch((error: unknown) => console.info(`[ardia windows] the update to ${named(update)} stopped: ${String(error)}`));
  }

  const installOffered = (update: WindowsUpdate) => {
    const consent = consentToken();
    void startRun(update, "accepted", consent).catch((error: unknown) => console.info(`[ardia windows] the update to ${named(update)} stopped: ${String(error)}`));
  };

  async function deliver(update: WindowsUpdate, status: EngineStatus, current: WindowsBuild, asked: boolean, consent: ConsentToken | null) {
    if (!installs(status)) {
      if (!asked) return;
      deps.pointToRelease(
        `Ardia ${update.version} is available`,
        `${named(update)} is available. You have ${named(current)}. This copy of Ardia isn't installed, so it doesn't update itself: download the installer from its release page.`,
      );
      return;
    }
    const saved = await preferences();
    if (!asked && saved.failed === update.build) return;
    if (asked || saved.automaticDownloads) return startRun(update, asked ? "asked" : "automatic", consent);
    if (await offeredOnce(update)) deps.offerInstall(update, () => installOffered(update));
  }

  function checksByItselfWith(status: EngineStatus | null, saved: Preferences) {
    return !!status?.current && installs(status) && !status.background && (!status.isolated || status.testFeed) && saved.automaticChecks;
  }

  async function check(asked: boolean, taken?: ConsentToken | null): Promise<void> {
    const consent = taken === undefined ? consentToken() : taken;
    if (checking) {
      if (asked) await deps.tell("Ardia is already checking for updates", "Try again in a moment.");
      return;
    }
    checking = true;
    const startedEpoch = windowsUpdateCounts.consentEpoch();
    const failed = async (reason: WindowsUpdateVerifyKey, message: string) => {
      windowsUpdateCounts.note(reason, startedEpoch);
      noteUpdateCheck(asked, "failed", consent);
      console.info(`[ardia windows] the update check failed: ${message}`);
      if (asked) await deps.tell("Ardia couldn't check for updates", `${message[0]?.toUpperCase() ?? ""}${message.slice(1)}. Try again later, or see ${WINDOWS_RELEASE_PAGE}.`);
    };
    try {
      const status = await engineStatus();
      const current = status?.current;
      if (!status || !current || status.kind === "unsupported") {
        if (asked) await deps.tell("Updates aren't set up for this build", "This copy of Ardia can't check for updates by itself. Download the newest build from ardia.dev.");
        return;
      }
      const saved = await preferences();
      if (!asked && !checksByItselfWith(status, saved)) return;
      if (status.phase === "ready" && status.offer && installs(status)) {
        if (asked) await noticeReady(status);
        return;
      }
      if (status.phase === "downloading" && status.offer) {
        if (asked) await deps.tell(`Downloading Ardia ${status.offer.version}`, `${named(status.offer)} is downloading. Ardia tells you when it's ready to install.`);
        return;
      }
      const answer = readCheckAnswer(await invokeHost<unknown>(CHECK_METHOD, { args: [] }, deps.host).catch(() => null), current);
      if (!answer) return await failed("verifier", "the update verifier returned an unreadable answer");
      if (answer.status === "busy") {
        if (asked) await deps.tell("Ardia is already checking for updates", "Try again in a moment.");
        return;
      }
      if (answer.status === "failed") return await failed(answer.reason, answer.message);
      if (answer.status === "notPublished" && status.testFeed) return await failed("network", "the test feed answered 404");
      windowsUpdateCounts.note(answer.status === "notPublished" ? "network" : "verified", startedEpoch);
      await remember({ lastCheck: now() }).catch(() => {});
      if (answer.status === "notPublished") {
        noteUpdateCheck(asked, "upToDate", consent);
        if (asked) await deps.tell("No Windows update published yet", `No Windows build of Ardia has been published for updates yet. You have ${named(current)}.`);
        return;
      }
      if (answer.status === "upToDate") {
        noteUpdateCheck(asked, "upToDate", consent);
        if (asked) await deps.tell("Ardia is up to date", `You have ${named(current)}, the newest build for Windows.`);
        return;
      }
      noteUpdateCheck(asked, "found", consent);
      const update: WindowsUpdate = { version: answer.version, build: answer.build, bytes: answer.bytes };
      await deliver(update, status, current, asked, consent).catch((error: unknown) => console.info(`[ardia windows] the update to ${named(update)} stopped: ${String(error)}`));
    } finally {
      checking = false;
    }
  }

  async function checkOrRestart(consent: ConsentToken | null, restartOffered: boolean) {
    const status = restartOffered ? await engineStatus() : null;
    if (status?.phase === "ready" && installs(status)) return restart(consent);
    return check(true, consent);
  }

  async function watch() {
    const status = await engineStatus();
    if (!status || !finished(status) || status.run <= settledRun) return;
    if (sightedRun !== status.run) {
      sightedRun = status.run;
      return;
    }
    await settle(status, null);
  }

  async function menuItem(): Promise<"check" | "restart"> {
    const status = await engineStatus();
    return status?.phase === "ready" && installs(status) ? "restart" : "check";
  }

  function switchCheckFor(status: EngineStatus | null, channel: UpdateChannel): SwitchCheck | null {
    const version = status?.offer?.version;
    switch (status?.phase) {
      case "checking":
        return { phase: "checking", channel };
      case "upToDate":
        return { phase: "upToDate", channel };
      case "available":
        return { phase: "found", channel, ...(version ? { version } : {}) };
      case "downloading":
        return { phase: "downloading", channel, ...(version ? { version } : {}) };
      case "ready":
        return { phase: "ready", channel, ...(version ? { version } : {}) };
      case "failed":
        return { phase: "found", channel, ...(version ? { version } : {}) };
      case "idle":
        return status.reason ? { phase: "failed", channel } : null;
      default:
        return null;
    }
  }

  const methods = {
    updaterState: async (): Promise<UpdaterState> => {
      const status = await engineStatus();
      const saved = await preferences();
      const current = status?.current ?? null;
      const configured = !!current && installs(status);
      const channel = windowsChannel(current?.version ?? "0.0.0");
      const busy = checking || updateBusy(status);
      const switchCheck = configured ? switchCheckFor(status, channel) : null;
      shownReady = switchCheck?.phase === "ready";
      return {
        available: true,
        configured,
        automaticChecks: saved.automaticChecks,
        automaticDownloads: configured && saved.automaticDownloads,
        canCheck: configured && !busy,
        sessionInProgress: busy,
        feedURL: configured ? WINDOWS_RELEASE_PAGE : null,
        lastCheck: saved.lastCheck,
        version: current?.version ?? "0.0.0",
        ...(current ? { displayVersion: named(current) } : {}),
        buildChannel: channel,
        switchCheck,
      };
    },
    checkForUpdates: () => checkOrRestart(consentToken(), shownReady),
    setAutomaticUpdateChecks: async (on: unknown) => remember({ automaticChecks: on === true }),
    setAutomaticUpdateDownloads: async (on: unknown) => remember({ automaticDownloads: on === true }),
    setUpdateChannel: async (_channel: unknown) => {},
  };

  const checksByItself = async () => checksByItselfWith(await engineStatus(), await preferences());
  const restartWhenReady = () => checkOrRestart(consentToken(), true);

  return { methods, check, checksByItself, watch, menuItem, restartWhenReady };
}

export type WindowsUpdater = ReturnType<typeof windowsUpdater>;

export function scheduleUpdateChecks(updater: WindowsUpdater, options: { locks?: { request(name: string, callback: () => Promise<void>): Promise<unknown> }; timers?: { setTimeout: typeof setTimeout; setInterval: typeof setInterval } }) {
  const timers = options.timers ?? globalThis;
  const run = () => void updater.checksByItself().then((checks) => {
    if (checks) return updater.check(false);
  }).catch(() => {});
  const watch = () => void updater.watch().catch(() => {});
  const lead = () => new Promise<void>(() => {
    timers.setTimeout(run, FIRST_CHECK_AFTER_MS);
    timers.setInterval(run, CHECK_EVERY_MS);
    timers.setInterval(watch, WATCH_EVERY_MS);
  });
  if (!options.locks) return;
  void options.locks.request(UPDATE_CHECK_LOCK, lead).catch(() => {});
}

export const installerSize = (update: WindowsUpdate) => `${megabytes(update.bytes)} MB`;
