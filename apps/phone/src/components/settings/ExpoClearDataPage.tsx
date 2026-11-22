import { useState } from "react";
import { PlatformColor } from "react-native";
import { Button, ConfirmationDialog, Form, Picker, Section, Text, Toggle } from "@expo/ui/swift-ui";
import { contentTransition, disabled, navigationBarTitleDisplayMode, navigationTitle, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { haptics } from "../../state/app/haptics";
import { clearBrowsingData, websiteDataClearsByTime } from "../../state/settings/actions";
import { popSettings, type SettingsRoute } from "../../state/settings/nav";
import { CLEAR_RANGES, clearChoice, clearFooter, clearIsEmpty, clearMessage, clearTitle, type ClearRange } from "../../state/settings/settingsRules";
import { modifierList, settingsChrome, settingsSwitchStyle } from "../ui";
import { ExpoBusyButton } from "./ExpoSettingsParts";
import { destinationWords } from "../../lib/sharedWords";

export function ExpoClearDataPage({ onCleared = popSettings }: { route?: SettingsRoute; onCleared?: () => void }) {
  const [range, setRange] = useState<ClearRange>("today");
  const [history, setHistory] = useState(true);
  const [cache, setCache] = useState(true);
  const [cookies, setCookies] = useState(false);
  const [archive, setArchive] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [byTime] = useState(websiteDataClearsByTime);
  const choice = clearChoice(history, cache, cookies, archive, range);
  const clear = async () => {
    haptics.warning();
    setClearing(true);
    await clearBrowsingData(choice, range);
    setClearing(false);
    onCleared();
  };
  const toggle = (title: string, isOn: boolean, onChange: (on: boolean) => void) => (
    <Toggle isOn={isOn} onIsOnChange={onChange} modifiers={modifierList(settingsSwitchStyle(), disabled(clearing))}>
      <Text>{title}</Text>
    </Toggle>
  );
  return (
    <Form modifiers={modifierList(navigationTitle("Clear Browsing Data"), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome())}>
      <Section>
        <Picker label="Time Range" selection={range} onSelectionChange={(next: ClearRange) => setRange(next)} modifiers={[pickerStyle("menu"), tint("secondary"), disabled(clearing)]}>
          {CLEAR_RANGES.map((option) => (
            <Text key={option.id} modifiers={[tag(option.id)]}>
              {option.title}
            </Text>
          ))}
        </Picker>
      </Section>
      <Section title="Clear" footer={<Text modifiers={[contentTransition("opacity")]}>{clearFooter(choice, range, byTime)}</Text>}>
        {toggle(destinationWords.history, history, setHistory)}
        {toggle("Cache", cache, setCache)}
        {toggle("Cookies and Site Data", cookies, setCookies)}
        {range === "allTime" ? toggle("Archived Tabs", archive, setArchive) : null}
      </Section>
      <Section>
        <ConfirmationDialog title={clearTitle(choice, range, byTime)} isPresented={confirming} onIsPresentedChange={setConfirming} titleVisibility="visible">
          <ConfirmationDialog.Trigger>
            <ExpoBusyButton role="destructive" title="Clear Data…" busy={clearing} isDisabled={clearIsEmpty(choice)} onPress={() => setConfirming(true)} />
          </ConfirmationDialog.Trigger>
          <ConfirmationDialog.Actions>
            <Button role="destructive" label="Clear Data" onPress={() => void clear()} />
          </ConfirmationDialog.Actions>
          <ConfirmationDialog.Message>
            <Text>{clearMessage(choice)}</Text>
          </ConfirmationDialog.Message>
        </ConfirmationDialog>
      </Section>
    </Form>
  );
}
