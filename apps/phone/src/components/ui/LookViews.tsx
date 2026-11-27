import {
  DeckBackdrop,
  Frost,
  FrostSource,
  Glass,
  GlassBackdrop,
  glassIsNative,
  INCOGNITO_LOOK,
  lookIsNative,
  ProfileBackdrop,
  type FrostVariant,
  type GlassShape,
} from "@ardia/phone-native";
import { createContext, useContext, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import Animated from "react-native-reanimated";
import { Platform, Pressable, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
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
import { useBrowsingPrivately } from "../../state/tabs/hooks";
import { useReduceTransparency } from "./contrast";
import { useIncognitoLook, useProfileLook, useTheme } from "./theme";
import { usePressStyle } from "./pressFeedback";
import { Symbol } from "./Symbol";
import { capsule, chromeInk, chromeLayout, nativeClassicChrome, overlayInk, shadowCss, smoothCorners, space, startInk, tabsInk, voiceLayout } from "./tokens";
import { useReduceMotion } from "./contrast";
import { useDesign } from "./design";

const useNativeLook = () => useDesign() !== "material" && lookIsNative();

export const SURFACES_FROST = "surfaces";
export const PAGE_FROST = "page";
export const START_FROST = "start";

const GlassSourceContext = createContext<string>(SURFACES_FROST);

const GlassPrivacyContext = createContext<boolean | null>(null);

export const GlassPrivacy = GlassPrivacyContext.Provider;

function useGlassPrivately() {
  const side = useContext(GlassPrivacyContext);
  const browsing = useBrowsingPrivately();
  return side ?? browsing;
}

const makeHeldFrostSource = () => Animated.createAnimatedComponent(FrostSource);

let heldFrostSource: ReturnType<typeof makeHeldFrostSource> | null = null;

export function HeldFrostSource(props: ComponentProps<ReturnType<typeof makeHeldFrostSource>>) {
  const Held = (heldFrostSource ??= makeHeldFrostSource());
  return <Held {...props} />;
}

export function GlassSource({ name, children }: { name: string; children: ReactNode }) {
  return <GlassSourceContext.Provider value={name}>{children}</GlassSourceContext.Provider>;
}

export const drawsGlassBehindItsLayers = (os: string, nativeGlass: boolean) => os === "android" && nativeGlass;

const GlassBranchContext = createContext<boolean | null>(null);

export function GlassBranch({ attached, children }: { attached: boolean; children: ReactNode }) {
  return <GlassBranchContext.Provider value={attached}>{children}</GlassBranchContext.Provider>;
}

export const splitsGlassFromFace = (os: string, nativeGlass: boolean, branch: boolean | null) => branch !== null && drawsGlassBehindItsLayers(os, nativeGlass);

export function GlassBehind() {
  const attached = useContext(GlassBranchContext) ?? true;
  if (!attached || !drawsGlassBehindItsLayers(Platform.OS, glassIsNative())) return null;
  return <GlassBackdrop testID="glassBehind" pointerEvents="none" style={StyleSheet.absoluteFill} />;
}

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
  name?: string;
  variant: FrostVariant;
  cornerRadius: number;
  fill: string;
  dark?: boolean;
  incognito?: boolean;
  privately?: boolean;
  overlay?: boolean;
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
  name,
  variant,
  cornerRadius,
  fill,
  dark,
  incognito = false,
  privately = false,
  overlay = false,
  solid = false,
  style,
  children,
}: FrostProps) {
  const look = useProfileLook();
  const theme = useTheme();
  const privateContext = useIncognitoLook();
  const browsingPrivately = useGlassPrivately();
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
  if (variant === "glass" && glassIsNative())
    return (
      <Glass
        source={source}
        name={name}
        shape="rounded"
        cornerRadius={cornerRadius}
        interactive={false}
        privately={incognito || privately || privateContext || browsingPrivately}
        overlay={overlay}
        {...lookColors(look, incognito, shade)}
        dark={shade}
        reduceTransparency={reduceTransparency}
        style={[style, { borderRadius: cornerRadius, backgroundColor: fill }]}
      >
        {children}
      </Glass>
    );
  return (
    <Frost
      source={source}
      name={name}
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
  privately = false,
  interactive = true,
  tinted = false,
  dark,
  shown,
  shownMs,
  underlay = false,
  sampleHold = null,
  testID,
  style,
  children,
}: {
  shape: GlassShape;
  cornerRadius: number;
  incognito?: boolean;
  barShadow?: boolean;
  privately?: boolean;
  interactive?: boolean;
  tinted?: boolean;
  dark?: boolean;
  shown?: boolean;
  shownMs?: number;
  underlay?: boolean;
  sampleHold?: string | null;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const look = useProfileLook();
  const theme = useTheme();
  const surface = useChromeStyle();
  const privateContext = useIncognitoLook();
  const browsingPrivately = useGlassPrivately();
  const incognito = incognitoChosen ?? privateContext;
  const source = useContext(GlassSourceContext);
  const branch = useContext(GlassBranchContext);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const laidOut = ({ nativeEvent: { layout } }: LayoutChangeEvent) => setBox((was) => (was && was.x === layout.x && was.y === layout.y && was.width === layout.width && was.height === layout.height ? was : layout));
  if (glassIsNative()) {
    const shade = dark ?? (incognito || theme.dark);
    const glassProps = { source, name: testID, shape, cornerRadius, tint: incognito ? undefined : lookGlassTint(look), interactive, tinted, surface, barShadow, shown, shownMs, sampleHold, privately: privately || incognito || privateContext || browsingPrivately, classicChrome: nativeClassicChrome, ...lookColors(look, incognito, shade), dark: shade };
    const split = splitsGlassFromFace(Platform.OS, true, branch);
    const glass = split ? (
      <View testID={testID ? `${testID}Face` : undefined} collapsable={false} style={[style, { borderRadius: cornerRadius }]} onLayout={underlay ? laidOut : undefined}>
        {branch ? <Glass testID={testID} {...glassProps} style={[StyleSheet.absoluteFill, { borderRadius: cornerRadius }]} /> : null}
        {children}
      </View>
    ) : (
      <Glass testID={testID} {...glassProps} style={[style, { borderRadius: cornerRadius }]} onLayout={underlay ? laidOut : undefined}>
        {children}
      </Glass>
    );
    if (!underlay) return glass;
    const sampleInk = shade ? chromeInk.dark : chromeInk.light;
    return (
      <>
        {box ? <View testID={testID ? `${testID}Sample` : undefined} pointerEvents="none" style={{ position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: cornerRadius, backgroundColor: sampleInk.surface, borderWidth: chromeLayout.edge, borderColor: sampleInk.edge }} /> : null}
        {glass}
      </>
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
          boxShadow: barShadow && shown !== false ? shadowCss("control", dark ?? (incognito || theme.dark)) : undefined,
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
  const privateContext = useIncognitoLook();
  const browsingPrivately = useGlassPrivately();
  if (!glassIsNative()) return <LookFrost {...frost} />;
  const shade = (frost.incognito ?? false) || (frost.dark ?? theme.dark);
  return (
    <Glass
      testID="deckGlass"
      source={frost.source}
      name={frost.name ?? "deckGlass"}
      shape={shape}
      tint={frost.incognito ? undefined : lookGlassTint(look)}
      privately={(frost.incognito ?? false) || (frost.privately ?? false) || privateContext || browsingPrivately}
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
      <OverlayPlate frostSource={frostSource} cornerRadius={capsule(voiceLayout.cancel)} style={overlayStyles.cancelFace}>
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
