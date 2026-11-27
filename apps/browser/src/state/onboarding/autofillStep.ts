import type { Secret } from "@ardia/core";
import { create } from "zustand";
import { applePasswordsConnected, cancelPairing, startApplePasswordsPairing, submitApplePasswordsCode, useApplePasswords } from "../site/applePasswords";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { noteOnboardingOffer } from "../telemetry/passwordManagerCounts";
import { useBrowser } from "../browser/store";
import { currentEngineProfile } from "../browser/current";
import { setMeCardFor, useMeCard } from "../site/meCard";
import { autofillStepOffers, holdAutofillOffers, offerPicks, recordAutofillAnswers, useHeldOffers, type AutofillOffer } from "./autofillOffers";
import { confirmAnswer, onboardingProfile, skipStep, useOnboarding } from "./onboarding";

type AutofillStepPhase = "offer" | "working" | "pairing";
type AutofillStepState = { picks: Partial<Record<AutofillOffer, boolean>>; phase: AutofillStepPhase; consent: ConsentToken | null };

const FRESH: AutofillStepState = { picks: {}, phase: "offer", consent: null };

export const useAutofillStep = create<AutofillStepState>()(() => ({ ...FRESH }));

const now = () => useAutofillStep.getState();
const profile = () => onboardingProfile(useOnboarding.getState().windowId) ?? null;
const inStep = () => useOnboarding.getState().step === "autofill" && !!useOnboarding.getState().windowId;

const ACCEPTED_LINES: Record<AutofillOffer, string> = {
  applePasswords: "Fills and saves logins with Apple Passwords",
  meCard: "Fills forms from your Me card",
};

function record(offered: readonly AutofillOffer[], accepted: readonly AutofillOffer[], consent: ConsentToken | null) {
  for (const [offer, answer] of recordAutofillAnswers(offered, accepted)) noteOnboardingOffer(offer, answer, consent);
}

export function useAutofillStepOffers(): AutofillOffer[] {
  const id = useOnboarding((s) => onboardingProfile(s.windowId));
  useHeldOffers((s) => s.held);
  useApplePasswords((s) => s.state);
  useMeCard((s) => s.entries);
  useBrowser((s) => (id ? s.profiles[id]?.passwordManager : undefined));
  return autofillStepOffers(id);
}

export const resetAutofillStep = () => useAutofillStep.setState({ ...FRESH });

export function toggleAutofillOffer(offer: AutofillOffer) {
  if (now().phase !== "offer") return;
  useAutofillStep.setState((s) => ({ picks: { ...s.picks, [offer]: !s.picks[offer] } }));
}

function finish(offered: readonly AutofillOffer[], accepted: readonly AutofillOffer[]) {
  const { consent } = now();
  resetAutofillStep();
  if (inStep()) confirmAnswer("autofill", {}, accepted.map((offer) => ACCEPTED_LINES[offer]));
  record(offered, accepted, consent);
}

export async function continueAutofillStep() {
  const id = profile();
  if (now().phase !== "offer" || !id || !inStep()) return;
  const offered = autofillStepOffers(id);
  const picked = offerPicks(now().picks, offered);
  holdAutofillOffers(offered);
  useAutofillStep.setState({ phase: "working", consent: consentToken() });
  if (picked.includes("meCard")) await setMeCardFor(currentEngineProfile(id), true);
  if (!inStep()) return;
  if (!picked.includes("applePasswords")) return finishPicked(false);
  useAutofillStep.setState({ phase: "pairing" });
  await startApplePasswordsPairing(id);
  if (now().phase === "pairing" && inStep() && !useApplePasswords.getState().pairing) finishPicked(applePasswordsConnected());
}

const meCardOn = (id: string | null) => !!id && !!useMeCard.getState().entries[currentEngineProfile(id)];

function answered(paired: boolean) {
  const id = profile();
  const offered = autofillStepOffers(id);
  const picked = (offer: AutofillOffer) => !!now().picks[offer];
  const unanswered = (offer: AutofillOffer) => picked(offer) && (offer === "applePasswords" ? !paired : !meCardOn(id));
  const kept = offered.filter((offer) => !unanswered(offer));
  return { offered: kept, accepted: offerPicks(now().picks, kept) };
}

function finishPicked(paired: boolean) {
  const { offered, accepted } = answered(paired);
  finish(offered, accepted);
}

export async function submitAutofillPairingCode(code: Secret<"pairingCode">): Promise<boolean> {
  if (now().phase !== "pairing" || !inStep()) return false;
  const paired = await submitApplePasswordsCode(code);
  if (paired && now().phase === "pairing") finishPicked(true);
  return paired;
}

export function finishAutofillPairing() {
  if (now().phase !== "pairing" || !inStep()) return;
  if (useApplePasswords.getState().pairing) cancelPairing();
  finishPicked(false);
}

export function skipAutofillStep() {
  if (!inStep()) return;
  const pairing = now().phase === "pairing";
  const { offered, accepted } = pairing ? answered(false) : { offered: autofillStepOffers(profile()), accepted: [] };
  if (pairing) cancelPairing();
  const consent = now().consent ?? consentToken();
  resetAutofillStep();
  skipStep();
  record(offered, accepted, consent);
}
