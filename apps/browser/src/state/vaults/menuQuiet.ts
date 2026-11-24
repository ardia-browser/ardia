import type { ConsentToken } from "../telemetry/choice";
import type { VaultField, VaultFieldKind } from "../../platform/vaults";

type FrameId = VaultField["frameId"];
type Quiet = { frameId: FrameId; kind: VaultFieldKind; until: number | null };

const quiet = new Map<string, Quiet>();
const declined = new Map<string, number>();
const offered = new Map<string, { at: number; consent: ConsentToken | null }>();
const shown = new Map<string, number>();

export const AFTER_FILL_QUIET_MS = 1500;

export function quietVaultField(tabId: string, menu: { frameId: FrameId; field: VaultFieldKind }, forMs: number | null) {
  quiet.set(tabId, { frameId: menu.frameId, kind: menu.field, until: forMs === null ? null : Date.now() + forMs });
}

export function isQuiet(tabId: string, event: Pick<VaultField, "frameId" | "kind">) {
  const hush = quiet.get(tabId);
  if (!hush) return false;
  const same = hush.frameId === event.frameId && hush.kind === event.kind;
  if (!same || (hush.until !== null && Date.now() > hush.until)) {
    quiet.delete(tabId);
    return false;
  }
  return true;
}

export const declineField = (tabId: string, at: number) => void declined.set(tabId, at);
export const declinedAt = (tabId: string, at: number) => declined.get(tabId) === at;

export function hearFieldAgain(tabId: string) {
  quiet.delete(tabId);
  declined.delete(tabId);
  offered.delete(tabId);
  shown.delete(tabId);
}

export const noteFieldOffered = (tabId: string, at: number, consent: ConsentToken | null) => void offered.set(tabId, { at, consent });
export const noteFieldShown = (tabId: string, at: number) => void shown.set(tabId, at);
export const offeredField = (tabId: string, at: number) => offered.get(tabId)?.at === at || shown.get(tabId) === at;
export const unansweredField = (tabId: string, at: number) => offered.get(tabId)?.at === at && shown.get(tabId) !== at;
export const offerConsentOf = (tabId: string) => offered.get(tabId)?.consent ?? null;

export const quietTabIds = () => [...quiet.keys(), ...declined.keys(), ...offered.keys(), ...shown.keys()];
