import { useEffect, useRef, useState, type RefObject } from "react";
import { Animated, Pressable, View, type ScrollView } from "react-native";
import { useActiveTabId, useTab } from "../../state/browser/hooks";
import { revealTab, selectedTabIn, watchRowsMoved } from "../../state/sidebar/reveal";
import { notePageOverlay } from "../../state/telemetry/usage";
import { curve, duration, usePresence } from "../ui/motion";
import { Symbol } from "../ui";
import { useTheme } from "../ui/theme";
import { HudPlate } from "../window/Hud";
import type { SidebarGeometry } from "./pageLayout";
import { locateTab, rowAway, type RowAway, type RowSpot } from "./selectedRow";
import { TabIcon } from "./TabIcon";
import { SELECTED_ROW_PILL } from "./tokens";

const MOTION = {
  show: { duration: duration.fast, easing: curve.enter },
  hide: { duration: duration.fast, easing: curve.exit },
} as const;

export function useSelectedRowAway(windowId: string, geometry: RefObject<SidebarGeometry> | undefined, scroll: RefObject<ScrollView | null>, scrollY: () => number) {
  const [away, setAway] = useState<RowAway>(null);
  const live = useRef({ geometry, scrollY });
  live.current = { geometry, scrollY };
  const [tracker] = useState(() => {
    let row: RowSpot | null = null;
    let ticket = 0;
    let frame = 0;
    const judge = () => {
      const page = live.current.geometry?.current;
      setAway(page ? rowAway(row, live.current.scrollY(), page.viewport) : null);
    };
    const locate = () => {
      frame = 0;
      const mine = ++ticket;
      const page = live.current.geometry?.current;
      const tabId = selectedTabIn(windowId);
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
      stop: () => cancelAnimationFrame(frame),
    };
  });
  useEffect(() => {
    tracker.relocate();
    const unsubscribe = watchRowsMoved(tracker.relocate);
    return () => {
      unsubscribe();
      tracker.stop();
    };
  }, [windowId, geometry]);
  return { away, judge: tracker.judge, relocate: tracker.relocate };
}

export function SelectedRowPill({ windowId, away }: { windowId: string; away: RowAway }) {
  const { shown, appear } = usePresence(away, MOTION);
  useEffect(() => {
    if (away) notePageOverlay("selectedRowPillShown");
  }, [away]);
  if (!shown) return null;
  return (
    <View pointerEvents="box-none" style={[PLACE, shown === "below" ? AT_BOTTOM : AT_TOP]}>
      <Animated.View
        pointerEvents={away ? "auto" : "none"}
        style={{ opacity: appear, transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [SELECTED_ROW_PILL.enterScale, 1] }) }] }}
      >
        <PillFace windowId={windowId} direction={shown} />
      </Animated.View>
    </View>
  );
}

function PillFace({ windowId, direction }: { windowId: string; direction: "above" | "below" }) {
  const theme = useTheme();
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
      <HudPlate shape="capsule" height={SELECTED_ROW_PILL.height}>
        <View style={FACE}>
          <TabIcon tabId={tabId ?? undefined} url={url} favicon={favicon} icon={icon} size={SELECTED_ROW_PILL.icon} />
          <Symbol name={direction === "below" ? "arrow.down" : "arrow.up"} size={SELECTED_ROW_PILL.arrow} weight="medium" color={theme.textSecondary} style={ARROW} />
        </View>
      </HudPlate>
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
