import { useState } from "react";
import { View } from "react-native";
import { useTheme } from "../../ui/theme";
import { useSettings, useTabLayout } from "../../../state/browser/hooks";
import { chooseScrollToolbar, chooseSidebarSide, chooseTabLayout, updateSettings } from "../../../state/settings/actions";
import { customNewTabUrl, type Settings } from "../../../state/settings/settings";
import { Box, Button, Checkbox, DialogActions, DialogTitle, PopUp, Segmented, Sheet, space, Text, TextField, Toggle, type Option, type SegmentOption } from "../../ui";
import { durationMinutes, durationParts, type DurationUnit } from "../../../lib/time";
import { cleanUpChoices, CUSTOM_CLEAN_UP, DAILY_CLEAN_UP_MINUTES } from "../../../state/settings/cleanUpAfter";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { Anchor, FormField, Group, Row, SectionHeader, SettingToggle } from "../Form";
import { setting, type SettingId } from "../settingsIndex";
import { ScrollToolbarPreview } from "../ChoicePreviews";
import { MiniWindow } from "../MiniWindow";
import { PictureChoice } from "../PictureChoice";
import { useSettingsColors } from "../useSettingsColors";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import type { SettingsPlace } from "../../../state/settings/settingsWindows";

const APP = "Ardia";

const SIDEBAR_SIDES: SegmentOption<Settings["sidebarSide"]>[] = [
  { value: "left", title: "Left" },
  { value: "right", title: "Right" },
];

type SleepingLook = "normal" | "fade" | "strike" | "both";

const SLEEPING_LOOKS: Option<SleepingLook>[] = [
  { value: "normal", title: "Look normal" },
  { value: "fade", title: "Fade icon" },
  { value: "strike", title: "Strike through" },
  { value: "both", title: "Both" },
];

const NEW_TAB_OPENS: Option<Settings["newTabOpens"]>[] = [
  { value: "page", title: "New Tab page" },
  { value: "commandBar", title: "Command bar" },
];

const NEW_TABS_DOWN: Option<Settings["newTabPosition"]>[] = [
  { value: "bottom", title: "At the bottom" },
  { value: "top", title: "At the top" },
  { value: "nextToCurrent", title: "Below the current tab" },
];

const NEW_TABS_ACROSS: Option<Settings["newTabPosition"]>[] = [
  { value: "bottom", title: "On the right" },
  { value: "top", title: "On the left" },
  { value: "nextToCurrent", title: "Next to the current tab" },
];

type OtherSiteLinks = "same" | "peek";

const OTHER_SITE_LINKS: Option<OtherSiteLinks>[] = [
  { value: "same", title: "Same tab" },
  { value: "peek", title: "Peek" },
];

const NEW_TAB_LINKS: Option<Settings["newTabLinksOpenIn"]>[] = [
  { value: "tab", title: "New tab" },
  { value: "peek", title: "Peek" },
  { value: "littleArdia", title: "Little Ardia" },
];

const PEEK_BUTTONS: Option<Settings["peekButtons"]>[] = [
  { value: "top", title: "In the title bar" },
  { value: "left", title: "On the left" },
  { value: "right", title: "On the right" },
];

const NEVER_CLEAN_UP = "never";

const DURATION_UNITS: Option<DurationUnit>[] = [
  { value: "minutes", title: "Minutes" },
  { value: "hours", title: "Hours" },
  { value: "days", title: "Days" },
];

export function TabsPane(_place: SettingsPlace) {
  return (
    <View>
      <LayoutSection />
      <TabsAndTopAppsSection />
      <NewTabsSection />
      <LinksSection />
      <CleanUpSection />
    </View>
  );
}

function LayoutSection() {
  const top = useTabLayout() === "top";
  const sidebarSide = useSettings((s) => s.sidebarSide);
  return (
    <>
      <SectionHeader title="Layout" />
      <Box gap="xl">
        <Anchor id="tabs.layout" shape="card">
          <Box row gap="xl">
            <LayoutChoice layout="sidebar" title="Vertical sidebar" selected={!top} side={sidebarSide} />
            <LayoutChoice layout="top" title="Horizontal row" selected={top} />
          </Box>
        </Anchor>
        <Group>
          <SettingToggle
            anchor="tabs.autoHideTabs"
            description={`Tabs slide away until you point at the ${top ? "top edge" : "edge"}. ${keyText("⌘S")} toggles.`}
          />
          <SettingToggle anchor="tabs.shrinkHorizontalTabs" />
          <Row anchor="tabs.sidebarSide">
            <Segmented options={SIDEBAR_SIDES} value={sidebarSide} onChange={chooseSidebarSide} />
          </Row>
          <ButtonsRow top={top} />
        </Group>
        <ScrollToolbarChoices />
      </Box>
    </>
  );
}

const SCROLL_TOOLBAR: { hides: boolean; title: string; caption: string }[] = [
  { hides: false, title: "Keep the toolbar", caption: "Stays put while the page scrolls." },
  { hides: true, title: "Shrink while scrolling", caption: "Shrinks to a strip as you scroll down." },
];

function ScrollToolbarChoices() {
  const hides = useSettings((s) => s.hideToolbarWhileScrolling);
  return (
    <Anchor id="tabs.hideToolbarWhileScrolling" shape="card">
      <FormField label={setting("tabs.hideToolbarWhileScrolling").title}>
        <Box row gap="xl" accessibilityRole="radiogroup">
          {SCROLL_TOOLBAR.map((c) => (
            <PictureChoice key={c.title} title={c.title} caption={c.caption} selected={hides === c.hides} onPress={() => chooseScrollToolbar(c.hides)} size="l">
              <ScrollToolbarPreview hides={c.hides} />
            </PictureChoice>
          ))}
        </Box>
      </FormField>
    </Anchor>
  );
}

function ButtonsRow({ top }: { top: boolean }) {
  const sidebarButton = useSettings((s) => s.showSidebarButton !== false);
  const clearButton = useSettings((s) => s.showClearButton);
  return (
    <Row anchor="tabs.buttons" description={top ? "Hide Tabs in the toolbar." : undefined}>
      <Box row gap="l" style={CHECKLIST}>
        <Checkbox value={sidebarButton} label="Hide Tabs" onChange={(showSidebarButton) => updateSettings({ showSidebarButton })} />
        {top ? null : <Checkbox value={clearButton} label="Clear" onChange={(showClearButton) => updateSettings({ showClearButton })} />}
      </Box>
    </Row>
  );
}

const sleepingLookOf = (fade: boolean, strike: boolean): SleepingLook => (fade && strike ? "both" : fade ? "fade" : strike ? "strike" : "normal");

function TabsAndTopAppsSection() {
  const unread = useSettings((s) => s.showUnreadCounts);
  const topAppBadges = useSettings((s) => s.showTopAppBadges);
  const fade = useSettings((s) => s.fadeUnloadedTabs);
  const strike = useSettings((s) => s.strikeSleepingTabs);
  return (
    <>
      <SectionHeader title="Tabs and Top Apps" />
      <Group>
        <Row anchor="tabs.badges">
          <Toggle value={unread || topAppBadges} accessibilityLabel="Badges" onChange={(on) => updateSettings({ showUnreadCounts: on, showTopAppBadges: on })} />
        </Row>
        <Row anchor="tabs.sleepingTabs">
          <PopUp
            value={sleepingLookOf(fade, strike)}
            options={SLEEPING_LOOKS}
            onChange={(look) => updateSettings({ fadeUnloadedTabs: look === "fade" || look === "both", strikeSleepingTabs: look === "strike" || look === "both" })}
            minWidth={150}
          />
        </Row>
        <SettingToggle anchor="tabs.keepTopAppsRunning" />
        <SettingToggle anchor="tabs.closedTopAppTiles" />
        <SettingToggle anchor="tabs.balancedTopApps" />
        <SettingToggle anchor="tabs.topAppFolders" />
        <SettingToggle anchor="tabs.tabReorderHaptics" />
        <SettingToggle anchor="tabs.swipeBetweenTabs" />
        <SettingToggle anchor="tabs.showTabHoverMenu" />
        <SettingToggle anchor="tabs.showFullUrlInTabHoverMenu" />
        <SettingToggle anchor="tabs.autoPictureInPicture" />
        <SettingToggle anchor="tabs.playingNowAcrossProfiles" />
        <SettingToggle anchor="tabs.videoUpscaling" />
      </Group>
    </>
  );
}

function NewTabsSection() {
  const newTabOpens = useSettings((s) => s.newTabOpens);
  const minimal = useSettings((s) => s.minimalismMode);
  const newTabPosition = useSettings((s) => s.newTabPosition);
  const top = useTabLayout() === "top";
  const choosePosition = (position: Settings["newTabPosition"]) =>
    updateSettings(position === "nextToCurrent" ? { newTabPosition: position } : { newTabPosition: position, newTabButtonPosition: position });
  return (
    <>
      <SectionHeader title="New tabs" />
      <Group>
        <Row anchor="tabs.newTabOpens" description={minimal ? "Minimalism mode opens the command bar. Your choice here comes back when you turn it off." : undefined}>
          <PopUp value={minimal ? "commandBar" : newTabOpens} disabled={minimal} options={NEW_TAB_OPENS} onChange={(v) => updateSettings({ newTabOpens: v })} minWidth={160} />
        </Row>
        <NewTabUrlRow anchor="tabs.newTabUrl" />
        <Row anchor="tabs.newTabPosition">
          <PopUp value={newTabPosition} options={top ? NEW_TABS_ACROSS : NEW_TABS_DOWN} onChange={choosePosition} minWidth={190} />
        </Row>
        <SettingToggle anchor="tabs.appLinksFirst" />
        <SettingToggle anchor="tabs.shareTabsAcrossWindows" />
      </Group>
    </>
  );
}

function NewTabUrlRow({ anchor }: { anchor: SettingId }) {
  const saved = useSettings((s) => s.newTabUrl);
  const [draft, setDraft] = useState(saved);
  const [editedFrom, setEditedFrom] = useState(saved);
  if (editedFrom !== saved) {
    setEditedFrom(saved);
    setDraft(saved);
  }
  const invalid = !!draft.trim() && !customNewTabUrl({ newTabOpens: "page", minimalismMode: false, newTabUrl: draft });
  const save = () => {
    const value = draft.trim();
    if (value !== saved) updateSettings({ newTabUrl: value });
  };
  return (
    <Row anchor={anchor}>
      <TextField value={draft} onChangeText={setDraft} placeholder="New Tab page" onSubmit={save} onBlur={save} invalid={invalid} width={220} />
    </Row>
  );
}

function LinksSection() {
  const littleArdia = useSettings((s) => s.openLinksInLittleArdia);
  const peekOtherSites = useSettings((s) => s.peekLinksToOtherSites);
  const newTabLinks = useSettings((s) => s.newTabLinksOpenIn);
  const peekButtons = useSettings((s) => s.peekButtons);
  return (
    <>
      <SectionHeader title="Links" />
      <Group>
        <SettingToggle
          anchor="tabs.openLinksInLittleArdia"
          description={
            littleArdia
              ? `A link from ${PLATFORM_TERMS.linkSourceExamples} opens in Little Ardia, a small window of its own. ${keyText("⌘O")} moves it into ${APP}; closing it throws it away.`
              : `A link from ${PLATFORM_TERMS.linkSourceExamples} opens as a new tab in the ${APP} window you used last.`
          }
        />
        <SettingToggle anchor="tabs.littleArdiaOpensNewTabLinks" />
        <SettingToggle anchor="tabs.littleArdiaShortcutFromAnyApp" />
        <Row anchor="tabs.peekLinksToOtherSites">
          <PopUp value={peekOtherSites ? "peek" : "same"} options={OTHER_SITE_LINKS} onChange={(v) => updateSettings({ peekLinksToOtherSites: v === "peek" })} />
        </Row>
        <Row anchor="tabs.newTabLinksOpenIn">
          <PopUp value={newTabLinks} options={NEW_TAB_LINKS} onChange={(newTabLinksOpenIn) => updateSettings({ newTabLinksOpenIn })} />
        </Row>
        <SettingToggle anchor="tabs.popupsOpenAsTabs" />
        <Row anchor="tabs.peekButtons">
          <PopUp value={peekButtons} options={PEEK_BUTTONS} onChange={(peekButtons) => updateSettings({ peekButtons })} />
        </Row>
      </Group>
    </>
  );
}

function CleanUpSection() {
  const minutes = useSettings((s) => s.cleanUpInactiveTabsAfterMinutes);
  const shown = minutes ?? DAILY_CLEAN_UP_MINUTES;
  const options = [{ value: NEVER_CLEAN_UP, title: "Never" }, ...cleanUpChoices(shown)];
  const choose = (v: string) => {
    if (v === NEVER_CLEAN_UP) return updateSettings({ cleanUpInactiveTabsAfterMinutes: null });
    if (v === CUSTOM_CLEAN_UP) return showSettingsSheet(<CustomCleanUpSheet minutes={shown} />);
    updateSettings({ cleanUpInactiveTabsAfterMinutes: Number(v) });
  };
  return (
    <>
      <SectionHeader title="Clean up" />
      <Group>
        <Row anchor="tabs.cleanUp">
          <PopUp value={minutes === null ? NEVER_CLEAN_UP : String(minutes)} options={options} onChange={choose} minWidth={130} />
        </Row>
        <SettingToggle anchor="tabs.suggestCleanUp" />
        <SettingToggle anchor="tabs.tidyTabs" />
      </Group>
    </>
  );
}

function CustomCleanUpSheet({ minutes }: { minutes: number }) {
  const start = durationParts(minutes);
  const [amount, setAmount] = useState(String(start.amount));
  const [unit, setUnit] = useState<DurationUnit>(start.unit);
  const [invalid, setInvalid] = useState(false);
  const save = () => {
    const chosen = durationMinutes(amount, unit);
    if (chosen === null) return setInvalid(true);
    updateSettings({ cleanUpInactiveTabsAfterMinutes: chosen });
    closeSettingsSheet();
  };
  return (
    <Sheet size="s" onClose={closeSettingsSheet}>
      <DialogTitle subtitle="Close unused tabs after:">Custom Clean Up Time</DialogTitle>
      <Box row gap="m" style={FIELDS}>
        <TextField
          value={amount}
          onChangeText={(text) => {
            setAmount(text);
            setInvalid(false);
          }}
          onSubmit={save}
          onEscape={closeSettingsSheet}
          autoFocus
          selectOnFocus
          width={80}
        />
        <PopUp
          value={unit}
          options={DURATION_UNITS}
          onChange={(next) => {
            setUnit(next);
            setInvalid(false);
          }}
          minWidth={110}
        />
      </Box>
      {invalid && (
        <Text size="caption" tone="destructive" style={ERROR}>
          Enter a number above zero, up to 365 days.
        </Text>
      )}
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title="Save" kind="primary" onPress={save} />
      </DialogActions>
    </Sheet>
  );
}

function LayoutChoice({ layout, title, selected, side }: { layout: "sidebar" | "top"; title: string; selected: boolean; side?: Settings["sidebarSide"] }) {
  const theme = useTheme();
  const look = useSettingsColors();
  return (
    <PictureChoice title={title} selected={selected} onPress={() => chooseTabLayout(layout)} size="l">
      <MiniWindow
        size="l"
        layout={layout === "sidebar" ? "side" : "top"}
        side={side}
        bars={layout === "sidebar" ? 4 : 3}
        accentBar={1}
        look={{ window: look.miniWindow, bar: look.miniBar, page: look.miniPage, accent: theme.formAccent }}
      />
    </PictureChoice>
  );
}

const CHECKLIST = { alignItems: "center" } as const;
const FIELDS = { marginTop: space.l, alignItems: "center" } as const;
const ERROR = { marginTop: space.ml } as const;
