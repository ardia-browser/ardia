import { StyleSheet } from "react-native";
import { haptics } from "../../state/app/haptics";
import { barGlyphLayout, capsule, ChromeSurface, controlSize, PressInPlace, rolesFor, SystemGlyph, type SymbolName } from "../ui";
import { PressedGlyph } from "../ui/PressInPlace";
import { SF_SYMBOL_NAMES } from "../ui/sfSymbolNames";

type StartBarLook = { dark: boolean; incognito: boolean };

export function StartCircleButton({ icon, label, testID, diameter = controlSize.bar, dark, incognito, onPress, onPressIn }: StartBarLook & { icon: SymbolName; label: string; testID: string; diameter?: number; onPress: () => void; onPressIn?: () => void }) {
  const size = { width: diameter, height: diameter };
  const { pointSize, weight, side } = barGlyphLayout.circle;
  return (
    <PressInPlace label={label} onPress={onPress} onPressIn={onPressIn ? () => pressIn(onPressIn) : haptics.barPress} dims="glyph" style={[styles.centered, size]}>
      <ChromeSurface testID={testID} shape="circle" cornerRadius={capsule(diameter)} incognito={incognito} dark={dark} style={[styles.centered, size]}>
        <PressedGlyph style={styles.centered}>
          <SystemGlyph testID={`${testID}Glyph`} systemName={SF_SYMBOL_NAMES[icon] ?? "circle"} pointSize={pointSize} weight={weight} name={icon} size={side} color={rolesFor(dark).label} />
        </PressedGlyph>
      </ChromeSurface>
    </PressInPlace>
  );
}

function pressIn(prepare: () => void) {
  haptics.barPress();
  prepare();
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", justifyContent: "center" },
});
