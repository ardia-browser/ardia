import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Animated, Pressable, StyleSheet, View, type ScrollView } from "react-native";
import { revealTab, rowsStamp, sameRows, samePillTab, selectedTabIn, showsProfile, selectedTabSnapshot, selectedPlaceIn, movedInPlace, watchPillTab, watchSelectedPlace, type PillTab, type RowsStamp, type SelectedPlace } from "../../state/sidebar/reveal";
import { notePageOverlay } from "../../state/telemetry/usage";
import { capsule, Panel, radius, reduceMotion, Symbol, Text, tintedImage } from "../ui";
import { useTheme } from "../ui/theme";
import { SHADOWS } from "../window/tokens";
import { GLOW_ROOM, type SidebarGeometry } from "./pageLayout";
import { locateTab, rowAway, type RowSpot } from "./selectedRow";
import { FaviconFallback, NewTabIcon } from "../favicon/Favicon";
import { drawnIcon } from "../../state/pins/rowIcons";
import { iconSymbol } from "../../lib/customIcon";
import { FADED, markedEngine } from "../../state/sidebar/rowState";
import { EngineMark, SLEEPING_OPACITY } from "./TabIcon";
import { SELECTED_ROW_PILL, SELECTED_ROW_PILL_MOTION, SELECTED_ROW_REVEAL_SETTLE_MS, useSidebarTokens } from "./tokens";

function settle(progress: Animated.Value, phase: keyof typeof SELECTED_ROW_PILL_MOTION, done?: () => void) {
  const toValue = phase === "enter" ? 1 : 0;
  if (reduceMotion()) {
    progress.setValue(toValue);
    done?.();
    return () => {};
  }
  const run = Animated.timing(progress, { toValue, ...SELECTED_ROW_PILL_MOTION[phase], useNativeDriver: true });
  run.start(({ finished }) => finished && done?.());
  return () => run.stop();
}

export type PillAway = { side: "above" | "below"; tab: PillTab } | null;
type PillSink = (away: PillAway) => void;
export type PillTracker = { judge: () => void; relocate: () => void; attach: (sink: PillSink) => () => void };

const samePill = (a: PillAway, b: PillAway) => a === b || (!!a && !!b && a.side === b.side && samePillTab(a.tab, b.tab));

export function useSelectedRowAway(
  windowId: string,
  geometry: RefObject<SidebarGeometry> | undefined,
  scroll: RefObject<ScrollView | null>,
  scrollY: () => number,
  profileId?: string,
): PillTracker {
  const live = useRef({ geometry, scrollY, profileId });
  live.current = { geometry, scrollY, profileId };
  const [tracker] = useState(() => {
    let away: PillAway = null;
    let sink: PillSink | null = null;
    let row: RowSpot | null = null;
    let stamp: RowsStamp | null = null;
    let ticket = 0;
    let frame = 0;
    let selected: string | null | undefined;
    let quietUntil = 0;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let selectedAt: SelectedPlace = { id: null, index: -1, group: null };
    let unwatchTab: (() => void) | null = null;
    const show = (next: PillAway) => {
      const same = samePill(next, away);
      if (same && (!next || unwatchTab)) return;
      away = next;
      unwatchTab?.();
      unwatchTab = away ? watchPillTab(away.tab, judge) : null;
      if (!same) sink?.(away);
    };
    const settleAfterSwitch = (tabId: string | null) => {
      if (selected !== undefined && tabId !== selected) {
        quietUntil = Date.now() + SELECTED_ROW_REVEAL_SETTLE_MS;
        clearTimeout(quiet);
        quiet = setTimeout(judge, SELECTED_ROW_REVEAL_SETTLE_MS);
      }
      selected = tabId;
    };
    const locate = () => {
      const mine = ++ticket;
      stamp = rowsStamp();
      selectedAt = selectedPlaceIn(windowId);
      const page = live.current.geometry?.current;
      const tabId = selectedTabIn(windowId) ?? null;
      settleAfterSwitch(tabId);
      const found = page && tabId ? locateTab(windowId, tabId, page, scroll.current, () => live.current.scrollY()) : null;
      if (found && "then" in found) {
        row = null;
        void found.then((spot) => {
          if (mine !== ticket) return;
          row = spot;
          place();
        });
        return;
      }
      row = found;
    };
    const place = () => {
      const own = live.current.profileId === undefined || showsProfile(windowId, live.current.profileId);
      const page = own ? live.current.geometry?.current : undefined;
      const side = page && Date.now() >= quietUntil ? rowAway(row, live.current.scrollY(), page.viewport, page.edgeLift) : null;
      const tab = side ? selectedTabSnapshot(windowId) : null;
      show(side && tab ? { side, tab } : null);
    };
    function judge() {
      if (!sameRows(stamp, rowsStamp())) locate();
      place();
    }
    return {
      judge,
      relocate: () => {
        stamp = null;
        judge();
      },
      selectionMoved: () => {
        stamp = null;
        const was = selectedAt;
        selectedAt = selectedPlaceIn(windowId);
        if (frame || (!away && !movedInPlace(was, selectedAt))) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          judge();
        });
      },
      attach: (next: PillSink) => {
        sink = next;
        next(away);
        return () => {
          if (sink === next) sink = null;
        };
      },
      stop: () => {
        cancelAnimationFrame(frame);
        frame = 0;
        clearTimeout(quiet);
        ticket++;
        unwatchTab?.();
        unwatchTab = null;
      },
    };
  });
  useEffect(() => {
    if (!geometry) return;
    tracker.relocate();
    const unwatch = watchSelectedPlace(windowId, tracker.selectionMoved);
    return () => {
      unwatch();
      tracker.stop();
    };
  }, [windowId, geometry]);
  return tracker;
}

export function SelectedRowPill({ windowId, tracker, lift, unedge, bottomShift }: { windowId: string; tracker: PillTracker; lift: number; unedge: Animated.AnimatedNode; bottomShift?: Animated.AnimatedInterpolation<number> }) {
  const [away, setAway] = useState<PillAway>(null);
  const [shown, setShown] = useState<PillAway>(null);
  const [leaving, setLeaving] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const onScreen = useRef(false);
  onScreen.current = !!shown;
  useEffect(() => tracker.attach(setAway), [tracker]);
  useEffect(() => {
    if (away) {
      notePageOverlay("selectedRowPillShown");
      setShown(away);
      setLeaving(false);
      return settle(progress, "enter");
    }
    if (!onScreen.current) return;
    setLeaving(true);
    return settle(progress, "exit", () => setShown(null));
  }, [away]);
  const outward = shown?.side === "below" ? 1 : -1;
  const motion = useMemo(() => (leaving ? leaveStyle(progress, outward) : enterStyle(progress, outward)), [leaving, outward]);
  if (!shown) return null;
  return (
    <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { top: GLOW_ROOM - lift, zIndex: 2, transform: [{ translateY: unedge }] }]}>
      <Animated.View
        pointerEvents="box-none"
        style={[PLACE, shown.side === "below" ? AT_BOTTOM : AT_TOP, shown.side === "below" && bottomShift ? { transform: [{ translateY: bottomShift }] } : null]}
      >
        <Animated.View pointerEvents={away ? "auto" : "none"} style={motion}>
          <PillFace windowId={windowId} side={shown.side} tab={shown.tab} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

function enterStyle(progress: Animated.Value, outward: number) {
  const { scale, rise } = SELECTED_ROW_PILL.enter;
  return {
    opacity: progress.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 0.85, 1] }),
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [rise * outward, 0] }) },
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [scale, 1] }) },
    ],
  };
}

function leaveStyle(progress: Animated.Value, outward: number) {
  const { scale, drop } = SELECTED_ROW_PILL.exit;
  return {
    opacity: progress.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.8, 1] }),
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [drop * outward, 0] }) },
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [scale, 1] }) },
    ],
  };
}

function PillFace({ windowId, side, tab }: { windowId: string; side: "above" | "below"; tab: PillTab }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const press = () => {
    notePageOverlay("selectedRowPillPressed");
    revealTab(windowId, tab.id);
  };
  return (
    <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={side === "below" ? "Scroll down to the selected tab" : "Scroll up to the selected tab"}>
      <Panel fill={tokens.selectedRowPillFill} border={tokens.selectedRowPillStroke} radius={capsule(SELECTED_ROW_PILL.height)} shadow={SHADOWS.status}>
        <View style={FACE}>
          <PillIcon tab={tab} size={SELECTED_ROW_PILL.icon} />
          <Symbol name={side === "below" ? "arrow.down" : "arrow.up"} size={SELECTED_ROW_PILL.arrow} weight="medium" color={theme.textSecondary} style={ARROW} />
        </View>
      </Panel>
    </Pressable>
  );
}

function PillIcon({ tab, size }: { tab: PillTab; size: number }) {
  const engine = markedEngine(tab.marks);
  const glyph = <PillGlyph tab={tab} size={size} />;
  return (
    <View style={{ opacity: tab.marks & FADED ? SLEEPING_OPACITY : 1 }}>
      {glyph}
      {engine ? <EngineMark mark={engine} size={size} /> : null}
    </View>
  );
}

function PillGlyph({ tab, size }: { tab: PillTab; size: number }) {
  const theme = useTheme();
  const [broken, setBroken] = useState<string | null>(null);
  const icon = drawnIcon(tab.icon);
  const symbol = iconSymbol(icon);
  if (symbol) return <Symbol name={symbol} size={size - 3} weight="medium" color={theme.icon} style={{ width: size, height: size }} />;
  if (icon) return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}><Text style={{ fontSize: size - 3, lineHeight: size }}>{icon}</Text></View>;
  if (!tab.url && !tab.faviconUri) return <NewTabIcon size={size} />;
  if (!tab.faviconUri || broken === tab.faviconUri) return <FaviconFallback url={tab.url} size={size} />;
  const uri = tab.faviconUri;
  return tintedImage({
    source: { uri },
    identity: uri,
    tint: tab.template && !theme.dark ? theme.textPrimary : undefined,
    onError: () => setBroken(uri),
    style: { width: size, height: size, borderRadius: radius.hair },
  });
}

const PLACE = { position: "absolute", left: 0, right: 0, alignItems: "center" } as const;
const AT_BOTTOM = { bottom: SELECTED_ROW_PILL.gap } as const;
const AT_TOP = { top: SELECTED_ROW_PILL.gap } as const;
const FACE = {
  height: SELECTED_ROW_PILL.height,
  flexDirection: "row",
  alignItems: "center",
  gap: SELECTED_ROW_PILL.iconGap,
  paddingLeft: SELECTED_ROW_PILL.padLeft,
  paddingRight: SELECTED_ROW_PILL.padRight,
} as const;
const ARROW = { width: SELECTED_ROW_PILL.arrow, height: SELECTED_ROW_PILL.arrow + 2 } as const;
