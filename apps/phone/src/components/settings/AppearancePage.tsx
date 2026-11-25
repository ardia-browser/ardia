import { useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { themeAccent, themePalette } from "@ardia/core/src/theme.ts";
import { Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { linearGradientCss } from "../../lib/gradient";
import { wallpaperColorsEnabled } from "../../lib/material/schemePick";
import { rainbow } from "../../lib/themeEditor";
import { INTERFACE_STYLE_NAMES, INTERFACE_STYLES, offeredInterfaceStyle, offeredScheme, SCHEME_CHOICES, SCHEME_NAMES } from "../../lib/appearance";
import { syncOffered } from "../../state/sync/offer";
import { setColorChoice, setDynamicColors, setInterfaceStyle, setSchemeChoice } from "../../state/settings/actions";
import { useAppearanceSummary } from "../../state/settings/appearance";
import { openThemeEditor } from "../../state/settings/customTheme";
import { usePreferences } from "../../state/settings/hooks";
import { popSettings, pushSettings } from "../../state/settings/nav";
import { matchMyMac } from "../../state/sync/actions";
import { useSyncEnabled } from "../../state/sync/hooks";
import { capsule, font, materialYouOffered, PROFILE_COLORS, settingsLayout, settingsMotion, settingsTint, space, Symbol, themeEditorLayout, useDesign, useProfileLook, useTheme, type ProfileColor, usePressStyle } from "../ui";
import { MaterialCheckRow, MaterialSettingsLeading } from "./MaterialSettingsKit";
import { useMaterialYouSwitch } from "./materialYouSwitch";
import { Divider, Group, IconTile, NavRow, SettingsFormColorsContext, SettingsPage, ToggleRow } from "./SettingsKit";
import { actionWords } from "../../lib/sharedWords";

const COLORS = Object.keys(PROFILE_COLORS) as ProfileColor[];

export const colorName = (choice: string) => (choice === "custom" ? "Custom" : (PROFILE_COLORS[choice as ProfileColor]?.name ?? choice));

const RAINBOW = rainbow(themeEditorLayout.rainbowStops);

export function AppearanceRow() {
  const look = useProfileLook();
  const summary = useAppearanceSummary(colorName);
  return <NavRow title="Appearance" icon="paintpaletteFill" tint={look.swatch} value={summary} onPress={() => pushSettings({ page: "appearance" })} />;
}

export function AppearancePage() {
  const syncEnabled = useSyncEnabled();
  const offersSync = syncOffered();
  const material = usePreferences((p) => materialYouOffered() && p.materialYou);
  const wallpaper = usePreferences((p) => material && wallpaperColorsEnabled(p.colorChoice, p.dynamicColors));
  const style = offeredInterfaceStyle(usePreferences((p) => p.interfaceStyle), offersSync);
  const scheme = offeredScheme(usePreferences((p) => p.schemeChoice), offersSync);
  const styleChoices = offersSync ? INTERFACE_STYLES : INTERFACE_STYLES.filter((choice) => choice !== "matchMac");
  const schemeChoices = offersSync ? SCHEME_CHOICES : SCHEME_CHOICES.filter((choice) => choice !== "matchMac");
  const materialSwitch = useRef<ViewInstance>(null);
  const { reveal, change } = useMaterialYouSwitch(material, () => materialSwitch.current);
  return (
    <SettingsPage title="Appearance" onBack={popSettings} revealRef={reveal}>
      <Group footer={wallpaper ? "Turn off Dynamic Colors to choose a color." : material ? "Custom themes are available with Material You off." : undefined}>
        <ColorRow labelled={false} customAvailable={!material} presetsAvailable={!wallpaper} />
        {syncEnabled ? <MatchMyMac labelled={false} /> : null}
      </Group>
      <Group header="Interface style" footer={material ? "Turn off Material You to use Glass or Classic." : offersSync ? "Match My Mac follows your Mac." : undefined}>
        {styleChoices.map((choice, index) => (
          <CheckRow key={choice} title={INTERFACE_STYLE_NAMES[choice]} checked={style === choice} disabled={material} divider={index < styleChoices.length - 1} onPress={() => setInterfaceStyle(choice)} />
        ))}
      </Group>
      <Group header="Light or dark" footer={offersSync ? "Match My Mac follows your Mac. System follows this device." : "System follows this device."}>
        {schemeChoices.map((choice, index) => (
          <CheckRow key={choice} title={SCHEME_NAMES[choice]} checked={scheme === choice} divider={index < schemeChoices.length - 1} onPress={() => setSchemeChoice(choice)} />
        ))}
      </Group>
      {materialYouOffered() ? <AndroidAppearanceControls materialSwitch={materialSwitch} onMaterialYou={change} /> : null}
    </SettingsPage>
  );
}

function AndroidAppearanceControls({ materialSwitch, onMaterialYou }: { materialSwitch: RefObject<ViewInstance | null>; onMaterialYou: (value: boolean) => void }) {
  const material = usePreferences((p) => p.materialYou);
  const colorChoice = usePreferences((p) => p.colorChoice);
  const dynamic = usePreferences((p) => p.dynamicColors);
  return (
    <Group>
      <ToggleRow buttonRef={materialSwitch} title="Material You" value={material} divider={material} onChange={onMaterialYou} />
      {material ? <ToggleRow title="Dynamic Colors" value={wallpaperColorsEnabled(colorChoice, dynamic)} onChange={setDynamicColors} /> : null}
    </Group>
  );
}

export function CheckRow(props: Parameters<typeof ClassicCheckRow>[0]) {
  return useDesign() === "material" ? <MaterialCheckRow {...props} /> : <ClassicCheckRow {...props} />;
}

function ClassicCheckRow({ title, checked, divider, onPress, disabled = false }: { title: string; checked: boolean; divider: boolean; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  const accent = useContext(SettingsFormColorsContext)?.formAccent ?? theme.formAccent;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ selected: checked, ...(disabled ? { disabled } : {}) }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <Text style={[font.body, styles.fill, { color: disabled ? theme.secondaryLabel : theme.label }]}>{title}</Text>
        {checked ? <Symbol name="checkmark" size={18} color={accent} /> : null}
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

export function ColorRow({ labelled = true, plainIcon = false, customAvailable = true, presetsAvailable = true }: { labelled?: boolean; plainIcon?: boolean; customAvailable?: boolean; presetsAvailable?: boolean }) {
  const theme = useTheme();
  const look = useProfileLook();
  const choice = usePreferences((p) => p.colorChoice);
  const material = useDesign() === "material";
  const selected = material ? choice ?? "plum" : look.preset;
  const custom = !material && choice === "custom";
  return (
    <>
      <View style={[styles.colorRow, labelled ? null : styles.colorRowPlain]}>
        <View style={[styles.colorLabel, plainIcon ? styles.plainColorLabel : null]}>
          {labelled ? plainIcon ? <MaterialSettingsLeading icon="paintpaletteFill" /> : <IconTile icon="paintpaletteFill" tint={look.swatch} /> : null}
          <Text style={[font.body, { color: theme.label }]}>{actionWords.color}</Text>
        </View>
        <View style={[styles.swatches, material ? null : styles.swatchGrid]} accessibilityRole="radiogroup">
          {COLORS.map((color) => (
            <Swatch key={color} color={color} selected={color === selected} grid={!material} disabled={!presetsAvailable} />
          ))}
          {material ? null : <CustomSwatch selected={custom} disabled={!customAvailable} />}
        </View>
      </View>
      {custom && customAvailable ? (
        <>
          <Divider />
          <NavRow title="Edit Theme" onPress={() => pushSettings({ page: "theme" })} />
        </>
      ) : null}
    </>
  );
}

function SwatchRing({ ring, selected, children }: { ring: string; selected: boolean; children: ReactNode }) {
  const shown = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    shown.value = withTiming(selected ? 1 : 0, settingsMotion.swatchPick);
  }, [selected, shown]);
  const ringStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const discStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - (1 - PICKED_DISC) * shown.value }] }));
  return (
    <View style={styles.ringBox}>
      <Animated.View testID="swatchRing" style={[StyleSheet.absoluteFill, styles.ring, { borderColor: ring }, ringStyle]} />
      <Animated.View testID="swatchDisc" style={discStyle}>
        {children}
      </Animated.View>
    </View>
  );
}

function CustomSwatch({ selected, disabled }: { selected: boolean; disabled: boolean }) {
  const look = useProfileLook();
  const saved = usePreferences((p) => p.customTheme);
  const colors = useMemo(() => (saved ? themePalette(saved) : RAINBOW), [saved]);
  const ring = useMemo(() => (saved ? themeAccent(saved) : settingsTint.neutral), [saved]);
  const side = settingsLayout.swatch;
  const pressStyle = usePressStyle("icon", { style: CUSTOM_SWATCH_HIT });
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel="Custom"
      accessibilityHint="Opens the theme editor"
      accessibilityState={{ selected, ...(disabled ? { disabled } : {}) }}
      disabled={disabled}
      onPress={() => openThemeEditor(look)}
      style={pressStyle}
    >
      <SwatchRing ring={ring} selected={selected}>
        <View testID="customSwatch" style={[styles.swatch, { experimental_backgroundImage: linearGradientCss(colors, true, side, side) }]} />
      </SwatchRing>
    </Pressable>
  );
}

function Swatch({ color, selected, grid, disabled }: { color: ProfileColor; selected: boolean; grid: boolean; disabled: boolean }) {
  const swatch = PROFILE_COLORS[color].swatch;
  const pressStyle = usePressStyle("icon", { style: grid ? CUSTOM_SWATCH_HIT : styles.swatchHit });
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={PROFILE_COLORS[color].name}
      accessibilityState={{ selected, ...(disabled ? { disabled } : {}) }}
      disabled={disabled}
      onPress={() => setColorChoice(color)}
      style={pressStyle}
    >
      <SwatchRing ring={swatch} selected={selected}>
        <View style={[styles.swatch, { backgroundColor: swatch }]} />
      </SwatchRing>
    </Pressable>
  );
}

const RING = settingsLayout.swatch + (settingsLayout.swatchGap + settingsLayout.swatchRing) * 2;

const PICKED_DISC = (RING - 2 * (2 * (settingsLayout.swatchGap + settingsLayout.swatchRing) - settingsLayout.swatchRing)) / settingsLayout.swatch;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: settingsLayout.rowInset },
  dividerPastIcon: { marginLeft: settingsLayout.rowInset + settingsLayout.tile + settingsLayout.labelGap },
  colorRow: { paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.m, gap: space.m },
  colorRowPlain: { gap: space.s },
  plainColorLabel: { gap: 16 },
  colorLabel: { flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap },
  swatches: { flexDirection: "row" },
  swatchGrid: { flexWrap: "wrap" },
  swatchCell: { flex: 0, width: "20%" },
  swatchHit: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center" },
  ringBox: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
  ring: { borderRadius: capsule(RING), borderWidth: settingsLayout.swatchRing },
  swatch: { width: settingsLayout.swatch, height: settingsLayout.swatch, borderRadius: capsule(settingsLayout.swatch) },
});

const CUSTOM_SWATCH_HIT = [styles.swatchHit, styles.swatchCell];
