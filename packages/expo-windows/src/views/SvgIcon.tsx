import { createElement, forwardRef, type ComponentType } from "react";
import type { SvgIconProps } from "@ardia/shell";
import { StyleSheet, View, type ViewProps } from "react-native";
import { bodyElements, type VectorElement, type VectorIcon, type VectorLayer } from "../symbol/layers";
import { NativeVectorIcon, type NativeVectorIconProps } from "../symbol/nativeVectorIcon";
import { useAppDark } from "./appearance";
import { colorOrUndefined, finite } from "./shared";

const LABEL_COLOR = { light: "rgba(0, 0, 0, 0.85)", dark: "rgba(255, 255, 255, 0.85)" };
const DEFAULT_SIZE = 16;

type Matrix = readonly [number, number, number, number, number, number];

function compose(outer: Matrix, inner: Matrix): Matrix {
  const [a, b, c, d, e, f] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}

const numberAttr = (value: string | undefined, fallback: number) => {
  const parsed = value === undefined ? NaN : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function rootAttributes(svg: string): Record<string, string> {
  const match = svg.match(/<svg\b([^>]*)>/i);
  const attributes: Record<string, string> = {};
  for (const [, key, value] of (match?.[1] ?? "").matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g)) {
    attributes[key!] = value!;
  }
  return attributes;
}

function viewBoxOf(root: Record<string, string>): readonly [number, number, number, number] {
  const parts = (root.viewBox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  const width = numberAttr(root.width, DEFAULT_SIZE);
  const height = numberAttr(root.height, DEFAULT_SIZE);
  return [0, 0, width > 0 ? width : DEFAULT_SIZE, height > 0 ? height : DEFAULT_SIZE];
}

const cache = new Map<string, VectorIcon | null>();

function svgVectorIcon(svg: string, width: number, height: number): VectorIcon | null {
  const key = `svg|${width}x${height}|${svg}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const root = rootAttributes(svg);
  const [vx, vy, vw, vh] = viewBoxOf(root);
  const inner = svg.replace(/^[\s\S]*?<svg\b[^>]*>/i, "").replace(/<\/svg>[\s\S]*$/i, "");
  const elements = bodyElements(inner);
  if (!elements.length || !(width > 0) || !(height > 0)) {
    cache.set(key, null);
    return null;
  }
  const fit = Math.min(width / vw, height / vh);
  const rootMatrix: Matrix = [fit, 0, 0, fit, -(vx + vw / 2) * fit, -(vy + vh / 2) * fit];
  const rootFill = root.fill;
  const rootStroke = root.stroke;
  const rootStrokeWidth = numberAttr(root["stroke-width"], 1);
  const rootCap = root["stroke-linecap"] ?? "butt";
  const rootJoin = root["stroke-linejoin"] ?? "miter";
  const rootOpacity = numberAttr(root.opacity, 1);

  const resolved: VectorElement[] = elements.map((element) => {
    const a = element.attributes;
    const fillAttr = a.fill ?? rootFill;
    const strokeAttr = a.stroke ?? rootStroke;
    const hasFill = fillAttr !== undefined ? fillAttr !== "none" && fillAttr !== "transparent" : true;
    const hasStroke = strokeAttr !== undefined && strokeAttr !== "none" && strokeAttr !== "transparent";
    const strokeWidth = numberAttr(a["stroke-width"], rootStrokeWidth);
    const opacity = rootOpacity * numberAttr(a.opacity, 1);
    const full = compose(rootMatrix, element.transform);
    return {
      d: element.d,
      matrix: [...full],
      evenOdd: (a["fill-rule"] ?? root["fill-rule"]) === "evenodd",
      fill: hasFill ? opacity * numberAttr(a["fill-opacity"], 1) : 0,
      stroke: hasStroke && strokeWidth > 0 ? opacity * numberAttr(a["stroke-opacity"], 1) : 0,
      width: strokeWidth,
      cap: a["stroke-linecap"] ?? rootCap,
      join: a["stroke-linejoin"] ?? rootJoin,
      dashes: [],
      dashOffset: 0,
      maskFill: false,
      maskStroke: false,
      maskWidth: 0,
    };
  });
  const layers: VectorLayer[] = [{ draw: true, cut: false, elements: resolved }];
  const icon = { key, layers };
  cache.set(key, icon);
  return icon;
}

export const SvgIcon = forwardRef<unknown, SvgIconProps>(function SvgIcon({ svg, color, style, ...props }, ref) {
  const scheme = useAppDark(undefined) ? "dark" : "light";
  const flat = StyleSheet.flatten(style) ?? {};
  const width = finite(flat.width, DEFAULT_SIZE);
  const height = finite(flat.height, width);
  const icon = svg ? svgVectorIcon(svg, width, height) : null;
  if (!icon) return createElement(View as ComponentType<ViewProps & { ref?: unknown }>, { pointerEvents: "none", ...props, style, ref });
  return createElement(NativeVectorIcon as unknown as ComponentType<NativeVectorIconProps & { ref?: unknown }>, {
    pointerEvents: "none",
    ...props,
    style,
    ref,
    symbolKey: icon.key,
    layers: icon.layers,
    color: colorOrUndefined(color) ?? (scheme === "dark" ? LABEL_COLOR.dark : LABEL_COLOR.light),
  });
});

SvgIcon.displayName = "ArdiaSvgIcon";
