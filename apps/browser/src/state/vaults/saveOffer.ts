import { consentToken, type ConsentToken } from "../telemetry/choice";
import { ardiaSavesInTab, vaultsSupported } from "./ardiaSources";
import { create } from "zustand";
import type { VaultItem, VaultProviderState, VaultSubmission } from "../../platform/vaults";
import { webviews } from "../../platform/webviews";
import { hideKeyedToast, showToast } from "../app/toasts";
import { noteVaultLoginFailedAfterNavigation, noteVaultPasswordUpdatedFromOffer } from "../telemetry/vaultCounts";
import { useBrowser } from "../browser/store";
import { patchPage, pageOf } from "../tabs/pageState";
import { filledUsername, forgetFilledUsernamesOutside, rememberedVaultAccount, rememberVaultAccount } from "./accounts";
import { ARDIA_PROVIDER, isArdiaProvider, itemsForTab } from "./ardia";
import { isSecureOrigin, itemKey, itemTier, loginSavedIn, sameSite, sameUsername, siteLabel, TIER } from "./originMatch";
import { PENDING_TOTP_MS } from "./pendingTotp";
import { allVaultItems, currentVaultProviders, loadAllVaultItems, loadVaultItems, vaultManagerName } from "./store";

export type VaultUpdateTarget = { provider: string; id: string };

export type VaultSaveOffer = {
  seq: number;
  update?: VaultUpdateTarget | null;
  origin: string;
  captured: string;
  username: string;
  editing: boolean;
  needsUsername: boolean;
  targets: string[];
  target: string;
  error: string | null;
};

export const useVaultSaveOffers = create<Record<string, VaultSaveOffer | null>>()(() => ({}));

const SAVE_OFFER_MS = PENDING_TOTP_MS;
export const SAME_SUBMISSION_MS = 2000;
const LOGIN_OUTCOME_MS = 8000;

type SaveInput = { enabled: boolean; origin: string; username: string; providers: readonly VaultProviderState[]; items: readonly VaultItem[]; preferred: string; checkSaved?: boolean };
type SaveDecision = { offer: false; alreadySaved: boolean } | { offer: true; targets: string[]; target: string };

export const saveTargets = (providers: readonly VaultProviderState[]) => providers.filter((p) => p.state === "unlocked" && p.capabilities.save).map((p) => p.id);

export const connectedSavers = (providers: readonly VaultProviderState[]) =>
  providers.filter((p) => (p.state === "unlocked" || p.state === "locked") && p.capabilities.save);

export function preferredSaveTarget(providers: readonly VaultProviderState[], chosen: string): string {
  const connected = connectedSavers(providers).map((p) => p.id);
  if (connected.includes(chosen)) return chosen;
  const managers = connected.filter((id) => !isArdiaProvider(id));
  if (managers.length === 1) return managers[0]!;
  return !managers.length && connected.includes(ARDIA_PROVIDER) ? ARDIA_PROVIDER : "";
}

export const chooseSaveTarget = (targets: readonly string[], preferred: string) => (targets.includes(preferred) ? preferred : (targets[0] ?? ""));

export function decideSave({ enabled, origin, username, providers, items, preferred, checkSaved = true }: SaveInput): SaveDecision {
  const unlocked = new Set(providers.filter((p) => p.state === "unlocked").map((p) => p.id));
  if (checkSaved && loginSavedIn(items.filter((i) => unlocked.has(i.provider)), origin, username)) return { offer: false, alreadySaved: true };
  const targets = saveTargets(providers);
  if (!enabled || !isSecureOrigin(origin) || !targets.length) return { offer: false, alreadySaved: false };
  const wanted = preferredSaveTarget(providers, preferred);
  const target = chooseSaveTarget(targets, wanted);
  return { offer: true, targets: target === wanted ? [target] : targets, target };
}

type UpdateInput = { origin: string; username: string; providers: readonly VaultProviderState[]; items: readonly VaultItem[]; remembered: string | null };

export const canEditLogins = (provider: Pick<VaultProviderState, "id" | "capabilities">) => isArdiaProvider(provider.id) || provider.capabilities.edit === true;

export function decideUpdate({ origin, username, providers, items, remembered }: UpdateInput): VaultUpdateTarget | null {
  if (!username.trim() || !isSecureOrigin(origin)) return null;
  const editable = new Set(providers.filter((p) => p.state === "unlocked" && canEditLogins(p)).map((p) => p.id));
  let best: VaultItem | null = null;
  let bestRank = 0;
  for (const item of items) {
    if (!editable.has(item.provider) || !sameUsername(item.username, username)) continue;
    const tier = itemTier(item, origin);
    if (tier < TIER.subdomain) continue;
    const rank = tier * 2 + (itemKey(item) === remembered ? 1 : 0);
    if (rank > bestRank) [best, bestRank] = [item, rank];
  }
  return best ? { provider: best.provider, id: best.id } : null;
}

export function soleSiteUsername(items: readonly VaultItem[], origin: string): string {
  let sole = "";
  for (const item of items) {
    if (itemTier(item, origin) < TIER.subdomain) continue;
    if (!item.username.trim()) return "";
    if (!sole) sole = item.username.trim();
    else if (!sameUsername(sole, item.username)) return "";
  }
  return sole;
}

const FORM_USERNAME_SOURCES: ReadonlySet<string> = new Set(["form", "step"]);

const usernameFromForm = (event: Pick<VaultSubmission, "username" | "usernameFrom">) => !!event.username.trim() && FORM_USERNAME_SOURCES.has(event.usernameFrom ?? "");

function mayAutoSave(event: Pick<VaultSubmission, "username" | "usernameFrom" | "newPassword" | "generated" | "trusted">): boolean {
  if (!event.username.trim()) return false;
  return event.generated === true || (event.newPassword === true && event.trusted === true && usernameFromForm(event));
}

function knownUsername(tabId: string, event: Pick<VaultSubmission, "origin" | "username">, items: readonly VaultItem[]): string {
  const typed = event.username.trim();
  if (typed) return typed;
  const remembered = rememberedVaultAccount(event.origin);
  const login = remembered ? items.find((i) => itemKey(i) === remembered) : undefined;
  return login?.username.trim() || filledUsername(tabId, event.origin).trim();
}

type Claim = { origin: string; at: number; offered: boolean };
const claims = new Map<string, Claim>();
const expiries = new Map<string, ReturnType<typeof setTimeout>>();
const recent = new Map<string, { key: string; at: number }>();
const saving = new Set<string>();
const pageLoads = new Map<string, number>();
const autoSavedOn = new Map<string, Set<string>>();
let seq = 0;

const pageLoadOf = (tabId: string) => pageLoads.get(tabId) ?? 0;

export const NAVIGATED_OUTCOME_MS = 10_000;

type LoginWait = { origin: string; consent: ConsentToken | null; done: (ok: boolean) => void; navigated: () => void; left: boolean };
const loginWaits = new Map<string, LoginWait>();

function waitForLogin(tabId: string, origin: string, consent: ConsentToken | null): Promise<boolean> {
  loginWaits.get(tabId)?.done(false);
  return new Promise((resolve) => {
    let timer = setTimeout(() => finish(false), LOGIN_OUTCOME_MS);
    const wait: LoginWait = {
      origin,
      consent,
      left: false,
      done: (ok) => finish(ok),
      navigated: () => {
        wait.left = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(false), NAVIGATED_OUTCOME_MS);
      },
    };
    function finish(ok: boolean) {
      if (loginWaits.get(tabId) === wait) loginWaits.delete(tabId);
      clearTimeout(timer);
      resolve(ok);
    }
    loginWaits.set(tabId, wait);
  });
}

export function noteVaultLoginOutcome(tabId: string, outcome: { origin: string; ok: boolean }) {
  const wait = loginWaits.get(tabId);
  if (!wait || !sameSite(wait.origin, outcome.origin)) return;
  if (wait.left && !outcome.ok) noteVaultLoginFailedAfterNavigation(wait.consent);
  wait.done(outcome.ok);
}

export function forgetVaultPageSaves(tabId: string) {
  loginWaits.get(tabId)?.navigated();
  pageLoads.set(tabId, pageLoadOf(tabId) + 1);
  autoSavedOn.delete(tabId);
}

export function forgetClosedVaultSaves(tabs: Readonly<Record<string, unknown>>) {
  const known = new Set([...claims.keys(), ...recent.keys(), ...pageLoads.keys(), ...autoSavedOn.keys(), ...loginWaits.keys(), ...expiries.keys(), ...Object.keys(useVaultSaveOffers.getState())]);
  const gone = [...known].filter((tabId) => !(tabId in tabs));
  forgetFilledUsernamesOutside(tabs);
  if (!gone.length) return;
  for (const tabId of gone) {
    loginWaits.get(tabId)?.done(false);
    clearTimeout(expiries.get(tabId));
    for (const map of [claims, recent, pageLoads, autoSavedOn, expiries]) map.delete(tabId);
  }
  useVaultSaveOffers.setState((s) => Object.fromEntries(Object.entries(s).filter(([tabId]) => !gone.includes(tabId))), true);
}

const autoSaveSlot = (load: number, origin: string) => `${load}\n${origin}`;
const autoSavedAlready = (tabId: string, load: number, origin: string) => autoSavedOn.get(tabId)?.has(autoSaveSlot(load, origin)) ?? false;
function spendAutoSave(tabId: string, load: number, origin: string) {
  const used = autoSavedOn.get(tabId) ?? new Set<string>();
  used.add(autoSaveSlot(load, origin));
  autoSavedOn.set(tabId, used);
}

const savingKey = (origin: string, username: string) => `${origin}\n${username.trim().toLowerCase()}`;

export function vaultClaimsPasswordPrompt(tabId: string, prompt: { origin: string; state: string }, now = Date.now()): boolean {
  if (!vaultsSupported) return false;
  const claim = claims.get(tabId);
  if (!claim || !ardiaSavesInTab(tabId) || now - claim.at > SAVE_OFFER_MS || !sameSite(claim.origin, prompt.origin)) return false;
  return claim.offered || prompt.state === "save";
}

const offerOf = (tabId: string) => useVaultSaveOffers.getState()[tabId] ?? null;
function setOffer(tabId: string, offer: VaultSaveOffer | null) {
  clearTimeout(expiries.get(tabId));
  expiries.delete(tabId);
  useVaultSaveOffers.setState((s) => ({ ...s, [tabId]: offer }));
  if (offer) expiries.set(tabId, setTimeout(() => offerOf(tabId)?.seq === offer.seq && dismissVaultOffer(tabId), SAVE_OFFER_MS));
}

const stillWanted = (tabId: string) => !!useBrowser.getState().tabs[tabId] && ardiaSavesInTab(tabId);
const discard = (tabId: string, origin: string) => void webviews.get(tabId)?.discardVaultCapture({ origin })?.catch(() => {});

function claim(tabId: string, origin: string, offered: boolean) {
  claims.set(tabId, { origin, at: Date.now(), offered });
  const chrome = pageOf(tabId).passwordPrompt;
  if (chrome && vaultClaimsPasswordPrompt(tabId, chrome)) patchPage(tabId, { passwordPrompt: null });
}

function seenJustNow(tabId: string, event: VaultSubmission, now: number) {
  const key = [event.origin, event.username.trim().toLowerCase(), event.newPassword ? 1 : 0, event.generated ? 1 : 0].join("\n");
  const last = recent.get(tabId);
  if (last && last.key === key && now - last.at < SAME_SUBMISSION_MS) return true;
  recent.set(tabId, { key, at: now });
  return false;
}

const saveError = (id: string) => `Couldn't save to ${vaultManagerName(id)}. Try again.`;

function showUpdate(tabId: string, origin: string, username: string, update: VaultUpdateTarget) {
  if (!stillWanted(tabId)) return discard(tabId, origin);
  const old = offerOf(tabId);
  if (old && old.origin !== origin) discard(tabId, old.origin);
  setOffer(tabId, { seq: ++seq, update, origin, captured: username, username, editing: false, needsUsername: false, targets: [update.provider], target: update.provider, error: null });
  claim(tabId, origin, true);
}

function showOffer(tabId: string, origin: string, captured: string, username: string, decision: Extract<SaveDecision, { offer: true }>, error: string | null = null) {
  if (!stillWanted(tabId)) return discard(tabId, origin);
  const old = offerOf(tabId);
  if (old && old.origin !== origin) discard(tabId, old.origin);
  const needsUsername = !username;
  setOffer(tabId, { seq: ++seq, origin, captured, username, editing: needsUsername, needsUsername, targets: decision.targets, target: decision.target, error });
  claim(tabId, origin, true);
}

export async function noteVaultSubmitted(tabId: string, event: VaultSubmission) {
  if (!ardiaSavesInTab(tabId)) return;
  const load = pageLoadOf(tabId), consent = consentToken();
  if (saving.has(savingKey(event.origin, event.username)) || seenJustNow(tabId, event, Date.now())) return;
  const signedIn = event.reportsOutcome ? waitForLogin(tabId, event.origin, consent) : Promise.resolve(true);
  await loadAllVaultItems();
  if (!stillWanted(tabId)) return discard(tabId, event.origin);
  const settings = useBrowser.getState().settings;
  const items = itemsForTab(allVaultItems(), tabId);
  const page = event.username.trim();
  const fresh = event.newPassword === true || event.generated === true;
  const base = { enabled: settings.vaultSaveOffer, origin: event.origin, providers: currentVaultProviders(), items, preferred: settings.vaultSaveTarget };
  if (!fresh) {
    const decision = decideSave({ ...base, username: page });
    if (!decision.offer) {
      if (decision.alreadySaved) claim(tabId, event.origin, false);
      return discard(tabId, event.origin);
    }
    if (!(await signedIn)) return discard(tabId, event.origin);
    return showOffer(tabId, event.origin, page, page, decision);
  }
  const guess = knownUsername(tabId, event, items);
  const account = page || soleSiteUsername(items.filter((i) => base.providers.some((p) => p.id === i.provider && p.state === "unlocked")), event.origin);
  const update = settings.vaultSaveOffer ? decideUpdate({ origin: event.origin, username: account, providers: base.providers, items, remembered: rememberedVaultAccount(event.origin) }) : null;
  if (update) {
    if (!(await signedIn)) return discard(tabId, event.origin);
    return showUpdate(tabId, event.origin, account, update);
  }
  if (usernameFromForm(event)) {
    const changed = decideSave({ ...base, username: page });
    if (!changed.offer && changed.alreadySaved) {
      claim(tabId, event.origin, false);
      return discard(tabId, event.origin);
    }
  }
  const decision = decideSave({ ...base, username: guess, checkSaved: false });
  if (!decision.offer) return discard(tabId, event.origin);
  if (!(await signedIn)) return discard(tabId, event.origin);
  const auto =
    settings.vaultAutoSave &&
    mayAutoSave(event) &&
    decision.targets.length === 1 &&
    !autoSavedAlready(tabId, load, event.origin) &&
    decideSave({ ...base, username: page }).offer;
  if (!auto) return showOffer(tabId, event.origin, page, guess, decision);
  if (!stillWanted(tabId)) return discard(tabId, event.origin);
  spendAutoSave(tabId, load, event.origin);
  claim(tabId, event.origin, true);
  const saved = await saveLogin(tabId, event.origin, decision.target, null, page, consent);
  if (!saved) showOffer(tabId, event.origin, page, page, decision, saveError(decision.target));
}

export const SAVE_TOAST_DELAY_MS = 150;
const saveToastKey = (tabId: string) => `vault-save:${tabId}`;

function savingToast(tabId: string, title: string) {
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;
  const key = saveToastKey(tabId);
  let shown = false;
  const timer = setTimeout(() => {
    if (!windowId) return;
    shown = true;
    showToast(windowId, title, undefined, { key, sticky: true, loading: true });
  }, SAVE_TOAST_DELAY_MS);
  return {
    done(doneTitle: string) {
      clearTimeout(timer);
      if (windowId) showToast(windowId, doneTitle, undefined, { key, icon: "checkmark.circle.fill" });
    },
    failed() {
      clearTimeout(timer);
      if (windowId && shown) hideKeyedToast(windowId, key);
    },
  };
}

async function saveLogin(tabId: string, origin: string, target: string, username: string | null, savedAs: string, consent: ConsentToken | null): Promise<boolean> {
  const web = webviews.get(tabId);
  const request = { provider: target, origin, title: siteLabel(origin), ...(username !== null ? { username } : {}) };
  const key = savingKey(origin, savedAs);
  const toast = savingToast(tabId, `Saving to ${vaultManagerName(target)}…`);
  saving.add(key);
  const result = web ? await web.saveToVault(request).catch(() => null) : null;
  saving.delete(key);
  if (!result?.saved) {
    toast.failed();
    return false;
  }
  if (result.item) rememberVaultAccount(origin, result.item, consent);
  void loadVaultItems(target, true);
  toast.done(`Saved to ${vaultManagerName(target)}`);
  return true;
}

async function updateLogin(tabId: string, origin: string, update: VaultUpdateTarget, consent: ConsentToken | null): Promise<"updated" | "declined" | "failed"> {
  const web = webviews.get(tabId);
  const toast = savingToast(tabId, `Updating in ${vaultManagerName(update.provider)}…`);
  const result = web ? await web.updateVaultPassword({ ...update, origin }).catch(() => null) : null;
  if (!result?.edited) {
    toast.failed();
    return result?.error === "declined" ? "declined" : "failed";
  }
  noteVaultPasswordUpdatedFromOffer(!isArdiaProvider(update.provider), consent);
  if (result.item) rememberVaultAccount(origin, result.item, consent);
  void loadVaultItems(update.provider, true);
  toast.done(`Password updated in ${vaultManagerName(update.provider)}`);
  return "updated";
}

const patchOffer = (tabId: string, s: number, patch: Partial<VaultSaveOffer>) => {
  const offer = offerOf(tabId);
  if (offer?.seq === s) setOffer(tabId, { ...offer, ...patch });
};

export const chooseVaultTarget = (tabId: string, target: string) => {
  const offer = offerOf(tabId);
  if (offer && offer.targets.includes(target)) patchOffer(tabId, offer.seq, { target, error: null });
};

export function editVaultOfferUsername(tabId: string) {
  const offer = offerOf(tabId);
  if (offer && !offer.update) patchOffer(tabId, offer.seq, { editing: true });
}

export function setVaultOfferUsername(tabId: string, username: string) {
  const offer = offerOf(tabId);
  if (offer) patchOffer(tabId, offer.seq, { username, error: null });
}

export const canSaveVaultOffer = (offer: Pick<VaultSaveOffer, "needsUsername" | "username">) => !offer.needsUsername || !!offer.username.trim();

export function dismissVaultOffer(tabId: string) {
  const offer = offerOf(tabId);
  if (!offer) return;
  setOffer(tabId, null);
  discard(tabId, offer.origin);
}

export async function saveVaultOffer(tabId: string) {
  const offer = offerOf(tabId), consent = consentToken();
  if (!offer || !canSaveVaultOffer(offer)) return;
  if (offer.update) {
    const pending = { ...offer, error: null };
    setOffer(tabId, null);
    const key = savingKey(offer.origin, offer.username);
    saving.add(key);
    const outcome = await updateLogin(tabId, offer.origin, offer.update, consent);
    saving.delete(key);
    if (outcome === "updated") return;
    return reopenOffer(tabId, pending, outcome === "failed" ? `Couldn't update the password in ${vaultManagerName(offer.update.provider)}. Try again.` : null);
  }
  const username = offer.username.trim();
  const pending = { ...offer, error: null, username };
  setOffer(tabId, null);
  const saved = await saveLogin(tabId, offer.origin, offer.target, username !== offer.captured ? username : null, offer.captured, consent);
  if (!saved) reopenOffer(tabId, pending, saveError(offer.target));
}

function reopenOffer(tabId: string, offer: VaultSaveOffer, error: string | null) {
  if (offerOf(tabId) || !stillWanted(tabId)) return;
  setOffer(tabId, { ...offer, error });
}
