import { useEffect, useRef, useState, type RefObject } from "react";
import { Animated, Pressable, View, type ScrollView } from "react-native";
import { useActiveTabId, useTab } from "../../state/browser/hooks";
import { revealTab, selectedTabIn, watchRowsMoved } from "../../state/sidebar/reveal";
import { notePageOverlay } from "../../state/telemetry/usage";
import { capsule, Panel, reduceMotion, Symbol } from "../ui";
import { useTheme } from "../ui/theme";
import { SHADOWS } from "../window/tokens";
import type { SidebarGeometry } from "./pageLayout";
import { locateTab, rowAway, type RowAway, type RowSpot } from "./selectedRow";
import { TabIcon } from "./TabIcon";
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

export function useSelectedRowAway(windowId: string, geometry: RefObject<SidebarGeometry> | undefined, scroll: RefObject<ScrollView | null>, scrollY: () => number) {
  const [away, setAway] = useState<RowAway>(null);
  const live = useRef({ geometry, scrollY });
  live.current = { geometry, scrollY };
  const [tracker] = useState(() => {
    let row: RowSpot | null = null;
    let ticket = 0;
    let frame = 0;
    let selected: string | null | undefined;
    let quietUntil = 0;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const judge = () => {
      const page = live.current.geometry?.current;
      setAway(page && Date.now() >= quietUntil ? rowAway(row, live.current.scrollY(), page.viewport, page.edgeLift) : null);
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
      frame = 0;
      const mine = ++ticket;
      const page = live.current.geometry?.current;
      const tabId = selectedTabIn(windowId);
      settleAfterSwitch(tabId ?? null);
      const found = page && tabId ? locateTab(windowId, tabId, page, scroll.current, () => live.current.scrollY()) : null;
      if (found && "then" in found) {
        void found.then((spot) => {
          if (mine !== ticket) return;
          row = spot;
          judge();
        });
        return;
      }
      row = found;
      judge();
    };
    return {
      judge,
      relocate: () => {
        if (!frame) frame = requestAnimationFrame(locate);
      },
      stop: () => {
        cancelAnimationFrame(frame);
        frame = 0;
        clearTimeout(quiet);
      },
    };
  });
  useEffect(() => {
    if (!geometry) return void tracker.judge();
    tracker.relocate();
    const unsubscribe = watchRowsMoved(tracker.relocate);
    return () => {
      unsubscribe();
      tracker.stop();
    };
  }, [windowId, geometry]);
  return { away, judge: tracker.judge, relocate: tracker.relocate };
}

export function SelectedRowPill({ windowId, away, bottomShift }: { windowId: string; away: RowAway; bottomShift?: Animated.AnimatedInterpolation<number> }) {
  const [shown, setShown] = useState<RowAway>(away);
  const [leaving, setLeaving] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (away) {
      notePageOverlay("selectedRowPillShown");
      setShown(away);
      setLeaving(false);
      return settle(progress, "enter");
    }
    setLeaving(true);
    return settle(progress, "exit", () => setShown(null));
  }, [away]);
  if (!shown) return null;
  const outward = shown === "below" ? 1 : -1;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[PLACE, shown === "below" ? AT_BOTTOM : AT_TOP, shown === "below" && bottomShift ? { transform: [{ translateY: bottomShift }] } : null]}
    >
      <Animated.View pointerEvents={away ? "auto" : "none"} style={leaving ? leaveStyle(progress, outward) : enterStyle(progress, outward)}>
        <PillFace windowId={windowId} direction={shown} />
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

function PillFace({ windowId, direction }: { windowId: string; direction: "above" | "below" }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const tabId = useActiveTabId();
  const url = useTab(tabId ?? "", (t) => t?.url ?? "");
  const favicon = useTab(tabId ?? "", (t) => t?.favicon ?? null);
  const icon = useTab(tabId ?? "", (t) => t?.customIcon ?? null);
  const press = () => {
    if (!tabId) return;
    notePageOverlay("selectedRowPillPressed");
    revealTab(windowId, tabId);
  };
  return (
    <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={direction === "below" ? "Scroll down to the selected tab" : "Scroll up to the selected tab"}>
      <Panel fill={tokens.selectedRowPillFill} border={tokens.selectedRowPillStroke} radius={capsule(SELECTED_ROW_PILL.height)} shadow={SHADOWS.status}>
        <View style={FACE}>
          <TabIcon tabId={tabId ?? undefined} url={url} favicon={favicon} icon={icon} size={SELECTED_ROW_PILL.icon} />
          <Symbol name={direction === "below" ? "arrow.down" : "arrow.up"} size={SELECTED_ROW_PILL.arrow} weight="medium" color={theme.textSecondary} style={ARROW} />
        </View>
      </Panel>
    </Pressable>
  );
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
