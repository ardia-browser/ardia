import { consentToken, type ConsentToken } from "../telemetry/choice";
import { addVaultTotp, copyConcealed, copyFromVault, copyVaultCode, forgetVaultCodeOffer, importVaultCodes, noteArdiaLoginChanged, readVaultCode, removeVaultTotp, vaultTotp, type VaultCodeReadError, type VaultCodeSource, type VaultItem } from "../../platform/vaults";
import { activeTabId } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { noteStandaloneCodesImported, noteVaultCodeCopied, noteVaultCodeReadMissed, noteVaultCodeRemoved, noteVaultCodeSetUp } from "../telemetry/vaultCounts";
import { ARDIA_PROVIDER, itemsForProfile } from "./ardia";
import { forgetVaultCode } from "./codes";
import { isSecureOrigin, sameSite, sameUsername, siteLabel } from "./originMatch";
import { loadVaultItems } from "./store";
import { addTotpErrorText } from "./totpSetupModel";

type CodeSetupChoice = { id: VaultCodeSource; title: string };
export type CodeOutcome = { ok: true } | { ok: false; error: string | null };

const OK: CodeOutcome = { ok: true };
const quiet: CodeOutcome = { ok: false, error: null };
const failed = (error: string): CodeOutcome => ({ ok: false, error });

export function ardiaLoginOf(items: readonly VaultItem[], profile: string, origin: string, username: string): VaultItem | null {
  const trimmed = origin.replace(/\/+$/, "").toLowerCase();
  return (
    itemsForProfile(items, profile).find(
      (item) => item.provider === ARDIA_PROVIDER && sameUsername(item.username, username) && (item.urls[0] ?? "").replace(/\/+$/, "").toLowerCase() === trimmed,
    ) ?? null
  );
}

export function codePageTab(s: BrowserState, origin: string): string | null {
  const windowId = s.ui.focusOrder.find((id) => !!s.windows[id]);
  const tabId = windowId ? activeTabId(s, windowId) : undefined;
  const url = tabId ? s.tabs[tabId]?.url : undefined;
  return tabId && url && isSecureOrigin(url) && sameSite(url, origin) ? tabId : null;
}

export function frontPageTab(s: BrowserState): { tabId: string; origin: string } | null {
  const windowId = s.ui.focusOrder.find((id) => !!s.windows[id]);
  const tabId = windowId ? activeTabId(s, windowId) : undefined;
  const url = tabId ? s.tabs[tabId]?.url : undefined;
  if (!tabId || !url || !isSecureOrigin(url)) return null;
  try {
    return { tabId, origin: new URL(url).origin };
  } catch {
    return null;
  }
}

export const currentFrontPageTab = () => frontPageTab(useBrowser.getState());

export function codeSetupChoices(origin: string, pageTab: string | null): CodeSetupChoice[] {
  const choices: CodeSetupChoice[] = [
    { id: "clipboard", title: "Paste Setup Key" },
    { id: "image", title: "Choose QR Code Image…" },
  ];
  return pageTab ? [...choices, { id: "page", title: `Scan QR Code on ${siteLabel(origin)}` }] : choices;
}

export function codeReadErrorText(error: VaultCodeReadError, source: VaultCodeSource, origin: string): string | null {
  switch (error) {
    case "declined":
      return null;
    case "many":
      return "There's more than one QR code. Crop the picture to one and try again.";
    case "unreadable":
      return source === "page" ? "Couldn't see the page. Bring it to the front and try again." : "Couldn't open that picture.";
    case "none":
      if (source === "clipboard") return "Copy the setup key or otpauth link first.";
      if (source === "page") return `No QR code for a verification code on ${siteLabel(origin)}.`;
      return "That picture has no QR code for a verification code.";
  }
}

export const setUpArdiaCode = (item: VaultItem, source: VaultCodeSource, tabId: string | null = null) => runSetUpArdiaCode(item, source, tabId, consentToken());

async function runSetUpArdiaCode(item: VaultItem, source: VaultCodeSource, tabId: string | null, consent: ConsentToken | null): Promise<CodeOutcome> {
  const origin = item.urls[0] ?? "";
  const read = await readVaultCode(source, origin, tabId ?? undefined).catch(() => ({ error: "unreadable" as const }));
  if (read.error !== undefined) {
    if (read.error !== "declined") noteVaultCodeReadMissed(consent);
    const text = codeReadErrorText(read.error, source, origin);
    return text ? failed(text) : quiet;
  }
  const result = await addVaultTotp(item.provider, item.id, read.token).catch(() => null);
  if (!result?.added) {
    void forgetVaultCodeOffer(read.token).catch(() => undefined);
    if (result?.error === "declined") return quiet;
    return failed(addTotpErrorText(result ?? { error: "failed" }, "Ardia"));
  }
  noteVaultCodeSetUp(source, 1, consent);
  forgetVaultCode(item);
  await loadVaultItems(item.provider, true);
  return OK;
}

export const removeArdiaCode = (item: VaultItem) => runRemoveArdiaCode(item, consentToken());

async function runRemoveArdiaCode(item: VaultItem, consent: ConsentToken | null): Promise<CodeOutcome> {
  const result = await removeVaultTotp(item.provider, item.id).catch(() => null);
  if (result?.error === "declined") return quiet;
  if (!result?.removed) return failed("Couldn't remove the verification code. Try again.");
  noteVaultCodeRemoved(consent);
  forgetVaultCode(item);
  await loadVaultItems(item.provider, true);
  return OK;
}

export async function copyArdiaCode(item: VaultItem): Promise<boolean> {
  const consent = consentToken();
  const result = await copyVaultCode(item.provider, item.id).catch(() => null);
  if (!result?.copied) return false;
  noteVaultCodeCopied(consent);
  return true;
}

export const currentCodePageTab = (origin: string) => codePageTab(useBrowser.getState(), origin);

export const ardiaLoginRenamed = (profile: string, origin: string, from: string, to: string) =>
  from === to ? Promise.resolve() : noteArdiaLoginChanged(profile, origin, from, to).then(() => loadVaultItems(ARDIA_PROVIDER, true), () => undefined);

export const ardiaLoginDeleted = (profile: string, origin: string, username: string) =>
  noteArdiaLoginChanged(profile, origin, username, null).then(() => loadVaultItems(ARDIA_PROVIDER, true), () => undefined);

export async function importArdiaCodes(profile: string, path: string, consent: ConsentToken | null): Promise<number> {
  const { imported, standalone = 0 } = await importVaultCodes(profile, path).catch(() => ({ imported: 0, standalone: 0 }));
  if (imported > 0) {
    noteVaultCodeSetUp("import", imported - standalone, consent);
    if (standalone > 0) noteStandaloneCodesImported(standalone, consent);
    await loadVaultItems(ARDIA_PROVIDER, true);
  }
  return imported;
}

export async function copySavedPassword(item: VaultItem | null, password: string | null): Promise<boolean> {
  if (item) {
    const reply = await copyFromVault(item.provider, item.id, "password").catch(() => null);
    if (reply?.copied || reply?.declined) return !!reply.copied;
  }
  if (!password) return false;
  return !!(await copyConcealed(password).catch(() => null))?.copied;
}

export const readArdiaCode = (item: Pick<VaultItem, "provider" | "id">) => vaultTotp(item.provider, item.id).catch(() => null);
