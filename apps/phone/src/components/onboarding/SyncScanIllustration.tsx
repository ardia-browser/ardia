import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, withSpring } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { tileGradient } from "../../lib/favicon";
import { linearGradientCss } from "../../lib/gradient";
import { withAlpha } from "../../lib/color";
import { sketchQrPath } from "../../lib/sketchQr";
import { LookBackdrop, PROFILE_COLORS, spring, Symbol, syncSketch, tabsMotion, useTheme, useReduceMotion } from "../ui";

const smooth = spring(0.42, 0.9);
const QR_PATH = sketchQrPath();
const QR_SIDE = 25;

const scaledIn = () => {
  "worklet";
  return { initialValues: { opacity: 0, transform: [{ scale: 0 }] }, animations: { opacity: withSpring(1, smooth), transform: [{ scale: withSpring(1, smooth) }] } };
};

const scaledOut = () => {
  "worklet";
  return { initialValues: { opacity: 1, transform: [{ scale: 1 }] }, animations: { opacity: withSpring(0, smooth), transform: [{ scale: withSpring(0, smooth) }] } };
};

export function SyncScanIllustration({ connected }: { connected: boolean }) {
  return (
    <View testID="syncSketch" style={styles.frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <MacWindowSketch />
      <PhoneSketch connected={connected} />
    </View>
  );
}

function MacWindowSketch() {
  const theme = useTheme();
  return (
    <View testID="syncSketchMac" style={[styles.mac, { borderColor: withAlpha(theme.label, 0.1) }]}>
      <View style={styles.sidebar}>
        <LookBackdrop />
        <View style={styles.sidebarRows}>
          <View style={styles.lights}>
            {syncSketch.trafficLights.map((color) => (
              <View key={color} style={[styles.light, { backgroundColor: color }]} />
            ))}
          </View>
          {syncSketch.tabs.map((tab) => (
            <View key={tab.look} style={styles.tab}>
              <View style={[styles.tabSwatch, { backgroundColor: PROFILE_COLORS[tab.look].swatch }]} />
              <View style={[styles.bar, { width: tab.width, backgroundColor: withAlpha(theme.label, 0.18) }]} />
            </View>
          ))}
        </View>
      </View>
      <View style={[styles.page, { backgroundColor: theme.canvas }]}>
        <SketchQr side={syncSketch.qr} color={theme.label} />
        <View style={[styles.bar, { width: syncSketch.lineWide, backgroundColor: withAlpha(theme.label, 0.14) }]} />
        <View style={[styles.bar, { width: syncSketch.lineNarrow, backgroundColor: withAlpha(theme.label, 0.1) }]} />
      </View>
    </View>
  );
}

function PhoneSketch({ connected }: { connected: boolean }) {
  const reduceMotion = useReduceMotion();
  const entering = reduceMotion ? FadeIn.duration(tabsMotion.fade) : scaledIn;
  const exiting = reduceMotion ? FadeOut.duration(tabsMotion.fade) : scaledOut;
  const screen = connected ? { experimental_backgroundImage: linearGradientCss(tileGradient(PROFILE_COLORS.plum.swatch), false, 1, 1) } : { backgroundColor: syncSketch.phoneScreen };
  return (
    <View testID="syncSketchPhone" style={styles.phone}>
      <View testID="syncSketchScreen" style={[styles.screen, screen]} />
      {connected ? (
        <Animated.View key="connected" testID="syncSketchCheck" entering={entering} exiting={exiting} style={styles.centered}>
          <Symbol name="checkmark" size={syncSketch.check} color="#FFFFFF" />
        </Animated.View>
      ) : (
        <Animated.View key="scanning" testID="syncSketchFinder" entering={entering} exiting={exiting} style={styles.centered}>
          <View style={styles.finder}>
            <FinderCorners />
            <View style={styles.finderQr}>
              <SketchQr side={syncSketch.finderQr} color="#FFFFFF" />
            </View>
          </View>
        </Animated.View>
      )}
      <View style={styles.notch} />
    </View>
  );
}

function FinderCorners() {
  const side = syncSketch.finder;
  const pad = syncSketch.finderStroke / 2;
  const arm = side * syncSketch.finderArmShare;
  const d = [
    [0, 0, 1, 1],
    [side, 0, -1, 1],
    [0, side, 1, -1],
    [side, side, -1, -1],
  ]
    .map(([x, y, dx, dy]) => `M${x! + pad} ${y! + pad + dy! * arm}L${x! + pad} ${y! + pad}L${x! + pad + dx! * arm} ${y! + pad}`)
    .join("");
  return (
    <Svg testID="syncSketchCorners" width={side + 2 * pad} height={side + 2 * pad} style={{ position: "absolute", left: -pad, top: -pad }}>
      <Path d={d} stroke="#FFFFFF" strokeWidth={syncSketch.finderStroke} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

function SketchQr({ side, color }: { side: number; color: string }) {
  return (
    <Svg testID="syncSketchQr" width={side} height={side} viewBox={`0 0 ${QR_SIDE} ${QR_SIDE}`}>
      <Path d={QR_PATH} fill={color} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  frame: { alignItems: "flex-end", justifyContent: "flex-end", alignSelf: "center" },
  mac: {
    width: syncSketch.macWidth,
    height: syncSketch.macHeight,
    marginRight: syncSketch.macTrailing,
    marginBottom: syncSketch.macBottom,
    borderRadius: syncSketch.macRadius,
    borderCurve: "continuous",
    borderWidth: 1,
    overflow: "hidden",
    flexDirection: "row",
    boxShadow: syncSketch.macShadow,
  },
  sidebar: { width: syncSketch.sidebarWidth, overflow: "hidden" },
  sidebarRows: { padding: syncSketch.sidebarPadding, gap: syncSketch.sidebarGap },
  lights: { flexDirection: "row", gap: syncSketch.lightGap, paddingBottom: 4 },
  light: { width: syncSketch.light, height: syncSketch.light, borderRadius: syncSketch.light / 2 },
  tab: { flexDirection: "row", alignItems: "center", gap: syncSketch.tabGap },
  tabSwatch: { width: syncSketch.tabSwatch, height: syncSketch.tabSwatch, borderRadius: syncSketch.tabSwatchRadius },
  bar: { height: syncSketch.tabBar, borderRadius: syncSketch.tabBar / 2 },
  page: { flex: 1, alignItems: "center", justifyContent: "center", gap: syncSketch.qrGap },
  phone: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: syncSketch.phoneWidth,
    height: syncSketch.phoneHeight,
    borderRadius: syncSketch.phoneRadius,
    borderCurve: "continuous",
    backgroundColor: syncSketch.phoneBody,
    boxShadow: syncSketch.phoneShadow,
    alignItems: "center",
    justifyContent: "center",
  },
  screen: {
    position: "absolute",
    top: syncSketch.phoneScreenInset,
    left: syncSketch.phoneScreenInset,
    right: syncSketch.phoneScreenInset,
    bottom: syncSketch.phoneScreenInset,
    borderRadius: syncSketch.phoneScreenRadius,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  centered: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  finder: { width: syncSketch.finder, height: syncSketch.finder, alignItems: "center", justifyContent: "center" },
  finderQr: { opacity: syncSketch.finderQrOpacity },
  notch: { position: "absolute", top: syncSketch.notchTop, width: syncSketch.notchWidth, height: syncSketch.notchHeight, borderRadius: syncSketch.notchHeight / 2, backgroundColor: "#000000" },
});
