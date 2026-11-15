import { createElement, type ComponentType, type ReactNode } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import { usePageCover } from "../../../expo-windows/src/engine/usePageCover";

type Covering = ViewProps & { cornerRadius?: number; children?: ReactNode };

const NO_FORWARDED_REF = undefined;

export function coveringPages<Props extends Covering>(Drawn: ComponentType<Props>, name: string): ComponentType<Props> {
  function Covered(props: Props) {
    const radius = typeof props.cornerRadius === "number" && props.cornerRadius > 0 ? props.cornerRadius : 0;
    const cover = usePageCover<View>(NO_FORWARDED_REF, undefined, radius);
    const marker = createElement(View, { key: "cover", ref: cover.ref, onLayout: cover.onLayout, pointerEvents: "none", style: StyleSheet.absoluteFill });
    return createElement(Drawn, props, marker, cover.within(props.children));
  }
  Covered.displayName = name;
  return Covered;
}
