import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { readDocument, writeDocument } from "../../platform/documents";
import { utcDay } from "../../lib/time";

export const FREEZE_SENDS_DOC = "freeze-sends.json";
export const FREEZE_SENDS_VERSION = 1;
export const MAX_FREEZES_PER_DAY = 20;
const SIGNATURE = /^[0-9a-z_]{1,16}$/;

type Sends = { day: string; sent: number; signatures: string[] };

export function sendsOn(now = Date.now()): Sends {
  const day = utcDay(now);
  try {
    const doc = parseSaved(readDocument(FREEZE_SENDS_DOC), FREEZE_SENDS_VERSION);
    if (doc && doc.day === day && Number.isSafeInteger(doc.sent) && (doc.sent as number) >= 0 && Array.isArray(doc.signatures)) {
      const signatures = doc.signatures.filter((s): s is string => typeof s === "string" && SIGNATURE.test(s)).slice(0, MAX_FREEZES_PER_DAY);
      return { day, sent: Math.min(doc.sent as number, MAX_FREEZES_PER_DAY), signatures };
    }
  } catch {}
  return { day, sent: 0, signatures: [] };
}

export function claimDailySend(signature: string, now = Date.now()): boolean {
  const today = sendsOn(now);
  if (today.sent >= MAX_FREEZES_PER_DAY || today.signatures.includes(signature)) return false;
  try {
    writeDocument(FREEZE_SENDS_DOC, versionedJson({ day: today.day, sent: today.sent + 1, signatures: [...today.signatures, signature] }, FREEZE_SENDS_VERSION));
  } catch {
    return false;
  }
  return sendsOn(now).sent === today.sent + 1;
}
