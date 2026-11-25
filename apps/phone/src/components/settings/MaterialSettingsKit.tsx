import { Children, createContext, useContext, useState, type ReactNode, type RefObject } from "react";
import { ActivityIndicator, StyleSheet, Text, View, type ViewInstance } from "react-native";
import { Pressable } from "react-native-gesture-handler";
import { withAlpha } from "../../lib/color";
import { MaterialIconButton, Symbol, ToggleTrack, type SymbolName } from "../ui";
import { MATERIAL_STATE } from "../ui/materialRoles";
import { MaterialDialog, useMaterialRipple } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { MATERIAL_SEGMENT_GAP, materialSegmentCorners, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { dismissWords } from "../../lib/sharedWords";

const AVATAR = 40;
const RADIO = 20;
const MEDIUM_TITLE_HEIGHT = 48;

export const materialMediumTitleHeight = (fontScale: number) => Math.max(MEDIUM_TITLE_HEIGHT, Math.ceil(materialType.headlineMedium.lineHeight * fontScale) + 12);

export const materialAppBarFill = (scheme: { surfaceContainer: string; surfaceContainerHigh: string }, scrolled: boolean) => (scrolled ? scheme.surfaceContainerHigh : scheme.surfaceContainer);

type AppBarProps = {
  title: string;
  onBack?: () => void;
  onClose?: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  mediumAppBar: boolean;
  collapsed: boolean;
  scrolled: boolean;
  topInset: number;
  leftInset: number;
  rightInset: number;
};

export function MaterialSettingsAppBar({ title, onBack, onClose, leading, trailing, mediumAppBar, collapsed, scrolled, topInset, leftInset, rightInset }: AppBarProps) {
  const { scheme } = useMaterialTheme();
  return (
    <View testID="materialTopAppBar" style={[styles.appBar, { paddingTop: topInset, paddingLeft: leftInset + 4, paddingRight: rightInset + 4, backgroundColor: materialAppBarFill(scheme, scrolled) }]}>
      <View style={styles.appBarRow}>
        {onBack ? (
          <MaterialIconButton testID="materialSettingsBack" icon="arrowRight" flipped label="Back" ink={scheme.onSurface} onPress={onBack} />
        ) : onClose ? (
          <MaterialIconButton testID="materialSettingsClose" icon="xmark" label={dismissWords.close} ink={scheme.onSurface} onPress={onClose} />
        ) : null}
        {leading}
        <Text testID="settingsTitle" accessibilityRole="header" numberOfLines={1} style={[materialType.titleLarge, styles.title, { color: scheme.onSurface, paddingLeft: onBack || onClose || leading ? 0 : 12 }]} accessibilityElementsHidden={mediumAppBar && !collapsed} importantForAccessibility={mediumAppBar && !collapsed ? "no" : "auto"}>
          {!mediumAppBar || collapsed ? title : null}
        </Text>
        {trailing}
      </View>
    </View>
  );
}

export function MaterialMediumTitle({ title, height, collapsed }: { title: string; height: number; collapsed: boolean }) {
  const { scheme } = useMaterialTheme();
  return (
    <Text testID="materialMediumTitle" accessibilityRole="header" numberOfLines={1} importantForAccessibility={collapsed ? "no" : "auto"} style={[materialType.headlineMedium, styles.mediumTitle, { height, color: scheme.onSurface }]}>
      {title}
    </Text>
  );
}

export const materialSettingsListStyles = {
  list: { flex: 1 },
  content: { paddingTop: 8, paddingBottom: 32 },
  mediumContent: { paddingTop: 0 },
} as const;

export function MaterialBarButton({ title, onPress, emphasized, enabled = true }: { title: string; onPress: () => void; emphasized?: boolean; enabled?: boolean }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const ink = enabled ? scheme.primary : withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !enabled }} disabled={!enabled} android_ripple={ripple} onPress={onPress} style={styles.textButton}>
      <Text style={[materialType.labelLarge, emphasized ? styles.emphasized : null, { color: ink }]}>{title}</Text>
    </Pressable>
  );
}

const MaterialGroupSurface = createContext<"page" | "sheet">("page");

export function MaterialSettingsSheetSurface({ children }: { children: ReactNode }) {
  return <MaterialGroupSurface.Provider value="sheet">{children}</MaterialGroupSurface.Provider>;
}

export function MaterialGroup({ header, footer, children }: { header?: string; footer?: string | null; children: ReactNode }) {
  const { scheme } = useMaterialTheme();
  const surface = useContext(MaterialGroupSurface);
  const fill = surface === "sheet" ? scheme.surfaceContainerHighest : scheme.surfaceBright;
  const rows = Children.toArray(children);
  return (
    <View testID="materialSettingsGroup" style={styles.group}>
      {header ? (
        <Text accessibilityRole="header" style={[materialType.titleSmall, styles.header, { color: scheme.primary }]}>
          {header}
        </Text>
      ) : null}
      <View style={styles.segments}>
        {rows.map((row, index) => (
          <View key={index} testID="materialSettingsSegment" style={[styles.segment, materialSegmentCorners(index, rows.length), { backgroundColor: fill }]}>
            {row}
          </View>
        ))}
      </View>
      {footer ? <Text style={[materialType.bodyMedium, styles.footer, { color: scheme.onSurfaceVariant }]}>{footer}</Text> : null}
    </View>
  );
}

export function MaterialIconTile({ icon, side = AVATAR }: { icon: SymbolName; tint?: string; side?: number }) {
  const { scheme } = useMaterialTheme();
  return (
    <View style={[styles.avatar, { width: side, height: side, borderRadius: side / 2, backgroundColor: scheme.secondaryContainer }]}>
      <Symbol name={icon} size={side * 0.6} color={scheme.onSecondaryContainer} />
    </View>
  );
}

function ItemText({ title, supporting, color }: { title: string; supporting?: string | null; color?: string }) {
  const { scheme } = useMaterialTheme();
  return (
    <View style={styles.fill}>
      <Text style={[materialType.bodyLarge, { color: color ?? scheme.onSurface }]}>{title}</Text>
      {supporting ? (
        <Text numberOfLines={2} style={[materialType.bodyMedium, { color: scheme.onSurfaceVariant }]}>
          {supporting}
        </Text>
      ) : null}
    </View>
  );
}

export function MaterialSettingsLeading({ icon }: { icon?: SymbolName }) {
  const { scheme } = useMaterialTheme();
  if (!icon) return null;
  return (
    <View testID="materialSettingsIconSlot" style={styles.leading}>
      <Symbol name={icon} size={materialSize.icon} color={scheme.onSurfaceVariant} />
    </View>
  );
}

export function MaterialCheckRow({ title, checked, onPress, disabled = false }: { title: string; checked: boolean; onPress: () => void; disabled?: boolean; divider?: boolean }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const ink = disabled ? withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent) : scheme.onSurface;
  const ring = disabled ? ink : checked ? scheme.primary : scheme.onSurfaceVariant;
  return (
    <Pressable
      testID={`materialSettingsRow:${title}`}
      accessibilityRole="radio"
      accessibilityLabel={title}
      accessibilityState={{ selected: checked, checked, ...(disabled ? { disabled } : {}) }}
      disabled={disabled}
      android_ripple={ripple}
      onPress={onPress}
      style={styles.row}
    >
      <ItemText title={title} color={ink} />
      <View style={[styles.radio, { borderColor: ring }]}>{checked ? <View style={[styles.radioDot, { backgroundColor: ring }]} /> : null}</View>
    </Pressable>
  );
}

type RowBase = { title: string; icon?: SymbolName; tint?: string; divider?: boolean };

const rowStyle = (supporting: unknown) => [styles.row, supporting ? styles.rowTwoLine : null];

export function MaterialNavRow({ title, icon, value, detail, onPress }: RowBase & { value?: string; detail?: string; onPress: () => void }) {
  const ripple = useMaterialRipple();
  const supporting = value ?? detail;
  return (
    <Pressable testID={`materialSettingsRow:${title}`} accessibilityRole="button" accessibilityLabel={detail ? `${title}, ${detail}` : title} accessibilityValue={value ? { text: value } : undefined} android_ripple={ripple} onPress={onPress} style={rowStyle(supporting)}>
      <MaterialSettingsLeading icon={icon} />
      <ItemText title={title} supporting={supporting} />
    </Pressable>
  );
}

export function MaterialToggleRow({ title, icon, value, onChange, detail, buttonRef }: RowBase & { value: boolean; onChange: (value: boolean) => void; detail?: string; buttonRef?: RefObject<ViewInstance | null> }) {
  const ripple = useMaterialRipple();
  return (
    <Pressable ref={buttonRef} testID={`materialSettingsRow:${title}`} accessibilityRole="switch" accessibilityLabel={title} accessibilityHint={detail} accessibilityState={{ checked: value }} android_ripple={ripple} onPress={() => onChange(!value)} style={rowStyle(detail)}>
      <View style={styles.rowInner} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <MaterialSettingsLeading icon={icon} />
        <ItemText title={title} supporting={detail} />
      </View>
      <ToggleTrack value={value} />
    </Pressable>
  );
}

export function MaterialButtonRow({ title, onPress, destructive, enabled = true, busy }: { title: string; onPress: () => void; destructive?: boolean; enabled?: boolean; busy?: boolean; divider?: boolean }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const color = !enabled ? withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent) : destructive ? scheme.error : scheme.primary;
  return (
    <Pressable testID={`materialSettingsRow:${title}`} accessibilityRole="button" accessibilityState={{ disabled: !enabled }} disabled={!enabled} android_ripple={ripple} onPress={onPress} style={styles.row}>
      <ItemText title={title} color={color} />
      {busy ? <ActivityIndicator color={scheme.primary} /> : null}
    </Pressable>
  );
}

export function MaterialValueRow({ title, value }: { title: string; value: string; divider?: boolean }) {
  return (
    <View testID={`materialSettingsRow:${title}`} accessible accessibilityLabel={value ? `${title}, ${value}` : title} style={rowStyle(value)}>
      <ItemText title={title} supporting={value} />
    </View>
  );
}

type PickerProps<T extends string> = RowBase & { options: { id: T; title: string }[]; selected: T; onSelect: (id: T) => void };

export function MaterialPickerRow<T extends string>({ title, icon, options, selected, onSelect }: PickerProps<T>) {
  const ripple = useMaterialRipple();
  const [choosing, setChoosing] = useState(false);
  const current = options.find((option) => option.id === selected)?.title ?? "";
  return (
    <>
      <Pressable testID={`materialSettingsRow:${title}`} accessibilityRole="button" accessibilityLabel={title} accessibilityValue={{ text: current }} android_ripple={ripple} onPress={() => setChoosing(true)} style={rowStyle(current)}>
        <MaterialSettingsLeading icon={icon} />
        <ItemText title={title} supporting={current} />
      </Pressable>
      {choosing ? (
        <MaterialDialog title={title} buttons={[{ title: dismissWords.cancel, onPress: () => setChoosing(false) }]} onDismiss={() => setChoosing(false)}>
          <View testID="materialRadioList" accessibilityRole="radiogroup" style={styles.radioList}>
            {options.map((option) => (
              <RadioItem
                key={option.id}
                title={option.title}
                selected={option.id === selected}
                onPress={() => {
                  setChoosing(false);
                  if (option.id !== selected) onSelect(option.id);
                }}
              />
            ))}
          </View>
        </MaterialDialog>
      ) : null}
    </>
  );
}

function RadioItem({ title, selected, onPress }: { title: string; selected: boolean; onPress: () => void }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const ring = selected ? scheme.primary : scheme.onSurfaceVariant;
  return (
    <Pressable testID={`materialRadio:${title}`} accessibilityRole="radio" accessibilityLabel={title} accessibilityState={{ selected, checked: selected }} android_ripple={ripple} onPress={onPress} style={styles.radioRow}>
      <View style={styles.radioHit}>
        <View style={[styles.radio, { borderColor: ring }]}>{selected ? <View style={[styles.radioDot, { backgroundColor: scheme.primary }]} /> : null}</View>
      </View>
      <Text style={[materialType.bodyLarge, styles.fill, { color: scheme.onSurface }]}>{title}</Text>
    </Pressable>
  );
}

export function MaterialEmptyState({ title, message, icon }: { title: string; message: string; icon: SymbolName }) {
  const { scheme } = useMaterialTheme();
  return (
    <View style={styles.empty} accessible accessibilityRole="header" accessibilityLabel={message ? `${title}. ${message}` : title}>
      <Symbol name={icon} size={48} color={scheme.onSurfaceVariant} />
      <Text style={[materialType.titleMedium, { color: scheme.onSurface }]}>{title}</Text>
      {message ? <Text style={[materialType.bodyMedium, styles.centered, { color: scheme.onSurfaceVariant }]}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  appBar: { zIndex: 1 },
  appBarRow: { flexDirection: "row", alignItems: "center", minHeight: materialSize.topAppBar, gap: 4 },
  title: { flex: 1 },
  mediumTitle: { paddingHorizontal: 16 },
  emphasized: { fontWeight: "700" },
  textButton: { minHeight: materialSize.touchTarget - 8, minWidth: materialSize.touchTarget, paddingHorizontal: 12, marginHorizontal: 4, borderRadius: materialShape.full, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  fill: { flex: 1 },
  group: { paddingTop: 16, marginHorizontal: 16 },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  segments: { gap: MATERIAL_SEGMENT_GAP },
  segment: { overflow: "hidden" },
  footer: { paddingHorizontal: 16, paddingTop: 8 },
  avatar: { alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 16, minHeight: materialSize.listItemOneLine, paddingHorizontal: 16, paddingVertical: 8 },
  rowTwoLine: { minHeight: materialSize.listItemTwoLine },
  leading: { width: materialSize.icon, height: materialSize.icon, alignItems: "center", justifyContent: "center" },
  rowInner: { flex: 1, flexDirection: "row", alignItems: "center", gap: 16 },
  radioList: { marginHorizontal: -24 },
  radioRow: { flexDirection: "row", alignItems: "center", minHeight: materialSize.touchTarget + 8, paddingHorizontal: 12, gap: 4 },
  radioHit: { width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center" },
  radio: { width: RADIO, height: RADIO, borderRadius: RADIO / 2, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  empty: { alignItems: "center", gap: 8, paddingTop: 96, paddingHorizontal: 32 },
  centered: { textAlign: "center" },
});
