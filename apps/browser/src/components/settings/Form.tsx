import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { showUnlockingSetting, useSettingsSearch } from "../../state/settings/searchState";
import { useSync } from "../../state/sync/engine";
import { useAirTrafficConfig } from "../../state/airTraffic/hooks";
import { useResource } from "../../state/settings/resources";
import { appIconChoices, updater } from "../../state/settings/paneData";
import { appIconCapability, updateChannelCapability, updatesCapability } from "../../state/settings/capabilities";
import { useCalendar } from "../../state/live/calendar";
import { registerAnchor, sectionAnchorId, settingTestId } from "./anchors";
import { useProfiles, useSettings, useTabLayout } from "../../state/browser/hooks";
import { currentSettings } from "../../state/browser/current";
import type { SettingsPane } from "../../state/settings/settingsWindows";
import { curve } from "../ui/motion";
import { Group as PlainGroup, Row as PlainRow } from "../ui/Row";
import { useTheme } from "../ui/theme";
import { lineHeight, proseLineHeight, radius as radii, space, perLook } from "../ui/tokens";
import { findSetting, hiddenFromSearch, loadingSettings, needsOf, unlockOf, sectionEntries, setting, unshownSettings, unsupportedSettings, type SettingEntry, type SettingId } from "./settingsIndex";
import type { SettingsEnv } from "./rows/types";
import { Toggle } from "../ui/Switch";
import { liquidGlass } from "../ui/Glass";
import { PopUp } from "../ui/Field";
import { Text } from "../ui/Text";
import { Symbol } from "../ui/Symbol";
import { Button } from "../ui/Button";
import { SelectionMark } from "../ui/SelectionMark";
import { updateSettings } from "../../state/settings/actions";
import type { Settings } from "../../state/settings/settings";
import { officialPlugins } from "../../state/plugins/official";
import { officialNamesInSettings } from "../../state/plugins/officialView";
import { usePlugins } from "../../state/plugins/store";
import { settingsMotion } from "./tokens";
import { useSettingsColors } from "./useSettingsColors";

export const SettingsPaneContext = createContext<SettingsPane | null>(null);

export function useSettingsEnv(): SettingsEnv {
  const top = useTabLayout() === "top";
  const { fallback } = useAirTrafficConfig();
  const fallbackOpensTab = !!fallback?.profileId && fallback.open === "tab";
  const [updaterState] = useResource(updater);
  const [iconChoices] = useResource(appIconChoices);
  const updates = updatesCapability(updaterState);
  const updateChannel = updateChannelCapability(updaterState);
  const appIcon = appIconCapability(iconChoices);
  const capabilities = useMemo(() => ({ updates, updateChannel, appIcon }), [updates, updateChannel, appIcon]);
  const syncOn = useSync((s) => s.enabled);
  const syncAvailable = useSync((s) => s.status !== "unavailable");
  const calendarAccess = useCalendar((s) => s.access === "fullAccess" || s.access === "fixture");
  const official = usePlugins((s) => officialNamesInSettings(officialPlugins(s)).join(" "));
  return { top, glass: liquidGlass, syncOn, syncAvailable, fallbackOpensTab, capabilities, calendarAccess, officialPlugins: official ? official.split(" ") : [] };
}

const idSet = (ids: string) => new Set(ids ? ids.split("\n") : []);

export function useUnshownSettings(): ReadonlySet<string> {
  const env = useSettingsEnv();
  const ids = useSettings((s) => unshownSettings(s, env));
  return useMemo(() => idSet(ids), [ids]);
}

export function useSearchHiddenSettings(): ReadonlySet<string> {
  const unshown = useUnshownSettings();
  const unsupported = useUnsupportedSettings();
  return useMemo(() => hiddenFromSearch(unshown, unsupported), [unshown, unsupported]);
}

export function useLoadingSettings(): ReadonlySet<string> {
  const ids = loadingSettings(useSettingsEnv());
  return useMemo(() => idSet(ids), [ids]);
}

export function useUnsupportedSettings(): ReadonlySet<string> {
  const ids = unsupportedSettings(useSettingsEnv());
  return useMemo(() => idSet(ids), [ids]);
}

function useHeldTarget(unshown: ReadonlySet<string>): SettingEntry | undefined {
  const held = useSettingsSearch((s) => (s.query.trim() ? s.held : null));
  const unsupported = useUnsupportedSettings();
  const entry = held && unshown.has(held) && !unsupported.has(held) ? findSetting(held) : undefined;
  return entry?.needs && entry.unlock ? entry : undefined;
}

export function useHiddenSetting() {
  const unshown = useUnshownSettings();
  const held = useHeldTarget(unshown);
  return (entry: SettingEntry | undefined) => !!entry && entry !== held && unshown.has(entry.id);
}

function useHiddenSection(pane: SettingsPane | null | undefined, section: string | undefined) {
  const hidden = useHiddenSetting();
  if (!pane || !section) return false;
  const entries = sectionEntries(pane, section);
  return entries.length > 0 && entries.every(hidden);
}

export function Group({ children, of }: { children: ReactNode; of?: SettingId }) {
  const hidden = useHiddenSetting();
  if (of && hidden(findSetting(of))) return null;
  const rows = Children.toArray(children).filter(
    (child) => !(isValidElement<{ anchor?: unknown }>(child) && typeof child.props.anchor === "string" && hidden(findSetting(child.props.anchor))),
  );
  if (!rows.length) return null;
  return <PlainGroup>{rows}</PlainGroup>;
}

export type AnchorShape = "row" | "card";

const ANCHOR_RADIUS: Record<AnchorShape, number> = { get row() { return radii.control; }, get card() { return radii.panel; } };

export function Anchor({ id, children, shape, style, keep }: { id?: SettingId; children: ReactNode; shape?: AnchorShape; style?: StyleProp<ViewStyle>; keep?: boolean }) {
  const hidden = useHiddenSetting();
  if (!keep && id && hidden(findSetting(id))) return null;
  return (
    <ShownAnchor id={id} radius={shape ? ANCHOR_RADIUS[shape] : 0} style={style}>
      {children}
    </ShownAnchor>
  );
}


function ShownAnchor({ id, children, radius, style }: { id?: SettingId; children: ReactNode; radius: number; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const colors = useSettingsColors();
  const ref = useRef<View>(null);
  const flash = useSettingsSearch((s) => (id && s.flash?.id === id ? s.flash.at : 0));
  const lit = useSettingsSearch((s) => !!id && s.previewing && s.spotlight === id);
  const glow = useRef(new Animated.Value(0)).current;
  const lastFlash = useRef(0);
  const raised = useRef(false);
  useEffect(() => (id && ref.current ? registerAnchor(id, ref.current) : undefined), [id]);
  useEffect(() => {
    const fresh = !!flash && flash !== lastFlash.current;
    lastFlash.current = flash;
    const glowIn = Animated.timing(glow, { toValue: 1, duration: settingsMotion.searchFlashIn, easing: curve.enter, useNativeDriver: true });
    const glowOut = Animated.timing(glow, { toValue: 0, duration: settingsMotion.searchFlashOut, easing: curve.move, useNativeDriver: true });
    if (!lit && !fresh && !raised.current) return;
    raised.current = lit || fresh;
    const run = lit ? glowIn : fresh ? Animated.sequence([glowIn, Animated.delay(settingsMotion.searchFlashHold), glowOut]) : glowOut;
    run.start();
    return () => run.stop();
  }, [flash, lit]);
  if (!id) return <View style={style}>{children}</View>;
  return (
    <View ref={ref} collapsable={false} style={style} testID={settingTestId(id)}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: theme.searchFlash, opacity: glow }]} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: glow }]}>
        <SelectionMark fill={theme.searchFlash} backdrop={colors.windowFill} />
      </Animated.View>
      {children}
    </View>
  );
}

export function SectionHeader({ title, description, action, anchor }: { title?: string; description?: string | null; action?: ReactNode; anchor?: SettingId }) {
  const pane = useContext(SettingsPaneContext);
  const entry = anchor ? setting(anchor) : undefined;
  const colors = useSettingsColors();
  const box = useRef<View>(null);
  const text = title ?? entry?.section ?? "";
  const detail = description === undefined ? entry?.description : description;
  const headerPane = entry?.pane ?? pane;
  const hidden = useHiddenSection(headerPane, entry?.section ?? title);
  useEffect(() => (headerPane && text && box.current ? registerAnchor(sectionAnchorId(headerPane, text), box.current) : undefined), [headerPane, text, hidden]);
  if (hidden) return null;
  return (
    <View ref={box} collapsable={false}>
    <Anchor id={anchor} keep shape="row" style={SECTION_HEADER}>
      <View style={{ flex: 1 }}>
        <Text weight="semibold">{text}</Text>
        {detail ? (
          <Text size="small" color={colors.secondaryText} style={SECTION_DETAIL()}>
            {detail}
          </Text>
        ) : null}
      </View>
      {action}
    </Anchor>
    </View>
  );
}

export function Row({
  title,
  description,
  children,
  icon,
  onPress,
  anchor,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  onPress?: () => void;
  anchor?: SettingId;
}) {
  const entry = anchor ? setting(anchor) : undefined;
  const colors = useSettingsColors();
  const held = useHeldTarget(useUnshownSettings());
  if (entry && entry === held) return <LockedRow entry={entry} />;
  const detail = description === undefined ? (entry?.explained ? entry.description : undefined) : description;
  const row = (
    <PlainRow
      title={title ?? entry?.title}
      description={typeof detail === "string" ? <Text size="caption" color={colors.secondaryText} style={ROW_DETAIL()}>{detail}</Text> : detail}
      icon={icon}
      onPress={onPress}
    >
      {children}
    </PlainRow>
  );
  return anchor ? <Anchor id={anchor}>{row}</Anchor> : row;
}

function LockedRow({ entry }: { entry: SettingEntry }) {
  const theme = useTheme();
  const colors = useSettingsColors();
  const needs = useSettings((s) => needsOf(entry, s));
  const unlockId = useSettings((s) => unlockOf(entry, s));
  const unlock = unlockId ? findSetting(unlockId) : undefined;
  return (
    <Anchor id={entry.id}>
      <PlainRow
        title={<Text color={theme.textSecondary}>{entry.title}</Text>}
        description={<Text size="caption" color={colors.secondaryText} style={ROW_DETAIL()}>{needs}</Text>}
        icon={<Symbol name="lock" size={12} color={colors.secondaryText} style={LOCK_GLYPH} />}
      >
        {unlock ? (
          <Button
            variant="text"
            look="link"
            pad="none"
            color={colors.lockedLink}
            title={unlock.pane === entry.pane ? "Show Setting" : `Show in ${unlock.paneTitle}`}
            onPress={() => showUnlockingSetting(unlock)}
          />
        ) : null}
      </PlainRow>
    </Anchor>
  );
}

const LOCK_GLYPH = { width: 14, height: 14 } as const;

type BooleanSettingKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

export function SettingToggle({ anchor, description }: { anchor: SettingId & `${string}.${BooleanSettingKey}`; description?: ReactNode }) {
  const key = anchor.slice(anchor.indexOf(".") + 1) as BooleanSettingKey;
  const value = useSettings((s) => s[key]);
  return (
    <Row anchor={anchor} description={description}>
      <Toggle value={value} accessibilityLabel={setting(anchor).title} onChange={(on) => updateSettings({ [key]: on })} />
    </Row>
  );
}

export const useSettingsProfile = (initial?: string | null) => useState(() => initial ?? currentSettings().defaultProfileId);

export function ProfilePicker({ value, onChange }: { value: string; onChange: (profileId: string) => void }) {
  const profiles = useProfiles();
  if (profiles.length < 2) return null;
  return <PopUp value={value} options={profiles.map((p) => ({ value: p.id, title: p.name }))} onChange={onChange} />;
}

const SECTION_HEADER = { flexDirection: "row", alignItems: "flex-end", marginTop: space.xxl, marginBottom: space.s, paddingHorizontal: space.s } as const;
const ROW_DETAIL = perLook(() => ({ marginTop: space.xxs, lineHeight: lineHeight.caption }) as const);
const SECTION_DETAIL = perLook(() => ({ marginTop: space.xs, lineHeight: lineHeight.body }) as const);

export function PaneIntro({ children }: { children: ReactNode }) {
  return (
    <Text size="small" tone="textSecondary" style={PANE_INTRO()}>
      {children}
    </Text>
  );
}

const PANE_INTRO = perLook(() => ({ marginTop: space.xxl, lineHeight: proseLineHeight.small }) as const);

export function FormField({ label, inline, children }: { label: string; inline?: boolean; children: ReactNode }) {
  return (
    <View style={inline ? FIELD_INLINE : FIELD}>
      <Text size="caption" tone="textSecondary" style={inline ? undefined : FIELD_LABEL}>
        {label}
      </Text>
      {children}
    </View>
  );
}

const FIELD = { marginTop: space.l } as const;
const FIELD_INLINE = { marginTop: space.l, flexDirection: "row", alignItems: "center", gap: space.ml } as const;
const FIELD_LABEL = { marginBottom: space.xs } as const;
