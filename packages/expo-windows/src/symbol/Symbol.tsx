import { createElement, forwardRef, useEffect, type ComponentType } from "react";
import type { SymbolProps } from "@ardia/shell";
import { View, type ViewProps } from "react-native";
import { useAppDark } from "../views/appearance";
import { noteMissing } from "../missing";
import { NATIVE_DEFAULT_POINT_SIZE, vectorIcon } from "./layers";
import { NativeVectorIcon, type NativeVectorIconProps } from "./nativeVectorIcon";

const LABEL_COLOR = { light: "rgba(0, 0, 0, 0.85)", dark: "rgba(255, 255, 255, 0.85)" };

export const Symbol = forwardRef<unknown, SymbolProps>(function Symbol({ name, size = NATIVE_DEFAULT_POINT_SIZE, weight = "regular", color, ...props }, ref) {
  const scheme = useAppDark(undefined) ? "dark" : "light";
  const icon = vectorIcon(name, size, weight);
  useEffect(() => {
    if (!icon) noteMissing(`symbol ${name}`);
  }, [icon, name]);
  if (!icon) return createElement(View as ComponentType<ViewProps & { ref?: unknown }>, { pointerEvents: "none", ...props, ref });
  return createElement(NativeVectorIcon as unknown as ComponentType<NativeVectorIconProps & { ref?: unknown }>, {
    pointerEvents: "none",
    ...props,
    ref,
    symbolKey: icon.key,
    layers: icon.layers,
    color: color ?? (scheme === "dark" ? LABEL_COLOR.dark : LABEL_COLOR.light),
  });
});

Symbol.displayName = "ArdiaSymbol";
