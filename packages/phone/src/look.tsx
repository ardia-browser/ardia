import { createElement, type ComponentType, type ReactNode } from "react";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { View, type ViewProps } from "react-native";

export const INCOGNITO_LOOK = "incognito";

export type ThemeTexture = "grain" | "sand" | "denim" | "tweed";

export type ThemeLookStop = { color: { r: number; g: number; b: number; a: number }; x: number; y: number };

export type ThemeLook = { stops: ThemeLookStop[]; intensity: number; grain: number; texture: ThemeTexture; translucency: number; angle: number };

export type LookColors = { color?: string | null; themeColors?: string[]; darkThemeColors?: string[] | null; themeLook?: ThemeLook | null };

export type DeckBackdropProps = ViewProps & LookColors & { dark?: boolean; reduceMotion?: boolean; reduceTransparency?: boolean };

export type ProfileBackdropProps = ViewProps & LookColors & { dark?: boolean; themed?: boolean; softened?: boolean; fadesOut?: boolean };

export type FilmGrainProps = ViewProps & { opacity?: number; children?: ReactNode };

export type FrostSourceProps = ViewProps & { name: string; children?: ReactNode };

export type FrostVariant = "bar" | "sheet" | "glass" | "thin";

export type FrostProps = ViewProps &
  LookColors & { source: string; name?: string; variant?: FrostVariant; cornerRadius?: number; dark?: boolean; reduceTransparency?: boolean; children?: ReactNode };

export type GlassShape = "capsule" | "circle" | "rounded";

export type GlassSurface = "glass" | "classic";

export type GlassProps = FrostProps & { shape?: GlassShape; tint?: string; interactive?: boolean; surface?: GlassSurface; tinted?: boolean; barShadow?: boolean; shown?: boolean; shownMs?: number };

type LookNative = {
  hasGlass?: () => boolean;
  setPageFrost?: (mode: "live" | "solid") => string;
  probeFrosts?: () => void;
  setLookOff?: (off: boolean) => boolean;
  lookIsOff?: () => boolean;
  setBlobFramesPerSecond?: (rate: number) => number;
  blobFramesPerSecond?: () => number;
  setBlurOverBackdrop?: (blur: boolean) => boolean;
  setBackdropDraw?: (draw: BackdropDraw) => BackdropDraw;
  backdropDraw?: () => BackdropDraw;
  setDeckLayers?: (on: boolean) => boolean;
  deckLayers?: () => boolean;
  blurOverBackdrop?: () => boolean;
  lookCounts?: () => LookCounts;
};

export type BackdropDraw = "small" | "smallnograin" | "full" | "flat";

export type LookCounts = {
  sources: number;
  recording: number;
  frosts: number;
  holdingLayers: number;
  layerBytes: number;
  decks: number;
  animating: number;
  recordingNames?: string[];
  layerNames?: string[];
  heldStill?: number;
  tinted?: number;
  backdropFrames?: number;
  sourceRecordings?: number;
  blurLayerRenders?: number;
  retints?: number;
  restingLayerHolds?: number;
  restingLayered?: number;
};

const lookNative = requireOptionalNativeModule<LookNative>("ArdiaPhoneLook");

const hasNativeLook = lookNative !== null;

export const lookLab = {
  setPageFrost: (mode: "live" | "solid"): string | null => lookNative?.setPageFrost?.(mode) ?? null,
  probeFrosts: () => lookNative?.probeFrosts?.(),
  setLookOff: (off: boolean): boolean | null => lookNative?.setLookOff?.(off) ?? null,
  lookIsOff: (): boolean => lookNative?.lookIsOff?.() ?? false,
  setBlobFramesPerSecond: (rate: number): number | null => lookNative?.setBlobFramesPerSecond?.(rate) ?? null,
  blobFramesPerSecond: (): number => lookNative?.blobFramesPerSecond?.() ?? 0,
  counts: (): LookCounts | null => lookNative?.lookCounts?.() ?? null,
  setBlurOverBackdrop: (blur: boolean): boolean | null => lookNative?.setBlurOverBackdrop?.(blur) ?? null,
  blurOverBackdrop: (): boolean => lookNative?.blurOverBackdrop?.() ?? false,
  setBackdropDraw: (draw: BackdropDraw): BackdropDraw | null => lookNative?.setBackdropDraw?.(draw) ?? null,
  backdropDraw: (): BackdropDraw => lookNative?.backdropDraw?.() ?? "small",
  setDeckLayers: (on: boolean): boolean | null => lookNative?.setDeckLayers?.(on) ?? null,
  deckLayers: (): boolean => lookNative?.deckLayers?.() ?? true,
};

const views = new Map<string, ComponentType<object>>();

function look<P extends ViewProps>(name: string) {
  return function LookView(props: P) {
    if (!hasNativeLook) {
      const { style, children, testID, pointerEvents } = props as ViewProps & { children?: ReactNode };
      return createElement(View, { style, testID, pointerEvents }, children);
    }
    let native = views.get(name);
    if (!native) {
      native = requireNativeViewManager<object>("ArdiaPhoneLook", name);
      views.set(name, native);
    }
    return createElement(native, props);
  };
}

export const lookIsNative = () => hasNativeLook;

const hasNativeGlass = hasNativeLook && lookNative?.hasGlass?.() === true;

export const glassIsNative = () => hasNativeGlass;

export const DeckBackdrop = look<DeckBackdropProps>("DeckBackdrop");

export const ProfileBackdrop = look<ProfileBackdropProps>("ProfileBackdrop");

export const FilmGrain = look<FilmGrainProps>("FilmGrain");

export const FrostSource = look<FrostSourceProps>("FrostSource");

export const Frost = look<FrostProps>("Frost");

const NativeGlass = look<GlassProps>("Glass");

export function Glass(props: GlassProps) {
  if (hasNativeGlass) return createElement(NativeGlass, props);
  const { shape, tint, interactive, surface, tinted, barShadow, shown, shownMs, ...frost } = props;
  const cornerRadius = frost.cornerRadius ?? (shape === "rounded" ? 0 : 999);
  const classic = surface === "classic" || frost.reduceTransparency === true;
  return createElement(Frost, { ...frost, variant: frost.variant ?? "glass", cornerRadius, reduceTransparency: classic ? true : frost.reduceTransparency });
}
