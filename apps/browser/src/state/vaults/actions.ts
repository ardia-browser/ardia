import {
  answerVault,
  cancelVaultSignIn,
  configureVault,
  copyFromVault,
  type VaultCopyField,
  lockVault,
  refreshVault,
  signInVault,
  signOutVault,
  unlockVault,
  type VaultHandOn,
  type VaultProviderState,
  type VaultAnswer,
  type VaultSignInRequest,
  type VaultSignInResult,
} from "../../platform/vaults";
import { openExternalURL } from "../../platform/app";
import { copyText } from "../../platform/clipboard";
import { showToast } from "../app/toasts";
import { useBrowser } from "../browser/store";
import { openSettings, openUrlFromSettings, SETTINGS_DETAIL, useSettingsNav } from "../settings/settingsWindows";
import { recordArdiaChoice } from "../site/ardiaChoice";
import { regularProfileId } from "../site/passwordManagerChoice";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { noteArdiaChoiceRecorded } from "../telemetry/vaultCounts";
import { applyProviderState, clearVaultIndex, currentVaultProviders, loadAllVaultItems, loadVaultProviders, vaultManagerName, vaultProviderOf } from "./store";
import { isArdiaProvider, passwordManagersOnly } from "./ardia";
import { restartProcess } from "../plugins/process";
import { CANCELLED_SIGN_IN, FAILED_SIGN_IN, signInMessage, wasCancelled } from "./signInFlow";

export type { VaultAnswer, VaultCopyField, VaultProviderState, VaultSignInRequest, VaultSignInResult };

function failure(provider: string, error: string): VaultSignInResult {
  const state = vaultProviderOf(provider);
  return state ? { ok: false, state, error } : ({ ok: false, error } as VaultSignInResult);
}

const attempts = new Map<string, number>();
const nextAttempt = (provider: string) => {
  const attempt = (attempts.get(provider) ?? 0) + 1;
  attempts.set(provider, attempt);
  return attempt;
};

export { wasCancelled };

function connectedFrom(handOn: VaultHandOn | undefined, from: string | null): string | null {
  const s = useBrowser.getState();
  const tabProfile = handOn?.tab ? s.tabs[handOn.tab]?.profileId : undefined;
  const nav = useSettingsNav.getState();
  const id = from ?? tabProfile ?? (nav.pane === "profiles" ? nav.profileId : null);
  return id && s.profiles[regularProfileId(id)] ? regularProfileId(id) : null;
}

async function withResult(provider: string, from: string | null, consent: ConsentToken | null, run: () => Promise<VaultSignInResult>): Promise<VaultSignInResult> {
  const attempt = nextAttempt(provider);
  try {
    const result = await run();
    if (attempts.get(provider) !== attempt) return failure(provider, CANCELLED_SIGN_IN);
    if (result.state) applyProviderState(result.state);
    if (result.ok && from !== null && !isArdiaProvider(provider) && recordArdiaChoice(from)) noteArdiaChoiceRecorded(consent);
    return result;
  } catch {
    return failure(provider, attempts.get(provider) === attempt ? FAILED_SIGN_IN : CANCELLED_SIGN_IN);
  }
}

async function withState(run: () => Promise<VaultProviderState>): Promise<VaultProviderState | null> {
  try {
    const state = await run();
    applyProviderState(state);
    return state;
  } catch {
    return null;
  }
}

export const unlockProvider = (provider: string, passwordEntry: string | null = null, handOn?: VaultHandOn, from: string | null = null, consent?: ConsentToken | null) =>
  withResult(provider, connectedFrom(handOn, from), consent === undefined ? consentToken() : consent, () => unlockVault(provider, passwordEntry, handOn));
export const signInProvider = (provider: string, request: VaultSignInRequest, from: string | null = null, consent?: ConsentToken | null) =>
  withResult(provider, connectedFrom(undefined, from), consent === undefined ? consentToken() : consent, () => signInVault(provider, request));
export const answerProvider = (provider: string, answer: VaultAnswer, from: string | null = null, consent?: ConsentToken | null) =>
  withResult(provider, connectedFrom(undefined, from), consent === undefined ? consentToken() : consent, () => answerVault(provider, answer));
export const lockProvider = (provider: string) => withState(() => lockVault(provider));
export const signOutProvider = (provider: string) => withState(() => signOutVault(provider));
export const refreshProvider = (provider: string) => withState(() => refreshVault(provider));
export const configureProvider = (provider: string, server: string | null) => withState(() => configureVault(provider, server));
export function cancelProviderSignIn(provider: string) {
  nextAttempt(provider);
  return withState(() => cancelVaultSignIn(provider));
}

export async function lockAllProviders() {
  const unlocked = passwordManagersOnly(currentVaultProviders()).filter((p) => p.state === "unlocked");
  clearVaultIndex();
  await Promise.all(unlocked.map((p) => lockProvider(p.id)));
}

export const reloadProviders = () => loadVaultProviders();

export const openProviderApp = (url: string) => void openExternalURL(url);
export const openApprovalPage = (url: string) => openUrlFromSettings(url);
export function openPasswordSettings(profileId: string | null = null) {
  const s = useBrowser.getState();
  const id = profileId === null ? null : regularProfileId(profileId);
  openSettings("profiles", id && s.profiles[id] ? id : null, SETTINGS_DETAIL.passwords);
}
export const copyInstallCommand = (command: string) => copyText(command);
export const restartProvider = (plugin: string) => restartProcess(plugin);

export function toastInTab(tabId: string, title: string, key: string, failed = false) {
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;
  if (windowId) showToast(windowId, title, undefined, { icon: failed ? "exclamationmark.circle" : "key", key });
}

export async function unlockForPick(tabId: string, provider: Pick<VaultProviderState, "id" | "name">, toastKey: string, fillOrigin?: string): Promise<boolean> {
  const result = await unlockProvider(provider.id, null, fillOrigin ? { tab: tabId, origin: fillOrigin } : undefined);
  if (!result.ok) {
    if (result.needs === "password") openPasswordSettings(useBrowser.getState().tabs[tabId]?.profileId ?? null);
    else toastInTab(tabId, `Couldn't unlock ${provider.name}. Try again.`, toastKey, true);
    return false;
  }
  await loadAllVaultItems(true);
  return true;
}

export const signInError = signInMessage;

export type VaultCopyOutcome = "copied" | "declined" | "locked" | "notFound" | "failed";

type VaultCopyReply = { copied?: boolean; declined?: boolean; error?: string } | null | undefined;

export function copyOutcomeOf(reply: VaultCopyReply): VaultCopyOutcome {
  if (reply?.copied) return "copied";
  if (reply?.declined) return "declined";
  if (reply?.error === "locked" || reply?.error === "notFound") return reply.error;
  return "failed";
}

export async function copyFromManager(provider: string, id: string, field: VaultCopyField): Promise<VaultCopyOutcome> {
  return copyOutcomeOf(await copyFromVault(provider, id, field).catch(() => null));
}

const FIELD_NOUN: Record<VaultCopyField, string> = { username: "username", password: "password" };

export function copyFailureMessage(outcome: VaultCopyOutcome, field: VaultCopyField, provider: string): string {
  const name = vaultManagerName(provider);
  const noun = FIELD_NOUN[field];
  if (outcome === "copied" || outcome === "declined") return "";
  if (outcome === "locked") return `Unlock ${name} to copy the ${noun}.`;
  if (outcome === "notFound") return `${name} has no ${noun} for this login.`;
  return `Couldn't copy the ${noun} from ${name}. Try again.`;
}
