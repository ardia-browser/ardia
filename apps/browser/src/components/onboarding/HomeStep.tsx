import { t } from "../../lib/i18n";
import {
  addToDock,
  backgroundInstance,
  isDefaultBrowser,
  isInDock,
  launchAtLoginStatus,
  setAsDefaultBrowser,
  setLaunchAtLogin,
} from "../../state/app/appSettings";
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { Checkbox, Symbol, Text } from "../ui";
import { capsule, space } from "../ui/tokens";
import { ChoiceCard } from "./ChoiceCard";
import { OptionCard } from "./OptionCard";
import { confirmAnswer, confirmDefaultBrowserAnswer, recordDefaultBrowserTrial, setOnboardingDraft, setOnboardingExtras, skipStep, useOnboarding } from "../../state/onboarding/onboarding";
import { probeOnboardingSystem, type OnboardingSystem } from "../../state/onboarding/systemProbe";
import { ChoiceList, type ChoiceOption } from "./ChoiceList";
import { onboardingMotion } from "./tokens";
import { useOnboardingColors } from "./Parts";
import { useScreen } from "./Screen";
import { useSection, useSharedMockFocus } from "./sectionContext";
import { StepActions, StepLayout } from "./StepLayout";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

const ICON = require("../../../assets/app-icon.png");


const LINK_CHOICES: ChoiceOption<boolean>[] = [
  { value: true, preview: "links-little", title: t("Little Ardia"), subtitle: t("A small window that's gone when you're done") },
  { value: false, preview: "links-tab", title: t("A new tab"), subtitle: t("Right in your main window") },
];

export function HomeStep() {
  const { sub } = useSection();
  return sub === 0 ? <DefaultBrowserQuestion /> : <LinksQuestion />;
}

let applying = false;

function DefaultBrowserQuestion() {
  const extras = useOnboarding((s) => s.extras);
  const redo = useOnboarding((s) => s.redo);
  const [system, setSystem] = useState<OnboardingSystem | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const setDefault = extras.setDefault ?? !backgroundInstance;
  const trial = !redo && PLATFORM_FEATURES.setsDefaultBrowser && (extras.trial ?? false);
  const dock = extras.dock ?? true;
  const login = extras.login ?? system?.loginEnabled ?? false;
  const setExtras = setOnboardingExtras;

  useEffect(() => {
    void probeOnboardingSystem({ isDefaultBrowser, isInDock, launchAtLoginStatus }).then(setSystem);
  }, []);

  const apply = async () => {
    if (!system || applying) return;
    applying = true;
    setPending(true);
    const slow = setTimeout(() => setBusy(true), onboardingMotion.busyLabelDelay);
    const picked: string[] = [];
    try {
      if (!system.isDefault && (setDefault || trial) && (await setAsDefaultBrowser())) {
        if (!setDefault) recordDefaultBrowserTrial();
        picked.push(setDefault ? "Ardia is your default browser" : "A week as your default browser");
      }
      if (login !== system.loginEnabled) await setLaunchAtLogin(login).catch(() => {});
      if (dock && system.dockAvailable && !system.inDock) await addToDock();
    } finally {
      clearTimeout(slow);
      applying = false;
      setBusy(false);
      setPending(false);
      confirmDefaultBrowserAnswer(picked);
    }
  };

  const defaultOn = system?.isDefault || setDefault;
  const trying = !defaultOn && trial;
  return (
    <StepLayout
      pageKey="default"
      title={t("Make Ardia your default?")}
      subtitle={t("Links from everywhere open here.")}
      actions={
        <StepActions
          continueTitle={busy ? t("Setting Up…") : t("Continue")}
          disabled={!system || busy}
          holdForward={pending}
          onContinue={() => void apply()}
          onSkip={() => skipStep("question")}
          holdScroll
        />
      }
      preview={<SystemPreview isDefault={!!(defaultOn || trying)} dock={!!(system?.inDock || (dock && system?.dockAvailable !== false))} login={login} />}
    >
      <View style={{ gap: space.m }}>
        <OptionCard
          control="check"
          icon="globe"
          title={t("Set Ardia as default browser")}
          subtitle={system?.isDefault ? t("Ardia is already your default browser") : PLATFORM_FEATURES.setsDefaultBrowser ? t("Open links and web pages in Ardia") : t("Continue opens {os} Settings, where you choose Ardia", { os: PLATFORM_TERMS.os })}
          selected={!!defaultOn}
          disabled={!system || system.isDefault}
          onPress={() => setExtras(defaultOn ? { setDefault: false, trial: !redo } : { setDefault: true })}
        />
        {system && !defaultOn && !redo && PLATFORM_FEATURES.setsDefaultBrowser ? (
          <OptionCard control="check" icon="calendar" title={t("Try it for seven days")} subtitle={t("We'll check in to make sure you love it.")} selected={trial} onPress={() => setExtras({ trial: !trial })} />
        ) : null}
        {system && system.dockAvailable && !system.inDock ? (
          <OptionCard control="check" icon="dock.rectangle" title={t("Add Ardia to Dock")} subtitle={t("Quick access whenever you need it")} selected={dock} onPress={() => setExtras({ dock: !dock })} />
        ) : null}
        <OptionCard control="check" icon="power" title={t("Open Ardia at login")} subtitle={t("Ready when you sign in")} selected={login} onPress={() => setExtras({ login: !login })} />
      </View>
    </StepLayout>
  );
}

function LinksQuestion() {
  const { values } = useScreen(["openLinksInLittleArdia"]);
  const focus = useSharedMockFocus();
  const little = values.openLinksInLittleArdia;
  return (
    <StepLayout
      pageKey="links"
      title={t("Where do links from other apps open?")}
      subtitle={t("From {apps} and the rest.", { apps: PLATFORM_TERMS.linkSourceApps })}
      actions={
        <StepActions
          onContinue={() =>
            confirmAnswer("links", { openLinksInLittleArdia: little }, [little ? "Links from other apps open in Little Ardia" : "Links from other apps open in a tab"])
          }
          onSkip={() => skipStep("question")}
        />
      }
    >
      <ChoiceList options={LINK_CHOICES} value={little} onChange={(v) => setOnboardingDraft({ openLinksInLittleArdia: v })} mock={focus} />
    </StepLayout>
  );
}

const CHIP_HEIGHT = 34;

function SystemPreview({ isDefault, dock, login }: { isDefault: boolean; dock: boolean; login: boolean }) {
  const colors = useOnboardingColors();
  const chip = (on: boolean, icon: string, label: string) => (
    <ChoiceCard
      key={label}
      radius={capsule(CHIP_HEIGHT)}
      style={{ flexDirection: "row", alignItems: "center", gap: space.m, height: CHIP_HEIGHT, paddingLeft: space.l, paddingRight: space.ml, opacity: on ? 1 : 0.45 }}
    >
      <Symbol name={icon} size={13} color={colors.title} style={{ width: 16, height: 16 }} />
      <Text size="small" weight="medium" color={colors.title}>
        {label}
      </Text>
      <Checkbox look="ring" size="s" value={on} />
    </ChoiceCard>
  );
  return (
    <View style={{ alignItems: "center", gap: space.xxxl }}>
      <Image source={ICON} style={{ width: 132, height: 132 }} />
      <View style={{ gap: space.m, alignItems: "center" }}>
        {chip(isDefault, "globe", "Default browser")}
        {PLATFORM_FEATURES.dock ? chip(dock, "dock.rectangle", t("In your Dock")) : null}
        {chip(login, "power", t("Opens at login"))}
      </View>
    </View>
  );
}
