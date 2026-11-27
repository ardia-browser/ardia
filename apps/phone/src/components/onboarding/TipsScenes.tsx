import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import { linearGradientCss } from "../../lib/gradient";
import { ForcedDark, space, Symbol, tabsMotion, useReduceMotion, useTheme, type Theme } from "../ui";
import { phoneScene, tipsReel } from "./onboardingTokens";
import { BottomBar, Finger, glide, PageMock, pulse, SceneCanvas, SCENE, settle, span, type FingerPath } from "./sceneKit";

export const REEL_TIPS = ["Tap + to search.", "Swipe a tab up to close it.", "Swipe a page to go back."] as const;

const SCREEN_W = SCENE.width;
const SCREEN_H = SCENE.height;
const BAR = phoneScene.bar;

export type TipsReelState = { scene: number; clock: SharedValue<number>; reduceMotion: boolean; next: () => void; jump: (scene: number) => void };

const TipsReelContext = createContext<TipsReelState | null>(null);

export const useTipsReel = () => useContext(TipsReelContext);

export function TipsReelProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const reduceMotion = useReduceMotion();
  const [scene, setScene] = useState(0);
  const clock = useSharedValue(reduceMotion ? tipsReel.reducedFrame : 0);

  useEffect(() => {
    if (!active) {
      setScene(0);
      return;
    }
    if (reduceMotion) {
      clock.value = tipsReel.reducedFrame;
    } else {
      clock.value = 0;
      clock.value = withTiming(1, { duration: tipsReel.sceneMs, easing: Easing.linear });
    }
    const timer = setTimeout(() => setScene((now) => (now + 1) % REEL_TIPS.length), reduceMotion ? tipsReel.reducedSceneMs : tipsReel.sceneMs);
    return () => {
      clearTimeout(timer);
      cancelAnimation(clock);
    };
  }, [active, scene, reduceMotion, clock]);

  const state = useMemo<TipsReelState>(() => ({ scene, clock, reduceMotion, next: () => setScene((now) => (now + 1) % REEL_TIPS.length), jump: setScene }), [scene, clock, reduceMotion]);
  return <TipsReelContext.Provider value={state}>{children}</TipsReelContext.Provider>;
}

export function TipsScreen() {
  return (
    <ForcedDark value={false}>
      <TipsScenes />
    </ForcedDark>
  );
}

function TipsScenes() {
  const theme = useTheme();
  const reel = useTipsReel();
  if (!reel) return null;
  const { scene, clock, reduceMotion } = reel;
  const fade = reduceMotion ? tabsMotion.fade : tabsMotion.surfaceFade;
  return (
    <View testID="tipsScreen" style={[StyleSheet.absoluteFill, { experimental_backgroundImage: linearGradientCss(theme.backdrop, false, 1, 1) }]}>
      <SceneCanvas>
        <Animated.View key={scene} entering={FadeIn.duration(fade)} exiting={FadeOut.duration(fade)} style={StyleSheet.absoluteFill}>
          {scene === 0 ? <SearchScene clock={clock} theme={theme} /> : scene === 1 ? <CloseScene clock={clock} theme={theme} /> : <BackScene clock={clock} theme={theme} />}
        </Animated.View>
        {reduceMotion ? null : <Finger clock={clock} path={FINGER_PATHS[scene]!} />}
      </SceneCanvas>
    </View>
  );
}

const FINGER_PATHS: FingerPath[] = [
  (t: number) => {
    "worklet";
    const reach = glide(t, 0.16, 0.36);
    const x = SCREEN_W * 0.66 + (SCREEN_W / 2 - SCREEN_W * 0.66) * reach;
    const y = SCREEN_H * 0.62 + (SCREEN_H - BAR.bottom - BAR.height / 2 - SCREEN_H * 0.62) * reach;
    return { x, y, opacity: span(t, 0.08, 0.16) * (1 - span(t, 0.42, 0.48)), press: pulse(t, 0.34, 0.44) };
  },
  (t: number) => {
    "worklet";
    const deck = tipsReel.deck;
    const lift = glide(t, 0.2, 0.42) * SCREEN_H * deck.lift + span(t, 0.42, 0.5) * SCREEN_H * 0.22;
    return { x: SCREEN_W / 2, y: SCREEN_H * (deck.topShare + deck.heightShare * 0.62) - lift, opacity: span(t, 0.08, 0.16) * (1 - span(t, 0.44, 0.52)), press: span(t, 0.16, 0.2) * (1 - span(t, 0.42, 0.46)) };
  },
  (t: number) => {
    "worklet";
    const back = tipsReel.back;
    return { x: back.edge + glide(t, 0.2, 0.55) * SCREEN_W * back.dragShare, y: SCREEN_H * 0.46, opacity: span(t, 0.08, 0.16) * (1 - span(t, 0.55, 0.63)), press: span(t, 0.16, 0.2) * (1 - span(t, 0.55, 0.59)) };
  },
];

function SearchScene({ clock, theme }: { clock: SharedValue<number>; theme: Theme }) {
  const tray = tipsReel.tray;
  const height = SCREEN_H * tray.share;
  const flash = useAnimatedStyle(() => ({ opacity: pulse(clock.value, 0.34, 0.48), transform: [{ scale: 0.7 + 0.5 * span(clock.value, 0.34, 0.48) }] }));
  const bar = useAnimatedStyle(() => ({ opacity: 1 - span(clock.value, 0.46, 0.54) }));
  const dim = useAnimatedStyle(() => ({ opacity: settle(clock.value, 0.46, 0.62) }));
  const rise = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - settle(clock.value, 0.46, 0.64)) * (height + BAR.bottom) }] }));
  const typed = useAnimatedStyle(() => ({ width: tray.queryWidth * span(clock.value, 0.62, 0.8) }));
  const results = useAnimatedStyle(() => ({ opacity: span(clock.value, 0.78, 0.86), transform: [{ translateY: 6 * (1 - settle(clock.value, 0.78, 0.9)) }] }));
  return (
    <View style={styles.fill}>
      <PageMock look={0} theme={theme} />
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.trayDim }, dim]} />
      <Animated.View style={[StyleSheet.absoluteFill, bar]}>
        <BottomBar theme={theme}>
          <Animated.View style={[styles.plusFlash, { backgroundColor: theme.spaceAccent }, flash]} />
        </BottomBar>
      </Animated.View>
      <Animated.View style={[styles.tray, { height, backgroundColor: theme.groupFill }, rise]}>
        <View style={[styles.field, { backgroundColor: theme.fieldFill }]}>
          <Symbol name="magnifyingglass" size={11} color={theme.secondaryLabel} />
          <Animated.View style={[styles.query, typed]}>
            <Text style={[styles.queryText, { color: theme.label }]} numberOfLines={1}>
              {tray.query}
            </Text>
          </Animated.View>
          <View style={[styles.caret, { backgroundColor: theme.spaceAccentInk }]} />
        </View>
        <Animated.View style={[styles.results, results]}>
          {[0.72, 0.54].map((share) => (
            <View key={share} style={styles.result}>
              <View style={[styles.resultIcon, { backgroundColor: withAlpha(theme.label, 0.12) }]} />
              <View style={[styles.line, { width: `${share * 100}%`, backgroundColor: withAlpha(theme.label, 0.2) }]} />
            </View>
          ))}
        </Animated.View>
        <View style={[styles.keyboard, { backgroundColor: withAlpha(theme.label, 0.05) }]}>
          {tray.keyRows.map((keys, row) => (
            <View key={row} style={styles.keyRow}>
              {Array.from({ length: keys }, (_, key) => (
                <View key={key} style={[styles.key, { backgroundColor: withAlpha(theme.label, theme.dark ? 0.22 : 0.1) }]} />
              ))}
            </View>
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

const DECK = tipsReel.deck;
const CARD_W = SCREEN_W * DECK.widthShare;
const CARD_H = SCREEN_H * DECK.heightShare;
const CARD_PITCH = CARD_W + DECK.gap;

function DeckCard({ clock, slot, look, closes, theme }: { clock: SharedValue<number>; slot: number; look: number; closes: boolean; theme: Theme }) {
  const style = useAnimatedStyle(() => {
    const t = clock.value;
    const shift = slot > 0 ? settle(t, 0.54, 0.76) * CARD_PITCH : 0;
    const lift = closes ? glide(t, 0.2, 0.42) * SCREEN_H * DECK.lift + Easing.in(Easing.quad)(span(t, 0.42, 0.56)) * SCREEN_H : 0;
    const press = closes ? span(t, 0.16, 0.22) * (1 - span(t, 0.42, 0.5)) : 0;
    return {
      opacity: closes ? 1 - span(t, 0.46, 0.56) : 1,
      transform: [{ translateX: slot * CARD_PITCH - shift }, { translateY: -lift }, { scale: 1 - 0.03 * press }],
    };
  }, [slot, closes]);
  return (
    <Animated.View style={[styles.card, { borderColor: theme.cardEdge }, style]}>
      <PageMock look={look} theme={theme} />
    </Animated.View>
  );
}

function CloseScene({ clock, theme }: { clock: SharedValue<number>; theme: Theme }) {
  return (
    <View style={styles.fill}>
      {[-1, 0, 1, 2].map((slot) => (
        <DeckCard key={slot} clock={clock} slot={slot} look={slot + 1} closes={slot === 0} theme={theme} />
      ))}
    </View>
  );
}

function BackScene({ clock, theme }: { clock: SharedValue<number>; theme: Theme }) {
  const back = tipsReel.back;
  const progress = (t: number) => {
    "worklet";
    return glide(t, 0.2, 0.55) * back.dragShare + settle(t, 0.55, 0.72) * (1 - back.dragShare);
  };
  const under = useAnimatedStyle(() => ({ transform: [{ translateX: back.parallax * SCREEN_W * (1 - progress(clock.value)) }] }));
  const shade = useAnimatedStyle(() => ({ opacity: back.shade * (1 - progress(clock.value)) }));
  const top = useAnimatedStyle(() => ({ transform: [{ translateX: progress(clock.value) * SCREEN_W }] }));
  return (
    <View style={styles.fill}>
      <Animated.View style={[StyleSheet.absoluteFill, under]}>
        <PageMock look={1} theme={theme} />
        <Animated.View style={[StyleSheet.absoluteFill, styles.shade, shade]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, styles.lifted, top]}>
        <PageMock look={3} theme={theme} />
      </Animated.View>
      <BottomBar theme={theme} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
  line: { height: phoneScene.page.line, borderRadius: phoneScene.page.line / 2 },
  plusFlash: { position: "absolute", width: BAR.plus, height: BAR.plus, borderRadius: BAR.plus / 2 },
  tray: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: tipsReel.tray.radius, borderTopRightRadius: tipsReel.tray.radius, padding: space.s, gap: space.s, boxShadow: "0px -4px 18px rgba(0, 0, 0, 0.16)" },
  field: { height: tipsReel.tray.field, borderRadius: tipsReel.tray.field / 2, flexDirection: "row", alignItems: "center", paddingHorizontal: space.s + 2, gap: space.xs },
  query: { overflow: "hidden" },
  queryText: { fontSize: 11, lineHeight: 14, fontWeight: "500", width: tipsReel.tray.queryWidth },
  caret: { width: 1.5, height: tipsReel.tray.caret, borderRadius: 1 },
  results: { gap: space.s, paddingHorizontal: space.xs },
  result: { flexDirection: "row", alignItems: "center", gap: space.s },
  resultIcon: { width: 14, height: 14, borderRadius: 4 },
  keyboard: { flex: 1, borderRadius: 10, padding: space.xs, gap: tipsReel.tray.rowGap, justifyContent: "flex-end" },
  keyRow: { flexDirection: "row", justifyContent: "center", gap: tipsReel.tray.keyGap },
  key: { flex: 1, maxWidth: 12, height: tipsReel.tray.keyHeight, borderRadius: 3 },
  card: { position: "absolute", left: (SCREEN_W - CARD_W) / 2, top: SCREEN_H * DECK.topShare, width: CARD_W, height: CARD_H, borderRadius: DECK.radius, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  shade: { backgroundColor: "#000000" },
  lifted: { boxShadow: phoneScene.pageShadow },
});
