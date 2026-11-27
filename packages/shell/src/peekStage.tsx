import { requireNativeViewManager } from "expo-modules-core";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ViewProps } from "react-native";
import type { PeekStageNative } from "./generated/native";

export type PeekRect = { x: number; y: number; width: number; height: number };

export type PeekStageGeometry = {
  width: number;
  height: number;
  page: PeekRect;
  tab: PeekRect;
  rest: PeekRect;
  card: PeekRect;
  source: PeekRect;
  restRadius: number;
  tabTopRadius: number;
  tabBottomRadius: number;
  fullscreen: boolean;
};

type PeekStagePhase = "idle" | "waiting" | "entering" | "open" | "gesture" | "settling" | "closing" | "promoting" | "finished";
type PeekEntrance = "genie" | "affine" | "fade";
type PeekMeshFallback = "switch" | "class" | "selector" | "encoding" | "layout" | "setter" | "constant" | "interpolation" | "construction" | "exception" | "invalid" | "test";

export type PeekStageState = {
  generation: number;
  phase: PeekStagePhase;
  entrance: PeekEntrance;
  interrupted: boolean;
  readyTimedOut: boolean;
  fallback?: PeekMeshFallback;
  chromeShown?: boolean;
  scrimShown?: boolean;
};
type PeekStageDone = { generation: number; outcome: "closed" | "promoted" };
type PeekStagePinch = { generation: number; outcome: "open" | "close" | "stay" };
type PeekStageAsked = { generation: number; leave: boolean };

export type PeekStageHandle = {
  begin(generation: number, animated?: boolean): Promise<boolean>;
  close(generation: number): Promise<boolean>;
  promote(generation: number): Promise<boolean>;
};

type PeekStageProps = ViewProps & {
  geometry: PeekStageGeometry;
  reduceMotion: boolean;
  gestures: boolean;
  meshAllowed: boolean;
  onPeekState?: (state: PeekStageState) => void;
  onPeekDone?: (done: PeekStageDone) => void;
  onPeekPinch?: (pinch: PeekStagePinch) => void;
  onPeekAsked?: (asked: PeekStageAsked) => void;
};

type NativeProps = Omit<PeekStageProps, "onPeekState" | "onPeekDone" | "onPeekPinch" | "onPeekAsked"> & {
  ref?: unknown;
  onPeekState?: (e: { nativeEvent: PeekStageState }) => void;
  onPeekDone?: (e: { nativeEvent: PeekStageDone }) => void;
  onPeekPinch?: (e: { nativeEvent: PeekStagePinch }) => void;
  onPeekAsked?: (e: { nativeEvent: PeekStageAsked }) => void;
};

const NativePeekStage = requireNativeViewManager<NativeProps>("ArdiaPeekStage");

export type { PeekStageNative };

export const PeekStage = forwardRef<PeekStageHandle, PeekStageProps>(function PeekStage({ onPeekState, onPeekDone, onPeekPinch, onPeekAsked, ...props }, ref) {
  const native = useRef<PeekStageHandle>(null);
  useImperativeHandle(ref, () => {
    const call = (fn: (view: PeekStageHandle) => Promise<boolean>) => (native.current ? fn(native.current).catch(() => false) : Promise.resolve(false));
    return {
      begin: (generation, animated = true) => call((n) => n.begin(generation, animated)),
      close: (generation) => call((n) => n.close(generation)),
      promote: (generation) => call((n) => n.promote(generation)),
    };
  }, []);
  return (
    <NativePeekStage
      ref={native}
      {...props}
      onPeekState={onPeekState && ((e) => onPeekState(e.nativeEvent))}
      onPeekDone={onPeekDone && ((e) => onPeekDone(e.nativeEvent))}
      onPeekPinch={onPeekPinch && ((e) => onPeekPinch(e.nativeEvent))}
      onPeekAsked={onPeekAsked && ((e) => onPeekAsked(e.nativeEvent))}
    />
  );
});
