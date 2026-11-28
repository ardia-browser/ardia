import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { currentEngineProfile } from "../browser/current";
import { applePasswordsOffered, useApplePasswords } from "../site/applePasswords";
import { useMeCard } from "../site/meCard";
import { currentPasswordManager } from "../site/passwordManager";
import { create } from "zustand";
import { readSaved, saveOnboarding } from "./onboardingDocument";

export type AutofillOffer = "applePasswords" | "meCard";
export type AutofillOfferAnswer = "accepted" | "declined";

const ORDER: readonly AutofillOffer[] = ["applePasswords", "meCard"];

const available: Record<AutofillOffer, (profileId: string) => boolean> = {
  applePasswords: (profileId) => applePasswordsOffered(useApplePasswords.getState().state) && currentPasswordManager(profileId) !== "apple",
  meCard: (profileId) => PLATFORM_FEATURES.meCard && !useMeCard.getState().entries[currentEngineProfile(profileId)],
};

export const answeredAutofillOffers = (): Partial<Record<AutofillOffer, AutofillOfferAnswer>> => readSaved()?.offers ?? {};

export function openAutofillOffers(profileId: string | null | undefined): AutofillOffer[] {
  if (!profileId) return [];
  const answered = answeredAutofillOffers();
  return ORDER.filter((offer) => !answered[offer] && available[offer](profileId));
}

export const offerPicks = (picks: Partial<Record<AutofillOffer, boolean>>, offered: readonly AutofillOffer[]) => offered.filter((offer) => !!picks[offer]);

export const useHeldOffers = create<{ held: AutofillOffer[] }>()(() => ({ held: [] }));

export const holdAutofillOffers = (offers: readonly AutofillOffer[]) => useHeldOffers.setState({ held: [...offers] });

export function autofillStepOffers(profileId: string | null | undefined): AutofillOffer[] {
  const { held } = useHeldOffers.getState();
  return held.length ? held : openAutofillOffers(profileId);
}

export function recordAutofillAnswers(offered: readonly AutofillOffer[], accepted: readonly AutofillOffer[]): [AutofillOffer, AutofillOfferAnswer][] {
  const answers = offered.map((offer): [AutofillOffer, AutofillOfferAnswer] => [offer, accepted.includes(offer) ? "accepted" : "declined"]);
  saveOnboarding({ offers: { ...answeredAutofillOffers(), ...Object.fromEntries(answers) } });
  useHeldOffers.setState({ held: [] });
  return answers;
}
