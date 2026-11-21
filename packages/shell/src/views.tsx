import { requireNativeViewManager } from "expo-modules-core";
import type { ViewProps } from "react-native";
import { nativeModule } from "./nativeModules";
import type { MiddleClickEvent } from "./system";
import type { PluginPageProps } from "./plugins";

export type WindowProfileSwapped = { selection?: string; switchId?: number; profileLoaded?: boolean; activeMs?: number; swapMs?: number; heldTimedOut?: boolean };
export type WindowProfileProps = ViewProps & {
  profile: string;
  selection?: string;
  switchId?: number;
  neighbours: string[];
  onSwapped?: (event: { nativeEvent: WindowProfileSwapped }) => void;
};
export const WindowProfile = requireNativeViewManager<WindowProfileProps>("ArdiaWindowProfile");

export type WindowDragRegionProps = ViewProps & {
  titleBarDoubleClick?: boolean;
  onRegionDoubleClick?: () => void;
  clickable?: boolean;
  onRegionClick?: () => void;
};

export const WindowDragRegion = requireNativeViewManager<WindowDragRegionProps>("ArdiaAppWindows");

export type OutsidePressAreaProps = ViewProps & { onOutsidePress?: (event: { nativeEvent: { timestamp?: number } }) => void };

export const OutsidePressArea = requireNativeViewManager<OutsidePressAreaProps>("ArdiaOutsidePressArea");

export type SymbolProps = ViewProps & {
  name: string;
  size?: number;
  weight?: "light" | "regular" | "medium" | "semibold" | "bold";
  color?: string;
};

export const Symbol = requireNativeViewManager<SymbolProps>("ArdiaSymbol");

export type FadeLabelProps = ViewProps & {
  text: string;
  fontSize?: number;
  weight?: "ultraLight" | "thin" | "light" | "regular" | "medium" | "semibold" | "bold" | "heavy" | "black";
  fontFamily?: string;
  color?: string;
  fadeWidth?: number;
  strikethrough?: boolean;
};

export const FadeLabel = requireNativeViewManager<FadeLabelProps>("ArdiaFadeLabel");

export type EdgeFadeMaskProps = ViewProps & { fadeWidth: number; floor: number; onset: number };

export const EdgeFadeMask = requireNativeViewManager<EdgeFadeMaskProps>("ArdiaEdgeFadeMask");

export type ActivitySpinnerProps = ViewProps;

export const ActivitySpinner = requireNativeViewManager<ActivitySpinnerProps>("ArdiaActivitySpinner");

export type FolderIconProps = ViewProps & {
  open: boolean;
  stroke?: string;
  face?: string;
  insideTop?: string;
  insideBottom?: string;
};

export const FolderIcon = requireNativeViewManager<FolderIconProps>("ArdiaFolderIcon");

export type ContextMenuAreaProps = ViewProps & {
  onContextMenu?: () => void;
  onMiddleClick?: (e: MiddleClickEvent) => void;
  captureDescendants?: boolean;
};

export type NativeContextMenuAreaProps = Omit<ContextMenuAreaProps, "onContextMenu" | "onMiddleClick"> & {
  onContextMenu?: (event: { nativeEvent: Record<string, never> }) => void;
  middleClicks: boolean;
  onMiddleClick?: (e: { nativeEvent: MiddleClickEvent }) => void;
};

const NativeContextMenuArea = requireNativeViewManager<NativeContextMenuAreaProps>("ArdiaContextMenuArea");

export function ContextMenuArea({ onMiddleClick, ...props }: ContextMenuAreaProps) {
  return <NativeContextMenuArea middleClicks={!!onMiddleClick} onMiddleClick={onMiddleClick && ((e) => onMiddleClick(e.nativeEvent))} {...props} />;
}

export type SurfaceProps = ViewProps & {
  grayscale?: boolean;
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

export type NativeSurfaceProps = Omit<SurfaceProps, "shadowColor" | "shadowOpacity" | "shadowRadius" | "shadowOffset"> & {
  surfaceShadowColor?: string;
  surfaceShadowOpacity?: number;
  surfaceShadowRadius?: number;
  surfaceShadowOffset?: [number, number];
};

const NativeSurface = requireNativeViewManager<NativeSurfaceProps>("ArdiaSurface");

export function Surface({ shadowColor, shadowOpacity, shadowRadius, shadowOffset, ...props }: SurfaceProps) {
  return (
    <NativeSurface
      {...props}
      surfaceShadowColor={shadowColor}
      surfaceShadowOpacity={shadowOpacity}
      surfaceShadowRadius={shadowRadius}
      surfaceShadowOffset={shadowOffset}
    />
  );
}

export type VisualEffectProps = ViewProps & {
  material?: string;
  blendingMode?: "withinWindow" | "behindWindow";
  cornerRadius?: number;
};

export const VisualEffect = requireNativeViewManager<VisualEffectProps>("ArdiaVisualEffect");

export type GlassEffectProps = ViewProps & {
  cornerRadius?: number;
  tint?: string;
  glassStyle?: "regular" | "clear";
  dark?: boolean;
};

export type GlassEffectNative = { isLiquidGlass(): boolean };

const GlassEffectModule = nativeModule("ArdiaGlassEffect");

export const isLiquidGlass = (): boolean => GlassEffectModule.isLiquidGlass();

export const GlassEffect = requireNativeViewManager<GlassEffectProps>("ArdiaGlassEffect");

export type GlassGroupProps = ViewProps & { strength?: number };

export const GlassGroup = requireNativeViewManager<GlassGroupProps>("ArdiaGlassGroup");

export type PopoverBubbleProps = ViewProps & {
  material?: "popover" | "menu" | "hudWindow" | "sheet" | "toolTip";
  dark?: boolean;
  cornerRadius?: number;
  arrowEdge?: "top" | "bottom" | "none";
  arrowX?: number;
  arrowWidth?: number;
  arrowHeight?: number;
  tint?: string;
  edgeColor?: string;
  edgeWidth?: number;
  shadowOpacity?: number;
  shadowRadius?: number;
  shadowOffsetY?: number;
  glass?: boolean;
};

export type NativePopoverBubbleProps = Omit<PopoverBubbleProps, "shadowOpacity" | "shadowRadius" | "shadowOffsetY"> & {
  bubbleShadowOpacity?: number;
  bubbleShadowRadius?: number;
  bubbleShadowOffsetY?: number;
};

const NativePopoverBubble = requireNativeViewManager<NativePopoverBubbleProps>("ArdiaPopoverBubble");

export function PopoverBubble({ shadowOpacity, shadowRadius, shadowOffsetY, ...props }: PopoverBubbleProps) {
  return <NativePopoverBubble {...props} bubbleShadowOpacity={shadowOpacity} bubbleShadowRadius={shadowRadius} bubbleShadowOffsetY={shadowOffsetY} />;
}

export type IconTheme = { kind: "blur" } | { kind: "template"; fill: string; stroke?: string };

export type DockSelectionNative = {
  iconTheme(uri: string | null, emoji: string | null): Promise<IconTheme | null>;
  iconAccent(uri: string): Promise<string | null>;
};

const DockSelectionModule = nativeModule("ArdiaDockSelection");

export const iconTheme = (source: { uri: string } | { emoji: string }): Promise<IconTheme | null> =>
  DockSelectionModule.iconTheme("uri" in source ? source.uri : null, "emoji" in source ? source.emoji : null);

export const iconAccent = (uri: string): Promise<string | null> => DockSelectionModule.iconAccent(uri);

export type DockSelectionProps = ViewProps & {
  image?: string;
  emoji?: string;
  theme?: IconTheme["kind"];
  fill?: string;
  stroke?: string;
  cornerRadius?: number;
  strokeWidth?: number;
  iconSize?: number;
  dark: boolean;
  glass?: boolean;
  colorRing?: boolean;
  outline?: boolean;
};

export const DockSelection = requireNativeViewManager<DockSelectionProps>("ArdiaDockSelection");

export const PluginPageView = requireNativeViewManager<PluginPageProps>("ArdiaPlugins");
