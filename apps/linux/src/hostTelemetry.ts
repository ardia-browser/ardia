import { APP_INGEST_KEY } from "@ardia/core";
import { installErrorReporting, resetAnonymousId, startTelemetry } from "../../browser/src/state/telemetry/index.ts";
import { captureException } from "../../browser/src/state/telemetry/errors";
import { capture, devState, endSession, flush, loadChoice, queueLog, saveQueueNow, setSharing } from "../../browser/src/state/telemetry/client";
import { dismissAsk, reloadChoice, savedChoice, useTelemetry } from "../../browser/src/state/telemetry/choice";
import { DAILY_DOC } from "../../browser/src/state/telemetry/daily";
import { requestLog } from "../../browser/src/state/telemetry/requestLog";
import { adoptInstallId } from "../../browser/src/state/telemetry/installId";
import { setTelemetryRelay, type ChoiceChange } from "../../browser/src/state/telemetry/relay";
import { reopenSession } from "../../browser/src/state/telemetry/sessionControl";
import { startWatch, stopWatch, watchNoticeShown } from "../../browser/src/state/telemetry/watch";
import { uuidv4 } from "../../browser/src/state/telemetry/ids";
import { setTelemetryHost } from "../../browser/src/state/telemetry/transport";
import { emitWindowUsage, sessionEnding } from "../../browser/src/state/telemetry/usage";
import { documentSaved } from "../../browser/src/platform/documents";
import { withDeadline } from "../../browser/src/lib/deadline";
import { refreshDocument } from "./shims/shellBase";
import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";
import { startTelemetryLeadership, TELEMETRY_CHANNEL, type LeaderChannel, type LeaderLocks, type TelemetryLeadership, type TelemetryOp } from "./telemetryLeader.ts";
import { createEndLedger, setTelemetrySettle } from "./telemetrySettle.ts";
import { parseChoiceChange, shownAfter } from "./telemetryChoice.ts";

export const TELEMETRY_POST = "ArdiaTelemetry.post";
export const TELEMETRY_STEP = "telemetry";
const STATE_DOC = "telemetry.json";
const TELEMETRY_DOCUMENTS = [STATE_DOC, "telemetry-queue.json", DAILY_DOC];
const END_TIMEOUT_MS = 2_000;
const RESET_TIMEOUT_MS = 10_000;
const WINDOW_USAGE_MS = 60 * 60 * 1000;

const report = (error: unknown) => console.warn("[ardia linux] telemetry", error);

export function hostTelemetrySend(host: ArdiaHost) {
  return async (body: string) => {
    const reply = await invokeHost<{ status?: unknown } | null>(TELEMETRY_POST, { args: [body, APP_INGEST_KEY] }, host);
    const status = reply?.status;
    return typeof status === "number" && Number.isSafeInteger(status) ? status : 0;
  };
}

async function continuesSession(host: ArdiaHost): Promise<boolean> {
  if (!hostSupports("ArdiaShell.launchSteps", host) || !hostSupports("ArdiaShell.completeLaunchStep", host)) return false;
  try {
    const steps = await invokeHost<unknown>("ArdiaShell.launchSteps", { args: [] }, host);
    if (Array.isArray(steps) && steps.includes(TELEMETRY_STEP)) return true;
    await invokeHost("ArdiaShell.completeLaunchStep", { args: [TELEMETRY_STEP] }, host);
  } catch (error) {
    report(error);
  }
  return false;
}

type ErrorTarget = { addEventListener(type: "error" | "unhandledrejection", listener: (event: { error?: unknown; message?: unknown; reason?: unknown }) => void): void };

export function watchUncaughtErrors(target: ErrorTarget, reportError: typeof captureException = captureException) {
  target.addEventListener("error", (event) => reportError(event.error ?? event.message, "onerror"));
  target.addEventListener("unhandledrejection", (event) => reportError(event.reason, "onunhandledrejection"));
}

export const reportUncaughtRender = (error: unknown) => captureException(error, "react", { fatal: true });

let sessionEnded = false;
const ends = createEndLedger();

async function saveState() {
  await saveQueueNow(END_TIMEOUT_MS);
  await documentSaved(STATE_DOC).catch(report);
}

function applyChoice(change: ChoiceChange) {
  if (change.kind === "sharing") setSharing(change.on, change.source, change.placement);
  else if (change.kind === "askDismissed") dismissAsk();
  else if (change.kind === "watchStarted") startWatch(change.reportId, change.days);
  else if (change.kind === "watchStopped") stopWatch();
  else if (change.kind === "watchNoticeShown") watchNoticeShown();
  else adoptInstallId(change.id);
}

export async function handleTelemetryOp(op: TelemetryOp, arg?: string): Promise<unknown> {
  if (op === "choice") {
    const change = parseChoiceChange(arg);
    if (!change) throw Object.assign(new Error("The telemetry choice isn't one this build knows"), { code: "ERR_TELEMETRY_CHOICE" });
    applyChoice(change);
    await documentSaved(STATE_DOC);
    leadership?.announce();
    return true;
  }
  if (op === "reset") {
    const installId = await resetAnonymousId();
    await documentSaved(STATE_DOC);
    leadership?.announce();
    return installId;
  }
  if (op === "reopen") {
    if (!ends.reopens(arg)) return false;
    reopenSession();
    sessionEnded = false;
    await documentSaved(STATE_DOC).catch(report);
    return true;
  }
  if (sessionEnded) endSession();
  else sessionEnding();
  sessionEnded = true;
  const token = ends.end();
  await saveState();
  return token;
}

let leadership: TelemetryLeadership | null = null;
let offeredInstallId: string | null = null;

const shownChoice = () => JSON.stringify(useTelemetry.getState());

async function refreshState() {
  await refreshDocument(STATE_DOC).catch(report);
  reloadChoice();
  if (savedChoice().installId) offeredInstallId = null;
}

export function startHostTelemetry(options: { host: ArdiaHost; candidate: boolean; locks?: LeaderLocks; channel?: LeaderChannel | null }) {
  const { host, candidate } = options;
  setTelemetrySettle({ settle: settleHostTelemetry, reopen: reopenHostTelemetry });
  setTelemetryHost({ os: "Linux", osType: "linux", send: hostSupports(TELEMETRY_POST, host) ? hostTelemetrySend(host) : null });
  loadChoice();
  installErrorReporting();
  watchUncaughtErrors(globalThis);
  const channel = options.channel !== undefined ? options.channel : typeof BroadcastChannel === "undefined" ? null : (new BroadcastChannel(TELEMETRY_CHANNEL) as unknown as LeaderChannel);
  const current = startTelemetryLeadership({
    candidate,
    locks: options.locks,
    channel,
    relay: (forward) => setTelemetryRelay(forward && {
      capture: (event, props, captureOptions) => forward({ kind: "capture", event, props, options: { ...captureOptions } }),
      log: (level, message, attributes) => forward({ kind: "log", level, message, attributes }),
      resetId: async () => {
        const installId = await current.request("reset", RESET_TIMEOUT_MS);
        await refreshState();
        if (typeof installId !== "string") throw Object.assign(new Error("The anonymous ID wasn't reset"), { code: "ERR_TELEMETRY_RESET" });
        return installId;
      },
      change: (change) => {
        const shown = shownAfter(change);
        if (shown) useTelemetry.setState(shown);
        void current.request("choice", RESET_TIMEOUT_MS, JSON.stringify(change)).catch(report).then(refreshState);
      },
      installId: () => {
        const known = savedChoice().installId;
        if (known) return known;
        const id = (offeredInstallId ??= uuidv4());
        void current.request("choice", RESET_TIMEOUT_MS, JSON.stringify({ kind: "installId", id } satisfies ChoiceChange)).catch(report).then(refreshState);
        return id;
      },
    }),
    deliver: (message) => message.kind === "capture" ? capture(message.event, message.props, message.options) : queueLog(message.level, message.message, message.attributes),
    handle: handleTelemetryOp,
    lead: async () => {
      await Promise.all(TELEMETRY_DOCUMENTS.map((name) => refreshDocument(name).catch(report)));
      const continuing = await continuesSession(host);
      reloadChoice();
      sessionEnded = continuing && !savedChoice().sessionOpen;
      startTelemetry({ continuing });
      await documentSaved(STATE_DOC).catch(report);
      current.announce();
    },
    changed: () => void refreshState(),
    report,
  });
  leadership = current;
  let announced = shownChoice();
  useTelemetry.subscribe(() => {
    const next = shownChoice();
    if (next === announced) return;
    announced = next;
    if (current.leading()) void documentSaved(STATE_DOC).catch(report).then(() => current.announce());
  });
  setInterval(() => {
    if (!current.leading()) emitWindowUsage();
  }, WINDOW_USAGE_MS);
  return current;
}

export async function settleHostTelemetry(endsSession: boolean): Promise<string | null> {
  if (!leadership) return null;
  if (!endsSession || !leadership.leading()) emitWindowUsage();
  if (endsSession) {
    const token = await leadership.request("end", END_TIMEOUT_MS).catch(report);
    return typeof token === "string" ? token : null;
  }
  if (leadership.leading()) await withDeadline(saveState(), END_TIMEOUT_MS, undefined);
  return null;
}

export async function reopenHostTelemetry(token: string) {
  await leadership?.request("reopen", END_TIMEOUT_MS, token).catch(report);
}

export const linuxTelemetryHooks = {
  leading: () => leadership?.leading() ?? false,
  state: devState,
  requests: requestLog,
  flush,
};
