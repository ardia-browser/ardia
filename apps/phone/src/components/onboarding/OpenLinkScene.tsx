import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import { tileGradient } from "../../lib/favicon";
import { linearGradientCss } from "../../lib/gradient";
import { ForcedDark, PROFILE_COLORS, Symbol, useReduceMotion, useTheme } from "../ui";
import { openLink, phoneScene } from "./onboardingTokens";
import { BottomBar, Finger, glide, pulse, SceneCanvas, SCENE, settle, span, type FingerPath } from "./sceneKit";

const HEADER = openLink.header;
const THREAD = openLink.thread;
const CARD = openLink.card;
const COMPOSE = openLink.compose;
const PAGE = openLink.page;
const AT = openLink.timeline;
const TINT = PROFILE_COLORS[CARD.tint].swatch;

const cardTop = THREAD.top + 2 * (THREAD.line + 2 * THREAD.padY + THREAD.gap);
const cardHeight = CARD.image + 2 * CARD.padY + CARD.titleLine + CARD.hostSize + 2;
const cardCenter = { x: THREAD.inset + CARD.width / 2, y: cardTop + cardHeight / 2 };

const tapPath: FingerPath = (t: number) => {
  "worklet";
  const reach = glide(t, AT.reach[0], AT.reach[1]);
  const fromX = SCENE.width * openLink.fingerFrom.x;
  const fromY = SCENE.height * openLink.fingerFrom.y;
  return {
    x: fromX + (cardCenter.x - fromX) * reach,
    y: fromY + (cardCenter.y - fromY) * reach,
    opacity: span(t, AT.fingerIn[0], AT.fingerIn[1]) * (1 - span(t, AT.fingerOut[0], AT.fingerOut[1])),
    press: pulse(t, AT.press[0], AT.press[1]),
  };
};

export const openLinkProgress = (t: number) => {
  "worklet";
  return settle(t, AT.open[0], AT.open[1]) * (1 - span(t, AT.close[0], AT.close[1]));
};

export function OpenLinkScreen() {
  return (
    <ForcedDark value={false}>
      <OpenLinkScenes />
    </ForcedDark>
  );
}

function OpenLinkScenes() {
  const reduceMotion = useReduceMotion();
  const clock = useSharedValue(0);
  const opened = useSharedValue(0);
  const [pageShown, setPageShown] = useState(false);

  useEffect(() => {
    if (reduceMotion) return;
    clock.value = 0;
    clock.value = withRepeat(withTiming(1, { duration: openLink.loopMs, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(clock);
  }, [reduceMotion, clock]);

  useEffect(() => {
    if (!reduceMotion) return;
    opened.value = withTiming(pageShown ? 1 : 0, { duration: openLink.reducedFadeMs });
    const timer = setTimeout(() => setPageShown((shown) => !shown), pageShown ? openLink.reducedPageMs : openLink.reducedThreadMs);
    return () => clearTimeout(timer);
  }, [reduceMotion, pageShown, opened]);

  return (
    <View testID="openLinkScreen" style={[StyleSheet.absoluteFill, styles.paper]}>
      <SceneCanvas>
        <Thread clock={clock} reduceMotion={reduceMotion} />
        <OpenedPage clock={clock} opened={opened} reduceMotion={reduceMotion} />
        {reduceMotion ? null : <Finger clock={clock} path={tapPath} />}
      </SceneCanvas>
    </View>
  );
}

function Thread({ clock, reduceMotion }: { clock: SharedValue<number>; reduceMotion: boolean }) {
  const behind = useAnimatedStyle(() => {
    const open = reduceMotion ? 0 : openLinkProgress(clock.value);
    return { transform: [{ translateX: openLink.parallax * SCENE.width * open }] };
  }, [reduceMotion]);
  const shade = useAnimatedStyle(() => ({ opacity: reduceMotion ? 0 : openLink.shade * openLinkProgress(clock.value) }), [reduceMotion]);
  const press = useAnimatedStyle(() => {
    const pressed = reduceMotion ? 0 : pulse(clock.value, AT.press[0], AT.press[1]);
    return { transform: [{ scale: 1 - (1 - CARD.pressScale) * pressed }] };
  }, [reduceMotion]);
  const dim = useAnimatedStyle(() => ({ opacity: reduceMotion ? 0 : CARD.pressDim * pulse(clock.value, AT.press[0], AT.press[1]) }), [reduceMotion]);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.paper, behind]}>
      <View style={styles.header}>
        <View style={styles.back}>
          <Symbol name="chevronLeft" size={HEADER.back} color={openLink.outgoing} />
        </View>
        <View style={[styles.avatar, { experimental_backgroundImage: linearGradientCss(tileGradient(PROFILE_COLORS.blue.swatch), false, 1, 1) }]}>
          <Text allowFontScaling={false} style={styles.initial}>
            {HEADER.initial}
          </Text>
        </View>
        <Text allowFontScaling={false} style={styles.name}>
          {HEADER.name}
        </Text>
      </View>
      <View style={styles.thread}>
        <View style={[styles.bubble, styles.incoming]}>
          <Text allowFontScaling={false} style={styles.bubbleText}>
            {openLink.messages.asked}
          </Text>
        </View>
        <View style={[styles.bubble, styles.outgoing]}>
          <Text allowFontScaling={false} style={[styles.bubbleText, { color: openLink.outgoingInk }]}>
            {openLink.messages.answered}
          </Text>
        </View>
        <Animated.View testID="openLinkCard" style={[styles.card, press]}>
          <View style={[styles.cardImage, { experimental_backgroundImage: linearGradientCss(tileGradient(TINT), false, 1, 1) }]} />
          <View style={styles.cardWords}>
            <Text allowFontScaling={false} numberOfLines={1} style={styles.cardTitle}>
              {openLink.link.title}
            </Text>
            <Text allowFontScaling={false} style={styles.cardHost}>
              {openLink.link.host}
            </Text>
          </View>
          <Animated.View style={[StyleSheet.absoluteFill, styles.cardDim, dim]} />
        </Animated.View>
      </View>
      <View style={styles.compose}>
        <View style={styles.composePlus}>
          <Symbol name="plus" size={COMPOSE.size + 2} color={openLink.muted} />
        </View>
        <View style={styles.composeField}>
          <Text allowFontScaling={false} style={styles.composeText}>
            {COMPOSE.placeholder}
          </Text>
        </View>
      </View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade, shade]} />
    </Animated.View>
  );
}

function OpenedPage({ clock, opened, reduceMotion }: { clock: SharedValue<number>; opened: SharedValue<number>; reduceMotion: boolean }) {
  const theme = useTheme();
  const style = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: opened.value, transform: [{ translateX: 0 }] };
    const open = openLinkProgress(clock.value);
    const closing = span(clock.value, AT.close[0], AT.close[1]);
    return { opacity: closing > 0 ? 1 - closing : open > 0 ? 1 : 0, transform: [{ translateX: closing > 0 ? 0 : (1 - open) * SCENE.width }] };
  }, [reduceMotion]);
  return (
    <Animated.View testID="openLinkPage" style={[StyleSheet.absoluteFill, styles.paper, styles.lifted, style]}>
      <View style={{ height: SCENE.height * PAGE.image, experimental_backgroundImage: linearGradientCss(tileGradient(TINT), false, 1, 1) }} />
      <View style={styles.pageWords}>
        <Text allowFontScaling={false} style={styles.pageHost}>
          {openLink.link.host}
        </Text>
        <Text allowFontScaling={false} style={styles.pageTitle}>
          {openLink.link.title}
        </Text>
        {PAGE.lines.map((share, index) => (
          <View key={index} style={[styles.pageLine, { width: `${share * 100}%` }]} />
        ))}
      </View>
      <BottomBar theme={theme} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  paper: { backgroundColor: openLink.paper, overflow: "hidden" },
  header: { position: "absolute", top: HEADER.top, left: 0, right: 0, height: HEADER.height, alignItems: "center", justifyContent: "center", gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: openLink.rule },
  back: { position: "absolute", left: THREAD.inset, top: (HEADER.height - HEADER.back) / 2 - 4 },
  avatar: { width: HEADER.avatar, height: HEADER.avatar, borderRadius: HEADER.avatar / 2, alignItems: "center", justifyContent: "center" },
  initial: { fontSize: HEADER.avatar * 0.46, fontWeight: "600", color: HEADER.avatarInk },
  name: { fontSize: HEADER.nameSize, color: openLink.ink },
  thread: { position: "absolute", top: THREAD.top, left: THREAD.inset, right: THREAD.inset, gap: THREAD.gap },
  bubble: { maxWidth: `${THREAD.maxShare * 100}%`, paddingHorizontal: THREAD.padX, paddingVertical: THREAD.padY, borderRadius: THREAD.radius, borderCurve: "continuous" },
  incoming: { alignSelf: "flex-start", backgroundColor: openLink.incoming },
  outgoing: { alignSelf: "flex-end", backgroundColor: openLink.outgoing },
  bubbleText: { fontSize: THREAD.size, lineHeight: THREAD.line, color: openLink.ink },
  card: { alignSelf: "flex-start", width: CARD.width, borderRadius: CARD.radius, borderCurve: "continuous", overflow: "hidden", backgroundColor: openLink.incoming },
  cardImage: { height: CARD.image },
  cardWords: { paddingHorizontal: CARD.padX, paddingVertical: CARD.padY, gap: 2 },
  cardTitle: { fontSize: CARD.titleSize, lineHeight: CARD.titleLine, fontWeight: "600", color: openLink.ink },
  cardHost: { fontSize: CARD.hostSize, color: openLink.muted },
  cardDim: { backgroundColor: "#000000" },
  compose: { position: "absolute", left: COMPOSE.inset, right: COMPOSE.inset, bottom: COMPOSE.bottom, height: COMPOSE.height, flexDirection: "row", alignItems: "center", gap: 6 },
  composePlus: { width: COMPOSE.plus, height: COMPOSE.plus, borderRadius: COMPOSE.plus / 2, backgroundColor: openLink.incoming, alignItems: "center", justifyContent: "center" },
  composeField: { flex: 1, height: COMPOSE.height, borderRadius: COMPOSE.height / 2, borderWidth: StyleSheet.hairlineWidth, borderColor: openLink.rule, justifyContent: "center", paddingHorizontal: 9 },
  composeText: { fontSize: COMPOSE.size, color: openLink.muted },
  shade: { backgroundColor: "#000000" },
  lifted: { boxShadow: phoneScene.pageShadow },
  pageWords: { padding: PAGE.pad, gap: PAGE.gap },
  pageHost: { fontSize: PAGE.hostSize, fontWeight: "600", letterSpacing: 0.4, color: withAlpha(openLink.ink, 0.5), textTransform: "uppercase" },
  pageTitle: { fontSize: PAGE.titleSize, lineHeight: PAGE.titleLine, fontWeight: "800", color: openLink.ink, marginBottom: 2 },
  pageLine: { height: PAGE.line, borderRadius: PAGE.line / 2, backgroundColor: withAlpha(openLink.ink, 0.12) },
});
