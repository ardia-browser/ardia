import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import { tileGradient } from "../../lib/favicon";
import { linearGradientCss } from "../../lib/gradient";
import { PROFILE_COLORS, smoothCorners, space, Symbol, type Theme } from "../ui";
import { phoneScene } from "./onboardingTokens";
import { PHONE_SCREEN } from "./PhoneFrame";
import { scaledFromTopLeft } from "./phoneGeometry";

export const SCENE = { width: PHONE_SCREEN.width / phoneScene.density, height: PHONE_SCREEN.height / phoneScene.density } as const;

const BAR = phoneScene.bar;
const FINGER = phoneScene.finger;

export const span = (t: number, from: number, to: number) => {
  "worklet";
  return Math.min(1, Math.max(0, (t - from) / (to - from)));
};

export const glide = (t: number, from: number, to: number) => {
  "worklet";
  return Easing.inOut(Easing.cubic)(span(t, from, to));
};

export const settle = (t: number, from: number, to: number) => {
  "worklet";
  return Easing.out(Easing.cubic)(span(t, from, to));
};

export const pulse = (t: number, from: number, to: number) => {
  "worklet";
  const x = span(t, from, to);
  return x < 0.5 ? x * 2 : (1 - x) * 2;
};

export type FingerAt = { x: number; y: number; opacity: number; press: number };

export type FingerPath = (t: number) => FingerAt;

export function SceneCanvas({ children }: { children: ReactNode }) {
  return <View style={styles.canvas}>{children}</View>;
}

export function Finger({ clock, path }: { clock: SharedValue<number>; path: FingerPath }) {
  const style = useAnimatedStyle(() => {
    const at = path(clock.value);
    return {
      opacity: at.opacity,
      transform: [{ translateX: at.x - FINGER.side / 2 }, { translateY: at.y - FINGER.side / 2 }, { scale: 1 - (1 - FINGER.pressScale) * at.press }],
    };
  }, [path]);
  return <Animated.View testID="sceneFinger" pointerEvents="none" style={[styles.finger, style]} />;
}

export function PageMock({ look, theme }: { look: number; theme: Theme }) {
  const page = phoneScene.page;
  const swatch = PROFILE_COLORS[phoneScene.looks[look % phoneScene.looks.length]!].swatch;
  return (
    <View style={[styles.page, { backgroundColor: theme.groupFill }]}>
      <View style={{ height: SCENE.height * page.header, experimental_backgroundImage: linearGradientCss(tileGradient(swatch), false, 1, 1) }} />
      <View style={styles.pageWords}>
        <View style={[styles.title, { width: `${page.titleWidth * 100}%`, backgroundColor: withAlpha(theme.label, 0.75) }]} />
        {page.lines.map((share, index) => (
          <View key={index} style={[styles.line, { width: `${share * 100}%`, backgroundColor: withAlpha(theme.label, 0.14) }]} />
        ))}
        <View style={[styles.figure, { backgroundColor: withAlpha(swatch, 0.22) }]} />
        {page.lines.slice(0, 2).map((share, index) => (
          <View key={`tail${index}`} style={[styles.line, { width: `${share * 100}%`, backgroundColor: withAlpha(theme.label, 0.14) }]} />
        ))}
      </View>
    </View>
  );
}

export function BottomBar({ theme, children }: { theme: Theme; children?: ReactNode }) {
  return (
    <View style={styles.barSlot}>
      <View style={[styles.bar, { backgroundColor: theme.groupFill, borderColor: theme.cardEdge }]}>
        <Symbol name="squareOnSquare" size={BAR.glyph} color={theme.label} />
        <View style={[styles.plus, { backgroundColor: theme.plusFill }]}>
          {children}
          <Symbol name="plus" size={BAR.glyph} color={theme.label} />
        </View>
        <Symbol name="chevronUp" size={BAR.glyph} color={theme.label} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { position: "absolute", left: 0, top: 0, width: SCENE.width, height: SCENE.height, overflow: "hidden", transform: scaledFromTopLeft(SCENE.width, SCENE.height, phoneScene.density) },
  finger: { position: "absolute", left: 0, top: 0, width: FINGER.side, height: FINGER.side, borderRadius: FINGER.side / 2, backgroundColor: FINGER.fill, borderWidth: FINGER.ring, borderColor: FINGER.edge, boxShadow: FINGER.shadow },
  page: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" },
  pageWords: { padding: phoneScene.page.pad, gap: phoneScene.page.gap },
  title: { height: phoneScene.page.title, borderRadius: phoneScene.page.title / 2, marginBottom: 2 },
  line: { height: phoneScene.page.line, borderRadius: phoneScene.page.line / 2 },
  figure: { height: SCENE.height * 0.12, borderRadius: 8, marginVertical: 2 },
  barSlot: { position: "absolute", left: BAR.inset, right: BAR.inset, bottom: BAR.bottom },
  bar: { height: BAR.height, borderRadius: BAR.height / 2, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.m, boxShadow: BAR.shadow, ...smoothCorners },
  plus: { width: BAR.plus, height: BAR.plus, borderRadius: BAR.plus / 2, alignItems: "center", justifyContent: "center" },
});
