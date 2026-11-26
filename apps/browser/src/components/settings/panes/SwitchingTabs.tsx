import { Box, Button, space, Text } from "../../ui";
import { Anchor, FormField, SectionHeader } from "../Form";
import { PictureChoice } from "../PictureChoice";
import { AfterClosingTabPreview, TabSwitcherOrderPreview, TabSwitcherViewPreview } from "../ChoicePreviews";
import { setting } from "../settingsIndex";
import { ctrlTabCustomQuery, restoreCtrlTab, useCtrlTabKeys } from "../../../state/commands/commandShortcuts";
import { useSettings, useTabLayout } from "../../../state/browser/hooks";
import { chooseAfterClosingTab, chooseTabSwitcherOrder, chooseTabSwitcherView } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { TAB_SWITCHER_ORDERS, TAB_SWITCHER_VIEWS } from "../ctrlTabChoices";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { setShortcutsQuery } from "../../../state/settings/searchState";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";

const CTRL_TAB_KEY = PLATFORM_TERMS.switchTabsKey;

const AFTER_CLOSING_DOWN: { value: Settings["afterClosingTab"]; title: string; caption: string }[] = [
  { value: "tabAbove", title: "Tab above", caption: "Goes to the tab right above it." },
  { value: "tabBelow", title: "Tab below", caption: "Goes to the tab right below it." },
  { value: "previouslyActive", title: "Previously active tab", caption: "Goes back to the tab you used before, like Arc." },
];

const AFTER_CLOSING_ACROSS: { value: Settings["afterClosingTab"]; title: string; caption: string }[] = [
  { value: "tabAbove", title: "Tab to the left", caption: "Goes to the tab to the left." },
  { value: "tabBelow", title: "Tab to the right", caption: "Goes to the tab to the right." },
  { value: "previouslyActive", title: "Previously active tab", caption: "Goes back to the tab you used before, like Arc." },
];

export function SwitchingTabsSection() {
  const keys = useCtrlTabKeys();
  const order = useSettings((s) => s.tabSwitcherOrder);
  const view = useSettings((s) => s.tabSwitcherView);
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
              {TAB_SWITCHER_ORDERS.map((c) => (
                <PictureChoice key={c.value} title={c.title} caption={c.caption} selected={order === c.value} onPress={() => order !== c.value && chooseTabSwitcherOrder(c.value)} size="l">
                  <TabSwitcherOrderPreview order={c.value} />
                </PictureChoice>
              ))}
            </Box>
            {keys === "custom" && <CustomCtrlTabNote />}
          </FormField>
        </Anchor>
        <Anchor id="appearance.tabSwitcherView" shape="card">
          <FormField label={setting("appearance.tabSwitcherView").title}>
            <Box row gap="xl" accessibilityRole="radiogroup">
              {TAB_SWITCHER_VIEWS.map((c) => (
                <PictureChoice key={c.value} title={c.title} caption={c.caption} selected={view === c.value} onPress={() => view !== c.value && chooseTabSwitcherView(c.value)} size="l">
                  <TabSwitcherViewPreview view={c.value} />
                </PictureChoice>
              ))}
            </Box>
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
        {`${CTRL_TAB_KEY} is set to something else in Shortcuts, so these apply to the Tab Switcher's own keys.`}
      </Text>
      <Button title="Show in Shortcuts" onPress={showKeys} />
      <Button title={`Use ${CTRL_TAB_KEY}`} onPress={() => void restoreCtrlTab()} />
    </Box>
  );
}

const FILL = { flex: 1 } as const;
const CUSTOM_NOTE = { alignItems: "center", marginTop: space.l } as const;
