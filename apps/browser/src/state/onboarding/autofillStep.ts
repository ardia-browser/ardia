import { create } from "zustand";
import { cancelPairing, startApplePasswordsPairing, submitApplePasswordsCode, useApplePasswords } from "../site/applePasswords";
import { setMeCardFor } from "../site/meCard";
import { autofillStepOffers, holdAutofillOffers, offerPicks, recordAutofillAnswers, type AutofillOffer } from "./autofillOffers";
import { confirmAnswer, onboardingProfile, skipStep, useOnboarding } from "./onboarding";

type AutofillStepPhase = "offer" | "working" | "pairing";
type AutofillStepState = { picks: Partial<Record<AutofillOffer, boolean>>; phase: AutofillStepPhase };

const FRESH: AutofillStepState = { picks: {}, phase: "offer" };

export const useAutofillStep = create<AutofillStepState>()(() => ({ ...FRESH }));

const now = () => useAutofillStep.getState();
const profile = () => onboardingProfile(useOnboarding.getState().windowId) ?? null;
const inStep = () => useOnboarding.getState().step === "autofill" && !!useOnboarding.getState().windowId;

const ACCEPTED_LINES: Record<AutofillOffer, string> = {
  applePasswords: "Fills and saves logins with Apple Passwords",
  meCard: "Fills forms from your Me card",
};

export const resetAutofillStep = () => useAutofillStep.setState({ ...FRESH });

export function toggleAutofillOffer(offer: AutofillOffer) {
  if (now().phase !== "offer") return;
  useAutofillStep.setState((s) => ({ picks: { ...s.picks, [offer]: !s.picks[offer] } }));
}

function finish(offered: readonly AutofillOffer[], accepted: readonly AutofillOffer[]) {
  resetAutofillStep();
  if (inStep()) confirmAnswer("autofill", {}, accepted.map((offer) => ACCEPTED_LINES[offer]));
  recordAutofillAnswers(offered, accepted);
}

export async function continueAutofillStep() {
  const id = profile();
  if (now().phase !== "offer" || !id || !inStep()) return;
  const offered = autofillStepOffers(id);
  const picked = offerPicks(now().picks, offered);
  holdAutofillOffers(offered);
  useAutofillStep.setState({ phase: "working" });
  if (picked.includes("meCard")) await setMeCardFor(id, true);
  if (!inStep()) return;
  if (!picked.includes("applePasswords")) return finish(offered, picked);
  useAutofillStep.setState({ phase: "pairing" });
  await startApplePasswordsPairing(id);
}

export function skipAutofillStep() {
  if (!inStep()) return;
  const offered = autofillStepOffers(profile());
  if (now().phase === "pairing") cancelPairing();
  resetAutofillStep();
  skipStep();
  recordAutofillAnswers(offered, []);
}
