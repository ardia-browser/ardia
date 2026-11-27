import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import { useSyncConnected } from "../../state/sync/hooks";
import { PROFILE_COLORS, smoothCorners, spring, Symbol, useReduceMotion } from "../ui";
import type { SlotRect } from "./OnboardingKit";
import { phoneFrame } from "./onboardingTokens";
import { PHONE_SCREEN } from "./PhoneFrame";
import { scaledFromTopLeft } from "./phoneGeometry";
import { glide, pulse, settle, span } from "./sceneKit";
import { syncFlight } from "./syncFlightTokens";

const STAGE = syncFlight.stage;
const MAC = syncFlight.mac;
const ROW = syncFlight.macRow;
const PAGE = syncFlight.page;
const PHONE = syncFlight.phone;
const LIST = syncFlight.phoneList;
const CHIP = syncFlight.chip;
const CHECK = syncFlight.check;
const LOOP = syncFlight.loop;
const GLOW = syncFlight.connectedGlow;
const TABS = syncFlight.tabs;

const ROW_WIDTH = MAC.sidebarWidth - 2 * ROW.inset;
const PAGE_WIDTH = MAC.width - MAC.sidebarWidth;
const SLOT_WIDTH = PHONE_SCREEN.width - 2 * LIST.inset;
const PS = PHONE.scale;
const POP = spring(CHECK.pop.response, CHECK.pop.damping);

export const PHONE_IN_STAGE = { left: PHONE.left, top: PHONE.top, width: phoneFrame.width * PS, height: phoneFrame.height * PS, scale: PS } as const;

const FLOWN_TABS: readonly number[] = LOOP.flights;
const FILLED_TABS: readonly number[] = [...FLOWN_TABS, ...TABS.map((_, index) => index).filter((index) => !FLOWN_TABS.includes(index))];

const macRowTop = (row: number) => ROW.top + row * (ROW.height + ROW.gap);
const phoneSlotTop = (slot: number) => LIST.top + slot * (LIST.height + LIST.gap);

export const flightTimes = (flight: number) => {
  const start = LOOP.firstAtMs + flight * LOOP.strideMs;
  const lifted = start + LOOP.liftMs;
  const arrived = lifted + LOOP.flyMs;
  return { start, lifted, arrived, glowGone: arrived + LOOP.glowFadeMs };
};

type Box = { x: number; y: number; width: number; height: number; radius: number; pad: number; swatch: number; swatchRadius: number; gap: number; bar: number; barWidth: number };

export const flightEnds = (flight: number): { from: Box; to: Box } => {
  const tab = TABS[FLOWN_TABS[flight]!]!;
  const bezel = phoneFrame.bezel;
  return {
    from: { x: MAC.left + ROW.inset, y: MAC.top + macRowTop(FLOWN_TABS[flight]!), width: ROW_WIDTH, height: ROW.height, radius: ROW.radius, pad: ROW.pad, swatch: ROW.swatch, swatchRadius: ROW.swatchRadius, gap: ROW.barGap, bar: ROW.bar, barWidth: tab.bar },
    to: {
      x: PHONE.left + (bezel + LIST.inset) * PS,
      y: PHONE.top + (bezel + phoneSlotTop(flight)) * PS,
      width: SLOT_WIDTH * PS,
      height: LIST.height * PS,
      radius: LIST.radius * PS,
      pad: LIST.pad * PS,
      swatch: LIST.swatch * PS,
      swatchRadius: LIST.swatchRadius * PS,
      gap: LIST.swatchGap * PS,
      bar: LIST.bar * PS,
      barWidth: tab.bar * LIST.barStretch * PS,
    },
  };
};

export const flightScale = (width: number, height: number) => Math.max(0, Math.min(syncFlight.maxScale, width / STAGE.width, height / STAGE.height));

export const stageAround = (phone: SlotRect) => {
  const scale = phone.width / PHONE_IN_STAGE.width;
  return { x: phone.x - PHONE.left * scale, y: phone.y - PHONE.top * scale, scale };
};

export type SyncFlightState = { clock: SharedValue<number>; glow: SharedValue<number>; looping: boolean; connected: boolean; reduceMotion: boolean };

const SyncFlightContext = createContext<SyncFlightState | null>(null);

export const useSyncFlight = () => useContext(SyncFlightContext);

export function SyncFlightProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const reduceMotion = useReduceMotion();
  const connected = useSyncConnected();
  const looping = active && !connected && !reduceMotion;
  const clock = useSharedValue(0);
  const glow = useSharedValue(0);

  useEffect(() => {
    if (!looping) return;
    clock.value = 0;
    clock.value = withDelay(LOOP.enterDelayMs, withRepeat(withTiming(LOOP.ms, { duration: LOOP.ms, easing: Easing.linear }), -1, false));
    return () => {
      cancelAnimation(clock);
      clock.value = 0;
    };
  }, [looping, clock]);

  useEffect(() => {
    if (!connected || !active) return;
    glow.value = 0;
    glow.value = withTiming(1, { duration: GLOW.ms, easing: Easing.linear });
    return () => {
      cancelAnimation(glow);
      glow.value = 0;
    };
  }, [connected, active, glow]);

  const state = useMemo(() => ({ clock, glow, looping, connected, reduceMotion }), [clock, glow, looping, connected, reduceMotion]);
  return <SyncFlightContext.Provider value={state}>{children}</SyncFlightContext.Provider>;
}

export function SyncStageBox({ x, y, scale, testID, children }: { x: number; y: number; scale: number; testID?: string; children: ReactNode }) {
  return (
    <View testID={testID} pointerEvents="none" style={[styles.stageBox, { left: x, top: y, transform: scaledFromTopLeft(STAGE.width, STAGE.height, scale) }]}>
      {children}
    </View>
  );
}

export function SyncMac() {
  const flight = useSyncFlight();
  if (!flight) return null;
  return (
    <View testID="syncFlightMac" style={styles.mac}>
      <View style={styles.sidebar}>
        <View style={styles.lights}>
          {MAC.trafficLights.map((color) => (
            <View key={color} style={[styles.light, { backgroundColor: color }]} />
          ))}
        </View>
        {TABS.map((spec, row) => (
          <MacRow key={spec.look} row={row} clock={flight.clock} glow={flight.glow} />
        ))}
      </View>
      <View style={styles.page}>
        <View style={styles.url} />
        <View style={[styles.pageTitle, { width: (PAGE_WIDTH - 2 * PAGE.pad) * PAGE.titleShare }]} />
        {PAGE.paragraphs.map((lines, paragraph) =>
          lines.map((share, index) => (
            <View key={`${paragraph}.${index}`} style={[styles.pageLine, { top: PAGE.lineTop + paragraph * (lines.length * (PAGE.lineHeight + PAGE.lineGap) + PAGE.paragraphGap) + index * (PAGE.lineHeight + PAGE.lineGap), width: (PAGE_WIDTH - 2 * PAGE.pad) * share }]} />
          )),
        )}
      </View>
    </View>
  );
}

function TabFace({ tab }: { tab: number }) {
  const spec = TABS[tab]!;
  return (
    <View style={styles.macFace}>
      <View style={[styles.macSwatch, { backgroundColor: PROFILE_COLORS[spec.look].swatch }]} />
      <View style={[styles.macBar, { width: spec.bar }]} />
    </View>
  );
}

function MacRow({ row, clock, glow }: { row: number; clock: SharedValue<number>; glow: SharedValue<number> }) {
  const flight = FLOWN_TABS.indexOf(row);
  const times = flight >= 0 ? flightTimes(flight) : null;
  const highlight = useAnimatedStyle(() => {
    const flown = times ? settle(clock.value, times.start, times.lifted) * (1 - span(clock.value, times.arrived, times.glowGone)) : 0;
    const swept = pulse(glow.value, row * GLOW.stagger, row * GLOW.stagger + GLOW.width);
    return { opacity: Math.max(flown, swept) };
  });
  const swatch = PROFILE_COLORS[TABS[row]!.look].swatch;
  return (
    <View testID="syncFlightMacRow" style={[styles.macRow, { top: macRowTop(row) }, row === 0 ? styles.activeRow : null]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.rowHighlight, { backgroundColor: withAlpha(swatch, ROW.highlightAlpha) }, highlight]} />
      <TabFace tab={row} />
    </View>
  );
}

export function SyncAbovePhone() {
  const flight = useSyncFlight();
  if (!flight) return null;
  return (
    <>
      {flight.looping ? FLOWN_TABS.map((_, index) => <FlightRow key={index} clock={flight.clock} flight={index} />) : null}
      {flight.connected ? (
        <Animated.View testID="syncFlightCheck" entering={flight.reduceMotion ? FadeIn.duration(syncFlight.reducedFadeMs) : checkPop} exiting={FadeOut.duration(syncFlight.fadeMs)} style={styles.check}>
          <Symbol name="checkmark" size={CHECK.glyph} color={CHECK.ink} weight="bold" />
        </Animated.View>
      ) : null}
    </>
  );
}

const checkPop = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0 }] },
    animations: { opacity: withDelay(CHECK.delayMs, withTiming(1, { duration: syncFlight.fadeMs })), transform: [{ scale: withDelay(CHECK.delayMs, withSpring(1, POP)) }] },
  };
};

const mix = (from: number, to: number, progress: number) => {
  "worklet";
  return from + (to - from) * progress;
};

function FlightRow({ clock, flight }: { clock: SharedValue<number>; flight: number }) {
  const times = flightTimes(flight);
  const { from, to } = flightEnds(flight);
  const swatch = PROFILE_COLORS[TABS[FLOWN_TABS[flight]!]!.look].swatch;
  const plate = useAnimatedStyle(() => {
    const t = clock.value;
    const lift = settle(t, times.start, times.lifted);
    const travel = glide(t, times.lifted, times.arrived);
    const x = mix(from.x, to.x, travel);
    const y = mix(from.y, to.y, travel) - CHIP.arc * 4 * travel * (1 - travel) - CHIP.liftRise * lift * (1 - travel);
    return {
      opacity: t >= times.start && t < times.arrived ? lift : 0,
      width: mix(from.width, to.width, travel),
      height: mix(from.height, to.height, travel),
      borderRadius: mix(from.radius, to.radius, travel),
      transform: [{ translateX: x }, { translateY: y }],
    };
  });
  const shadow = useAnimatedStyle(() => {
    const travel = glide(clock.value, times.lifted, times.arrived);
    return { opacity: 1 - travel * travel * travel, borderRadius: mix(from.radius, to.radius, travel) };
  });
  const tile = useAnimatedStyle(() => {
    const travel = glide(clock.value, times.lifted, times.arrived);
    const side = mix(from.swatch, to.swatch, travel);
    return { left: mix(from.pad, to.pad, travel), width: side, height: side, marginTop: -side / 2, borderRadius: mix(from.swatchRadius, to.swatchRadius, travel) };
  });
  const bar = useAnimatedStyle(() => {
    const travel = glide(clock.value, times.lifted, times.arrived);
    const height = mix(from.bar, to.bar, travel);
    return { left: mix(from.pad + from.swatch + from.gap, to.pad + to.swatch + to.gap, travel), width: mix(from.barWidth, to.barWidth, travel), height, marginTop: -height / 2, borderRadius: height / 2 };
  });
  return (
    <Animated.View testID="syncFlightChip" pointerEvents="none" style={[styles.chip, plate]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.chipShadow, shadow]} />
      <Animated.View style={[styles.chipTile, { backgroundColor: swatch }, tile]} />
      <Animated.View style={[styles.chipBar, bar]} />
    </Animated.View>
  );
}

export function SyncScreen() {
  const flight = useSyncFlight();
  if (!flight) return null;
  return (
    <View testID="syncScreen" style={[StyleSheet.absoluteFill, { backgroundColor: syncFlight.phoneScreen }]}>
      <View style={styles.listHeader}>
        <Symbol name="laptop" size={LIST.glyph} color={LIST.glyphInk} />
        <Text allowFontScaling={false} numberOfLines={1} style={styles.listTitle}>
          {LIST.title}
        </Text>
      </View>
      {flight.looping ? (
        FLOWN_TABS.map((_, slot) => <ArrivingRow key={slot} clock={flight.clock} slot={slot} />)
      ) : (
        <FilledRows key={flight.connected ? "connected" : "still"} count={flight.connected ? TABS.length : FLOWN_TABS.length} reduceMotion={flight.reduceMotion} />
      )}
    </View>
  );
}

function PhoneRowFace({ tab }: { tab: number }) {
  const spec = TABS[tab]!;
  return (
    <>
      <View style={[styles.phoneSwatch, { backgroundColor: PROFILE_COLORS[spec.look].swatch }]} />
      <View style={[styles.phoneBar, { width: spec.bar * LIST.barStretch }]} />
    </>
  );
}

function ArrivingRow({ clock, slot }: { clock: SharedValue<number>; slot: number }) {
  const times = flightTimes(slot);
  const style = useAnimatedStyle(() => {
    const t = clock.value;
    return { opacity: (t >= times.arrived ? 1 : 0) * (1 - span(t, LOOP.resetFromMs, LOOP.resetFromMs + LOOP.resetMs)) };
  });
  return (
    <Animated.View testID="syncFlightPhoneRow" style={[styles.phoneRow, { top: phoneSlotTop(slot) }, style]}>
      <PhoneRowFace tab={FLOWN_TABS[slot]!} />
    </Animated.View>
  );
}

function FilledRows({ count, reduceMotion }: { count: number; reduceMotion: boolean }) {
  const step = reduceMotion ? syncFlight.reducedStaggerMs : syncFlight.filledStaggerMs;
  return (
    <>
      {FILLED_TABS.slice(0, count).map((tab, slot) => (
        <Animated.View key={tab} testID="syncFlightPhoneRow" entering={FadeIn.duration(reduceMotion ? syncFlight.reducedFadeMs : syncFlight.fadeMs).delay(slot * step)} style={[styles.phoneRow, { top: phoneSlotTop(slot) }]}>
          <PhoneRowFace tab={tab} />
        </Animated.View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  stageBox: { position: "absolute", width: STAGE.width, height: STAGE.height },
  mac: {
    position: "absolute",
    left: MAC.left,
    top: MAC.top,
    width: MAC.width,
    height: MAC.height,
    borderRadius: MAC.radius,
    ...smoothCorners,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: MAC.border,
    backgroundColor: MAC.chrome,
    boxShadow: MAC.shadow,
    flexDirection: "row",
  },
  sidebar: { width: MAC.sidebarWidth, backgroundColor: MAC.sidebar, borderTopLeftRadius: MAC.radius, borderBottomLeftRadius: MAC.radius, ...smoothCorners, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: MAC.divider },
  lights: { position: "absolute", top: MAC.lightsTop, left: MAC.lightsLeft, flexDirection: "row", gap: MAC.lightGap },
  light: { width: MAC.light, height: MAC.light, borderRadius: MAC.light / 2 },
  macRow: { position: "absolute", left: ROW.inset, width: ROW_WIDTH, height: ROW.height, borderRadius: ROW.radius, ...smoothCorners },
  activeRow: { backgroundColor: ROW.activeFill, boxShadow: ROW.activeShadow },
  rowHighlight: { borderRadius: ROW.radius, ...smoothCorners },
  macFace: { flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: ROW.pad, gap: ROW.barGap },
  macSwatch: { width: ROW.swatch, height: ROW.swatch, borderRadius: ROW.swatchRadius, ...smoothCorners },
  macBar: { height: ROW.bar, borderRadius: ROW.bar / 2, backgroundColor: ROW.ink },
  page: { flex: 1 },
  url: { position: "absolute", top: PAGE.urlTop, left: (PAGE_WIDTH - PAGE.urlWidth) / 2, width: PAGE.urlWidth, height: PAGE.urlHeight, borderRadius: PAGE.urlHeight / 2, backgroundColor: PAGE.urlFill },
  pageTitle: { position: "absolute", top: PAGE.titleTop, left: PAGE.pad, height: PAGE.titleHeight, borderRadius: PAGE.titleHeight / 2, backgroundColor: PAGE.titleInk },
  pageLine: { position: "absolute", left: PAGE.pad, height: PAGE.lineHeight, borderRadius: PAGE.lineHeight / 2, backgroundColor: PAGE.lineInk },
  listHeader: { position: "absolute", top: LIST.titleTop, left: LIST.titleLeft, right: LIST.titleLeft, flexDirection: "row", alignItems: "center", gap: LIST.glyphGap },
  listTitle: { fontSize: LIST.titleSize, lineHeight: LIST.titleLineHeight, fontWeight: "700", color: LIST.titleInk },
  phoneRow: { position: "absolute", left: LIST.inset, width: SLOT_WIDTH, height: LIST.height, borderRadius: LIST.radius, ...smoothCorners, backgroundColor: LIST.fill, flexDirection: "row", alignItems: "center", paddingHorizontal: LIST.pad, gap: LIST.swatchGap },
  phoneSwatch: { width: LIST.swatch, height: LIST.swatch, borderRadius: LIST.swatchRadius, ...smoothCorners },
  phoneBar: { height: LIST.bar, borderRadius: LIST.bar / 2, backgroundColor: LIST.ink },
  chip: { position: "absolute", left: 0, top: 0, backgroundColor: LIST.fill, borderCurve: "continuous" },
  chipShadow: { backgroundColor: LIST.fill, boxShadow: CHIP.shadow, borderCurve: "continuous" },
  chipTile: { position: "absolute", top: "50%", borderCurve: "continuous" },
  chipBar: { position: "absolute", top: "50%", backgroundColor: LIST.ink },
  check: {
    position: "absolute",
    left: PHONE.left + PHONE_IN_STAGE.width - CHECK.inset - CHECK.side / 2,
    top: PHONE.top + CHECK.inset - CHECK.side / 2,
    width: CHECK.side,
    height: CHECK.side,
    borderRadius: CHECK.side / 2,
    backgroundColor: CHECK.fill,
    borderWidth: CHECK.ring,
    borderColor: CHECK.ringColor,
    boxShadow: CHECK.shadow,
    alignItems: "center",
    justifyContent: "center",
  },
});
