import { Label, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import { SettingsRowLabel, settingsTint, settingsUIAvailable, type SettingsTintName } from "../ui";

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const DESCRIPTION_GAP = 2;

const fallbackInk = (tint: SettingsTintName) => (tint in settingsTint ? settingsTint[tint as keyof typeof settingsTint] : settingsTint.neutral);

export function ExpoPaneLabel({ title, systemImage, tint }: { title: string; systemImage: string; tint: SettingsTintName }) {
  if (settingsUIAvailable()) return <SettingsRowLabel title={title} systemImage={systemImage} tint={tint} />;
  return <Label title={title} systemImage={systemImage as never} color={fallbackInk(tint)} />;
}

export function ExpoRowText({ title, description }: { title: string; description?: string }) {
  if (!description) return <Text>{title}</Text>;
  return (
    <VStack alignment="leading" spacing={DESCRIPTION_GAP}>
      <Text>{title}</Text>
      <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(SECONDARY)]}>{description}</Text>
    </VStack>
  );
}
