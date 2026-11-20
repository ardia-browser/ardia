import { hostOf } from "@ardia/core";
import { setUpVerificationCode, type VerificationCodeFound } from "../../platform/passwordProviders";
import { patchPage, pageOf, usePages } from "../tabs/pageState";
import { currentTab } from "../browser/current";
import { showToast } from "../app/toasts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { noteVerificationCodeSetup } from "../telemetry/passwordManagerCounts";

const MAX_APP = 40;
const SETUP_LINK = /^\s*(otpauth(?:-migration)?):/i;

export const hoverStatus = (text: string) => {
  const setup = SETUP_LINK.exec(text);
  return setup ? `${setup[1]!.toLowerCase()}:` : text;
};
const clipped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function verificationCodeCopy(app: string, host: string): { title: string; message: string } {
  const name = clipped(app, MAX_APP);
  return {
    title: `Set Up Verification Code in ${name}?`,
    message: `${host ? `${clipped(host, 64)} shows a two-factor setup code. ` : ""}${name} fills its codes from now on.`,
  };
}

const appOf = (found: VerificationCodeFound): string => {
  const app = (found as { app?: unknown } | null)?.app;
  return typeof app === "string" ? app.trim() : "";
};

type Offer = NonNullable<ReturnType<typeof pageOf>["verificationCode"]>;
const QUEUED_PER_PAGE = 8;
const queued = new Map<string, { offer: Offer; consent: ConsentToken | null }[]>();
const documents = new Map<string, number>();

function showOffer(tabId: string, offer: Offer, consent: ConsentToken | null) {
  patchPage(tabId, { verificationCode: offer });
  noteVerificationCodeSetup("offered", consent);
}

function showNext(tabId: string) {
  const next = queued.get(tabId)?.shift();
  if (!queued.get(tabId)?.length) queued.delete(tabId);
  if (next) showOffer(tabId, next.offer, next.consent);
}

export function offerVerificationCode(tabId: string, found: VerificationCodeFound, offered: (tabId: string) => boolean, generation: number) {
  const token = typeof found?.token === "string" ? found.token : "";
  const app = appOf(found);
  if (!token || !app || !offered(tabId)) return;
  const offer = { token, app, host: hostOf(currentTab(tabId)?.url ?? "") ?? "", generation };
  const consent = consentToken();
  if (!pageOf(tabId).verificationCode) return showOffer(tabId, offer, consent);
  const waiting = queued.get(tabId) ?? [];
  if (waiting.length < QUEUED_PER_PAGE) queued.set(tabId, [...waiting, { offer, consent }]);
}

export function forgetVerificationCodes(tabId: string) {
  queued.delete(tabId);
  if (pageOf(tabId).verificationCode) patchPage(tabId, { verificationCode: null });
}

export function verificationCodeDocument(tabId: string, committedAt: number | undefined) {
  if (typeof committedAt !== "number" || !(committedAt > 0)) return;
  const last = documents.get(tabId);
  if (last !== undefined && committedAt <= last) return;
  documents.set(tabId, committedAt);
  if (last !== undefined) forgetVerificationCodes(tabId);
}

export function verificationCodeTabGone(tabId: string) {
  queued.delete(tabId);
  documents.delete(tabId);
}

export function declineVerificationCode(tabId: string) {
  patchPage(tabId, { verificationCode: null });
  showNext(tabId);
}

export function acceptVerificationCode(tabId: string) {
  const offer = pageOf(tabId).verificationCode;
  if (!offer) return;
  patchPage(tabId, { verificationCode: null });
  showNext(tabId);
  const consent = consentToken();
  noteVerificationCodeSetup("accepted", consent);
  void setUpVerificationCode(tabId, offer.token, offer.generation)
    .then((r) => !!r?.opened, () => false)
    .then((opened) => {
      if (opened) return;
      noteVerificationCodeSetup("failed", consent);
      const windowId = currentTab(tabId)?.windowId;
      if (windowId) showToast(windowId, `Couldn't open ${clipped(offer.app, MAX_APP)}.`, undefined, { icon: "key.fill" });
    });
}

export function closeVerificationCodePrompts() {
  queued.clear();
  for (const [tabId, page] of Object.entries(usePages.getState().pages)) if (page.verificationCode) patchPage(tabId, { verificationCode: null });
}
