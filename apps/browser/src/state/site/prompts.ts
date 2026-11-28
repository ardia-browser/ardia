import type { BlockedPopup } from "../../platform/tabs";
import { getSiteSettings, resolveExternalApp } from "./siteSettings";
import { patchPage, pageOf, setPopover, type AutofillPrompt, type AutofillPromptAnswer, type PasswordPrompt, type PasswordPromptAnswer } from "../tabs/pageState";
import { webviews } from "../tabs/webviewHandles";
import type { ExternalAppRequest } from "../../platform/siteSettings";
import { currentEngineProfile, currentTab } from "../browser/current";
import { noteExternalApp } from "../telemetry/externalAppCounts";
import { noteExternalAppRequest } from "../telemetry/track";
import { hostOrOrigin } from "../../lib/url";

async function shouldPromptForPopups(profile: string, origin: string): Promise<boolean> {
  try {
    const settings = await getSiteSettings(profile, origin);
    return settings.popups.isDefault;
  } catch {
    return true;
  }
}

export function popupBlocked(tabId: string, popup: BlockedPopup) {
  const first = !pageOf(tabId).popups.length;
  patchPage(tabId, { popups: [...pageOf(tabId).popups, popup] });
  const tab = currentTab(tabId);
  if (first && tab) void shouldPromptForPopups(currentEngineProfile(tab.profileId), popup.origin).then((ask) => ask && setPopover(tabId, "popups"));
}

const passwordPromptIds = new WeakMap<PasswordPrompt, string>();
let passwordPromptSerial = 0;

export const passwordPromptId = (prompt: PasswordPrompt) => passwordPromptIds.get(prompt) ?? null;

export function passwordPromptCopy(prompt: PasswordPrompt): { title: string; message: string } {
  const site = hostOrOrigin(prompt.origin);
  const update = prompt.state === "update";
  if (prompt.target === "applePasswords") {
    if (prompt.state === "notSaved") {
      return { title: "Not saved to Apple Passwords", message: "Apple Passwords didn't take this login. Unlock the Passwords app, then sign in again to save it." };
    }
    return { title: "Connect Apple Passwords?", message: `Then Apple Passwords will ask to ${update ? "update" : "save"} this login for ${site}.` };
  }
  return update
    ? { title: "Update saved password?", message: `It will be auto-filled on ${site}` }
    : { title: `Save password for ${site}?`, message: "That way, it'll be auto-filled next time" };
}

export function passwordPromptAction(prompt: PasswordPrompt): string {
  if (prompt.target === "applePasswords") return "Connect";
  return prompt.state === "update" ? "Update" : "Save";
}

export function showPasswordPrompt(tabId: string, prompt: PasswordPrompt) {
  if (prompt.state !== "saved") passwordPromptIds.set(prompt, `pw${++passwordPromptSerial}`);
  patchPage(tabId, { passwordPrompt: prompt.state === "saved" ? null : prompt });
}

export function showAutofillPrompt(tabId: string, prompt: AutofillPrompt | null, id: number) {
  if (prompt) patchPage(tabId, { autofillPrompt: prompt });
  else if (pageOf(tabId).autofillPrompt?.id === id) patchPage(tabId, { autofillPrompt: null });
}

export function showExternalApp(tabId: string, request: ExternalAppRequest) {
  noteExternalAppRequest(!!request.app);
  if (request.app) patchPage(tabId, { externalApp: request });
  else void resolveExternalApp(request.id, false);
}

export function answerExternalApp(tabId: string, open: boolean, remember = false) {
  const request = pageOf(tabId).externalApp;
  if (!request) return;
  patchPage(tabId, { externalApp: null });
  if (request.app) noteExternalApp(!open ? "declined" : remember ? "allowedAlways" : "allowed");
  void resolveExternalApp(request.id, open, remember);
}

export function answerPasswordPrompt(tabId: string, action: PasswordPromptAnswer, username?: string, shown?: PasswordPrompt) {
  const prompt = pageOf(tabId).passwordPrompt;
  if (!prompt || (shown && prompt !== shown)) return false;
  const offer = prompt.offer === undefined ? {} : { offer: prompt.offer };
  const keeps = action === "save" || action === "update";
  void webviews.get(tabId)?.resolvePasswordPrompt(action, keeps ? { username: username ?? prompt.username, ...offer } : prompt.offer === undefined ? undefined : offer);
  patchPage(tabId, { passwordPrompt: null });
  return true;
}

export function answerAutofillPrompt(tabId: string, action: AutofillPromptAnswer, id: number) {
  const prompt = pageOf(tabId).autofillPrompt;
  if (!prompt || prompt.id !== id) return false;
  void webviews.get(tabId)?.resolveAutofillPrompt(prompt.id, action);
  patchPage(tabId, { autofillPrompt: null });
  return true;
}

export type ConfirmedAnswer = "answered" | "gone" | "noView" | "refused";

export async function answerAutofillPromptConfirmed(tabId: string, id: number, action: AutofillPromptAnswer): Promise<ConfirmedAnswer> {
  const prompt = pageOf(tabId).autofillPrompt;
  if (!prompt || prompt.id !== id) return "gone";
  const view = webviews.get(tabId);
  if (!view?.answerAutofillPrompt) return "noView";
  if (!(await view.answerAutofillPrompt(id, action))) return "refused";
  if (pageOf(tabId).autofillPrompt?.id === id) patchPage(tabId, { autofillPrompt: null });
  return "answered";
}
