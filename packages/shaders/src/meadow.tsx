import { requireNativeViewManager } from "expo-modules-core";
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import type { MeadowProps, MeadowTone } from "./index";

type NativeMeadowProps = ViewProps & { night: boolean; creeper?: boolean; onTone?: (event: { nativeEvent: MeadowTone }) => void; onReady?: () => void; onBoom?: () => void };

let NativeMeadow: ComponentType<NativeMeadowProps> | null = null;

export function Meadow({ onTone, intro: _drawnByTheApp, onIntro: _neverSent, ...props }: MeadowProps) {
  NativeMeadow ??= requireNativeViewManager<NativeMeadowProps>("ArdiaMeadow");
  return <NativeMeadow pointerEvents="none" {...props} onTone={onTone ? (event) => onTone(event.nativeEvent) : undefined} />;
}
