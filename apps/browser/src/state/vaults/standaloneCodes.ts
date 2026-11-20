import { consentToken, type ConsentToken } from "../telemetry/choice";
import { create } from "zustand";
import { addStandaloneCode, deleteStandaloneCode, editStandaloneCode, forgetVaultCodeOffer, onStandaloneCodesChanged, readVaultCode, standaloneCodes, type VaultCodeSource, type VaultItem, type VaultStandaloneCode } from "../../platform/vaults";
import { noteStandaloneCodeCreated, noteStandaloneCodeDeleted, noteVaultCodeReadMissed } from "../telemetry/vaultCounts";
import { codeReadErrorText, type CodeOutcome } from "./ardiaCodes";
import { forgetVaultCode } from "./codes";
import { codeItem, sortedCodes } from "./standaloneCodesModel";

type CodesState = { codes: VaultStandaloneCode[] | null; items: VaultItem[] };

export const useStandaloneCodes = create<CodesState>()(() => ({ codes: null, items: [] }));

const NONE: VaultItem[] = [];
let loading: Promise<void> | null = null;
let queued: Promise<void> | null = null;

function adopt(list: readonly VaultStandaloneCode[]) {
  const codes = sortedCodes(list);
  useStandaloneCodes.setState({ codes, items: codes.length ? codes.map(codeItem) : NONE });
}

export function loadStandaloneCodes(): Promise<void> {
  if (!loading) {
    loading = standaloneCodes()
      .then(adopt, () => undefined)
      .finally(() => {
        loading = null;
      });
    return loading;
  }
  const next = (queued ??= loading.then(() => {
    queued = null;
    return loadStandaloneCodes();
  }));
  return next;
}

export const currentCodeItems = () => useStandaloneCodes.getState().items;

let started = false;

export function startStandaloneCodes() {
  if (started) return;
  started = true;
  onStandaloneCodesChanged(() => void loadStandaloneCodes());
  void loadStandaloneCodes();
}

export const readSetupCode = (source: VaultCodeSource, origin: string, tabId: string | null) => runReadSetupCode(source, origin, tabId, consentToken());

async function runReadSetupCode(source: VaultCodeSource, origin: string, tabId: string | null, consent: ConsentToken | null): Promise<{ read: { token: string; issuer: string; account: string } } | { outcome: CodeOutcome }> {
  const read = await readVaultCode(source, origin, tabId ?? undefined).catch(() => ({ error: "unreadable" as const }));
  if (read.error === undefined) return { read };
  if (read.error !== "declined") noteVaultCodeReadMissed(consent);
  const text = codeReadErrorText(read.error, source, origin);
  return { outcome: text ? { ok: false, error: text } : { ok: false, error: null } };
}

export const forgetSetupCode = (token: string) => void forgetVaultCodeOffer(token).catch(() => undefined);

const ADD_ERRORS: Record<string, string> = {
  expired: "The code expired. Set it up again.",
  invalid: "Check the label and website.",
  exists: "This code is already saved.",
  failed: "Couldn't save the code. Try again.",
};

export async function createStandaloneCode(code: { token: string; label: string; issuer: string; website: string | null }): Promise<CodeOutcome> {
  const consent = consentToken();
  const result = await addStandaloneCode({ token: code.token, label: code.label.trim(), ...(code.issuer.trim() ? { issuer: code.issuer.trim() } : {}), ...(code.website ? { website: code.website } : {}) }).catch(() => null);
  if (result?.added) {
    noteStandaloneCodeCreated(consent);
    await loadStandaloneCodes();
    return { ok: true };
  }
  if (result?.error === "declined") return { ok: false, error: null };
  return { ok: false, error: ADD_ERRORS[result?.error ?? "failed"] ?? ADD_ERRORS.failed! };
}

export async function renameStandaloneCode(id: string, label: string, website: string | null): Promise<CodeOutcome> {
  const result = await editStandaloneCode(id, label.trim(), website ?? "").catch(() => null);
  if (!result?.saved) return { ok: false, error: result?.error === "invalid" ? "Check the label and website." : "Couldn't save the change. Try again." };
  await loadStandaloneCodes();
  return { ok: true };
}

export const removeStandaloneCode = (id: string) => runRemoveStandaloneCode(id, consentToken());

async function runRemoveStandaloneCode(id: string, consent: ConsentToken | null): Promise<CodeOutcome> {
  const result = await deleteStandaloneCode(id).catch(() => null);
  if (result?.error === "declined") return { ok: false, error: null };
  if (!result?.deleted) return { ok: false, error: "Couldn't delete the code. Try again." };
  noteStandaloneCodeDeleted(consent);
  forgetVaultCode({ provider: "ardia", id });
  await loadStandaloneCodes();
  return { ok: true };
}
