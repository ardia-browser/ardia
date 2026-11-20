import { consentToken, type ConsentToken } from "../telemetry/choice";
import { nativeConsent } from "../telemetry/nativeConsent";
import {
  answerPasskey,
  deleteVaultPasskey,
  onPasskeyDone,
  onPasskeyOffer,
  onPasskeyRequest,
  onPasskeysChanged,
  onVaultItemsChanged,
  vaultPasskeys,
  type VaultItem,
  type VaultPasskey,
  type VaultPasskeyAnswer,
  type VaultPasskeyDone,
  type VaultPasskeyRequest,
} from "../../platform/vaults";
import { notePasskeyChooser, notePasskeyDeleted, notePasskeyOutcome } from "../telemetry/vaultCounts";
import { noteObservedExtensions, passkeyVendorOf, startPasskeySources } from "./passkeySources";
import { dismissVaultMenu, patchVaultMenu, vaultMenuOf, type VaultMenu } from "./menu";
import type { VaultRow } from "./menuModel";
import { usePasskeys, type PasskeySheet } from "./passkeyStore";
import { passkeyTarget } from "./passkeyTarget";
import { useBrowser } from "../browser/store";
import { brandOf } from "./brands";
import { currentVaultProviders } from "./store";

export { usePasskeys, type PasskeySheet };

const FAILED = "Couldn't use the passkey. Try again.";
const GONE = "The page moved on. Try again from the page.";

let sheetSeq = 0;

function withoutRequest<T extends { requestId: string }>(all: Record<string, T>, requestId: string): Record<string, T> {
  const left = Object.entries(all).filter(([, value]) => value.requestId !== requestId);
  return left.length === Object.keys(all).length ? all : Object.fromEntries(left);
}

function refreshMenuOf(tabId: string) {
  if (vaultMenuOf(tabId)) patchVaultMenu(tabId, {});
}

function noteRequest(request: VaultPasskeyRequest, consent: ConsentToken | null) {
  noteObservedExtensions((request.extensions ?? []).map((e) => e.id));
  if (request.choose) notePasskeyChooser(consent);
  const selected = request.passkeys[0]?.id ?? null;
  const { target, targets, note } = passkeyTarget(currentVaultProviders(), useBrowser.getState().settings.vaultSaveTarget, (id) => brandOf(id).name);
  const sheet: PasskeySheet = { ...request, seq: ++sheetSeq, selected, busy: false, error: null, target, targets, targetNote: note };
  usePasskeys.setState((s) => ({ sheets: { ...s.sheets, [request.tabId]: sheet } }));
}

function noteOffer(request: VaultPasskeyRequest) {
  noteObservedExtensions((request.extensions ?? []).map((e) => e.id));
  usePasskeys.setState((s) => ({ offers: { ...s.offers, [request.tabId]: request } }));
  refreshMenuOf(request.tabId);
}

function noteDone(done: VaultPasskeyDone, consent: ConsentToken | null) {
  const direct = !done.via || done.via === "ardia" || done.via === "chrome" || done.via === "bitwarden";
  const via = direct ? done.via : `extension:${passkeyVendorOf(done.via!)}`;
  if (!direct) noteObservedExtensions([done.via!]);
  notePasskeyOutcome(done.outcome, via, consent);
  if (!done.requestId) return;
  const before = usePasskeys.getState();
  usePasskeys.setState((s) => ({ sheets: withoutRequest(s.sheets, done.requestId), offers: withoutRequest(s.offers, done.requestId) }));
  if (before.offers[done.tabId]?.requestId === done.requestId) refreshMenuOf(done.tabId);
}

let loading: Promise<void> | null = null;
let again = false;

export function loadPasskeys(): Promise<void> {
  if (loading) {
    again = true;
    return loading;
  }
  loading = vaultPasskeys()
    .then((list) => usePasskeys.setState({ list: [...list].sort((a, b) => a.rpId.localeCompare(b.rpId) || a.userName.localeCompare(b.userName)) }))
    .catch(() => undefined)
    .finally(() => {
      loading = null;
      if (again) {
        again = false;
        void loadPasskeys();
      }
    });
  return loading;
}

let started = false;

export function startPasskeys() {
  if (started) return;
  started = true;
  startPasskeySources();
  onPasskeyRequest((request) => noteRequest(request, nativeConsent(request)));
  onPasskeyOffer(noteOffer);
  onPasskeyDone((done) => noteDone(done, nativeConsent(done)));
  onPasskeysChanged(() => void loadPasskeys());
  onVaultItemsChanged((provider) => provider === "bitwarden" && void loadPasskeys());
  void loadPasskeys();
}

function patchSheet(tabId: string, seq: number, patch: Partial<PasskeySheet>) {
  usePasskeys.setState((s) => {
    const sheet = s.sheets[tabId];
    if (!sheet || sheet.seq !== seq) return s;
    return { sheets: { ...s.sheets, [tabId]: { ...sheet, ...patch } } };
  });
}

export const choosePasskeyTarget = (tabId: string, target: string) => {
  const sheet = usePasskeys.getState().sheets[tabId];
  if (sheet && !sheet.busy && sheet.targets.includes(target)) patchSheet(tabId, sheet.seq, { target, targetNote: null, error: null });
};

export const selectPasskey = (tabId: string, id: string) => {
  const sheet = usePasskeys.getState().sheets[tabId];
  if (sheet && !sheet.busy) patchSheet(tabId, sheet.seq, { selected: id, error: null });
};

const errorText = (error: VaultPasskeyAnswer["error"]) => (error === "gone" ? GONE : error === "declined" || error === "busy" ? null : FAILED);

export async function answerPasskeySheet(tabId: string, choice: "save" | "existing" | "use" | "cancel" | "other" | "system" | `source:${string}`) {
  const sheet = usePasskeys.getState().sheets[tabId];
  if (!sheet || sheet.busy) return;
  const picked = choice === "use" ? sheet.selected : choice;
  if (!picked) return;
  const quiet = choice === "cancel" || choice === "other" || choice.startsWith("source:");
  if (!quiet) patchSheet(tabId, sheet.seq, { busy: true, error: null });
  const target = choice === "save" ? sheet.target : undefined;
  const result = await answerPasskey(sheet.requestId, picked, target).catch((): VaultPasskeyAnswer => ({ ok: false, error: "failed" }));
  if (result.ok) return;
  if (result.error === "gone") {
    usePasskeys.setState((s) => ({ sheets: withoutRequest(s.sheets, sheet.requestId) }));
    return;
  }
  const failure = result.error === "unavailable" ? `${brandOf(sheet.target).name} is locked. Unlock it, or save to Ardia.` : result.message || errorText(result.error);
  patchSheet(tabId, sheet.seq, { busy: false, error: failure });
}

export async function pickPasskeyFromMenu(tabId: string, menu: VaultMenu, row: VaultRow, item: VaultItem) {
  const passkey = item.passkey;
  if (!passkey) return;
  patchVaultMenu(tabId, { busy: row.key, error: null }, menu.seq);
  const result = await answerPasskey(passkey.requestId, passkey.credentialId).catch((): VaultPasskeyAnswer => ({ ok: false, error: "failed" }));
  if (vaultMenuOf(tabId)?.seq !== menu.seq) return;
  if (result.ok) return dismissVaultMenu(tabId);
  patchVaultMenu(tabId, { busy: null, error: errorText(result.error), touch: "off" }, menu.seq);
}

export const deletePasskey = (id: string) => runDeletePasskey(id, consentToken());

async function runDeletePasskey(id: string, consent: ConsentToken | null): Promise<{ ok: boolean; error: string | null }> {
  const result = await deleteVaultPasskey(id).catch(() => null);
  if (result?.deleted) {
    notePasskeyDeleted(consent);
    await loadPasskeys();
    return { ok: true, error: null };
  }
  if (result?.error === "declined") return { ok: false, error: null };
  return { ok: false, error: "Couldn't delete the passkey. Try again." };
}

export function passkeyOfLogin(list: readonly VaultPasskey[] | null, url: string | null, username: string): VaultPasskey | null {
  const host = url?.match(/^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase() ?? null;
  const name = username.trim().toLowerCase();
  if (!host || !name) return null;
  return (list ?? []).find((p) => (host === p.rpId || host.endsWith(`.${p.rpId}`)) && (p.userName.toLowerCase() === name || p.displayName.toLowerCase() === name)) ?? null;
}
