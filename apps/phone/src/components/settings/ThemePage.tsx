import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView, LegacyScrollView } from "react-native-gesture-handler";
import { lookAngle, MAX_THEME_STOPS, THEME_TEXTURES, withAddedStop, withAngle, withoutStop, withTexture, type ProfileTheme, type ThemeMode, type ThemeTexture } from "@ardia/core/src/theme.ts";
import { customLook, shownTheme, type ProfileLook } from "../../lib/profileLook";
import { editedLook, keptReadable, TEXTURE_NAMES, THEME_MODES } from "../../lib/themeEditor";
import { dropThemeDraft, editCustomTheme, editedChoice, startingCustomTheme, stopMatchingToEdit } from "../../state/settings/customTheme";
import { popSettings } from "../../state/settings/nav";
import { useCustomTheme } from "../../state/settings/themeDraft";
import { capsule, CustomLookBackdrop, font, press, settingsLayout, slotAround, space, Symbol, themeEditorLayout as L, useProfileLook, useTheme } from "../ui";
import { ButtonRow, Group, PickerRow, SettingsHostedContext, SettingsPage } from "./SettingsKit";
import { themeStepperLayout } from "./settingsTokens";
import { ColorPad, DirectionDial, LightnessBar, ThemeSlider, type BlockedScroll } from "./ThemeControls";
import { usePreferences } from "../../state/settings/hooks";
import { SettingsPageOpenedContext } from "./settingsOpened";
import type { ColorChoice } from "../../state/settings/preferences";
import { useSyncEnabled } from "../../state/sync/hooks";

const FOLLOWING_MAC = "Following your Mac's theme.";
const STOP_MATCHING = "Stop matching to edit";

function useLiveTheme(stored: ProfileTheme, target: ColorChoice | null) {
  const opened = useContext(SettingsPageOpenedContext) && target !== null;
  const [local, setLocal] = useState<ProfileTheme | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<ProfileTheme | null>(null);
  const showing = useRef(opened);
  const targetNow = useRef(target);
  targetNow.current = target;
  const endDraft = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
    dropThemeDraft();
  }, []);
  useEffect(
    () => () => {
      showing.current = false;
      endDraft();
    },
    [endDraft],
  );
  useEffect(() => {
    showing.current = opened;
    if (opened) return;
    endDraft();
    setLocal(null);
  }, [opened, endDraft]);
  const change = useCallback((next: ProfileTheme, settle: boolean) => {
    if (!showing.current) return;
    if (settle) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = null;
      setLocal(null);
      if (targetNow.current) editCustomTheme(next, true, targetNow.current);
      return;
    }
    setLocal(next);
    pending.current = next;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current && showing.current) editCustomTheme(pending.current, false);
    });
  }, []);
  const cancel = useCallback(() => {
    endDraft();
    setLocal(null);
  }, [endDraft]);
  return { theme: local ?? stored, change, cancel };
}

const MATCHING_MAC = "matchMac";

export function ThemePage() {
  const look = useProfileLook();
  const stored = useCustomTheme();
  const colorChoice = usePreferences((p) => p.colorChoice);
  const syncEnabled = useSyncEnabled();
  const matchingMac = syncEnabled && colorChoice === null;
  const target = matchingMac ? null : editedChoice(colorChoice, look);
  const saved = stored !== null;
  const fallback = useMemo(() => (saved ? null : startingCustomTheme(look)), [target, saved, look]);
  return <ThemeEditor key={target ?? MATCHING_MAC} stored={stored ?? fallback!} target={target} look={look} onStopMatching={() => stopMatchingToEdit(look)} />;
}

function ThemeEditor({ stored, target, look, onStopMatching }: { stored: ProfileTheme; target: ColorChoice | null; look: ProfileLook; onStopMatching: () => void }) {
  const ui = useTheme();
  const dark = ui.dark;
  const locked = target === null;
  const { theme: editing, editsDark } = locked && look.custom ? { theme: shownTheme(look.custom, dark), editsDark: null } : editedLook(stored, dark);
  const { theme, change, cancel } = useLiveTheme(editing, target);
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, theme.stops.length - 1);
  const scroll = useRef(null);
  const blocks = scroll as unknown as BlockedScroll;
  const hosted = useContext(SettingsHostedContext);
  const preview = useMemo(() => (locked ? look : customLook(theme, "own")), [locked, look, theme]);
  const set = (patch: Partial<ProfileTheme>) => change({ ...theme, ...patch }, true);
  const live = (field: "intensity" | "translucency" | "grain") => (value: number, settle: boolean) => change({ ...theme, [field]: value }, settle);
  const kept = keptReadable(theme, dark);
  const body = (
    <LegacyScrollView ref={scroll} bounces alwaysBounceVertical={false} overScrollMode="auto" style={styles.fill} contentContainerStyle={styles.content}>
      <Group footer={locked ? FOLLOWING_MAC : null}>
        <CustomLookBackdrop testID="themePreview" look={preview} dark={dark} style={styles.preview} />
      </Group>
      {locked ? (
        <Group>
          <ButtonRow title={STOP_MATCHING} onPress={onStopMatching} />
        </Group>
      ) : null}
      <View collapsable={false} pointerEvents={locked ? "none" : "auto"} accessibilityElementsHidden={locked} importantForAccessibility={locked ? "no-hide-descendants" : "auto"} style={locked ? styles.locked : null}>
        <Group header="Colors" footer={editsDark === null ? null : `Separate light and dark looks. Editing keeps the ${editsDark ? "dark" : "light"} one.`}>
          <View style={styles.colors}>
            <ColorPad theme={theme} selected={index} onSelect={setSelected} onChange={change} onCancel={cancel} blocks={blocks} />
            <LightnessBar theme={theme} index={index} onChange={change} onCancel={cancel} blocks={blocks} />
            <View style={styles.count}>
              <Text style={[font.body, styles.fill, { color: ui.secondaryLabel }]}>
                {theme.stops.length} of {MAX_THEME_STOPS} colors
              </Text>
              <Stepper
                icon="minus"
                label="Remove Color"
                enabled={!locked && theme.stops.length > 1}
                onPress={() => {
                  change(withoutStop(theme, index), true);
                  setSelected(Math.max(0, index - 1));
                }}
              />
              <Stepper
                icon="plus"
                label="Add Color"
                enabled={!locked && theme.stops.length < MAX_THEME_STOPS}
                onPress={() => {
                  change(withAddedStop(theme), true);
                  setSelected(theme.stops.length);
                }}
              />
            </View>
          </View>
        </Group>
        <Group>
          <ThemeSlider title="Intensity" value={theme.intensity} onChange={live("intensity")} onCancel={cancel} blocks={blocks} />
          <ThemeSlider title="Pass-Through Blur" value={theme.translucency} onChange={live("translucency")} onCancel={cancel} blocks={blocks} />
          <ThemeSlider title="Noise" value={theme.grain} onChange={live("grain")} onCancel={cancel} blocks={blocks} />
          <PickerRow<ThemeTexture> title="Texture" options={THEME_TEXTURES.map((id) => ({ id, title: TEXTURE_NAMES[id] }))} selected={theme.texture} divider onSelect={(texture) => change(withTexture(theme, texture), true)} />
          <Row title="Direction">
            <Text style={[font.body, styles.degrees, { color: ui.secondaryLabel }]}>{Math.round(lookAngle(theme))}°</Text>
            <DirectionDial angle={lookAngle(theme)} onChange={(angle, settle) => change(withAngle(theme, angle), settle)} onCancel={cancel} blocks={blocks} />
          </Row>
        </Group>
        <Group footer={kept ? `Kept ${dark ? "dark" : "light"} so text stays readable.` : null}>
          <PickerRow<ThemeMode> title="Appearance" options={[...THEME_MODES]} selected={theme.mode} onSelect={(mode) => set({ mode })} />
        </Group>
      </View>
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
      testID="themeStepper"
      style={styles.stepperSlot}
    >
      {({ pressed }) => (
        <View style={[styles.stepper, { backgroundColor: pressed ? ui.rowHighlight : ui.separator }]}>
          <Symbol name={icon} size={themeStepperLayout.glyph} color={enabled ? ui.formAccent : ui.tertiaryLabel} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  locked: { opacity: press.disabledOpacity },
  fill: { flex: 1 },
  content: { paddingTop: space.m, paddingBottom: space.huge, gap: space.xxl },
  preview: { height: L.preview },
  colors: { paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.l, gap: space.l },
  count: { flexDirection: "row", alignItems: "center", gap: space.s },
  stepperSlot: slotAround(L.stepper),
  stepper: { width: L.stepper, height: L.stepper, borderRadius: capsule(L.stepper), alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  degrees: { fontVariant: ["tabular-nums"] },
});
