import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { BackedView } from "./views/BackedView";
import { VisualEffect } from "./views/materials";
import { WindowDragRegion } from "./windowDragRegion";

export const FADE_LAB = { tile: 48, slot: 64, left: 24, rows: [96, 176], rounds: 6, roundMs: 2000, shownMs: 1400, fadeMs: 250 };

type Variant = { name: string; blur: boolean; layout: boolean; drag: boolean; later: boolean };

const SHAPES = [
  { name: "plain", blur: false, layout: false, drag: false },
  { name: "blur", blur: true, layout: false, drag: false },
  { name: "layout", blur: false, layout: true, drag: false },
  { name: "blur+layout", blur: true, layout: true, drag: false },
  { name: "overlay", blur: true, layout: true, drag: true },
];

export const FADE_VARIANTS: Variant[] = [false, true].flatMap((later) => SHAPES.map((shape) => ({ ...shape, name: `${shape.name}${later ? " later" : ""}`, later })));

export const FADE_PROBES = ["state", "setNativeProps", "inside background", "inside clear", "inside zIndex", "inside background+zIndex", "inside v1 panel", "helper background+zIndex"];

const CONTAINERS: { slot: number; style: object; pointerEvents?: "none" }[] = [
  { slot: 2, style: { backgroundColor: "#010101" } },
  { slot: 3, style: {} },
  { slot: 4, style: { zIndex: 10 } },
  { slot: 5, style: { backgroundColor: "#010101", zIndex: 10 } },
  { slot: 6, style: { backgroundColor: "#010101", zIndex: 1000 }, pointerEvents: "none" },
];

const note = (text: string) => console.info(`[ardia windows] fade lab ${text}`);

const at = (row: number, slot: number) => ({ top: FADE_LAB.rows[row], left: FADE_LAB.left + slot * FADE_LAB.slot });

function FadeTile({ variant, round, slot }: { variant: Variant; round: number; slot: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const begin = () => {
      note(`round ${round} ${variant.name} started`);
      Animated.timing(opacity, { toValue: 1, duration: FADE_LAB.fadeMs, easing: Easing.linear, useNativeDriver: true }).start(({ finished }) => note(`round ${round} ${variant.name} ended finished=${finished}`));
    };
    if (!variant.later) return begin();
    const frame = requestAnimationFrame(begin);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Animated.View style={[styles.tile, at(0, slot), { opacity }]} onLayout={variant.layout ? (e) => setWidth(e.nativeEvent.layout.width) : undefined}>
      {variant.blur ? <VisualEffect material="fullScreenUI" blendingMode="withinWindow" style={StyleSheet.absoluteFill} /> : null}
      <View style={[StyleSheet.absoluteFill, styles.white, width > 0 ? { width } : null]} />
      {variant.drag ? <WindowDragRegion style={StyleSheet.absoluteFill} /> : null}
    </Animated.View>
  );
}

const progress = (started: number) => Math.min(1, (Date.now() - started) / FADE_LAB.fadeMs);

function StateTile({ round }: { round: number }) {
  const [opacity, setOpacity] = useState(0);
  useEffect(() => {
    const started = Date.now();
    let frame = 0;
    const step = () => {
      const next = progress(started);
      setOpacity(next);
      if (next < 1) frame = requestAnimationFrame(step);
      else note(`round ${round} state ended`);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <View style={[styles.tile, styles.white, at(1, 0), { opacity }]} />;
}

function NativePropsTile({ round }: { round: number }) {
  const view = useRef<View>(null);
  useEffect(() => {
    const started = Date.now();
    let frame = 0;
    const step = () => {
      const next = progress(started);
      view.current?.setNativeProps({ style: { opacity: next } });
      if (next < 1) frame = requestAnimationFrame(step);
      else note(`round ${round} setNativeProps ended`);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <View ref={view} style={[styles.tile, styles.white, at(1, 1), { opacity: 0 }]} />;
}

export function FadeLab() {
  const [round, setRound] = useState(1);
  useEffect(() => {
    note(`round 1 mounted`);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let next = 1; next <= FADE_LAB.rounds; next++) {
      timers.push(setTimeout(() => setRound(0), (next - 1) * FADE_LAB.roundMs + FADE_LAB.shownMs));
      if (next < FADE_LAB.rounds)
        timers.push(
          setTimeout(() => {
            note(`round ${next + 1} mounted`);
            setRound(next + 1);
          }, next * FADE_LAB.roundMs),
        );
    }
    return () => timers.forEach(clearTimeout);
  }, []);
  const shown = round > 0;
  return (
    <View pointerEvents="none" style={styles.panel}>
      <View style={styles.backdrop} />
      {shown ? <View style={[styles.tile, styles.white, at(0, 0)]} /> : null}
      {shown ? FADE_VARIANTS.map((variant, i) => <FadeTile key={`${round}-${variant.name}`} variant={variant} round={round} slot={i + 1} />) : null}
      {shown ? <StateTile key={`${round}-state`} round={round} /> : null}
      {shown ? <NativePropsTile key={`${round}-native`} round={round} /> : null}
      <BackedView style={[styles.tile, at(1, 7), { backgroundColor: "#010101", zIndex: 10 }]}>{shown ? <View style={[StyleSheet.absoluteFill, styles.white]} /> : null}</BackedView>
      {CONTAINERS.map(({ slot, style, pointerEvents }) => (
        <View key={slot} pointerEvents={pointerEvents} style={[styles.tile, at(1, slot), style]}>
          {shown ? <View style={[StyleSheet.absoluteFill, styles.white]} /> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { ...StyleSheet.absoluteFillObject, zIndex: 1000 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "#000000" },
  tile: { position: "absolute", width: FADE_LAB.tile, height: FADE_LAB.tile },
  white: { backgroundColor: "#FFFFFF" },
});
