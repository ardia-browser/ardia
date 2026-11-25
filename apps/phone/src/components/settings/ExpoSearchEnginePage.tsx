import { PlatformColor } from "react-native";
import { Form, LabeledContent, Section, Text } from "@expo/ui/swift-ui";
import { navigationBarTitleDisplayMode, navigationTitle, tint } from "@expo/ui/swift-ui/modifiers";
import { setSearchEngine, useEngines } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { useSyncEnabled, useSyncView } from "../../state/sync/hooks";
import { syncedEngineName } from "../../state/sync/syncRules";
import { modifierList, neverBounces, settingsChrome } from "../ui";
import { ExpoChoiceRow } from "./ExpoSettingsParts";

export function ExpoSearchEnginePage() {
  const engines = useEngines((s) => s.engines);
  const selected = usePreferences((p) => p.searchEngineId);
  const syncEnabled = useSyncEnabled();
  const synced = useSyncView().search;
  return (
    <Form modifiers={modifierList(navigationTitle("Search Engine"), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), neverBounces())}>
      {syncEnabled && synced ? (
        <Section footer={<Text>Set on your Mac.</Text>}>
          <LabeledContent label="From Your Mac">
            <Text>{syncedEngineName(synced, engines)}</Text>
          </LabeledContent>
        </Section>
      ) : (
        <Section>
          {engines.map((engine) => (
            <ExpoChoiceRow key={engine.id} title={engine.name} checked={engine.id === selected} onPress={() => setSearchEngine(engine.id)} />
          ))}
        </Section>
      )}
    </Form>
  );
}
