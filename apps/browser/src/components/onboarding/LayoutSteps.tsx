import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { space } from "../ui/tokens";
import { durationTitle } from "../../lib/time";
import { DEFAULT_SETTINGS, type PeekModifier, type Settings } from "../../state/settings/settings";
import { ChoiceList, useMockFocus, type ChoiceOption } from "./ChoiceList";
import { MockPanel, useScreen } from "./Screen";
import { confirmAnswer, previewLive, PRESET_NAMES, PRESETS, setOnboardingDraft, skipStep, useOnboarding, type Preset, type QuestionId } from "../../state/onboarding/onboarding";
import { keysOf, questionKeys, useQuestions } from "../../state/onboarding/questions";
import { placementCard, placementFromCard } from "../../state/omnibox/barPlacement";
import { StepActions, StepLayout } from "./StepLayout";
import { OptionCard } from "./OptionCard";
import { OptionRow } from "./Parts";
import { keyText } from "../../state/commands/keyText";
import { t } from "../../lib/uiLanguage";


export function Page({
  id,
  title,
  subtitle,
  tag,
  patch,
  picked,
  preview,
  onConfirm,
  children,
}: {
  id: QuestionId;
  title: string;
  subtitle: string;
  tag?: string;
  patch: Partial<Settings>;
  picked: string[];
  preview: ReactNode;
  onConfirm?: () => void;
  children: ReactNode;
}) {
  return (
    <StepLayout
      pageKey={id}
      title={title}
      subtitle={subtitle}
      tag={tag}
      actions={<StepActions onContinue={() => {
            onConfirm?.();
            confirmAnswer(id, patch, picked);
          }} onSkip={() => skipStep()} />}
      preview={preview}
    >
      {children}
    </StepLayout>
  );
}

export function useQuestion(step: "layout" | "tabs" | "look") {
  const sub = useOnboarding((s) => s.sub);
  const id = useQuestions(step)[sub]?.id;
  return { id, focus: useMockFocus(id) };
}

export function change(patch: Partial<Settings>, live = false) {
  setOnboardingDraft(patch);
  if (live) previewLive(patch);
}

const LAYOUT_KEYS = keysOf("layout");

const TAB_CHOICES: ChoiceOption<Settings["tabLayout"]>[] = [
  { value: "sidebar", preview: "tabs-sidebar", title: t(`In the sidebar`), subtitle: t(`A tall list down the side, as in Arc`) },
  { value: "top", preview: "tabs-top", title: t(`Along the top`), subtitle: t(`Classic tabs above the page`) },
];
const ADDRESS_CHOICES: ChoiceOption<Settings["addressBar"]>[] = [
  { value: "toolbar", preview: "address-toolbar", title: t(`In the toolbar`), subtitle: t(`Above the page, as in Dia`) },
  { value: "sidebar", preview: "address-sidebar", title: t(`In the sidebar`), subtitle: t(`On top of your tabs, as in Arc`) },
];
const CMDL_CHOICES: ChoiceOption<Settings["commandBarPlacement"]>[] = [
  { value: "field", preview: "cmdl-field", title: t(`Under the address`), subtitle: t(`Drops down from the field, as in Dia`) },
  { value: "centred", preview: "cmdl-centred", title: t(`In the center`), subtitle: t(`Floats over the page, as in Arc`) },
];

function styleOf(values: Pick<Settings, (typeof LAYOUT_KEYS)[number]>, preset: Preset) {
  const keys = values.tabLayout === "top" ? (["tabLayout", "commandBarPlacement"] as const) : LAYOUT_KEYS;
  const matches = (p: Preset) => keys.every((k) => values[k] === (PRESETS[p][k] ?? DEFAULT_SETTINGS[k]));
  const match = ([preset, "arc", "dia"] as const).find(matches);
  return match ? `${PRESET_NAMES[match]}-style` : t(`Your mix`);
}

export function LayoutStep() {
  const { id, focus } = useQuestion("layout");
  const { values, mock } = useScreen(LAYOUT_KEYS);
  const preset = useOnboarding((s) => s.preset);
  useEffect(() => previewLive(values), []);
  const preview = <MockPanel settings={mock} focus={focus.focus} />;
  const tag = styleOf(values, preset);
  const top = values.tabLayout === "top";

  if (id === "address")
    return (
      <Page
        id={id}
        title={t(`Where's the address bar?`)}
        subtitle={t(`Your window changes as you pick.`)}
        tag={tag}
        patch={{ addressBar: values.addressBar }}
        picked={[values.addressBar === "sidebar" ? t(`Address in the sidebar`) : t(`Address in the toolbar`)]}
        preview={preview}
      >
        <ChoiceList options={ADDRESS_CHOICES} value={values.addressBar} onChange={(addressBar) => change({ addressBar }, true)} mock={focus} />
      </Page>
    );
  if (id === "cmdl")
    return (
      <Page
        id={id}
        title={`Where does ${keyText("⌘L")} open?`}
        subtitle={t(`The command bar, for going anywhere.`)}
        tag={tag}
        patch={{ commandBarPlacement: values.commandBarPlacement }}
        picked={[values.commandBarPlacement !== "field" ? `${keyText("⌘L")} opens in the center` : `${keyText("⌘L")} opens under the address`]}
        preview={preview}
      >
        <ChoiceList
          options={CMDL_CHOICES}
          value={placementCard(values.commandBarPlacement)}
          onChange={(card) => change({ commandBarPlacement: placementFromCard(card, values.commandBarPlacement) }, true)}
          mock={focus}
        />
      </Page>
    );
  return (
    <Page
      id="tabs"
      title={t(`Where do your tabs go?`)}
      subtitle={t(`Your window changes as you pick.`)}
      tag={tag}
      patch={{ tabLayout: values.tabLayout }}
      picked={[top ? t(`Tabs along the top`) : t(`Tabs in the sidebar`)]}
      preview={preview}
    >
      <ChoiceList options={TAB_CHOICES} value={values.tabLayout} onChange={(tabLayout) => change({ tabLayout }, true)} mock={focus} />
    </Page>
  );
}

const TABS_MORE = questionKeys("tabsMore");

const NEW_TAB_CHOICES: ChoiceOption<Settings["newTabOpens"]>[] = [
  { value: "page", preview: "newtab-page", title: t(`The New Tab page`), subtitle: t(`Your apps and a search box, as in Dia`) },
  { value: "commandBar", preview: "newtab-commandbar", title: t(`The command bar`), subtitle: t(`Start typing right away, as in Arc`) },
];
const TIDY_CHOICES: ChoiceOption<"keep" | "tidy">[] = [
  { value: "keep", preview: "tidy-keep", title: t(`Keep them`), subtitle: t(`Tabs stay until you close them`) },
  { value: "tidy", preview: "tidy-auto", title: t(`Tidy them up`), subtitle: t(`Close the ones you haven't used in a while`) },
];
const QUIT_CHOICES: ChoiceOption<boolean>[] = [
  { value: true, preview: "quit-restore", title: t(`Restore my tabs`), subtitle: t(`Pick up where you left off`) },
  { value: false, preview: "quit-fresh", title: t(`Start fresh`), subtitle: t(`Open to a clean window`) },
];
const WINDOW_CHOICES: ChoiceOption<boolean>[] = [
  { value: false, preview: "windows-separate", title: t(`Separate`), subtitle: t(`Each window has its own tabs`) },
  { value: true, preview: "windows-shared", title: t(`Shared`), subtitle: t(`Every window shows the same tabs, as in Arc`) },
];
const TIDY_AFTER = [
  { value: 12 * 60, title: t(`12 h`) },
  { value: 24 * 60, title: t(`1 day`) },
  { value: 7 * 24 * 60, title: t(`1 week`) },
];
const PEEK_WITH: { value: PeekModifier; title: string }[] = [
  { value: "shift", title: `${keyText("⇧")}-click` },
  { value: "alt", title: `${keyText("⌥")}-click` },
  { value: "off", title: t(`Off`) },
];

const tidyLabel = (minutes: number) => (minutes !== TIDY_AFTER[0]!.value && TIDY_AFTER.find((o) => o.value === minutes)?.title) || durationTitle(minutes);

export function TabsStep() {
  const { id, focus } = useQuestion("tabs");
  const { values, mock } = useScreen(keysOf("tabs"));
  const top = mock.tabLayout === "top";
  const tidy = values.cleanUpInactiveTabsAfterMinutes;
  const preview = <MockPanel settings={mock} focus={focus.focus} />;

  if (id === "newTabPosition") {
    const options: ChoiceOption<Settings["newTabPosition"]>[] = [
      { value: "bottom", preview: "newtabpos-bottom", title: top ? t(`On the right`) : t(`At the bottom`), subtitle: top ? t(`After your other tabs, as in Dia`) : t(`Under your other tabs, as in Dia`) },
      { value: "top", preview: "newtabpos-top", title: top ? t(`On the left`) : t(`At the top`), subtitle: top ? t(`Before your other tabs, as in Arc`) : t(`Above your other tabs, as in Arc`) },
      { value: "nextToCurrent", preview: "newtabpos-next", title: top ? t(`Next to the current tab`) : t(`Below the current tab`), subtitle: top ? t(`Right after the tab you're on`) : t(`Right under the tab you're on`) },
    ];
    return (
      <Page
        id={id}
        title={t(`Where do new tabs go?`)}
        subtitle={t(`Where a tab lands when you open it.`)}
        patch={{ newTabPosition: values.newTabPosition, newTabButtonPosition: values.newTabButtonPosition }}
        picked={[]}
        preview={preview}
      >
        <ChoiceList options={options} value={values.newTabPosition} onChange={(newTabPosition) => change({ newTabPosition, newTabButtonPosition: newTabPosition === "top" ? "top" : "bottom" })} mock={focus} />
      </Page>
    );
  }
  if (id === "tidy")
    return (
      <Page
        id={id}
        title={t(`What about old tabs?`)}
        subtitle={t(`Tabs you opened and forgot.`)}
        patch={{ cleanUpInactiveTabsAfterMinutes: tidy }}
        picked={[tidy === null ? t(`Old tabs stay until you close them`) : `Old tabs tidy up after ${tidyLabel(tidy)}`]}
        preview={preview}
      >
        <ChoiceList
          options={TIDY_CHOICES}
          value={tidy === null ? "keep" : "tidy"}
          onChange={(v) => change({ cleanUpInactiveTabsAfterMinutes: v === "keep" ? null : (tidy ?? TIDY_AFTER[0]!.value) })}
          mock={focus}
        />
        {tidy === null ? null : (
          <OptionRow
            title={t(`Tidy after`)}
            value={tidy}
            options={TIDY_AFTER.some((o) => o.value === tidy) ? TIDY_AFTER : [...TIDY_AFTER, { value: tidy, title: tidyLabel(tidy) }]}
            onChange={(cleanUpInactiveTabsAfterMinutes) => change({ cleanUpInactiveTabsAfterMinutes })}
          />
        )}
      </Page>
    );
  if (id === "quit")
    return (
      <Page
        id={id}
        title={t(`When you quit and come back?`)}
        subtitle={t(`What Ardia opens to.`)}
        patch={{ restoreSession: values.restoreSession }}
        picked={values.restoreSession ? [] : [t(`Ardia starts fresh each launch`)]}
        preview={preview}
      >
        <ChoiceList options={QUIT_CHOICES} value={values.restoreSession} onChange={(restoreSession) => change({ restoreSession })} mock={focus} />
      </Page>
    );
  if (id === "windows")
    return (
      <Page
        id={id}
        title={t(`Two windows, same tabs?`)}
        subtitle={t(`How windows share what's open.`)}
        patch={{ shareTabsAcrossWindows: values.shareTabsAcrossWindows }}
        picked={values.shareTabsAcrossWindows ? [t(`Windows share their tabs`)] : []}
        preview={preview}
      >
        <ChoiceList
          options={WINDOW_CHOICES}
          value={values.shareTabsAcrossWindows}
          onChange={(shareTabsAcrossWindows) => change({ shareTabsAcrossWindows })}
          mock={focus}
        />
      </Page>
    );
  if (id === "tabsMore")
    return (
      <Page
        id={id}
        title={t(`A few more tab habits`)}
        subtitle={t(`Small things Arc and Dia do differently.`)}
        patch={Object.fromEntries(TABS_MORE.map((k) => [k, values[k]]))}
        picked={[]}
        preview={preview}
      >
        <View style={{ gap: space.m }}>
          <OptionCard control="check" title={t(`Top Apps grow with the sidebar`)} subtitle={t(`Up to four across, as in Arc`)} selected={values.balancedTopApps} onPress={() => change({ balancedTopApps: !values.balancedTopApps })} />
          <OptionRow title={t(`Peek a link with`)} value={values.peekModifier} options={PEEK_WITH} onChange={(peekModifier) => change({ peekModifier })} />
          <OptionCard control="check" title={`${keyText("⌘Z")} reopens closed tabs`} subtitle={t(`Outside text fields, as in Arc`)} selected={values.undoReopensClosedTab} onPress={() => change({ undoReopensClosedTab: !values.undoReopensClosedTab })} />
          <OptionCard
            control="check"
            title={`${keyText("⌘")}-click on a link makes a tab group`}
            subtitle={t(`Keeps related tabs together`)}
            selected={values.cmdClickCreatesTabGroup}
            onPress={() => change({ cmdClickCreatesTabGroup: !values.cmdClickCreatesTabGroup })}
          />
        </View>
      </Page>
    );
  return (
    <Page
      id="newTab"
      title={`What does ${keyText("⌘T")} open?`}
      subtitle={t(`What you see when you open a tab.`)}
      patch={{ newTabOpens: values.newTabOpens }}
      picked={[values.newTabOpens === "commandBar" ? `${keyText("⌘T")} opens the command bar` : `${keyText("⌘T")} opens the New Tab page`]}
      preview={preview}
    >
      <ChoiceList options={NEW_TAB_CHOICES} value={values.newTabOpens} onChange={(newTabOpens) => change({ newTabOpens })} mock={focus} />
    </Page>
  );
}
