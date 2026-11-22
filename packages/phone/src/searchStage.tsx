import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { createElement, forwardRef, useImperativeHandle, useRef, type ComponentType, type ReactNode, type Ref } from "react";
import { Platform, View, type ColorValue, type NativeSyntheticEvent, type ViewProps } from "react-native";

export type SearchStageExit = "morph" | "depart" | "drop";

export type SearchStageMorphLook = { usesGlass: boolean; panelTint: ColorValue; panelDark: boolean; classicPanel: ColorValue; frosted?: boolean };

export type SearchStageCorners = { anchor?: number; panel: number; field?: number };

export type SearchStageHandle = {
  present(): Promise<void>;
  holdLift(): void;
  releaseLift(): void;
  close(exit: SearchStageExit, velocity?: number): void;
  finish(): void;
};

export type SearchStageLift = { lift: number; up: boolean };

export type SearchStageProps = ViewProps & {
  shown: boolean;
  anchorNativeId?: string | null;
  faceNativeId?: string | null;
  focusNativeId?: string | null;
  revealNativeId?: string | null;
  rowsRevealNativeId?: string | null;
  fieldCenter?: number;
  commandTop?: number | null;
  landsDirectly?: boolean;
  morphLook?: SearchStageMorphLook;
  morphCorners?: SearchStageCorners;
  cardInset?: number;
  cardGap?: number;
  fieldInset?: number;
  fieldTop?: number;
  onLift?: (lift: SearchStageLift) => void;
  onReveal?: (reveal: { late: boolean }) => void;
  onSettled?: (settled: { landed: boolean }) => void;
  children?: ReactNode;
};

type NativeHandle = { present(): Promise<void>; holdLift(): Promise<void>; releaseLift(): Promise<void>; close(exit: string, velocity: number): Promise<void>; finish(): Promise<void> };

type NativeProps = Omit<SearchStageProps, "onLift" | "onReveal" | "onSettled" | "morphLook" | "morphCorners" | "anchorNativeId" | "faceNativeId" | "focusNativeId" | "revealNativeId" | "rowsRevealNativeId" | "commandTop"> & {
  ref?: Ref<NativeHandle>;
  anchorNativeId?: string;
  faceNativeId?: string;
  focusNativeId?: string;
  revealNativeId?: string;
  rowsRevealNativeId?: string;
  commandTop?: number;
  morphUsesGlass?: boolean;
  morphPanelTint?: ColorValue;
  morphFrosted?: boolean;
  morphPanelDark?: boolean;
  morphClassicPanel?: ColorValue;
  anchorRadius?: number;
  panelRadius?: number;
  fieldRadius?: number;
  onLift?: (event: NativeSyntheticEvent<SearchStageLift>) => void;
  onReveal?: (event: NativeSyntheticEvent<{ late: boolean }>) => void;
  onSettled?: (event: NativeSyntheticEvent<{ landed: boolean }>) => void;
};

const hasNative = Platform.OS === "ios" && requireOptionalNativeModule("ArdiaPhoneSearchStage") !== null;

let stageView: ComponentType<NativeProps> | undefined;
let panelView: ComponentType<ViewProps> | undefined;
const stage = () => (stageView ??= requireNativeViewManager<NativeProps>("ArdiaPhoneSearchStage", "SearchStage"));
const panel = () => (panelView ??= requireNativeViewManager<ViewProps>("ArdiaPhoneSearchStage", "SearchStagePanel"));

export const searchStageIsNative = () => hasNative;

export const SearchStage = forwardRef<SearchStageHandle, SearchStageProps>(function SearchStage(props, ref) {
  const native = useRef<NativeHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      present: async () => {
        await native.current?.present();
      },
      holdLift: () => void native.current?.holdLift(),
      releaseLift: () => void native.current?.releaseLift(),
      close: (exit, velocity) => void native.current?.close(exit, velocity ?? 0),
      finish: () => void native.current?.finish(),
    }),
    [],
  );
  const { onLift, onReveal, onSettled, morphLook, morphCorners, anchorNativeId, faceNativeId, focusNativeId, revealNativeId, rowsRevealNativeId, commandTop, ...rest } = props;
  if (!hasNative) return createElement(View, { ...rest, pointerEvents: props.shown ? "box-none" : "none" });
  return createElement(stage(), {
    ...rest,
    ref: native,
    anchorNativeId: anchorNativeId ?? undefined,
    faceNativeId: faceNativeId ?? undefined,
    focusNativeId: focusNativeId ?? undefined,
    revealNativeId: revealNativeId ?? undefined,
    rowsRevealNativeId: rowsRevealNativeId ?? undefined,
    commandTop: commandTop ?? undefined,
    morphUsesGlass: morphLook?.usesGlass,
    morphPanelTint: morphLook?.panelTint,
    morphFrosted: morphLook?.frosted,
    morphPanelDark: morphLook?.panelDark,
    morphClassicPanel: morphLook?.classicPanel,
    anchorRadius: morphCorners?.anchor,
    panelRadius: morphCorners?.panel,
    fieldRadius: morphCorners?.field,
    onLift: onLift ? (event: NativeSyntheticEvent<SearchStageLift>) => onLift(event.nativeEvent) : undefined,
    onReveal: onReveal ? (event: NativeSyntheticEvent<{ late: boolean }>) => onReveal(event.nativeEvent) : undefined,
    onSettled: onSettled ? (event: NativeSyntheticEvent<{ landed: boolean }>) => onSettled(event.nativeEvent) : undefined,
  });
});

export function SearchStagePanel(props: ViewProps & { children?: ReactNode }) {
  return createElement(hasNative ? panel() : View, { collapsable: false, ...props });
}
