import { Label } from "@expo/ui/swift-ui";
import { SettingsRowLabel, settingsTint, settingsUIAvailable, type SettingsTintName } from "../ui";

const fallbackInk = (tint: SettingsTintName) => (tint in settingsTint ? settingsTint[tint as keyof typeof settingsTint] : settingsTint.neutral);

export function ExpoRowLabel({ title, systemImage, tint }: { title: string; systemImage: string; tint: SettingsTintName }) {
  if (settingsUIAvailable()) return <SettingsRowLabel title={title} systemImage={systemImage} tint={tint} />;
  return <Label title={title} systemImage={systemImage as never} color={fallbackInk(tint)} />;
}
