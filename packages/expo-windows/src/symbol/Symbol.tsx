import { createElement, forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { SymbolProps } from "@ardia/shell";
import { Animated, processColor, View, type ViewProps } from "react-native";
import { useAppDark } from "../views/appearance";
import * as NativeComponentRegistry from "react-native/Libraries/NativeComponent/NativeComponentRegistry";
import { noteMissing } from "../missing";
import { NATIVE_DEFAULT_POINT_SIZE, vectorIcon, type VectorLayer } from "./layers";
import { bounceScale, playBounce } from "./bounce";
import { playReplace, replaceStyles } from "./replace";

type NativeVectorIconProps = ViewProps & { symbolKey: string; layers: VectorLayer[]; color?: string };

const NativeVectorIcon = NativeComponentRegistry.get<NativeVectorIconProps>("ArdiaVectorIcon", () => ({
  uiViewClassName: "ArdiaVectorIcon",
  validAttributes: {
    symbolKey: true,
    layers: true,
    color: { process: processColor as (value: never) => unknown },
  },
}));

const AnimatedVectorIcon = Animated.createAnimatedComponent(NativeVectorIcon as unknown as ComponentType<NativeVectorIconProps>);

function useBounce(bounce: number | undefined) {
  const progress = useRef(new Animated.Value(1)).current;
  const played = useRef(bounce);
  useEffect(() => {
    if (bounce === played.current) return;
    played.current = bounce;
    playBounce(progress);
  }, [bounce, progress]);
  const scale = useMemo(() => bounceScale(progress), [progress]);
  return bounce === undefined ? null : scale;
}

type Ghost = { key: string; layers: VectorLayer[]; calm: boolean };

function useReplace(icon: { key: string; layers: VectorLayer[] } | null, replace: boolean | undefined) {
  const incoming = useRef(new Animated.Value(1)).current;
  const outgoing = useRef(new Animated.Value(1)).current;
  const shown = useRef(icon);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = icon;
    if (!replace || !was || !icon || was.key === icon.key) return;
    const calm = playReplace(incoming, outgoing, () => setGhost((current) => (current?.key === was.key ? null : current)));
    setGhost({ key: was.key, layers: was.layers, calm });
  }, [icon?.key, replace]);
  const styles = useMemo(() => replaceStyles(incoming, outgoing, ghost?.calm ?? false), [incoming, outgoing, ghost?.calm]);
  return { ghost, styles };
}

const FILL = { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 } as const;

const LABEL_COLOR = { light: "rgba(0, 0, 0, 0.85)", dark: "rgba(255, 255, 255, 0.85)" };

export const Symbol = forwardRef<unknown, SymbolProps>(function Symbol({ name, size = NATIVE_DEFAULT_POINT_SIZE, weight = "regular", color, bounce, replace, ...props }, ref) {
  const scheme = useAppDark(undefined) ? "dark" : "light";
  const scale = useBounce(bounce);
  const icon = vectorIcon(name, size, weight);
  const { ghost, styles } = useReplace(icon, replace);
  useEffect(() => {
    if (!icon) noteMissing(`symbol ${name}`);
  }, [icon, name]);
  if (!icon) return createElement(View as ComponentType<ViewProps & { ref?: unknown }>, { pointerEvents: "none", ...props, ref });
  const ink = color ?? (scheme === "dark" ? LABEL_COLOR.dark : LABEL_COLOR.light);
  if (replace) {
    const bounced = scale ? [{ scale }] : [];
    return createElement(
      View as ComponentType<ViewProps & { ref?: unknown }>,
      { pointerEvents: "none", ...props, ref },
      ghost ? createElement(AnimatedVectorIcon as unknown as ComponentType<NativeVectorIconProps & { style?: unknown }>, { key: ghost.key, pointerEvents: "none", style: [FILL, styles.outgoing], symbolKey: ghost.key, layers: ghost.layers, color: ink }) : null,
      createElement(AnimatedVectorIcon as unknown as ComponentType<NativeVectorIconProps & { style?: unknown }>, {
        key: "glyph",
        pointerEvents: "none",
        style: [FILL, { opacity: styles.incoming.opacity, transform: [...bounced, ...styles.incoming.transform] }],
        symbolKey: icon.key,
        layers: icon.layers,
        color: ink,
      }),
    );
  }
  return createElement((scale ? AnimatedVectorIcon : NativeVectorIcon) as unknown as ComponentType<NativeVectorIconProps & { ref?: unknown }>, {
    pointerEvents: "none",
    ...props,
    style: scale ? [props.style, { transform: [{ scale }] }] : props.style,
    ref,
    symbolKey: icon.key,
    layers: icon.layers,
    color: ink,
  });
});

Symbol.displayName = "ArdiaSymbol";
