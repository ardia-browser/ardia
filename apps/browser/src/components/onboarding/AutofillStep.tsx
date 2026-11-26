import { useEffect, useState } from "react";
import { View } from "react-native";
import { PAIRING_CODE_DIGITS, pairingCodeInput, pairingPrompt, useApplePasswords, type Pairing } from "../../state/site/applePasswords";
import { useMeCard } from "../../state/site/meCard";
import { useBrowser } from "../../state/browser/store";
import { autofillStepOffers, useHeldOffers, type AutofillOffer } from "../../state/onboarding/autofillOffers";
import { continueAutofillStep, finishAutofillPairing, skipAutofillStep, submitAutofillPairingCode, toggleAutofillOffer, useAutofillStep } from "../../state/onboarding/autofillStep";
import { onboardingProfile, useOnboarding } from "../../state/onboarding/onboarding";
import { Checkbox, Symbol, Text, TextField } from "../ui";
import { capsule, space } from "../ui/tokens";
import { ChoiceCard } from "./ChoiceCard";
import { OptionCard } from "./OptionCard";
import { useOnboardingColors } from "./Parts";
import { StepActions, StepLayout } from "./StepLayout";

const CARDS: Record<AutofillOffer, { icon: string; title: string; subtitle: string; chip: string }> = {
  applePasswords: { icon: "key.fill", title: "Use Apple Passwords", subtitle: "Fill and save logins with the Passwords app", chip: "Logins from Apple Passwords" },
  meCard: { icon: "person.crop.circle", title: "Use my Me card from Contacts", subtitle: "Fill forms with your name, email and addresses", chip: "Forms from your Me card" },
};

function useStepOffers(): AutofillOffer[] {
  const profile = useOnboarding((s) => onboardingProfile(s.windowId));
  useHeldOffers((s) => s.held);
  useApplePasswords((s) => s.state);
  useMeCard((s) => s.entries);
  useBrowser((s) => (profile ? s.profiles[profile]?.passwordManager : undefined));
  return autofillStepOffers(profile);
}

export function AutofillStep() {
  const offers = useStepOffers();
  const picks = useAutofillStep((s) => s.picks);
  const phase = useAutofillStep((s) => s.phase);
  const pairing = useApplePasswords((s) => s.pairing);
  const [code, setCode] = useState("");
  useEffect(() => {
    if (pairing?.error) setCode("");
  }, [pairing?.error]);
  const pairingShown = phase === "pairing" && !!pairing;
  const connect = () => {
    if (code.length === PAIRING_CODE_DIGITS) void submitAutofillPairingCode(code);
  };
  const actions = pairingShown && pairing.step !== "failed" ? (
    <StepActions continueTitle="Connect" disabled={pairing.step !== "code" || code.length !== PAIRING_CODE_DIGITS} onContinue={connect} onSkip={skipAutofillStep} holdScroll />
  ) : (
    <StepActions disabled={phase === "working"} onContinue={() => (phase === "pairing" ? finishAutofillPairing() : void continueAutofillStep())} onSkip={skipAutofillStep} holdScroll />
  );
  return (
    <StepLayout pageKey="autofill" title="Fill from your Mac?" subtitle="Use what your Mac already keeps. Optional." actions={actions} preview={<AutofillPreview offers={offers} picks={picks} />}>
      <View style={{ gap: space.m }}>
        {offers.map((offer) => (
          <View key={offer} style={{ gap: space.m }}>
            <OptionCard control="check" icon={CARDS[offer].icon} title={CARDS[offer].title} subtitle={CARDS[offer].subtitle} selected={!!picks[offer]} disabled={phase !== "offer"} onPress={() => toggleAutofillOffer(offer)} />
            {offer === "applePasswords" && pairingShown ? <PairingCode pairing={pairing} code={code} onCode={setCode} onSubmit={connect} /> : null}
          </View>
        ))}
      </View>
    </StepLayout>
  );
}

function PairingCode({ pairing, code, onCode, onSubmit }: { pairing: Pairing; code: string; onCode: (code: string) => void; onSubmit: () => void }) {
  const colors = useOnboardingColors();
  const prompt = pairingPrompt(pairing.step);
  return (
    <View style={{ gap: space.ml, paddingHorizontal: space.l }}>
      {prompt ? (
        <Text size="small" color={colors.subtitle}>
          {prompt}
        </Text>
      ) : null}
      {pairing.step === "code" || pairing.step === "checking" ? (
        <TextField value={code} onChangeText={(text) => onCode(pairingCodeInput(text))} onSubmit={onSubmit} autoFocus mono width={120} disabled={pairing.step === "checking"} />
      ) : null}
      {pairing.error ? (
        <Text size="small" selectable color={colors.title}>
          {pairing.error}
        </Text>
      ) : null}
    </View>
  );
}

const CHIP_HEIGHT = 34;

function AutofillPreview({ offers, picks }: { offers: readonly AutofillOffer[]; picks: Partial<Record<AutofillOffer, boolean>> }) {
  const colors = useOnboardingColors();
  return (
    <View style={{ alignItems: "center", gap: space.m }}>
      {offers.map((offer) => (
        <ChoiceCard
          key={offer}
          radius={capsule(CHIP_HEIGHT)}
          style={{ flexDirection: "row", alignItems: "center", gap: space.m, height: CHIP_HEIGHT, paddingLeft: space.l, paddingRight: space.ml, opacity: picks[offer] ? 1 : 0.45 }}
        >
          <Symbol name={CARDS[offer].icon} size={13} color={colors.title} style={{ width: 16, height: 16 }} />
          <Text size="small" weight="medium" color={colors.title}>
            {CARDS[offer].chip}
          </Text>
          <Checkbox look="ring" size="s" value={!!picks[offer]} />
        </ChoiceCard>
      ))}
    </View>
  );
}
