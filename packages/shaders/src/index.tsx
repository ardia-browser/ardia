import type { ThemeBackdropProps, ThemeTexture } from "@ardia/core";
import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import { MEADOW_INK } from "./meadowPage/config";

export const DIA_SPECTRUM = ["#0358F7", "#5092C7", "#E1E1FE", "#FFD400", "#FA3D1D", "#FD02F5"];

export type Rect = { x: number; y: number; width: number; height: number };

export type AreaLightPalette = "blue" | "red" | "pink" | "orange" | "yellow" | "green" | "purple";

export type WindowBackdropProps = ViewProps &
  Partial<ThemeBackdropProps> & {
    colors: [string, string];
    vibrancy?: boolean;
    tintColor?: string;
    tintAlpha?: number;
    tintLightness?: number;
    angle?: number;
    grainOpacity?: number;
    grainScale?: number;
  };

const NativeBackdrop = requireNativeViewManager<WindowBackdropProps>("ArdiaWindowBackdrop");

const BackdropModule = requireNativeModule<{ holdKeyLook(on: boolean): Promise<void> }>("ArdiaWindowBackdrop");

export function holdThemedWindowsKeyLook(on: boolean) {
  void BackdropModule.holdKeyLook(on);
}

export function WindowBackdrop({ angle = 180, grainOpacity = 0.09, grainScale = 1, ...props }: WindowBackdropProps) {
  return <NativeBackdrop pointerEvents="none" angle={angle} grainOpacity={grainOpacity} grainScale={grainScale} {...props} />;
}

const rect = (r: Rect) => [r.x, r.y, r.width, r.height];

export type PowerUpProps = ViewProps & {
  palette?: AreaLightPalette | string[];
  speed?: number;
  origin?: number;
  cornerRadius?: number;
  halo?: Rect | null;
};

type NativePowerUpProps = Omit<PowerUpProps, "palette" | "halo"> & { palette?: string[]; haloFrame: number[] };

const NativePowerUp = requireNativeViewManager<NativePowerUpProps>("ArdiaPowerUp");

export function PowerUp({ palette = "pink", halo = null, ...props }: PowerUpProps) {
  return (
    <NativePowerUp
      pointerEvents="none"
      {...props}
      palette={typeof palette === "string" ? [palette] : palette}
      haloFrame={halo ? rect(halo) : [0, 0, 0, 0]}
    />
  );
}


export type ThemeSwatchProps = ViewProps & {
  colors: number[];
  grain?: number;
  texture?: ThemeTexture;
  padLightness?: number;
  angle?: number;
};

const NativeThemeSwatch = requireNativeViewManager<ThemeSwatchProps>("ArdiaThemeSwatch");

export function ThemeSwatch({ grain = 0, padLightness = -1, angle = 135, style, ...props }: ThemeSwatchProps) {
  return <NativeThemeSwatch pointerEvents="none" grain={grain} padLightness={padLightness} angle={angle} style={style} {...props} />;
}

export type MeadowTone = { tone: "light" | "dark"; halo: number };

export { MEADOW_INK };

export function meadowTextStyle({ tone, halo }: MeadowTone) {
  const { ink, halo: rgb } = MEADOW_INK[tone];
  return {
    color: ink,
    textShadowColor: `rgba(${rgb.join(",")},${Math.min(1, Math.max(0, halo))})`,
    textShadowRadius: 2,
    textShadowOffset: { width: 0, height: 0 },
  };
}

export type MeadowText = { fontSize: number; fontWeight: string; letterSpacing?: number };

export type MeadowMotion = { delay: number; duration: number; easing: string };

export type MeadowIntro = {
  startedAt: number;
  muted: boolean;
  wordmark: string;
  tagline: string;
  skip: { label: string; hint: string };
  mute: { mute: string; unmute: string; mutedIcon: string; playingIcon: string; iconSize: number; iconWeight: string; iconBox: number };
  colors: { background: string; buttonBorder: string; buttonText: string; buttonHover: string };
  type: { wordmark: MeadowText; tagline: MeadowText; button: MeadowText };
  layout: { gap: number; icon: number; inset: number; button: number; buttonPad: number; iconFrom: number; iconOpaque: number; letterRise: number; taglineRise: number; exitScale: number; exitHold: number };
  motion: { icon: MeadowMotion; letters: MeadowMotion[]; tagline: MeadowMotion; exit: MeadowMotion; skip: MeadowMotion; holds: { exit: number; skip: number }; press: { scale: number; circleScale: number; duration: number; easing: string } };
};

export type MeadowIntroEvent =
  | { kind: "live"; firstFrameMs: number }
  | { kind: "fallback"; reason: string }
  | { kind: "poster" }
  | { kind: "skip" }
  | { kind: "mute"; muted: boolean };

export type MeadowProps = ViewProps & { night: boolean; onTone?: (tone: MeadowTone) => void; intro?: MeadowIntro; onIntro?: (event: MeadowIntroEvent) => void };

export type { MeadowPageConfig, MeadowPageReport, MeadowPageState } from "./meadowPage/config";

export { Meadow } from "./meadow";
