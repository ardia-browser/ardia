import { View } from "react-native";
import type { SettingsPlace } from "../../../state/settings/settingsWindows";
import { CalendarSection } from "./CalendarSection";
import { LinkRoutingSection } from "./LinkRoutingSection";
import { LiveFoldersSection } from "./LiveFoldersSection";

export function AutomationsPane({ spaceId: profileId }: SettingsPlace) {
  return (
    <View>
      <CalendarSection />
      <LiveFoldersSection />
      <LinkRoutingSection profileId={profileId} />
    </View>
  );
}
