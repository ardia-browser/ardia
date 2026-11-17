import { Platform, StyleSheet, Text, View } from "react-native";
import { shownSharingFootnote, shownWhatsSent } from "../../lib/shownWhatsSent";
import { PHONE_SHARING_COPY } from "../../lib/telemetryCopy";
import { syncOffered } from "../../state/sync/offer";
import { popSettings } from "../../state/settings/nav";
import { font, settingsLayout, space, useTheme } from "../ui";
import { Divider, Group, SettingsPage } from "./SettingsKit";

export function WhatsSentPage() {
  const theme = useTheme();
  const offersSync = syncOffered();
  const sections = shownWhatsSent(Platform.OS, offersSync);
  return (
    <SettingsPage title={PHONE_SHARING_COPY.whatsSent} onBack={popSettings}>
      {sections.map((section, index) => (
        <Group key={section.title} header={section.title} footer={index === sections.length - 1 ? shownSharingFootnote(offersSync) : null}>
          {section.items.map((item, at) => (
            <View key={item.text}>
              <Text style={[font.subheadline, styles.item, { color: theme.label }]}>{item.text}</Text>
              {at < section.items.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </Group>
      ))}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  item: { paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.m },
});
