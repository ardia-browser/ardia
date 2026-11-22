import { useEffect, useRef } from "react";
import { Keyboard, StyleSheet, Text, View } from "react-native";
import { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialSearchBar, type MaterialSearchBarHandle } from "../../platform/completingField";
import { closeFind, findNext, findPrevious, typeFind } from "../../state/page/actions";
import { useFindQuery, useFindResult } from "../../state/page/hooks";
import { findCount, findHasMatches } from "../../state/page/pagePrompts";
import { useKeyboardHeight } from "../search/useKeyboardHeight";
import { MaterialIconButton, type SymbolName } from "../ui";
import { MaterialBottomBarSurface } from "../ui/MaterialBottomBar";
import { useMaterialBack } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialBottomBar, materialShape, materialType } from "../ui/materialTokens";
import { t } from "../../lib/uiLanguage";


export function MaterialFindBar({ tabId }: { tabId: string }) {
  const { dark, scheme } = useMaterialTheme();
  const insets = useSafeAreaInsets();
  const side = Math.max(insets.left, insets.right) + materialBottomBar.edge;
  const keyboard = useAnimatedKeyboard({ isStatusBarTranslucentAndroid: true, isNavigationBarTranslucentAndroid: true });
  const fallbackKeyboard = useKeyboardHeight();
  const position = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, keyboard.height.value - insets.bottom, fallbackKeyboard) }],
  }));
  const query = useFindQuery();
  const result = useFindResult(tabId);
  const count = findCount(result, query);
  const matches = findHasMatches(result, query);
  const input = useRef<MaterialSearchBarHandle>(null);
  useEffect(() => {
    const focus = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(focus);
  }, []);
  const dismiss = () => {
    input.current?.blur();
    Keyboard.dismiss();
    closeFind();
  };
  useMaterialBack(true, { onCommit: dismiss });
  useEffect(() => {
    const hidden = Keyboard.addListener("keyboardDidHide", dismiss);
    return () => hidden.remove();
  }, []);
  return (
    <MaterialBottomBarSurface scheme={scheme} container={{ testID: "materialFindBar", style: [styles.bar, { left: side, right: side, bottom: insets.bottom + materialBottomBar.inset }, position] }}>
      {count ? (
        <View pointerEvents="none" style={[styles.countBadge, { backgroundColor: scheme.surfaceContainerHigh }]}>
          <Text testID="materialFindCount" accessibilityLiveRegion="polite" style={[materialType.labelMedium, styles.count, { color: count.kind === "match" ? scheme.onSurfaceVariant : scheme.error }]}>{count.label}</Text>
        </View>
      ) : null}
      <MaterialSearchBar
        ref={input}
        testID="materialFindInput"
        fieldOnly
        fieldLabel={t(`Find on Page`)}
        placeholder={t(`Find on Page`)}
        text={query}
        appearance={{ dark, scheme }}
        onTypedChange={typeFind}
        onSubmit={() => matches && findNext()}
        style={styles.field}
      />
      <FindControl icon="chevronUp" label={t(`Previous Match`)} enabled={matches} onPress={findPrevious} />
      <FindControl icon="chevronDown" label={t(`Next Match`)} enabled={matches} onPress={findNext} />
      <FindControl icon="xmark" label={t(`Close Find`)} enabled onPress={dismiss} />
    </MaterialBottomBarSurface>
  );
}

function FindControl({ icon, label, enabled, onPress }: { icon: SymbolName; label: string; enabled: boolean; onPress: () => void }) {
  return <MaterialIconButton icon={icon} iconSize={20} label={label} enabled={enabled} onPress={onPress} />;
}

const styles = StyleSheet.create({
  bar: { position: "absolute", zIndex: 2 },
  field: { flex: 1, height: materialBottomBar.field },
  countBadge: { position: "absolute", right: materialBottomBar.inset, bottom: materialBottomBar.height + 4, paddingHorizontal: 12, paddingVertical: 4, borderRadius: materialShape.full },
  count: { fontVariant: ["tabular-nums"] },
});
