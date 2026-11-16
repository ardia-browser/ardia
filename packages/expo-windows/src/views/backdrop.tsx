import { forwardRef, memo, useMemo } from "react";
import type { ThemeSwatchProps, WindowBackdropProps } from "@ardia/shaders";
import { StyleSheet, View } from "react-native";
import { Bands } from "./Bands";
import { adjustingLightness, flatStops, hslToRgb, parseColor, rgbaString, type Rgba } from "./color";
import { useAppDark } from "./appearance";
import { NativeMaterialGrain, nativeGrain, NativeWindowMaterial, nativeWindowMaterial, type GrainTexture } from "./nativeMaterials";
import { finite, useFirstWindow } from "./shared";
import { grainCellOf } from "./grainCell";

const VIBRANCY = {
  dark: { material: [68.3 / 255, 68.0 / 255, 68.4 / 255], white: 0, alpha: 0.4, gradientOpacity: 0.5 },
  light: { material: [211.2 / 255, 206.7 / 255, 206.0 / 255], white: 1, alpha: 0.8, gradientOpacity: 0.75 },
};
const TINT_OVER_SYSTEM_MATERIAL = { dark: 0.15, light: 0.3 };
const DEFAULT_TINT: Rgba = [0.5, 0.5, 0.5, 1];
const DEFAULT_THEME_ANGLE = 135;
const OVERLAY_TURN = 45;
const PAD_CELLS = 16;
const THEME_REACH = 0.75;
const WINDOW_MATERIAL = "acrylic";
const DEFAULT_GRAIN_OPACITY = 0.09;

function underColor(dark: boolean, baseAlpha?: number): Rgba {
  const look = dark ? VIBRANCY.dark : VIBRANCY.light;
  const alpha = baseAlpha ?? look.alpha;
  const white = baseAlpha === undefined ? look.white : dark ? 0 : 1;
  const [r, g, b] = look.material.map((value) => white * alpha + value * (1 - alpha)) as [number, number, number];
  return [r, g, b, 1];
}

function tintOverMaterial(dark: boolean, baseAlpha?: number): Rgba {
  const white = dark ? 0 : 1;
  return [white, white, white, baseAlpha ?? TINT_OVER_SYSTEM_MATERIAL[dark ? "dark" : "light"]];
}

export type WindowBackdropColors = { fallback: Rgba; tint: Rgba; gradientOpacity: number };

export function windowBackdropColors(dark: boolean, baseAlpha?: number): WindowBackdropColors {
  return { fallback: underColor(dark, baseAlpha), tint: tintOverMaterial(dark, baseAlpha), gradientOpacity: (dark ? VIBRANCY.dark : VIBRANCY.light).gradientOpacity };
}

function MaterialBase({ dark, baseAlpha }: { dark: boolean; baseAlpha?: number }) {
  const colors = windowBackdropColors(dark, baseAlpha);
  const fallback = rgbaString(colors.fallback);
  if (!nativeWindowMaterial()) return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: fallback }]} />;
  return (
    <NativeWindowMaterial
      pointerEvents="none"
      material={WINDOW_MATERIAL}
      dark={dark}
      fallbackColor={fallback}
      tintColor={rgbaString(colors.tint)}
      style={StyleSheet.absoluteFill}
    />
  );
}

function ThemeLayers({ stops, angle, opacity }: { stops: Rgba[]; angle: number; opacity?: number }) {
  if (stops.length === 0) return null;
  const base = stops.slice(0, 2);
  const overlay = stops[2];
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      <Bands stops={base} angle={angle} span="base" reach={THEME_REACH} />
      {overlay ? <Bands stops={[[overlay[0], overlay[1], overlay[2], 0], overlay]} angle={angle + OVERLAY_TURN} span="corner" count={8} /> : null}
    </View>
  );
}

const unit = (value: unknown, fallback: number) => Math.min(1, Math.max(0, finite(value, fallback)));

const grainTexture = (texture: unknown): GrainTexture => (texture === "sand" || texture === "denim" || texture === "tweed" ? texture : "grain");

function Grain({ texture, amount, cellSize }: { texture: GrainTexture; amount: number; cellSize?: number }) {
  if (!(amount > 0) || !nativeGrain()) return null;
  return <NativeMaterialGrain pointerEvents="none" texture={texture} amount={amount} cellSize={cellSize} style={StyleSheet.absoluteFill} />;
}

const colorList = (colors: unknown): Rgba[] => (Array.isArray(colors) ? colors.map(parseColor).filter((stop): stop is Rgba => !!stop) : []);

export const WindowBackdrop = forwardRef<View, WindowBackdropProps>(function WindowBackdrop(
  {
    colors,
    vibrancy,
    tintColor,
    tintAlpha,
    tintLightness,
    angle,
    grainOpacity,
    grainScale,
    themeColors,
    themeOpacity,
    themeBaseAlpha,
    themeGrain,
    themeTexture,
    themeAppearance,
    themeAngle,
    style,
    children,
    ...rest
  },
  ref,
) {
  useFirstWindow();
  const appDark = useAppDark(undefined);
  const theme = useMemo(() => flatStops(themeColors), [themeColors]);
  const dark = theme.length > 0 && themeAppearance === "dark" ? true : theme.length > 0 && themeAppearance === "light" ? false : appDark;
  let layers;
  if (vibrancy === true) {
    const { gradientOpacity } = windowBackdropColors(dark);
    if (theme.length > 0) {
      layers = (
        <>
          <MaterialBase dark={dark} baseAlpha={Math.min(1, Math.max(0, finite(themeBaseAlpha, 0)))} />
          <ThemeLayers stops={theme} angle={finite(themeAngle, DEFAULT_THEME_ANGLE)} opacity={Math.min(1, Math.max(0, finite(themeOpacity, 1)))} />
          <Grain texture={grainTexture(themeTexture)} amount={unit(themeGrain, 0)} />
        </>
      );
    } else {
      const tint = parseColor(tintColor) ?? DEFAULT_TINT;
      const alpha = Math.min(1, Math.max(0, finite(tintAlpha, 0.36)));
      const lighter = adjustingLightness(tint, finite(tintLightness, 0.25));
      layers = (
        <>
          <MaterialBase dark={dark} />
          <Bands stops={[[tint[0], tint[1], tint[2], alpha], [lighter[0], lighter[1], lighter[2], alpha]]} opacity={gradientOpacity} count={12} />
        </>
      );
    }
  } else {
    const stops = colorList(colors);
    const ends = stops.length > 1 ? [stops[0]!, stops[stops.length - 1]!] : stops;
    layers = (
      <>
        <Bands stops={ends} angle={finite(angle, 180)} />
        <Grain texture="hash" amount={unit(grainOpacity, DEFAULT_GRAIN_OPACITY)} cellSize={grainCellOf(grainScale)} />
      </>
    );
  }
  return (
    <View {...rest} ref={ref} pointerEvents="none" style={style}>
      {layers}
      {children}
    </View>
  );
});

const ColorPad = memo(function ColorPad({ lightness }: { lightness: number }) {
  const rows = [];
  for (let y = 0; y < PAD_CELLS; y++) {
    const cells = [];
    for (let x = 0; x < PAD_CELLS; x++) {
      const dx = (x + 0.5) / PAD_CELLS - 0.5;
      const dy = (y + 0.5) / PAD_CELLS - 0.5;
      let hue = Math.atan2(dy, dx) / (2 * Math.PI);
      if (hue < 0) hue += 1;
      const saturation = Math.min(1, Math.hypot(dx, dy) / 0.5);
      const [r, g, b] = hslToRgb(hue, saturation, lightness);
      cells.push(<View key={x} style={{ flex: 1, backgroundColor: rgbaString([r, g, b, 1]) }} />);
    }
    rows.push(
      <View key={y} style={{ flex: 1, flexDirection: "row" }}>
        {cells}
      </View>,
    );
  }
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {rows}
    </View>
  );
});

export const ThemeSwatch = forwardRef<View, ThemeSwatchProps>(function ThemeSwatch({ colors, grain, texture, padLightness, angle, style, children, ...rest }, ref) {
  const stops = useMemo(() => flatStops(colors), [colors]);
  const pad = finite(padLightness, -1);
  return (
    <View {...rest} ref={ref} pointerEvents="none" style={style}>
      <ThemeLayers stops={stops} angle={finite(angle, DEFAULT_THEME_ANGLE)} />
      {pad >= 0 ? <ColorPad lightness={Math.min(1, pad)} /> : null}
      <Grain texture={grainTexture(texture)} amount={unit(grain, 0)} />
      {children}
    </View>
  );
});
