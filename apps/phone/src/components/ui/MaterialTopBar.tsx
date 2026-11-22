import type { ReactNode } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { withAlpha } from "../../lib/color";
import { MaterialIconButton } from "./MaterialIconButton";
import { useMaterialTheme } from "./materialTheme";
import { materialShape, materialSize, materialType } from "./materialTokens";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { t } from "../../lib/uiLanguage";


type TopBarProps = { title?: string; titleTestID?: string; nav: "close" | "back"; navLabel?: string; onNav: () => void; actions?: ReactNode; ink?: string; fill?: string };

export function MaterialTopBar({ title, titleTestID, nav, navLabel, onNav, actions, ink, fill }: TopBarProps) {
  const { scheme } = useMaterialTheme();
  const color = ink ?? scheme.onSurface;
  return (
    <View testID="materialTopBar" style={[styles.bar, fill ? { backgroundColor: fill } : null]}>
      <MaterialIconAction testID="materialTopBarNav" icon={nav === "close" ? "xmark" : "arrowRight"} flipped={nav === "back"} label={navLabel ?? (nav === "close" ? t(`Close`) : t(`Back`))} ink={color} onPress={onNav} />
      {title ? (
        <Text testID={titleTestID} accessibilityRole="header" numberOfLines={1} style={[materialType.titleLarge, styles.title, { color }]}>
          {title}
        </Text>
      ) : (
        <View style={styles.title} />
      )}
      {actions}
    </View>
  );
}

type ActionProps = { testID?: string; icon: SymbolName; label: string; ink?: string; turned?: boolean; flipped?: boolean; onPress: () => void };

export function MaterialIconAction({ testID, icon, label, ink, turned, flipped, onPress }: ActionProps) {
  return <MaterialIconButton testID={testID} icon={icon} label={label} ink={ink} turned={turned} flipped={flipped} onPress={onPress} />;
}

type FieldProps = { value: string; placeholder: string; onChangeText: (text: string) => void; testID?: string };

export function MaterialSearchField({ value, placeholder, onChangeText, testID }: FieldProps) {
  const { scheme } = useMaterialTheme();
  return (
    <View testID={testID ?? "materialSearchField"} style={[styles.field, { backgroundColor: scheme.surfaceContainerHigh }]}>
      <Symbol name="magnifyingglass" size={materialSize.icon} color={scheme.onSurfaceVariant} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={scheme.onSurfaceVariant}
        cursorColor={scheme.primary}
        selectionColor={withAlpha(scheme.primary, 0.4)}
        autoCorrect={false}
        autoCapitalize="none"
        style={[materialType.bodyLarge, styles.input, { color: scheme.onSurface }]}
      />
      {value ? <MaterialIconAction icon="xmark" label={t(`Clear Search`)} onPress={() => onChangeText("")} /> : null}
    </View>
  );
}

export function MaterialEmptyIcon({ icon }: { icon: SymbolName }) {
  const { scheme } = useMaterialTheme();
  return (
    <View testID="materialEmptyIcon" style={[styles.empty, { backgroundColor: scheme.primaryContainer }]}>
      <Symbol name={icon} size={materialSize.icon * 1.5} color={scheme.onPrimaryContainer} />
    </View>
  );
}

const EMPTY_SIDE = 72;

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", minHeight: materialSize.topAppBar, paddingHorizontal: 4, gap: 4 },
  title: { flex: 1, paddingHorizontal: 4 },
  field: { height: materialSize.searchBar, borderRadius: materialShape.full, flexDirection: "row", alignItems: "center", gap: 16, paddingLeft: 16, paddingRight: 4, overflow: "hidden" },
  input: { flex: 1, height: materialSize.touchTarget, paddingVertical: 0 },
  empty: { width: EMPTY_SIDE, height: EMPTY_SIDE, borderRadius: EMPTY_SIDE / 2, alignItems: "center", justifyContent: "center" },
});
