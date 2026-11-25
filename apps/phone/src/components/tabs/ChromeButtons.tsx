import { StyleSheet, type ViewProps, type ViewStyle } from "react-native";
import { haptics } from "../../state/app/haptics";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { newIncognitoTab, newRegularTab, newTab, reopenLastClosed } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useCanReopen, useIncognito } from "../../state/tabs/hooks";
import { actionWords } from "../../lib/sharedWords";
import { BarPlusGlyph, capsule, ChromeSurface, controlSize, iconRoles, PressInPlace, rolesFor, startLayout, Symbol, SystemGlyph, type MenuItem, type SymbolName } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { PressedGlyph } from "../ui/PressInPlace";

const CIRCLE_SYSTEM_NAMES: Partial<Record<SymbolName, string>> = {
  ellipsis: "ellipsis",
  gearshape: "gearshape",
  magnifyingglass: "magnifyingglass",
  squareOnSquare: "square.on.square",
  squareStack: "square.stack",
  squareGrid2x2: "square.grid.2x2",
};

const CIRCLE_SYSTEM_GLYPH = 16;

type PlusMenuItem = { label: string; icon: SymbolName; onPress: () => void };

export function plusMenuItems(incognito: boolean, canReopen: boolean): PlusMenuItem[] {
  return [
    ...(incognito
      ? [
          { label: actionWords.newTab, icon: iconRoles.newTab, onPress: newRegularTab },
          { label: actionWords.newIncognitoTab, icon: "eyes" as const, onPress: newTab },
        ]
      : [{ label: actionWords.newIncognitoTab, icon: "eyes" as const, onPress: newIncognitoTab }]),
    ...(canReopen ? [{ label: "Reopen Closed Tab", icon: "arrowUturnBackward" as const, onPress: reopenLastClosed }] : []),
  ];
}

export const plusMenu = (incognito: boolean, canReopen: boolean): MenuItem[] => plusMenuItems(incognito, canReopen);

type Look = { dark: boolean; incognito?: boolean };

export type GlyphFade = { readonly value: number };

export type ChromeFade = { glassShown?: boolean; glassShownMs?: number; glyphFade?: GlyphFade };

export function FadingGlyphs({ fade, style, ...rest }: ViewProps & { fade?: GlyphFade }) {
  const faded = useAnimatedStyle(() => (fade ? { opacity: fade.value } : {}));
  return <Animated.View {...rest} style={fade ? [style, faded] : style} />;
}

function PressedFadingGlyphs({ fade, style, children, ...rest }: ViewProps & { fade?: GlyphFade }) {
  return (
    <FadingGlyphs {...rest} fade={fade} style={style}>
      <PressedGlyph style={styles.centered}>{children}</PressedGlyph>
    </FadingGlyphs>
  );
}

export function GlassCircleButton({ icon, label, testID, diameter = controlSize.bar, dark, incognito = false, glassShown, glassShownMs, glyphFade, onPress }: Look & ChromeFade & { icon: SymbolName; label: string; testID: string; diameter?: number; onPress: () => void }) {
  const size = { width: diameter, height: diameter };
  return (
    <PressInPlace label={label} onPress={onPress} onPressIn={haptics.barPress} dims="glyph" style={[styles.centered, size]}>
      <ChromeSurface testID={testID} shape="circle" cornerRadius={capsule(diameter)} incognito={incognito} dark={dark} shown={glassShown} shownMs={glassShownMs} style={[styles.centered, size]}>
        <PressedFadingGlyphs testID={`${testID}Glyph`} pointerEvents="none" fade={glyphFade}>
          {CIRCLE_SYSTEM_NAMES[icon] ? (
            <SystemGlyph systemName={CIRCLE_SYSTEM_NAMES[icon]} pointSize={CIRCLE_SYSTEM_GLYPH} weight="medium" name={icon} size={startLayout.circleGlyph} color={rolesFor(dark).label} />
          ) : (
            <Symbol name={icon} size={startLayout.circleGlyph} color={rolesFor(dark).label} />
          )}
        </PressedFadingGlyphs>
      </ChromeSurface>
    </PressInPlace>
  );
}

export const PLUS_HINT = "Touch and hold for more options.";

export type PlusMenuButtonProps = Look & ChromeFade & { width: number; label: string; testID: string; place: ViewStyle; menusShown?: boolean; frost?: string | null; onMenu?: (open: boolean) => void };

export function PlusMenuButton({ width, label, testID, dark, incognito = false, place, menusShown = true, frost, onMenu, glassShown, glassShownMs, glyphFade }: PlusMenuButtonProps) {
  const tabIncognito = useIncognito();
  const canReopen = useCanReopen();
  const size = { width, height: controlSize.bar };
  return (
    <MenuTrigger items={plusMenu(tabIncognito, canReopen)} trigger="longPress" haptic={menuOpenedHaptic} disabled={!menusShown} frost={frost} onOpen={() => onMenu?.(true)} onClose={() => onMenu?.(false)} place={place} style={size}>
      {({ onLongPress }) => (
        <PressInPlace label={label} hint={PLUS_HINT} onPress={newTab} onLongPress={onLongPress ?? noop} onPressIn={haptics.barPress} dims="glyph" style={size}>
          <ChromeSurface testID={testID} shape={width === size.height ? "circle" : "capsule"} cornerRadius={capsule(size.height)} incognito={incognito} dark={dark} shown={glassShown} shownMs={glassShownMs} style={[styles.centered, size]}>
            <PressedFadingGlyphs testID={`${testID}Glyph`} pointerEvents="none" fade={glyphFade}>
              <BarPlusGlyph color={rolesFor(dark).label} />
            </PressedFadingGlyphs>
          </ChromeSurface>
        </PressInPlace>
      )}
    </MenuTrigger>
  );
}

const noop = () => undefined;

const styles = StyleSheet.create({
  centered: { alignItems: "center", justifyContent: "center" },
});
