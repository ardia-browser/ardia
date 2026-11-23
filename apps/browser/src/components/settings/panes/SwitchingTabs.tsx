import { Box, Button, space, Text } from "../../ui";
import { Anchor, FormField, SectionHeader } from "../Form";
import { PictureChoice } from "../PictureChoice";
import { AfterClosingTabPreview, CtrlTabPreview } from "../ChoicePreviews";
import { setting } from "../settingsIndex";
import { chooseCtrlTab, ctrlTabCustomQuery, useCtrlTabChoice } from "../../../state/commands/commandShortcuts";
import type { CtrlTabPreset } from "../../../state/commands/ctrlTabKeys";
import { useSettings, useTabLayout } from "../../../state/browser/hooks";
import { chooseAfterClosingTab } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { setShortcutsQuery } from "../../../state/settings/searchState";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";

const CTRL_TAB_KEY = PLATFORM_TERMS.switchTabsKey;

const CTRL_TAB: { value: CtrlTabPreset; title: string; caption: string }[] = [
  { value: "step", title: "Step through tabs", caption: "Goes one tab down the list, like Chrome." },
  { value: "switcher", title: "Recent tabs switcher", caption: "Shows recent tabs; let go to switch, like Arc." },
];

const AFTER_CLOSING_DOWN: { value: Settings["afterClosingTab"]; title: string; caption: string }[] = [
  { value: "tabAbove", title: "Tab above", caption: "Goes to the tab right above it." },
  { value: "previouslyActive", title: "Previously active tab", caption: "Goes back to the tab you used before, like Arc." },
];

const AFTER_CLOSING_ACROSS: { value: Settings["afterClosingTab"]; title: string; caption: string }[] = [
  { value: "tabAbove", title: "Tab to the left", caption: "Goes to the tab to the left." },
  { value: "previouslyActive", title: "Previously active tab", caption: "Goes back to the tab you used before, like Arc." },
];

export function SwitchingTabsSection() {
  const choice = useCtrlTabChoice();
  const afterClosingTab = useSettings((s) => s.afterClosingTab);
  const top = useTabLayout() === "top";
  const side = useSettings((s) => s.sidebarSide);
  const closeChoices = top ? AFTER_CLOSING_ACROSS : AFTER_CLOSING_DOWN;
  return (
    <>
      <SectionHeader title="Switching tabs" />
      <Box gap="xl">
        <Anchor id="appearance.ctrlTab" shape="card">
          <FormField label={setting("appearance.ctrlTab").title}>
            <Box row gap="xl" accessibilityRole="radiogroup">
              {CTRL_TAB.map((c) => (
                <PictureChoice key={c.value} title={c.title} caption={c.caption} selected={choice === c.value} onPress={() => chooseCtrlTab(c.value)} size="l">
                  <CtrlTabPreview preset={c.value} />
                </PictureChoice>
              ))}
            </Box>
            {choice === "custom" && <CustomCtrlTabNote />}
          </FormField>
        </Anchor>
        <Anchor id="appearance.afterClosingTab" shape="card">
          <FormField label={setting("appearance.afterClosingTab").title}>
            <Box row gap="xl" accessibilityRole="radiogroup">
              {closeChoices.map((c) => (
                <PictureChoice
                  key={c.value}
                  title={c.title}
                  caption={c.caption}
                  selected={afterClosingTab === c.value}
                  onPress={() => afterClosingTab !== c.value && chooseAfterClosingTab(c.value)}
                  size="l"
                >
                  <AfterClosingTabPreview mode={c.value} top={top} side={side} />
                </PictureChoice>
              ))}
            </Box>
          </FormField>
        </Anchor>
      </Box>
    </>
  );
}

function CustomCtrlTabNote() {
  const showKeys = () => {
    setShortcutsQuery(ctrlTabCustomQuery());
    goToSettingsPane("shortcuts");
  };
  return (
    <Box row gap="s" style={CUSTOM_NOTE}>
      <Text size="caption" tone="textSecondary" style={FILL}>
        {`Custom: you set your own keys for ${CTRL_TAB_KEY} in Shortcuts. Pick one above to use it instead.`}
      </Text>
      <Button title="Show in Shortcuts" onPress={showKeys} />
    </Box>
  );
}

const FILL = { flex: 1 } as const;
const CUSTOM_NOTE = { alignItems: "center", marginTop: space.l } as const;
