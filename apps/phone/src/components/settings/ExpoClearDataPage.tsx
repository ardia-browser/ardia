import { useState } from "react";
import { PlatformColor } from "react-native";
import { Button, ConfirmationDialog, Form, HStack, Picker, ProgressView, Section, Spacer, Text, Toggle } from "@expo/ui/swift-ui";
import { contentTransition, disabled, navigationBarTitleDisplayMode, navigationTitle, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { haptics } from "../../state/app/haptics";
import { clearBrowsingData, websiteDataClearsByTime } from "../../state/settings/actions";
import { popSettings, type SettingsRoute } from "../../state/settings/nav";
import { CLEAR_RANGES, clearChoice, clearFooter, clearIsEmpty, clearMessage, clearTitle, type ClearRange } from "../../state/settings/settingsRules";
import { modifierList, settingsChrome, settingsSwitchStyle } from "../ui";
import { t } from "../../lib/uiLanguage";


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
    <Toggle isOn={isOn} onIsOnChange={onChange} modifiers={modifierList(settingsSwitchStyle())}>
      <Text>{title}</Text>
    </Toggle>
  );
  return (
    <Form modifiers={modifierList(navigationTitle(t(`Clear Browsing Data`)), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome())}>
      <Section>
        <Picker label={t(`Time Range`)} selection={range} onSelectionChange={(next: ClearRange) => setRange(next)} modifiers={[pickerStyle("menu"), tint("secondary")]}>
          {CLEAR_RANGES.map((option) => (
            <Text key={option.id} modifiers={[tag(option.id)]}>
              {option.title}
            </Text>
          ))}
        </Picker>
      </Section>
      <Section title={t(`Clear`)} footer={<Text modifiers={[contentTransition("opacity")]}>{clearFooter(choice, range, byTime)}</Text>}>
        {toggle(t(`History`), history, setHistory)}
        {toggle(t(`Cache`), cache, setCache)}
        {toggle(t(`Cookies and Site Data`), cookies, setCookies)}
        {range === "allTime" ? toggle(t(`Archived Tabs`), archive, setArchive) : null}
      </Section>
      <Section>
        <ConfirmationDialog title={clearTitle(choice, range, byTime)} isPresented={confirming} onIsPresentedChange={setConfirming} titleVisibility="visible">
          <ConfirmationDialog.Trigger>
            <Button role="destructive" onPress={() => setConfirming(true)} modifiers={[disabled(clearIsEmpty(choice) || clearing)]}>
              <HStack>
                <Text>Clear Data…</Text>
                <Spacer />
                {clearing ? <ProgressView /> : null}
              </HStack>
            </Button>
          </ConfirmationDialog.Trigger>
          <ConfirmationDialog.Actions>
            <Button role="destructive" label={t(`Clear Data`)} onPress={() => void clear()} />
          </ConfirmationDialog.Actions>
          <ConfirmationDialog.Message>
            <Text>{clearMessage(choice)}</Text>
          </ConfirmationDialog.Message>
        </ConfirmationDialog>
      </Section>
    </Form>
  );
}
