import { PlatformColor } from "react-native";
import { Button, Form, HStack, Image, LabeledContent, Section, Spacer, Text } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityHidden, font, foregroundStyle, navigationBarTitleDisplayMode, navigationTitle, tint } from "@expo/ui/swift-ui/modifiers";
import { setSearchEngine, useEngines } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { useSyncEnabled, useSyncView } from "../../state/sync/hooks";
import { syncedEngineName } from "../../state/sync/syncRules";
import { modifierList, settingsChrome, useTheme } from "../ui";
import { t } from "../../lib/uiLanguage";


export function ExpoSearchEnginePage() {
  const theme = useTheme();
  const engines = useEngines((s) => s.engines);
  const selected = usePreferences((p) => p.searchEngineId);
  const syncEnabled = useSyncEnabled();
  const synced = useSyncView().search;
  return (
    <Form modifiers={modifierList(navigationTitle(t(`Search Engine`)), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome())}>
      {syncEnabled && synced ? (
        <Section footer={<Text>Set on your Mac.</Text>}>
          <LabeledContent label={t(`From Your Mac`)}>
            <Text>{syncedEngineName(synced, engines)}</Text>
          </LabeledContent>
        </Section>
      ) : (
        <Section>
          {engines.map((engine) => (
            <Button key={engine.id} onPress={() => setSearchEngine(engine.id)} modifiers={[tint("primary"), accessibilityAddTraits(engine.id === selected ? ["isButton", "isSelected"] : ["isButton"])]}>
              <HStack>
                <Text>{engine.name}</Text>
                <Spacer />
                {engine.id === selected ? <Image systemName="checkmark" modifiers={[font({ textStyle: "body", weight: "semibold" }), foregroundStyle(theme.formAccent), accessibilityHidden(true)]} /> : null}
              </HStack>
            </Button>
          ))}
        </Section>
      )}
    </Form>
  );
}
