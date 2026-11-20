import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { INTERFACE_STYLE_NAMES, INTERFACE_STYLES, offeredInterfaceStyle, offeredScheme, SCHEME_CHOICES, SCHEME_NAMES, TABS_STYLE_FOOTER } from "../../lib/appearance";
import { syncOffered } from "../../state/sync/offer";
import { setColorChoice, setInterfaceStyle, setSchemeChoice } from "../../state/settings/actions";
import { useAppearanceSummary } from "../../state/settings/appearance";
import { usePreferences } from "../../state/settings/hooks";
import { popSettings, pushSettings } from "../../state/settings/nav";
import { matchMyMac } from "../../state/sync/actions";
import { useSyncEnabled } from "../../state/sync/hooks";
import { setDeckGrid, useDeckGrid } from "../../state/browse/deckGrid";
import { useIncognito } from "../../state/tabs/hooks";
import { capsule, font, PROFILE_COLORS, settingsLayout, settingsMotion, settingsTint, space, Symbol, useProfileLook, useTheme, type ProfileColor } from "../ui";
import { Divider, Group, IconTile, NavRow, SettingsPage, ToggleRow } from "./SettingsKit";

const COLORS = Object.keys(PROFILE_COLORS) as ProfileColor[];

const colorName = (choice: string) => PROFILE_COLORS[choice as ProfileColor]?.name ?? choice;

export function AppearanceRow() {
  const look = useProfileLook();
  const summary = useAppearanceSummary(colorName);
  return <NavRow title="Appearance" icon="paintpaletteFill" tint={look.swatch} value={summary} onPress={() => pushSettings({ page: "appearance" })} />;
}

export function AppearancePage() {
  const syncEnabled = useSyncEnabled();
  const offersSync = syncOffered();
  const style = offeredInterfaceStyle(usePreferences((p) => p.interfaceStyle), offersSync);
  const scheme = offeredScheme(usePreferences((p) => p.schemeChoice), offersSync);
  const styleChoices = offersSync ? INTERFACE_STYLES : INTERFACE_STYLES.filter((choice) => choice !== "matchMac");
  const schemeChoices = offersSync ? SCHEME_CHOICES : SCHEME_CHOICES.filter((choice) => choice !== "matchMac");
  const grid = useDeckGrid();
  const incognito = useIncognito();
  return (
    <SettingsPage title="Appearance" onBack={popSettings}>
      <Group>
        <ColorRow labelled={false} />
        {syncEnabled ? <MatchMyMac labelled={false} /> : null}
      </Group>
      <Group header="Interface Style" footer={offersSync ? "Match My Mac follows your Mac." : undefined}>
        {styleChoices.map((choice, index) => (
          <CheckRow key={choice} title={INTERFACE_STYLE_NAMES[choice]} checked={style === choice} divider={index < styleChoices.length - 1} onPress={() => setInterfaceStyle(choice)} />
        ))}
      </Group>
      <Group header="Light or Dark" footer={offersSync ? "Match My Mac follows your Mac. System follows this device." : "System follows this device."}>
        {schemeChoices.map((choice, index) => (
          <CheckRow key={choice} title={SCHEME_NAMES[choice]} checked={scheme === choice} divider={index < schemeChoices.length - 1} onPress={() => setSchemeChoice(choice)} />
        ))}
      </Group>
      <Group header="Tabs" footer={TABS_STYLE_FOOTER}>
        <CheckRow title="Stack" checked={!grid} divider onPress={() => setDeckGrid(false, !incognito)} />
        <CheckRow title="Grid" checked={grid} divider={false} onPress={() => setDeckGrid(true, !incognito)} />
      </Group>
    </SettingsPage>
  );
}

function CheckRow({ title, checked, divider, onPress }: { title: string; checked: boolean; divider: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ selected: checked }}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <Text style={[font.body, styles.fill, { color: theme.label }]}>{title}</Text>
        {checked ? <Symbol name="checkmark" size={18} color={theme.formAccent} /> : null}
      </Pressable>
      {divider ? <Divider /> : null}
    </View>
  );
}

export function MatchMyMac({ labelled = true }: { labelled?: boolean }) {
  const theme = useTheme();
  const chosen = usePreferences((p) => p.colorChoice);
  const look = useProfileLook();
  return (
    <>
      <View style={[styles.divider, labelled ? styles.dividerPastIcon : null, { backgroundColor: theme.separator }]} />
      <ToggleRow title="Match My Mac" icon={labelled ? "laptop" : undefined} tint={labelled ? settingsTint.neutral : undefined} value={chosen === null} onChange={(on) => matchMyMac(on, look)} />
    </>
  );
}

export function ColorRow({ labelled = true }: { labelled?: boolean }) {
  const theme = useTheme();
  const look = useProfileLook();
  return (
    <View style={[styles.colorRow, labelled ? null : styles.colorRowPlain]}>
      <View style={styles.colorLabel}>
        {labelled ? <IconTile icon="paintpaletteFill" tint={look.swatch} /> : null}
        <Text style={[font.body, { color: theme.label }]}>Color</Text>
      </View>
      <View style={styles.swatches} accessibilityRole="radiogroup">
        {COLORS.map((color) => (
          <Swatch key={color} color={color} selected={color === look.preset} />
        ))}
      </View>
    </View>
  );
}

function Swatch({ color, selected }: { color: ProfileColor; selected: boolean }) {
  const swatch = PROFILE_COLORS[color].swatch;
  const ring = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    ring.value = withSpring(selected ? 1 : 0, settingsMotion.swatchRing);
  }, [selected, ring]);
  const ringStyle = useAnimatedStyle(() => ({ opacity: ring.value }));
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={PROFILE_COLORS[color].name}
      accessibilityState={{ selected }}
      onPress={() => setColorChoice(color)}
      style={styles.swatchHit}
    >
      <View style={styles.ringBox}>
        <Animated.View testID="swatchRing" style={[StyleSheet.absoluteFill, styles.ring, { borderColor: swatch }, ringStyle]} />
        <View style={[styles.swatch, { backgroundColor: swatch }]} />
      </View>
    </Pressable>
  );
}

const RING = settingsLayout.swatch + (settingsLayout.swatchGap + settingsLayout.swatchRing) * 2;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: settingsLayout.rowInset },
  dividerPastIcon: { marginLeft: settingsLayout.rowInset + settingsLayout.tile + settingsLayout.labelGap },
  colorRow: { paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.m, gap: space.m },
  colorRowPlain: { gap: space.s },
  colorLabel: { flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap },
  swatches: { flexDirection: "row" },
  swatchHit: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center" },
  ringBox: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
  ring: { borderRadius: capsule(RING), borderWidth: settingsLayout.swatchRing },
  swatch: { width: settingsLayout.swatch, height: settingsLayout.swatch, borderRadius: capsule(settingsLayout.swatch) },
});
