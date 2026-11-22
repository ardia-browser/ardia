import { StyleSheet, View, type ViewStyle } from "react-native";
import { haptics } from "../../state/app/haptics";
import { newTab } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useCanReopen, useIncognito } from "../../state/tabs/hooks";
import { capsule, PressScale, rolesFor, smoothCorners, startLayout, SystemGlyph, type SymbolName } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { SF_SYMBOL_NAMES } from "../ui/sfSymbolNames";
import { plusMenu } from "../tabs/DeckBottomBar";
import { startButtonFill } from "./startLook";

export function StartCircleButton({ icon, label, testID, diameter = startLayout.barCircle, dark, incognito, onPress }: { icon: SymbolName; label: string; testID: string; diameter?: number; dark: boolean; incognito: boolean; onPress: () => void }) {
  const size = { width: diameter, height: diameter };
  return (
    <PressScale label={label} onPress={onPress} onPressIn={haptics.barPress} style={[styles.centered, size]}>
      <View testID={testID} style={[styles.centered, size, { borderRadius: capsule(diameter), backgroundColor: startButtonFill[dark || incognito ? "dark" : "light"] }]}>
        <SystemGlyph testID={`${testID}Glyph`} systemName={SF_SYMBOL_NAMES[icon] ?? "circle"} pointSize={16} weight="medium" name={icon} size={startLayout.circleGlyph} color={rolesFor(dark).label} />
      </View>
    </PressScale>
  );
}

export function StartPlusButton({ width, label, testID, dark, incognito, place, menusShown }: { width: number; label: string; testID: string; dark: boolean; incognito: boolean; place: ViewStyle; menusShown: boolean }) {
  const tabIncognito = useIncognito();
  const canReopen = useCanReopen();
  const size = { width, height: startLayout.barPlus.height };
  return (
    <MenuTrigger items={plusMenu(tabIncognito, canReopen)} trigger="longPress" haptic={menuOpenedHaptic} disabled={!menusShown} place={place} style={size}>
      {({ onLongPress }) => (
        <PressScale label={label} hint="Touch and hold for more options." onPress={newTab} onLongPress={onLongPress ?? noop} onPressIn={haptics.barPress} style={size}>
          <View testID={testID} style={[styles.centered, size, { borderRadius: capsule(size.height), backgroundColor: startButtonFill[dark || incognito ? "dark" : "light"] }]}>
            <SystemGlyph testID={`${testID}Glyph`} systemName="plus" pointSize={18} weight="medium" name="plus" size={startLayout.plusGlyph} color={rolesFor(dark).label} />
          </View>
        </PressScale>
      )}
    </MenuTrigger>
  );
}

const noop = () => undefined;

const styles = StyleSheet.create({
  centered: { alignItems: "center", justifyContent: "center", ...smoothCorners },
});
