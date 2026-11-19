import { APP_INGEST_KEY } from "@ardia/core";
import { installErrorReporting, startTelemetry } from "../../browser/src/state/telemetry/index.ts";
import { captureException } from "../../browser/src/state/telemetry/errors";
import { capture, consentNow, devState, flush, loadChoice, queueLog } from "../../browser/src/state/telemetry/client";
import { reloadChoice, savedChoice, useTelemetry, type ConsentToken } from "../../browser/src/state/telemetry/choice";
import { DAILY_DOC } from "../../browser/src/state/telemetry/daily";
import { requestLog } from "../../browser/src/state/telemetry/requestLog";
import { setTelemetryRelay, type ChoiceChange } from "../../browser/src/state/telemetry/relay";
import { uuidv4 } from "../../browser/src/state/telemetry/ids";
import { setTelemetryHost } from "../../browser/src/state/telemetry/transport";
import { emitWindowUsage } from "../../browser/src/state/telemetry/usage";
import { documentSaved } from "../../browser/src/platform/documents";
import { withDeadline } from "../../browser/src/lib/deadline";
import { refreshDocument } from "./shims/shellBase";
import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";
import { startTelemetryLeadership, TELEMETRY_CHANNEL, type LeaderChannel, type LeaderLocks, type TelemetryLeadership } from "./telemetryLeader.ts";
import { setTelemetrySettle } from "./telemetrySettle.ts";
import { shownAfter } from "./telemetryChoice.ts";
import { followerChoiceSaved } from "./telemetryChoiceApply.ts";
import { handleTelemetryOp, saveState, setSessionEnded, setTelemetryAnnouncer } from "./telemetryOps.ts";

export { handleTelemetryOp };

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

const recoveredCause = (error: unknown) => (error instanceof Error && error.cause !== undefined ? error.cause : error);

export const reportRecoverableRender = (error: unknown) => captureException(recoveredCause(error), "react_recovered", { handled: true });

let leadership: TelemetryLeadership | null = null;
let offeredInstallId: string | null = null;

const shownChoice = () => JSON.stringify(useTelemetry.getState());

async function refreshState() {
  await refreshDocument(STATE_DOC).catch(report);
  reloadChoice();
  if (savedChoice().installId) offeredInstallId = null;
}

const relayedConsent = (consent: unknown) => (typeof consent === "string" && consent ? (consent as ConsentToken) : null);

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
      capture: (event, props, consent, captureOptions) => forward({ kind: "capture", event, props, options: { ...captureOptions }, consent }),
      log: (level, message, attributes, consent) => forward({ kind: "log", level, message, attributes, consent }),
      resetId: async () => {
        const installId = await current.request("reset", RESET_TIMEOUT_MS);
        await refreshState();
        if (typeof installId !== "string") throw Object.assign(new Error("The anonymous ID wasn't reset"), { code: "ERR_TELEMETRY_RESET" });
        return installId;
      },
      change: (change) => {
        const shown = shownAfter(change);
        if (shown) useTelemetry.setState(shown);
        return followerChoiceSaved(current.request("choice", RESET_TIMEOUT_MS, JSON.stringify(change)), refreshState, report);
      },
      installId: () => {
        const known = savedChoice().installId;
        if (known) return known;
        const id = (offeredInstallId ??= uuidv4());
        void current.request("choice", RESET_TIMEOUT_MS, JSON.stringify({ kind: "installId", id } satisfies ChoiceChange)).catch(report).then(refreshState);
        return id;
      },
    }),
    deliver: (message) => message.kind === "capture" ? capture(message.event, message.props, relayedConsent(message.consent), message.options) : queueLog(message.level, message.message, message.attributes, relayedConsent(message.consent)),
    handle: handleTelemetryOp,
    lead: async () => {
      await Promise.all(TELEMETRY_DOCUMENTS.map((name) => refreshDocument(name).catch(report)));
      const continuing = await continuesSession(host);
      reloadChoice();
      setSessionEnded(continuing && !savedChoice().sessionOpen);
      startTelemetry({ continuing });
      await documentSaved(STATE_DOC).catch(report);
      current.announce();
    },
    changed: () => void refreshState(),
    report,
  });
  leadership = current;
  setTelemetryAnnouncer(current, report);
  let announced = shownChoice();
  useTelemetry.subscribe(() => {
    const next = shownChoice();
    if (next === announced) return;
    announced = next;
    if (current.leading()) void documentSaved(STATE_DOC).catch(report).then(() => current.announce());
  });
  setInterval(() => {
    if (!current.leading()) emitWindowUsage(consentNow());
  }, WINDOW_USAGE_MS);
  return current;
}

export async function settleHostTelemetry(endsSession: boolean): Promise<string | null> {
  if (!leadership) return null;
  if (!endsSession || !leadership.leading()) emitWindowUsage(consentNow());
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
