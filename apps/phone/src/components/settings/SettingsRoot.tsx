import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig } from "react-native-reanimated";
import { destinationWords, dismissWords } from "../../lib/sharedWords";
import { closeSettings, pushSettings } from "../../state/settings/nav";
import { useSyncStatus } from "../../state/sync/hooks";
import { syncOffered } from "../../state/sync/offer";
import { syncRowSubtitle } from "../../state/sync/syncRules";
import { duration, font, settingsLayout, settingsTint, space, Symbol, useDesign, useTheme, useWarningInk } from "../ui";
import { BarButton, Group, IconTile, NavRow, SettingsPage } from "./SettingsKit";
import { SettingsPaneList } from "./SettingsPanes";

export function SettingsRoot() {
  const stacks = useWindowDimensions().fontScale >= settingsLayout.accessibilityFontScale;
  const material = useDesign() === "material";
  return (
    <SettingsPage
      title={destinationWords.settings}
      mediumAppBar={material}
      onClose={material ? closeSettings : undefined}
      trailing={material ? undefined : <BarButton title={dismissWords.done} emphasized onPress={closeSettings} />}
    >
      {syncOffered() ? (
        <Group>
          {material ? <MaterialSyncRow /> : <SyncCard stacks={stacks} />}
        </Group>
      ) : null}
      <SettingsPaneList />
    </SettingsPage>
  );
}

function MaterialSyncRow() {
  const line = syncRowSubtitle(useSyncStatus());
  return <NavRow title={destinationWords.sync} icon="macAndPhone" value={line.text} onPress={() => pushSettings({ page: "sync" })} />;
}

function SyncCard({ stacks }: { stacks: boolean }) {
  const theme = useTheme();
  const warningInk = useWarningInk();
  const status = useSyncStatus();
  const line = syncRowSubtitle(status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={destinationWords.sync}
      accessibilityValue={{ text: line.text }}
      onPress={() => pushSettings({ page: "sync" })}
      style={({ pressed }) => [styles.syncCard, pressed ? { backgroundColor: theme.rowHighlight } : null]}
    >
      <View testID="syncCardContent" style={[styles.fill, stacks ? styles.syncStacked : styles.syncBeside]}>
        <IconTile icon="macAndPhone" tint={settingsTint.sync} side={stacks ? settingsLayout.syncTileLarge : settingsLayout.syncTile} />
        <View style={styles.syncText}>
          <Text style={[font.title3, styles.bold, { color: theme.label }]}>{destinationWords.sync}</Text>
          <LayoutAnimationConfig skipEntering>
            <Animated.Text
              key={line.text}
              testID="syncStatusLine"
              entering={FadeIn.duration(duration.crossfade)}
              exiting={FadeOut.duration(duration.crossfade)}
              style={[font.subheadline, { color: line.isWarning ? warningInk : theme.secondaryLabel }]}
              numberOfLines={stacks ? undefined : 2}
            >
              {line.text}
            </Animated.Text>
          </LayoutAnimationConfig>
        </View>
      </View>
      <Symbol name="chevronRight" size={14} color={theme.tertiaryLabel} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  syncCard: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.m },
  syncText: { flexShrink: 1, gap: space.tight },
  syncBeside: { flexDirection: "row", alignItems: "center", gap: space.s + 2 },
  syncStacked: { flexDirection: "column", alignItems: "flex-start", gap: space.s },
});
