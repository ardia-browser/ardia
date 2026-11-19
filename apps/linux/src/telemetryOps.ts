import { resetAnonymousId } from "../../browser/src/state/telemetry/index.ts";
import { endSession, saveQueueNow } from "../../browser/src/state/telemetry/client";
import { reopenSession } from "../../browser/src/state/telemetry/sessionControl";
import { reopenSessionAfterCancelledQuit } from "../../browser/src/state/telemetry/sessionQuit";
import { sessionEnding } from "../../browser/src/state/telemetry/usage";
import { documentSaved } from "../../browser/src/platform/documents";
import type { TelemetryOp } from "./telemetryLeader.ts";
import { createEndLedger } from "./telemetrySettle.ts";
import { parseChoiceChange } from "./telemetryChoice.ts";
import { applyChoiceDurably } from "./telemetryChoiceApply.ts";

const STATE_DOC = "telemetry.json";
const END_TIMEOUT_MS = 2_000;

let sessionEnded = false;
let announcer: { announce(): void } | null = null;
let report: (error: unknown) => void = () => {};
const ends = createEndLedger();

export const setSessionEnded = (ended: boolean) => void (sessionEnded = ended);
export function setTelemetryAnnouncer(next: { announce(): void } | null, reportError: (error: unknown) => void) {
  announcer = next;
  report = reportError;
}

export async function saveState() {
  await saveQueueNow(END_TIMEOUT_MS);
  await documentSaved(STATE_DOC).catch(report);
}

export async function handleTelemetryOp(op: TelemetryOp, arg?: string): Promise<unknown> {
  if (op === "choice") {
    const change = parseChoiceChange(arg);
    if (!change) throw Object.assign(new Error("The telemetry choice isn't one this build knows"), { code: "ERR_TELEMETRY_CHOICE" });
    const durable = await applyChoiceDurably(change);
    announcer?.announce();
    return durable;
  }
  if (op === "reset") {
    const installId = await resetAnonymousId();
    await documentSaved(STATE_DOC);
    announcer?.announce();
    return installId;
  }
  if (op === "reopen") {
    if (!ends.reopens(arg)) return false;
    if (!reopenSessionAfterCancelledQuit()) reopenSession();
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
