import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { View } from "react-native";
import type { MeadowProps, PowerUpProps, ThemeSwatchProps, WindowBackdropProps } from "@ardia-real/shaders";
import { useBrowser } from "../../../browser/src/state/browser/store";
import { prefersReducedMotion } from "./web/gl/clock";
import { parseHex } from "./web/gl/colors";
import { GLView } from "./web/gl/GLView";
import { backdropFragment, haloFragment, powerUpFragment } from "./web/gl/sources";
import { webgl2Supported } from "./web/gl/surface";
import { backdropUniforms, HALO, haloUniforms, POWER_UP, powerUpPalette, powerUpUniforms } from "./web/gl/uniforms";
import { BackdropFallback, HaloFallback, PowerUpFallback } from "./web/gl/fallbacks";
import { Vibrancy } from "./web/gl/Vibrancy";
import { mountMeadow, type MeadowScene } from "./web/gl/meadow";
import { baseLine, baseStops, GRAIN_POINTS, GRAIN_SIDE, grainAlpha, overlayLine, overlayStops, padLayers, stopCss, swatchColors, type SwatchLine, type SwatchStop } from "./web/gl/themeSwatch";
import { usePageHoleLayer } from "../shellAbove";
import { useSurfaceDark } from "./web/chrome";

export * from "@ardia-real/shaders";

const FRAME = 1 / 60;

export function WindowBackdrop({ colors, angle = 180, grainOpacity = 0.09, grainScale = 1, vibrancy, tintColor, tintAlpha, tintLightness, style }: WindowBackdropProps) {
  const dark = useSurfaceDark();
  const key = `${colors.join()}|${angle}|${grainOpacity}|${grainScale}`;
  const uniformsAt = useMemo(() => (css: [number, number]) => backdropUniforms({ colors, angle, grainOpacity, grainScale }, css), [key]);
  const layer = useRef<View & HTMLElement>(null);
  usePageHoleLayer(layer);
  return (
    <View ref={layer} pointerEvents="none" style={style}>
      {vibrancy ? (
        <Vibrancy dark={dark} tintColor={tintColor} tintAlpha={tintAlpha} tintLightness={tintLightness} />
      ) : webgl2Supported() ? (
        <GLView fragment={backdropFragment} uniformsAt={uniformsAt} version={key} />
      ) : (
        <BackdropFallback colors={colors} angle={angle} />
      )}
    </View>
  );
}

export function PowerUp({ palette = "pink", speed = POWER_UP.defaultSpeed, origin = POWER_UP.defaultOrigin, cornerRadius = POWER_UP.defaultCornerRadius, halo = null, style }: PowerUpProps) {
  const dark = useBrowser((s) => s.ui.appDark);
  const [reduceMotion] = useState(prefersReducedMotion);
  const paletteKey = typeof palette === "string" ? palette : palette.join();
  const srgb = useMemo(() => powerUpPalette(palette), [paletteKey]);
  const powerUpAt = useMemo(() => (_css: [number, number], time: number) => powerUpUniforms({ srgb, speed, origin }, time), [srgb, speed, origin]);
  const haloAt = useMemo(
    () => (css: [number, number], time: number) => haloUniforms({ srgb, speed, cornerRadius, dark }, css, time),
    [srgb, speed, cornerRadius, dark],
  );
  if (reduceMotion) return <View pointerEvents="none" style={style} />;
  const gl = webgl2Supported();
  const haloBox = halo && halo.width > 0 && halo.height > 0
    ? { left: halo.x - HALO.inset, top: halo.y - HALO.inset, width: halo.width + 2 * HALO.inset, height: halo.height + 2 * HALO.inset }
    : null;
  return (
    <View pointerEvents="none" style={style}>
      {gl ? (
        <GLView fragment={powerUpFragment} uniformsAt={powerUpAt} animation={{ lastFrameTime: POWER_UP.finishTime - FRAME }} style={{ filter: "blur(24px)" }} />
      ) : (
        <PowerUpFallback srgb={srgb} speed={speed} />
      )}
      {haloBox ? (
        <div style={{ position: "absolute", pointerEvents: "none", ...haloBox }}>
          {gl ? (
            <GLView fragment={haloFragment} uniformsAt={haloAt} animation={{ lastFrameTime: HALO.finishTime }} />
          ) : (
            <HaloFallback color={srgb[0] ?? parseHex("#FF845A")!} speed={speed} cornerRadius={cornerRadius + 2} dark={dark} />
          )}
        </div>
      ) : null}
    </View>
  );
}

const SWATCH_FILL: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" };
const grainTiles = new Map<string, string | null>();

function grainTile(texture: string): string | null {
  const cached = grainTiles.get(texture);
  if (cached !== undefined) return cached;
  let tile: string | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = GRAIN_SIDE;
    const context = canvas.getContext("2d");
    if (context) {
      const image = context.createImageData(GRAIN_SIDE, GRAIN_SIDE);
      image.data.set(grainAlpha(texture));
      context.putImageData(image, 0, 0);
      tile = canvas.toDataURL("image/png");
    }
  } catch {
    tile = null;
  }
  grainTiles.set(texture, tile);
  return tile;
}

function SwatchGradient({ id, line, stops }: { id: string; line: SwatchLine; stops: SwatchStop[] }) {
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" {...line}>
      {stops.map(({ offset, color }) => {
        const css = stopCss(color);
        return <stop key={offset} offset={offset} stopColor={css.color} stopOpacity={css.opacity} />;
      })}
    </linearGradient>
  );
}

export function ThemeSwatch({ colors, grain = 0, texture = "grain", padLightness = -1, angle = 135, style }: ThemeSwatchProps) {
  const id = useId();
  const layer = useRef<View & HTMLElement>(null);
  const [size, setSize] = useState<[number, number]>([1, 1]);
  useLayoutEffect(() => {
    const node = layer.current;
    if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      setSize((current) => (current[0] === width && current[1] === height ? current : [width, height]));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const key = colors.join();
  const parsed = useMemo(() => swatchColors(colors), [key]);
  const base = useMemo(() => baseStops(parsed), [parsed]);
  const overlay = useMemo(() => overlayStops(parsed), [parsed]);
  const pad = padLightness < 0 ? null : padLayers(padLightness);
  const grainOpacity = Math.min(Math.max(grain, 0), 1);
  const tile = grainOpacity > 0 ? grainTile(texture) : null;
  return (
    <View ref={layer} pointerEvents="none" style={[{ overflow: "hidden" }, style]}>
      {base.length ? (
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={SWATCH_FILL}>
          <defs>
            <SwatchGradient id={`${id}b`} line={baseLine(size[0], size[1], angle)} stops={base} />
            {overlay.length ? <SwatchGradient id={`${id}o`} line={overlayLine(size[0], size[1], angle)} stops={overlay} /> : null}
          </defs>
          <rect width="1" height="1" fill={`url(#${id}b)`} />
          {overlay.length ? <rect width="1" height="1" fill={`url(#${id}o)`} /> : null}
        </svg>
      ) : null}
      {pad ? <div style={{ ...SWATCH_FILL, backgroundImage: `${pad.centre}, ${pad.wheel}` }} /> : null}
      {tile ? <div style={{ ...SWATCH_FILL, opacity: grainOpacity, backgroundImage: `url(${tile})`, backgroundSize: `${GRAIN_POINTS}px ${GRAIN_POINTS}px`, imageRendering: "pixelated" }} /> : null}
    </View>
  );
}

export function Meadow({ night, onTone, style }: MeadowProps) {
  const layer = useRef<View & HTMLElement>(null);
  const scene = useRef<MeadowScene | null>(null);
  const toneHandler = useRef(onTone);
  toneHandler.current = onTone;
  useEffect(() => {
    const node = layer.current;
    if (!node) return;
    const mounted = mountMeadow(node, { night, reduceMotion: prefersReducedMotion(), onTone: (tone) => toneHandler.current?.(tone) });
    scene.current = mounted;
    return () => {
      scene.current = null;
      mounted.dispose();
    };
  }, []);
  useEffect(() => scene.current?.setNight(night), [night]);
  return <View ref={layer} pointerEvents="none" style={[{ overflow: "hidden" }, style]} />;
}
