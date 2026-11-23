import { holdThemedWindowsKeyLook, choosePresetColor, onPresetSelection, resetPresetTheme, setProfileTheme, showingPreset, showingTheme } from "../../state/profiles/themeActions";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { flatColors, lookAngle, MAX_THEME_STOPS, requestedDarkFor, resolveTheme, shownLook, themeAccent, withAddedStop, withAngle, withoutStop, spaceLookSource, stopLightness, type PresetLookFields, type ShownLook } from "../../lib/profileLook";
import { isUntouched, presetStartingTheme, presetThemeOf } from "../../lib/presetLook";
import { THEME_TEXTURES } from "@ardia/core";
import { PROFILE_COLORS } from "../ui/theme";
import { useAppDark, useProfile, useSettings, useWindow } from "../../state/browser/hooks";
import type { ProfileColor, ProfileTheme, ThemeMode, ThemeTexture } from "../../state/browser/types";
import { Box, Button, curve, duration, Group, PopUp, radioA11y, Segmented, space, spaceActivates, Swatch, swatch, Text, ThemeSwatch, useClosing, useLiveAction, tapActivates } from "../ui";
import { importArcTheme } from "../../state/profiles/arcThemes";
import { noteThemePreset } from "../../state/telemetry/themePresetCounts";
import { themeGesture, type ThemeEdit } from "../../lib/themeGesture";
import { Row, SectionHeader } from "./Form";
import type { SettingId } from "./settingsIndex";
import { ColorPad, DirectionDial, LABEL, Labelled, LightnessBar, Preview, Slider } from "./ThemeControls";

export { arcThemeChoices, importArcTheme } from "../../state/profiles/arcThemes";

const MODES: { value: ThemeMode; symbol: string; title: string }[] = [
  { value: "light", symbol: "sun.max", title: "Light" },
  { value: "dark", symbol: "moon", title: "Dark" },
  { value: "auto", symbol: "circle.lefthalf.filled", title: "Match System" },
];

const TEXTURE_NAMES: Record<ThemeTexture, string> = { grain: "Grain", sand: "Sand", denim: "Denim", tweed: "Tweed" };

function useLiveTheme(profileId: string, theme: ProfileTheme | null | undefined, target: string, showing: () => string, apply: (theme: ProfileTheme | null) => void) {
  const [draft, setDraft] = useState<ThemeEdit | null>(null);
  const applyLatest = useRef(apply);
  applyLatest.current = apply;
  const showingLatest = useRef(showing);
  showingLatest.current = showing;
  const profileLatest = useRef(profileId);
  profileLatest.current = profileId;
  const gesture = useRef<ReturnType<typeof themeGesture> | null>(null);
  gesture.current ??= themeGesture({
    apply: (next) => applyLatest.current(next),
    showing: () => showingLatest.current(),
    current: () => showingTheme(profileLatest.current),
    draft: setDraft,
    requestFrame: requestAnimationFrame,
    cancelFrame: cancelAnimationFrame,
  });
  useEffect(() => () => gesture.current?.dispose(), []);
  useEffect(() => onPresetSelection(profileId, () => gesture.current?.selectionChanged()), [profileId]);
  const change = (next: ProfileTheme | null, settle = false) => gesture.current!.change(next, target, settle);
  return { theme: draft && draft.target === target ? draft.theme : (theme ?? null), change, cancel: () => gesture.current!.cancel(), begin: () => gesture.current!.begin(target) };
}

export function useThemeDraft(profileId: string, apply: (theme: ProfileTheme | null) => void) {
  const profile = useProfile(profileId, (p) => p);
  const color = profile?.color ?? "plum";
  const live = useLiveTheme(profileId, profile?.theme, `${profileId}:${color}`, () => `${profileId}:${showingPreset(profileId)}`, apply);
  const appDark = useAppDark();
  const source = useSettings((s) => spaceLookSource(s));
  const original = useMemo(() => presetStartingTheme((PROFILE_COLORS[color] ?? PROFILE_COLORS.plum).swatch), [color]);
  const stored = live.theme;
  const look = stored ?? original;
  const editsDark = !!stored && requestedDarkFor(stored, appDark, source);
  const editing = stored?.dark ? resolveTheme(stored, editsDark) : look;
  const shown = shownLook(look, appDark, source);
  const change = (next: ProfileTheme | null, settle = false) => {
    const kept = next && isUntouched(next, original) ? null : next;
    if (kept && !stored) noteThemePreset("edited");
    live.change(kept, settle);
  };
  return { profile, stored, editing, editsDark, shown, followsApp: source === "app", change, cancel: live.cancel, begin: live.begin, original };
}

export function ThemeSection({ profileId, anchor }: { profileId: string; anchor: SettingId }) {
  const { profile, stored, editing: theme, editsDark, shown, followsApp, change, cancel, begin, original } = useThemeDraft(profileId, (next) => setProfileTheme(profileId, next));
  const editing = !!profile && !!stored;
  useEffect(() => {
    if (!editing) return;
    holdThemedWindowsKeyLook(true);
    return () => holdThemedWindowsKeyLook(false);
  }, [editing]);
  if (!profile) return null;
  return (
    <>
      <SectionHeader
        title="Theme"
        description="Tints this profile's windows, New Tab page and highlights."
        action={<Button title="Import from Arc…" onPress={() => void importArcTheme(profileId)} />}
      />
      <Group>
        <Row
          anchor={anchor}
          description={
            stored?.dark
              ? `Separate light and dark looks. Editing keeps the ${editsDark ? "dark" : "light"} one.`
              : presetLabel(profile.color, !!stored)
          }
        >
          <ThemeSwatches color={profile.color} edits={profile} onPreset={(c) => choosePresetColor(profileId, c)} />
        </Row>
        <Box pad="l">
          <ThemeEditor theme={theme} start={original} full={{ shown, followsApp }} onChange={change} onBegin={begin} onReset={stored ? () => { cancel(); resetPresetTheme(profileId); } : undefined} resetLabel={presetLabel(profile.color, false)} />
        </Box>
      </Group>
    </>
  );
}

export function ThemePicker({
  windowId,
  size,
  gap,
  onPreset,
  onTheme,
}: {
  windowId: string;
  size?: number;
  gap?: number;
  onPreset?: (color: ProfileColor) => void;
  onTheme?: (theme: ProfileTheme | null) => void;
}) {
  const profileId = useWindow(windowId, (w) => w?.profileId) ?? "";
  const incognito = useWindow(windowId, (w) => w?.kind === "private");
  const look = useThemeDraft(profileId, (theme) => (onTheme ? onTheme(theme) : setProfileTheme(profileId, theme)));
  if (!profileId || incognito || !look.profile) return null;
  const reset = () => {
    look.cancel();
    if (onTheme) onTheme(null);
    else resetPresetTheme(profileId);
  };
  return (
    <View style={{ gap: space.xxxl }}>
      <ThemeSwatches size={size} gap={gap} color={look.profile.color} edits={look.profile} onPreset={(c) => (onPreset ? onPreset(c) : choosePresetColor(profileId, c))} />
      <FadeIn>
        <ThemeEditor theme={look.editing} start={look.original} onChange={look.change} onBegin={look.begin} onReset={look.stored ? reset : undefined} resetLabel={presetLabel(look.profile.color, false)} />
      </FadeIn>
    </View>
  );
}

function presetLabel(color: ProfileColor, edited: boolean): string {
  const name = (PROFILE_COLORS[color] ?? PROFILE_COLORS.plum).name;
  return edited ? `${name}, edited` : name;
}

const COLORS = Object.keys(PROFILE_COLORS) as ProfileColor[];

export function ThemeSwatches({
  color,
  onPreset,
  edits,
  size = swatch.size,
  gap = swatch.gap,
}: {
  color: ProfileColor | null;
  onPreset: (color: ProfileColor) => void;
  edits?: PresetLookFields;
  size?: number;
  gap?: number;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap }} accessibilityRole="radiogroup" accessibilityLabel="Theme color">
      {COLORS.map((c) => {
        const edited = edits ? presetThemeOf(edits, c) : null;
        const name = presetLabel(c, !!edited);
        return edited ? (
          <ColorButton key={c} name={name} ring={themeAccent(edited)} size={size} selected={color === c} onPress={() => onPreset(c)}>
            <EditedSwatch theme={edited} />
          </ColorButton>
        ) : (
          <ColorButton key={c} name={name} ring={PROFILE_COLORS[c].swatch} size={size} selected={color === c} onPress={() => onPreset(c)} />
        );
      })}
    </View>
  );
}

function ColorButton({ name, ring, size, selected, onPress, children }: { name: string; ring: string; size: number; selected: boolean; onPress: () => void; children?: ReactNode }) {
  const closing = useClosing();
  const live = useLiveAction();
  return (
    <View tooltip={name}>
      <Pressable disabled={closing} onPress={live(onPress)} onAccessibilityTap={tapActivates(live(onPress))} onKeyDown={live(spaceActivates(onPress))} {...radioA11y(selected, name)}>
        {({ pressed }) => (
          <View style={{ transform: [{ scale: pressed ? PRESSED_SCALE : 1 }] }}>
            <Swatch animated size={size} selected={selected} ring={ring} fill={children ? undefined : ring}>
              {children}
            </Swatch>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function FadeIn({ children }: { children: ReactNode }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: duration.base, easing: curve.enter, useNativeDriver: true }).start();
  }, []);
  return <Animated.View style={{ opacity: t, transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [FADE_RISE, 0] }) }] }}>{children}</Animated.View>;
}

function EditedSwatch({ theme }: { theme: ProfileTheme }) {
  return <ThemeSwatch colors={flatColors(theme)} angle={lookAngle(theme)} style={FILL} />;
}

type Reset = { onReset?: () => void; resetLabel?: string; onBegin?: () => void; start?: ProfileTheme };

function ThemeStops({ theme, onChange, onReset, resetLabel, onBegin, start }: { theme: ProfileTheme; onChange: (next: ProfileTheme, settle?: boolean) => void } & Reset) {
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, theme.stops.length - 1);
  return (
    <Box gap="m">
      <ColorPad theme={theme} selected={index} onSelect={setSelected} onChange={onChange} onBegin={onBegin} start={start?.stops.length === theme.stops.length ? start.stops : undefined} />
      <LightnessBar theme={theme} index={index} onChange={onChange} snapTo={start?.stops.length === theme.stops.length && start.stops[index] ? stopLightness(start.stops[index]) : undefined} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text size="caption" tone="textSecondary">
          {theme.stops.length} of {MAX_THEME_STOPS} colors
        </Text>
        <Box row gap="xs" style={CENTERED}>
          {onReset ? <Button variant="text" look="link" size="caption" title="Reset" label={resetLabel ? `Reset to ${resetLabel}` : "Reset"} onPress={onReset} /> : null}
          <Button
            variant="stepper"
            icon="minus"
            tooltip="Remove Color"
            disabled={theme.stops.length <= 1}
            onPress={() => {
              onChange(withoutStop(theme, index), true);
              setSelected(Math.max(0, index - 1));
            }}
          />
          <Button
            variant="stepper"
            icon="plus"
            tooltip="Add Color"
            disabled={theme.stops.length >= MAX_THEME_STOPS}
            onPress={() => {
              onChange(withAddedStop(theme), true);
              setSelected(theme.stops.length);
            }}
          />
        </Box>
      </View>
    </Box>
  );
}

export function ThemeEditor({
  theme,
  full,
  onChange,
  onReset,
  resetLabel,
  onBegin,
  start,
}: {
  theme: ProfileTheme;
  full?: { shown: ShownLook; followsApp: boolean };
  onChange: (next: ProfileTheme, settle?: boolean) => void;
} & Reset) {
  const stacked = !full;
  return (
    <Box row gap="xl">
      <ThemeStops theme={theme} onChange={onChange} onReset={onReset} resetLabel={resetLabel} onBegin={onBegin} start={start} />
      <Box gap={full ? "l" : "xl"} style={FILL}>
        {full ? <Preview shown={full.shown} /> : null}
        <Slider stacked={stacked} label="Intensity" value={theme.intensity} snapTo={start?.intensity} onChange={(v, settle) => onChange({ ...theme, intensity: v }, settle)} />
        <Slider stacked={stacked} label="Pass-through blur" value={theme.translucency} snapTo={start?.translucency} onChange={(v, settle) => onChange({ ...theme, translucency: v }, settle)} />
        <Slider stacked={stacked} label="Noise" value={theme.grain} snapTo={start?.grain} onChange={(v, settle) => onChange({ ...theme, grain: v }, settle)}>
          <PopUp
            value={theme.texture}
            minWidth={78}
            options={THEME_TEXTURES.map((t) => ({ value: t, title: TEXTURE_NAMES[t] }))}
            onChange={(texture) => onChange({ ...theme, texture, grain: theme.grain || 0.5 }, true)}
          />
        </Slider>
        <EditorRow stacked={stacked} label="Direction">
          <DirectionDial angle={lookAngle(theme)} onChange={(angle, settle) => onChange(withAngle(theme, angle), settle)} />
        </EditorRow>
        {full ? (
          <EditorRow label="Appearance">
            {full.followsApp ? (
              <Text size="caption" tone="textSecondary" lines={2} style={FILL}>
                Follows Settings › Appearance
              </Text>
            ) : (
              <Segmented options={MODE_OPTIONS} value={theme.mode} onChange={(mode) => onChange({ ...theme, mode }, true)} />
            )}
            {full.shown.dark !== full.shown.requestedDark ? (
              <Text size="caption" tone="textSecondary" lines={2} style={KEPT_NOTE}>
                Kept {full.shown.dark ? "dark" : "light"} so text stays readable
              </Text>
            ) : null}
          </EditorRow>
        ) : null}
      </Box>
    </Box>
  );
}

function EditorRow({ label, stacked, children }: { label: string; stacked?: boolean; children: ReactNode }) {
  if (stacked) return <Labelled label={label}>{children}</Labelled>;
  return (
    <View style={LABELLED_ROW}>
      <Text size="small" style={EDITOR_LABEL}>
        {label}
      </Text>
      {children}
    </View>
  );
}

const FILL = { flex: 1 } as const;
const CENTERED = { alignItems: "center" } as const;
const LABELLED_ROW = { flexDirection: "row", alignItems: "center" } as const;
const EDITOR_LABEL = { width: LABEL + space.ml } as const;
const KEPT_NOTE = { flex: 1, marginLeft: space.m } as const;
const PRESSED_SCALE = 0.94;
const FADE_RISE = 4;
const MODE_OPTIONS = MODES.map((m) => ({ value: m.value, title: m.title, image: m.symbol }));
