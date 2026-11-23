import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { RawView } from "./views/raw/rawView";

export const BACKED_LAB = { tile: 48, slot: 64, left: 24, top: 96, rounds: 3, roundMs: 1600, shownMs: 1000 };

export const BACKED_PROBES = ["marker", "raw background+zIndex", "background+zIndex", "background", "background with a child below zero", "setNativeProps background"];

const DARK = "#010101";

const note = (text: string) => console.info(`[ardia windows] backed lab ${text}`);

const at = (slot: number) => ({ top: BACKED_LAB.top, left: BACKED_LAB.left + slot * BACKED_LAB.slot });

function LateChild({ belowZero }: { belowZero?: boolean }) {
  return <View style={[StyleSheet.absoluteFill, styles.white, belowZero ? { zIndex: -1 } : null]} />;
}

function NativePaintTile() {
  const view = useRef<View>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => view.current?.setNativeProps({ style: { backgroundColor: "#FFFFFF" } }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return <View ref={view} style={[styles.tile, at(5), { backgroundColor: DARK }]} />;
}

export function BackedLab() {
  const [round, setRound] = useState(1);
  useEffect(() => {
    note("round 1 mounted");
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let next = 1; next <= BACKED_LAB.rounds; next++) {
      timers.push(setTimeout(() => setRound(0), (next - 1) * BACKED_LAB.roundMs + BACKED_LAB.shownMs));
      if (next < BACKED_LAB.rounds)
        timers.push(
          setTimeout(() => {
            note(`round ${next + 1} mounted`);
            setRound(next + 1);
          }, next * BACKED_LAB.roundMs),
        );
    }
    return () => timers.forEach(clearTimeout);
  }, []);
  const shown = round > 0;
  return (
    <View pointerEvents="none" style={styles.panel}>
      <View style={styles.backdrop} />
      {shown ? <View style={[styles.tile, styles.white, at(0)]} /> : null}
      <RawView style={[styles.tile, at(1), { backgroundColor: DARK, zIndex: 10 }]}>{shown ? <LateChild /> : null}</RawView>
      <View style={[styles.tile, at(2), { backgroundColor: DARK, zIndex: 10 }]}>{shown ? <LateChild /> : null}</View>
      <View style={[styles.tile, at(3), { backgroundColor: DARK }]}>{shown ? <LateChild /> : null}</View>
      <View style={[styles.tile, at(4), { backgroundColor: DARK }]}>{shown ? <LateChild belowZero /> : null}</View>
      {shown ? <NativePaintTile key={round} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { ...StyleSheet.absoluteFillObject, zIndex: 1000 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "#000000" },
  tile: { position: "absolute", width: BACKED_LAB.tile, height: BACKED_LAB.tile },
  white: { backgroundColor: "#FFFFFF" },
});
