import { Children, forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import { createStageController, createWebAnimator, stageCard, type StageEntrance, type StageGeometry, type StageOutcome, type StagePhase } from "../../peekStageMotion";
import { refreshTabViewports } from "../../hostViewport";

const HIDDEN = { display: "none" } as const;
const WAITING = { opacity: 0 } as const;

type Event<T> = (event: { nativeEvent: T }) => void;
type StageState = { generation: number; phase: StagePhase; entrance: StageEntrance; interrupted: boolean; readyTimedOut: boolean };

type Props = ViewProps & {
  geometry?: StageGeometry;
  reduceMotion?: boolean;
  gestures?: boolean;
  meshAllowed?: boolean;
  onPeekState?: Event<StageState>;
  onPeekDone?: Event<{ generation: number; outcome: StageOutcome }>;
  onPeekPinch?: unknown;
  children?: ReactNode;
};

export const PeekStage = forwardRef<unknown, Props>(function PeekStage({ geometry, reduceMotion, onPeekState, onPeekDone, onPeekPinch: _pinch, gestures: _gestures, meshAllowed: _mesh, children, style, ...rest }, ref) {
  const root = useRef<View & HTMLElement>(null);
  const cardLayer = useRef<View & HTMLElement>(null);
  const scrimLayer = useRef<View & HTMLElement>(null);
  const [waiting, setWaiting] = useState(true);
  const latest = useRef({ onPeekState, onPeekDone, reduceMotion: !!reduceMotion, geometry });
  latest.current = { onPeekState, onPeekDone, reduceMotion: !!reduceMotion, geometry };
  const [controller] = useState(() =>
    createStageController(
      createWebAnimator(() => root.current, () => cardLayer.current, () => scrimLayer.current, refreshTabViewports),
      {
        state: (phase, generation, entrance) => {
          if (phase === "entering") setWaiting(false);
          latest.current.onPeekState?.({ nativeEvent: { generation, phase, entrance, interrupted: false, readyTimedOut: false } });
        },
        done: (generation, outcome) => latest.current.onPeekDone?.({ nativeEvent: { generation, outcome } }),
      },
      () => ({ geometry: latest.current.geometry ?? { width: 0, height: 0, card: { x: 0, y: 0, width: 0, height: 0 }, source: { x: 0, y: 0, width: 0, height: 0 }, fullscreen: true }, reduceMotion: latest.current.reduceMotion }),
    ),
  );
  useEffect(() => () => controller.dispose(), []);

  useImperativeHandle(ref, () => ({
    begin: (generation: number, animated = true) => Promise.resolve(controller.begin(generation, animated)),
    close: (generation: number) => Promise.resolve(controller.close(generation)),
    promote: (generation: number) => Promise.resolve(controller.promote(generation)),
  }));

  const [scrim, chrome, page] = Children.toArray(children);
  const full = !geometry || geometry.fullscreen;
  const width = geometry?.width ?? 0;
  const height = geometry?.height ?? 0;
  const card = geometry ? stageCard(geometry) : { x: 0, y: 0, width, height };

  return (
    <View ref={root} {...rest} style={style} pointerEvents="box-none">
      <View ref={scrimLayer} style={[StyleSheet.absoluteFill, waiting && WAITING, full && HIDDEN]} pointerEvents="box-none">
        {scrim}
      </View>
      <View
        ref={cardLayer}
        pointerEvents="box-none"
        style={[{ position: "absolute", left: card.x, top: card.y, width: card.width, height: card.height, transformOrigin: "50% 50%", willChange: "transform, opacity" } as object, waiting && WAITING]}
      >
        <View pointerEvents="box-none" style={{ position: "absolute", left: -card.x, top: -card.y, width, height }}>
          <View style={[StyleSheet.absoluteFill, full && HIDDEN]} pointerEvents="box-none">
            {chrome}
          </View>
          {page !== undefined && (
            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
              {page}
            </View>
          )}
        </View>
      </View>
    </View>
  );
});
