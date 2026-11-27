import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";
import { useBrowser } from "../../../../../apps/browser/src/state/browser/store";
import { useScopedTheme } from "../../../../../apps/browser/src/components/ui/theme";
import { materialFill } from "./materials";
import type { MiddleClickEvent } from "./MouseArea";
import { LiquidGlassLayer } from "./liquidGlass";
import { backdropKeyOf, DOCK_GLASS, glassGlow } from "./liquidGlassOptics";
import { edgeGain, fallbackRadius, highlightMask, maskStyle, peakGain, shapeMask, type RimCurve, type RimProfile, type ShadeProfile } from "./glassRim";

type Style = ViewStyle & Record<string, unknown>;


export function parseColor(color: string): [number, number, number, number] | null {
  const hex = color.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) {
    const v = parseInt(hex[1]!, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, hex[2] ? parseInt(hex[2], 16) / 255 : 1];
  }
  const fn = color.match(/rgba?\(([^)]+)\)/);
  if (!fn) return null;
  const [r = 0, g = 0, b = 0, a = 1] = fn[1]!.split(",").map((v) => Number(v.trim()));
  return [r, g, b, a];
}

export const rgbaString = ([r, g, b, a]: [number, number, number, number]) => `rgba(${r},${g},${b},${+a.toFixed(4)})`;

function withOpacity(color: string, opacity: number) {
  const c = parseColor(color);
  return c ? rgbaString([c[0], c[1], c[2], c[3] * opacity]) : color;
}

export type SurfaceProps = ViewProps & {
  fill?: string;
  fillColors?: string[];
  fillStops?: number[];
  fade?: number[];
  fadeStops?: number[];
  cornerRadius?: number;
  borderColor?: string;
  borderWidth?: number;
  borderColors?: string[];
  shadowColor?: string;
  shadowOpacity?: number;
  shadowRadius?: number;
  shadowOffset?: [number, number];
};

const CA_SHADOW_BLUR = 2;

export function Surface({ fill, fillColors, fillStops, fade, fadeStops, cornerRadius = 0, borderColor, borderWidth = 0, borderColors, shadowColor: color, shadowOpacity = 0, shadowRadius = 0, shadowOffset, style, children, ...props }: SurfaceProps) {
  const gradientBorder = !!borderColors && borderColors.length >= 2 && borderWidth > 0;
  const surface: Style = {
    backgroundColor: fill,
    borderRadius: cornerRadius,
    ...(borderColor && borderWidth > 0 && !gradientBorder ? { borderColor, borderWidth, borderStyle: "solid" } : {}),
  };
  if (fillColors && fillColors.length >= 2) {
    const placed = fillStops?.length === fillColors.length;
    surface.backgroundImage = `linear-gradient(to bottom, ${fillColors.map((c, i) => (placed ? `${c} ${fillStops![i]! * 100}%` : c)).join(", ")})`;
  }
  if (fade && fade.length >= 2) {
    const at = fadeStops?.length === fade.length ? fadeStops : null;
    const mask = `linear-gradient(to right, ${fade.map((a, i) => `rgba(0,0,0,${a})${at ? ` ${at[i]! * 100}%` : ""}`).join(", ")})`;
    surface.maskImage = mask;
    surface.WebkitMaskImage = mask;
  }
  if (color && shadowOpacity > 0) {
    const [x, y] = shadowOffset ?? [0, 0];
    surface.boxShadow = `${x}px ${y}px ${shadowRadius * CA_SHADOW_BLUR}px ${withOpacity(color, shadowOpacity)}`;
  }
  return (
    <View {...props} style={[surface, style]}>
      {gradientBorder ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            borderRadius: cornerRadius,
            border: `${borderWidth}px solid transparent`,
            background: `linear-gradient(to bottom, ${borderColors!.join(", ")}) border-box`,
            mask: "linear-gradient(#000 0 0) padding-box exclude, linear-gradient(#000 0 0) border-box",
            WebkitMask: "linear-gradient(#000 0 0) padding-box, linear-gradient(#000 0 0) border-box",
            WebkitMaskComposite: "xor",
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

export function useSurfaceDark(): boolean {
  const appDark = useBrowser((s) => s.ui.appDark);
  return useScopedTheme()?.dark ?? appDark;
}

export type VisualEffectProps = ViewProps & { material?: string; blendingMode?: "withinWindow" | "behindWindow"; cornerRadius?: number };

export function VisualEffect({ material = "popover", cornerRadius, style, ...props }: VisualEffectProps) {
  const fill = materialFill(material, useSurfaceDark());
  const glass: Style = {
    backgroundColor: fill,
    backdropFilter: "blur(24px) saturate(180%)",
    WebkitBackdropFilter: "blur(24px) saturate(180%)",
    borderRadius: cornerRadius,
    overflow: cornerRadius ? "hidden" : undefined,
  };
  return <View {...props} style={[glass, style]} />;
}

export type GlassEffectProps = ViewProps & { cornerRadius?: number; tint?: string; glassStyle?: "regular" | "clear"; dark?: boolean };

type GlassLook = { saturate: number; slope: number; offset: number; rim: RimProfile; shade: ShadeProfile };

const RIM_ANGLES = [0, 1, 8.5, 25, 45, 65, 81.5, 89, 90];
const RIM_DEPTHS = [0, 0.25, 0.75, 1.25, 1.75];
const GLOW_BY_ANGLE: RimCurve = [[0, 1], [5, 0.9], [10, 0.8], [20, 0.7], [35, 0.6], [90, 0.6]];

const GLASS: { light: GlassLook; dark: GlassLook } = {
  light: {
    saturate: 1.8705,
    slope: 0.6098,
    offset: 98.2,
    rim: {
      angles: RIM_ANGLES,
      depths: RIM_DEPTHS,
      gains: [
        [0.42, 0.42, 0.16, 0, 0],
        [0.16, 0.16, 0.13, 0, 0],
        [0.16, 0.16, 0.12, 0, 0],
        [0.1, 0.105, 0.04, 0, 0],
        [0.085, 0.088, 0.03, 0, 0],
        [0.11, 0.114, 0.033, 0, 0],
        [0.03, 0.03, 0.045, 0.025, 0.01],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ],
      glow: [[0, 0.14], [1.25, 0.14], [1.75, 0.12], [2.25, 0.1], [2.75, 0.09], [3.25, 0.08], [3.75, 0.07], [4.25, 0.06], [5, 0.05], [6, 0.03], [7, 0.015], [8, 0]],
      glowByAngle: GLOW_BY_ANGLE,
    },
    shade: {
      line: [[0, 1], [0.45, 1], [0.6, 0]],
      byAngle: [[0, 0.1], [8.5, 0.1], [25, 0.13], [45, 0.16], [65, 0.19], [81.5, 0.22], [89, 0.27], [90, 0.29]],
    },
  },
  dark: {
    saturate: 1.2652,
    slope: 0.8684,
    offset: 32.48,
    rim: {
      angles: RIM_ANGLES,
      depths: RIM_DEPTHS,
      gains: [
        [0.55, 0.55, 0.26, 0, 0],
        [0.22, 0.22, 0.2, 0, 0],
        [0.18, 0.18, 0.18, 0, 0],
        [0.16, 0.168, 0.05, 0, 0],
        [0.18, 0.186, 0.065, 0, 0],
        [0.106, 0.107, 0.039, 0, 0],
        [0, 0, 0.05, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ],
      glow: [[0, 0.14], [1.25, 0.14], [1.75, 0.11], [2.25, 0.09], [2.75, 0.07], [3.25, 0.05], [3.75, 0.04], [4.25, 0.03], [5, 0.02], [6, 0.01], [7, 0]],
      glowByAngle: GLOW_BY_ANGLE,
    },
    shade: {
      line: [[0, 1], [0.45, 1], [0.6, 0]],
      byAngle: [[0, 0], [8.5, 0.02], [25, 0.02], [45, 0.1], [65, 0.15], [81.5, 0.33], [89, 0.47], [90, 0.51]],
    },
  },
};

function glassFilter(saturate: number, slope: number, offset: number) {
  const brightness = slope + (2 * offset) / 255;
  return `saturate(${saturate}) contrast(${(slope / brightness).toFixed(5)}) brightness(${brightness.toFixed(5)})`;
}

function fallbackBands(rim: RimProfile) {
  const peak = peakGain(rim);
  const stops = rim.glow.map(([d]) => [d, edgeGain(rim, d) / peak] as const);
  const top = stops.map(([at, alpha]) => `rgba(0,0,0,${alpha.toFixed(3)}) ${at}px`).join(", ");
  const bottom = [...stops].reverse().map(([at, alpha]) => `rgba(0,0,0,${alpha.toFixed(3)}) calc(100% - ${at}px)`).join(", ");
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}

const layer: React.CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };

function backdrop(filter: string, extra?: Record<string, string>): React.CSSProperties {
  return { ...layer, backdropFilter: filter, WebkitBackdropFilter: filter, ...extra };
}

function inScrollView(node: Element | null) {
  for (let a = node?.parentElement; a; a = a.parentElement) {
    if (a.hasAttribute("data-ardia-wheel-area")) return true;
    const overflow = getComputedStyle(a).overflowY;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

function scrolledGlassSurface(theme: "light" | "dark", clear: boolean, cornerRadius: number): React.CSSProperties {
  const dark = theme === "dark";
  return {
    ...layer,
    borderRadius: fallbackRadius(cornerRadius),
    background: dark
      ? clear
        ? "linear-gradient(to bottom, rgba(255,255,255,0.09), rgba(255,255,255,0.04))"
        : "linear-gradient(to bottom, rgba(255,255,255,0.14), rgba(255,255,255,0.07))"
      : clear
        ? "linear-gradient(to bottom, rgba(255,255,255,0.44), rgba(255,255,255,0.24))"
        : "linear-gradient(to bottom, rgba(255,255,255,0.68), rgba(255,255,255,0.42))",
    boxShadow: dark
      ? "inset 0 1px 0.5px rgba(255,255,255,0.2), inset 0 0 0 0.5px rgba(255,255,255,0.1), 0 1px 3px rgba(0,0,0,0.26)"
      : "inset 0 1px 0.5px rgba(255,255,255,0.82), inset 0 0 0 0.5px rgba(255,255,255,0.48), 0 1px 3px rgba(0,0,0,0.07)",
  };
}

export function GlassEffect({ cornerRadius = 0, tint, glassStyle = "regular", dark, style, children, ...props }: GlassEffectProps) {
  const surfaceDark = useSurfaceDark();
  const theme = (dark ?? surfaceDark) ? "dark" : "light";
  const g = GLASS[theme];
  const clear = glassStyle === "clear";
  const filter = clear ? glassFilter(1, (1 + g.slope) / 2, g.offset / 2) : glassFilter(g.saturate, g.slope, g.offset);
  const backdropKey = backdropKeyOf(useScopedTheme()?.backdrop, theme === "dark");
  const host = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState<boolean | null>(null);
  useLayoutEffect(() => setScrolled(inScrollView(host.current)), []);
  const { opacity, ...rest } = StyleSheet.flatten(style) ?? {};
  const fade: React.CSSProperties = opacity === undefined ? {} : { opacity: Number(opacity) };
  if (scrolled) {
    const radiusStyle: React.CSSProperties = { borderRadius: fallbackRadius(cornerRadius) };
    return (
      <View pointerEvents="none" {...props} style={rest}>
        <div ref={host} style={{ ...scrolledGlassSurface(theme, clear, cornerRadius), ...fade }}>
          {tint ? <div style={{ ...layer, ...radiusStyle, background: tint }} /> : null}
        </div>
        {children}
      </View>
    );
  }
  const highlight = highlightMask(cornerRadius, g.rim, theme);
  const shape = shapeMask(cornerRadius);
  const clip: React.CSSProperties = shape ? {} : { borderRadius: fallbackRadius(cornerRadius), overflow: "hidden" };
  const shaped = shape ? maskStyle(shape) : {};
  const fallback = (
    <div style={{ ...layer, ...clip }}>
      <div style={backdrop(filter, shaped)} />
      {tint ? <div style={{ ...layer, ...shaped, background: tint }} /> : null}
      <div style={backdrop(`brightness(${1 + peakGain(g.rim)})`, highlight ? maskStyle(highlight) : { mask: fallbackBands(g.rim), WebkitMask: fallbackBands(g.rim) })} />
    </div>
  );
  return (
    <View pointerEvents="none" {...props} style={rest}>
      <LiquidGlassLayer
        hostRef={(node) => void (host.current = node)}
        theme={theme}
        glassStyle={glassStyle}
        cornerRadius={cornerRadius}
        radius={fallbackRadius(cornerRadius)}
        tint={tint}
        opacity={opacity === undefined ? undefined : Number(opacity)}
        enabled={scrolled === false}
        backdropKey={backdropKey}
        fallback={fallback}
      />
      {children}
    </View>
  );
}

export function GlassGroup({ strength: _strength, ...props }: ViewProps & { strength?: number }) {
  return <View {...props} />;
}

export type ContextMenuAreaProps = ViewProps & { onContextMenu?: () => void; onMiddleClick?: (e: MiddleClickEvent) => void; captureDescendants?: boolean };

type WebMenuProps = ViewProps & { onContextMenu?: (e: MouseEvent) => void; onAuxClick?: (e: MouseEvent) => void; onMouseDown?: (e: MouseEvent) => void };

export function ContextMenuArea({ onContextMenu, onMiddleClick, captureDescendants: _capture, ...props }: ContextMenuAreaProps) {
  const WebView = View as unknown as React.ComponentType<WebMenuProps>;
  return (
    <WebView
      {...props}
      onMouseDown={(e) => {
        if (e.button === 1 && onMiddleClick) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1 || !onMiddleClick) return;
        e.preventDefault();
        e.stopPropagation();
        onMiddleClick({ shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
      }}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu();
      }}
    />
  );
}

export function OutsidePressArea({ onOutsidePress, ...props }: ViewProps & { onOutsidePress?: (event: { nativeEvent: { timestamp?: number } }) => void; children?: ReactNode }) {
  const node = useRef<HTMLElement | null>(null);
  const latest = useRef(onOutsidePress);
  latest.current = onOutsidePress;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (node.current && e.target instanceof Node && !node.current.contains(e.target)) latest.current?.({ nativeEvent: { timestamp: e.timeStamp } });
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);
  return <View {...props} ref={(view) => void (node.current = view as unknown as HTMLElement | null)} />;
}

export function WindowDragRegion({
  titleBarDoubleClick: _double,
  clickable: _clickable,
  onRegionClick,
  onRegionDoubleClick,
  ...props
}: ViewProps & { titleBarDoubleClick?: boolean; clickable?: boolean; onRegionClick?: () => void; onRegionDoubleClick?: () => void }) {
  const Region = View as unknown as React.ComponentType<ViewProps & { onClick?: () => void; onDoubleClick?: () => void }>;
  return <Region {...props} onClick={onRegionClick} onDoubleClick={onRegionDoubleClick} />;
}

export type DockSelectionProps = ViewProps & { image?: string; emoji?: string; theme?: string; fill?: string; stroke?: string; cornerRadius?: number; strokeWidth?: number; iconSize?: number; dark: boolean; glass?: boolean; colorRing?: boolean; outline?: boolean };

const BLURRED_ICON_SPREAD = 250;
const BLURRED_ICON_BLUR = { glow: 10, ring: 6 };

function BlurredFavicon({ image, blur }: { image: string; blur: number }) {
  return <img alt="" aria-hidden draggable={false} src={image} style={{ position: "absolute", left: "50%", top: "50%", width: `${BLURRED_ICON_SPREAD}%`, height: `${BLURRED_ICON_SPREAD}%`, transform: "translate(-50%, -50%)", objectFit: "contain", filter: `blur(${blur}px) saturate(1.8)`, pointerEvents: "none" }} />;
}

export function DockSelection({ fill, stroke, cornerRadius, strokeWidth, dark, glass, colorRing, outline, image, emoji: _emoji, theme, iconSize: _iconSize, style, ...props }: DockSelectionProps & Record<string, unknown>) {
  if (!glass) return <View {...props} style={[{ backgroundColor: outline ? undefined : fill, borderColor: stroke, borderWidth: stroke ? (strokeWidth ?? 1) : 0, borderRadius: cornerRadius }, style]} />;
  const look = dark ? "dark" : "light";
  const blurred = theme === "blur" && image ? image : null;
  const glow = outline || !fill || blurred ? null : glassGlow(parseColor(fill));
  const ringWidth = colorRing ? (strokeWidth ?? 1) : 0;
  const shape: React.CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none", borderRadius: cornerRadius, overflow: "hidden" };
  const ring: React.CSSProperties = { ...shape, boxSizing: "border-box", padding: ringWidth, mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", maskComposite: "exclude", WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite: "xor" };
  return (
    <View pointerEvents="none" {...props} style={[{ borderRadius: cornerRadius }, style]}>
      {glow ? <div style={{ ...shape, background: glow, opacity: DOCK_GLASS.hue[look] }} /> : null}
      {blurred && !outline ? <div style={{ ...shape, opacity: DOCK_GLASS.hue[look] }}><BlurredFavicon image={blurred} blur={BLURRED_ICON_BLUR.glow} /></div> : null}
      {outline ? null : <div style={{ ...shape, background: `linear-gradient(to bottom, rgba(255,255,255,${DOCK_GLASS.sheen[look]}), rgba(255,255,255,0) ${DOCK_GLASS.sheenEnd}%)` }} />}
      {ringWidth > 0 && blurred && !stroke ? <div style={ring}><BlurredFavicon image={blurred} blur={BLURRED_ICON_BLUR.ring} /></div> : null}
      {ringWidth > 0 && !(blurred && !stroke) ? <div style={{ ...shape, boxSizing: "border-box", border: `${ringWidth}px solid ${stroke ?? `rgba(255,255,255,${DOCK_GLASS.ring[look]})`}`, mixBlendMode: stroke ? undefined : "soft-light" }} /> : null}
    </View>
  );
}
