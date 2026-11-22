import {
  DeckBackdrop,
  Frost,
  Glass,
  glassIsNative,
  INCOGNITO_LOOK,
  lookIsNative,
  ProfileBackdrop,
  type FrostVariant,
  type GlassShape,
} from "@ardia/phone-native";
import type { ReactNode, RefObject } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  backdropStops,
  lookGlassTint,
  nativeLookColors,
  windowTintStops,
  type NativeLookColors,
  type ProfileLook,
} from "../../lib/profileLook";
import { Backdrop } from "./Backdrop";
import type { ChromeStyle } from "../../lib/appearance";
import { useChromeStyle } from "../../state/settings/appearance";
import { useReduceTransparency } from "./contrast";
import { useIncognitoLook, useProfileLook, useTheme } from "./theme";
import { usePressStyle } from "./pressFeedback";
import { Symbol } from "./Symbol";
import { chromeInk, chromeLayout, controlRadius, nativeClassicChrome, overlayInk, shadowCss, smoothCorners, space, startInk, tabsInk, voiceLayout } from "./tokens";
import { useReduceMotion } from "./contrast";
import { useDesign } from "./design";

const useNativeLook = () => useDesign() !== "material" && lookIsNative();

export const SURFACES_FROST = "surfaces";

function BackdropBase({ color }: { color: string | undefined }) {
  return (
    <View
      testID="backdropBase"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: color }]}
    />
  );
}

const INCOGNITO_COLORS: NativeLookColors = {
  color: INCOGNITO_LOOK,
  themeColors: [],
  darkThemeColors: null,
  themeLook: null,
};

const lookColors = (look: ProfileLook, incognito: boolean, dark: boolean): NativeLookColors =>
  incognito ? INCOGNITO_COLORS : nativeLookColors(look, dark);

type BackdropProps = {
  themed?: boolean;
  softened?: boolean;
  fadesOut?: boolean;
  incognito?: boolean;
  dark?: boolean;
  baseOutside?: boolean;
  veiled?: boolean;
};

function useBackdropStops({ themed = false, incognito = false, dark }: BackdropProps) {
  const look = useProfileLook();
  const theme = useTheme();
  const shade = incognito || (dark ?? theme.dark);
  const stops = incognito
    ? tabsInk.incognitoBackdrop
    : themed
      ? theme.start.colors
      : dark === undefined
        ? theme.backdrop
        : windowTintStops(look, shade);
  return { look, theme, shade, stops };
}

export function LookBackdropBase(props: BackdropProps) {
  const { stops } = useBackdropStops(props);
  const nativeLook = useNativeLook();
  if (!nativeLook || props.fadesOut) return null;
  return <BackdropBase color={stops[0]} />;
}

export function DeckLookBackdropBase() {
  const theme = useTheme();
  const nativeLook = useNativeLook();
  if (!nativeLook) return null;
  return <BackdropBase color={theme.backdrop[0]} />;
}

export function LookBackdrop(props: BackdropProps) {
  const { themed = false, softened = false, fadesOut = false, incognito = false, baseOutside = false, veiled = false } = props;
  const { look, theme, shade, stops } = useBackdropStops(props);
  const nativeLook = useNativeLook();
  if (!nativeLook) {
    if (incognito) return <Backdrop colors={tabsInk.incognitoBackdrop} />;
    if (themed && veiled && theme.start.diagonal && !shade)
      return (
        <>
          <Backdrop colors={theme.start.colors} diagonal />
          <View testID="themeVeil" pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: startInk.veil }]} />
        </>
      );
    if (themed)
      return (
        <Backdrop colors={theme.start.colors} diagonal={theme.start.diagonal} />
      );
    return <Backdrop colors={stops} />;
  }
  return (
    <>
      {fadesOut || baseOutside ? null : <BackdropBase color={stops[0]} />}
      <ProfileBackdrop
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        {...lookColors(look, incognito, shade)}
        dark={shade}
        themed={themed}
        softened={softened}
        fadesOut={fadesOut}
      />
    </>
  );
}

export function DeckLookBackdrop({ baseOutside = false }: { baseOutside?: boolean }) {
  const look = useProfileLook();
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const reduceTransparency = useReduceTransparency();
  const nativeLook = useNativeLook();
  if (!nativeLook) return <Backdrop colors={theme.backdrop} />;
  return (
    <>
      {baseOutside ? null : <BackdropBase color={theme.backdrop[0]} />}
      <DeckBackdrop
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        {...nativeLookColors(look, theme.dark)}
        dark={theme.dark}
        reduceMotion={reduceMotion}
        reduceTransparency={reduceTransparency}
      />
    </>
  );
}

export function CustomLookBackdrop({ look, dark, testID, style }: { look: ProfileLook; dark: boolean; testID?: string; style?: StyleProp<ViewStyle> }) {
  const nativeLook = useNativeLook();
  const stops = backdropStops(look, dark, true);
  return (
    <View testID={testID} pointerEvents="none" style={[style, { backgroundColor: stops[0] }]}>
      {nativeLook ? (
        <ProfileBackdrop pointerEvents="none" style={StyleSheet.absoluteFill} {...nativeLookColors(look, dark)} dark={dark} themed />
      ) : (
        <Backdrop colors={stops} diagonal />
      )}
    </View>
  );
}

type FrostProps = {
  source: string;
  variant: FrostVariant;
  cornerRadius: number;
  fill: string;
  dark?: boolean;
  incognito?: boolean;
  solid?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

export const chromeIsSolid = (style: ChromeStyle, reduceTransparency: boolean, frostIsNative: boolean) => style === "classic" || reduceTransparency || !frostIsNative;

export function useSolidChrome() {
  const style = useChromeStyle();
  const reduceTransparency = useReduceTransparency();
  return chromeIsSolid(style, reduceTransparency, useNativeLook());
}

export type PlateMaterial = "glass" | "frost" | "solid";

export type PlateFace = Exclude<PlateMaterial, "solid">;

export const SEARCH_PANEL_FACE: PlateFace = "frost";

export const plateMaterial = (face: PlateFace, solid: boolean, glassIsLive: boolean): PlateMaterial => (solid ? "solid" : face === "glass" && glassIsLive ? "glass" : "frost");

export function LookFrost({
  source,
  variant,
  cornerRadius,
  fill,
  dark,
  incognito = false,
  solid = false,
  style,
  children,
}: FrostProps) {
  const look = useProfileLook();
  const theme = useTheme();
  const reduceTransparency = useReduceTransparency();
  const nativeLook = useNativeLook();
  if (!nativeLook || solid)
    return (
      <View
        style={[style, { backgroundColor: fill, borderRadius: cornerRadius, ...smoothCorners }]}
      >
        {children}
      </View>
    );
  const shade = incognito || (dark ?? theme.dark);
  return (
    <Frost
      source={source}
      variant={variant}
      cornerRadius={cornerRadius}
      {...lookColors(look, incognito, shade)}
      dark={shade}
      reduceTransparency={reduceTransparency}
      style={[style, { borderRadius: cornerRadius, backgroundColor: fill }]}
    >
      {children}
    </Frost>
  );
}

export function ChromeFrost({ solidFill, ...props }: Omit<FrostProps, "solid"> & { solidFill?: string }) {
  const solid = useSolidChrome();
  return <LookFrost {...props} fill={solid && solidFill !== undefined ? solidFill : props.fill} solid={solid} />;
}

export const usesGlass = () => glassIsNative();

export function ChromeSurface({
  shape,
  cornerRadius,
  incognito: incognitoChosen,
  barShadow = false,
  interactive = true,
  tinted = false,
  dark,
  shown,
  shownMs,
  testID,
  style,
  children,
}: {
  shape: GlassShape;
  cornerRadius: number;
  incognito?: boolean;
  barShadow?: boolean;
  interactive?: boolean;
  tinted?: boolean;
  dark?: boolean;
  shown?: boolean;
  shownMs?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const look = useProfileLook();
  const theme = useTheme();
  const surface = useChromeStyle();
  const privateContext = useIncognitoLook();
  const incognito = incognitoChosen ?? privateContext;
  if (glassIsNative()) {
    const shade = dark ?? (incognito || theme.dark);
    return (
      <Glass testID={testID} source={SURFACES_FROST} shape={shape} cornerRadius={cornerRadius} tint={incognito ? undefined : lookGlassTint(look)} interactive={interactive} tinted={tinted} surface={surface} barShadow={barShadow} shown={shown} shownMs={shownMs} classicChrome={nativeClassicChrome} {...lookColors(look, incognito, shade)} dark={shade} style={[style, { borderRadius: cornerRadius }]}>
        {children}
      </Glass>
    );
  }
  const ink = dark ?? (incognito || theme.dark) ? chromeInk.dark : chromeInk.light;
  return (
    <View
      testID={testID}
      style={[
        style,
        {
          borderRadius: cornerRadius,
          backgroundColor: tinted ? theme.canvas : ink.surface,
          borderWidth: chromeLayout.edge,
          borderColor: ink.edge,
          boxShadow: barShadow ? shadowCss("control", dark ?? (incognito || theme.dark)) : undefined,
        },
      ]}
    >
      {children}
    </View>
  );
}

export function LookGlass({
  shape,
  ...frost
}: FrostProps & { shape: GlassShape }) {
  const look = useProfileLook();
  const theme = useTheme();
  if (!glassIsNative()) return <LookFrost {...frost} />;
  const shade = (frost.incognito ?? false) || (frost.dark ?? theme.dark);
  return (
    <Glass
      testID="deckGlass"
      source={frost.source}
      shape={shape}
      tint={frost.incognito ? undefined : lookGlassTint(look)}
      classicChrome={nativeClassicChrome}
      {...lookColors(look, frost.incognito ?? false, shade)}
      dark={shade}
      style={frost.style}
    >
      {frost.children}
    </Glass>
  );
}

type OverlayFace = { frostSource?: string };

function OverlayPlate({ frostSource, cornerRadius, style, children }: OverlayFace & { cornerRadius: number; style: StyleProp<ViewStyle>; children: ReactNode }) {
  if (frostSource)
    return (
      <ChromeFrost source={frostSource} variant="glass" dark cornerRadius={cornerRadius} fill={overlayInk.glass} solidFill={overlayInk.solidGlass} style={style}>
        {children}
      </ChromeFrost>
    );
  return <View style={[style, overlayStyles.plate, { borderRadius: cornerRadius }]}>{children}</View>;
}

export function OverlayCancelButton({ label, onPress, frostSource, buttonRef, testID }: OverlayFace & { label: string; onPress: () => void; buttonRef?: RefObject<ViewInstance | null>; testID?: string }) {
  const insets = useSafeAreaInsets();
  const pressStyle = usePressStyle("icon", { style: [overlayStyles.cancel, { top: insets.top + space.s, right: insets.right + space.l }] });
  return (
    <Pressable ref={buttonRef} testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={pressStyle}>
      <OverlayPlate frostSource={frostSource} cornerRadius={controlRadius(voiceLayout.cancel)} style={overlayStyles.cancelFace}>
        <Symbol name="xmark" size={voiceLayout.icon} color={overlayInk.label} />
      </OverlayPlate>
    </Pressable>
  );
}

const overlayStyles = StyleSheet.create({
  plate: { backgroundColor: overlayInk.glass, overflow: "hidden", ...smoothCorners },
  cancel: { position: "absolute", width: voiceLayout.cancel, height: voiceLayout.cancel },
  cancelFace: { flex: 1, alignItems: "center", justifyContent: "center", ...smoothCorners },
});
