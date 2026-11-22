import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView, LegacyScrollView } from "react-native-gesture-handler";
import { lookAngle, MAX_THEME_STOPS, THEME_TEXTURES, withAddedStop, withAngle, withoutStop, withTexture, type ProfileTheme, type ThemeMode, type ThemeTexture } from "@ardia/core/src/theme.ts";
import { customLook } from "../../lib/profileLook";
import { editedLook, keptReadable, TEXTURE_NAMES, THEME_MODES } from "../../lib/themeEditor";
import { dropThemeDraft, editCustomTheme, startingCustomTheme } from "../../state/settings/customTheme";
import { popSettings } from "../../state/settings/nav";
import { useCustomTheme } from "../../state/settings/themeDraft";
import { capsule, CustomLookBackdrop, font, settingsLayout, space, Symbol, themeEditorLayout as L, useProfileLook, useTheme } from "../ui";
import { Group, PickerRow, SettingsHostedContext, SettingsPage } from "./SettingsKit";
import { ColorPad, DirectionDial, LightnessBar, ThemeSlider, type BlockedScroll } from "./ThemeControls";

function useLiveTheme(stored: ProfileTheme) {
  const [local, setLocal] = useState<ProfileTheme | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<ProfileTheme | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      dropThemeDraft();
    },
    [],
  );
  const change = useCallback((next: ProfileTheme, settle: boolean) => {
    if (settle) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = null;
      setLocal(null);
      editCustomTheme(next, true);
      return;
    }
    setLocal(next);
    pending.current = next;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) editCustomTheme(pending.current, false);
    });
  }, []);
  return { theme: local ?? stored, change };
}

export function ThemePage() {
  const look = useProfileLook();
  const stored = useCustomTheme();
  const [fallback] = useState(() => startingCustomTheme(look));
  return <ThemeEditor stored={stored ?? fallback} />;
}

function ThemeEditor({ stored }: { stored: ProfileTheme }) {
  const ui = useTheme();
  const dark = ui.dark;
  const { theme: editing, editsDark } = editedLook(stored, dark);
  const { theme, change } = useLiveTheme(editing);
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, theme.stops.length - 1);
  const scroll = useRef(null);
  const blocks = scroll as unknown as BlockedScroll;
  const hosted = useContext(SettingsHostedContext);
  const preview = useMemo(() => customLook(theme, "own"), [theme]);
  const set = (patch: Partial<ProfileTheme>) => change({ ...theme, ...patch }, true);
  const live = (field: "intensity" | "translucency" | "grain") => (value: number, settle: boolean) => change({ ...theme, [field]: value }, settle);
  const kept = keptReadable(theme, dark);
  const body = (
    <LegacyScrollView ref={scroll} style={styles.fill} contentContainerStyle={styles.content}>
      <Group>
        <CustomLookBackdrop testID="themePreview" look={preview} dark={dark} style={styles.preview} />
      </Group>
      <Group header="Colors" footer={editsDark === null ? null : `Separate light and dark looks. Editing keeps the ${editsDark ? "dark" : "light"} one.`}>
        <View style={styles.colors}>
          <ColorPad theme={theme} selected={index} onSelect={setSelected} onChange={change} blocks={blocks} />
          <LightnessBar theme={theme} index={index} onChange={change} blocks={blocks} />
          <View style={styles.count}>
            <Text style={[font.body, styles.fill, { color: ui.secondaryLabel }]}>
              {theme.stops.length} of {MAX_THEME_STOPS} colors
            </Text>
            <Stepper
              icon="minus"
              label="Remove Color"
              enabled={theme.stops.length > 1}
              onPress={() => {
                change(withoutStop(theme, index), true);
                setSelected(Math.max(0, index - 1));
              }}
            />
            <Stepper
              icon="plus"
              label="Add Color"
              enabled={theme.stops.length < MAX_THEME_STOPS}
              onPress={() => {
                change(withAddedStop(theme), true);
                setSelected(theme.stops.length);
              }}
            />
          </View>
        </View>
      </Group>
      <Group>
        <ThemeSlider title="Intensity" value={theme.intensity} onChange={live("intensity")} blocks={blocks} />
        <ThemeSlider title="Pass-Through Blur" value={theme.translucency} onChange={live("translucency")} blocks={blocks} />
        <ThemeSlider title="Noise" value={theme.grain} onChange={live("grain")} blocks={blocks} />
        <PickerRow<ThemeTexture> title="Texture" options={THEME_TEXTURES.map((id) => ({ id, title: TEXTURE_NAMES[id] }))} selected={theme.texture} divider onSelect={(texture) => change(withTexture(theme, texture), true)} />
        <Row title="Direction">
          <Text style={[font.body, styles.degrees, { color: ui.secondaryLabel }]}>{Math.round(lookAngle(theme))}°</Text>
          <DirectionDial angle={lookAngle(theme)} onChange={(angle, settle) => change(withAngle(theme, angle), settle)} blocks={blocks} />
        </Row>
      </Group>
      <Group footer={kept ? `Kept ${dark ? "dark" : "light"} so text stays readable.` : null}>
        <PickerRow<ThemeMode> title="Appearance" options={[...THEME_MODES]} selected={theme.mode} onSelect={(mode) => set({ mode })} />
      </Group>
    </LegacyScrollView>
  );
  return (
    <SettingsPage title="Theme" onBack={popSettings} scroll={false}>
      {hosted ? <GestureHandlerRootView style={styles.fill}>{body}</GestureHandlerRootView> : body}
    </SettingsPage>
  );
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  const ui = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[font.body, styles.fill, { color: ui.label }]}>{title}</Text>
      {children}
    </View>
  );
}

function Stepper({ icon, label, enabled, onPress }: { icon: "minus" | "plus"; label: string; enabled: boolean; onPress: () => void }) {
  const ui = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      hitSlop={space.xs}
      style={({ pressed }) => [styles.stepper, { backgroundColor: pressed ? ui.rowHighlight : ui.separator }]}
    >
      <Symbol name={icon} size={14} color={enabled ? ui.formAccent : ui.tertiaryLabel} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingTop: space.m, paddingBottom: space.huge, gap: space.xxl },
  preview: { height: L.preview },
  colors: { paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.l, gap: space.l },
  count: { flexDirection: "row", alignItems: "center", gap: space.s },
  stepper: { width: L.stepper, height: L.stepper, borderRadius: capsule(L.stepper), alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  degrees: { fontVariant: ["tabular-nums"] },
});
