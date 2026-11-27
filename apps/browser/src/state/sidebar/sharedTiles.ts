import { useMemo } from "react";
import { Animated } from "react-native";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useBrowser, type BrowserState } from "../browser/store";
import { topAppsShared } from "../pins/topApps";
import { pagerFor } from "../windows/profilePager";

type SharedSides = { before: boolean; after: boolean };

export function sharedTileSides(s: Pick<BrowserState, "profiles" | "profileOrder">, slot: number): SharedSides {
  const id = s.profileOrder[slot];
  const neighbour = (other: string | undefined) => !!id && !!other && topAppsShared(s, id, other);
  return { before: neighbour(s.profileOrder[slot - 1]), after: neighbour(s.profileOrder[slot + 1]) };
}

export function sharedTilesMotion(pos: Animated.Value, slot: number, width: number, { before, after }: SharedSides) {
  const inputRange = [slot - 1, slot, slot + 1];
  return {
    opacity: pos.interpolate({ inputRange, outputRange: [before ? 0 : 1, 1, after ? 0 : 1], extrapolate: "clamp" }),
    transform: [{ translateX: pos.interpolate({ inputRange, outputRange: [before ? -width : 0, 0, after ? width : 0], extrapolate: "clamp" }) }],
  };
}

const HANDOFF = 0.001;

type PlayerShifts = { before: number; after: number };
const NO_SHIFT: PlayerShifts = { before: 0, after: 0 };

export function stationaryPlayerMotion(pos: Animated.Value, slot: number, width: number, { before, after }: SharedSides, shifts: PlayerShifts = NO_SHIFT) {
  const handoff = [slot - 1, slot - 0.5 - HANDOFF, slot - 0.5, slot + 0.5, slot + 0.5 + HANDOFF, slot + 1];
  const beforeShown = before ? 0 : 1;
  const afterShown = after ? 0 : 1;
  const across = [slot - 1, slot, slot + 1];
  return {
    opacity: pos.interpolate({ inputRange: handoff, outputRange: [beforeShown, beforeShown, 1, 1, afterShown, afterShown], extrapolate: "clamp" }),
    transform: [
      { translateX: pos.interpolate({ inputRange: across, outputRange: [before ? -width : 0, 0, after ? width : 0], extrapolate: "clamp" }) },
      { translateY: pos.interpolate({ inputRange: across, outputRange: [before ? shifts.before : 0, 0, after ? shifts.after : 0], extrapolate: "clamp" }) },
    ],
  };
}

const usePlayerTops = create<Record<string, Record<string, number>>>()(() => ({}));

export function notePlayerTop(windowId: string, profileId: string, top: number | null) {
  const tops = usePlayerTops.getState()[windowId] ?? {};
  if ((tops[profileId] ?? null) === top) return;
  const { [profileId]: _gone, ...rest } = tops;
  usePlayerTops.setState({ [windowId]: top === null ? rest : { ...rest, [profileId]: top } });
}

export function useStationaryPlayerStyle(windowId: string, slot: number, width: number, shared: boolean) {
  const { pos } = pagerFor(windowId);
  const [beforeId, ownId, afterId] = useBrowser(useShallow((s) => (shared ? [s.profileOrder[slot - 1], s.profileOrder[slot], s.profileOrder[slot + 1]] : [undefined, undefined, undefined])));
  const [beforeTop, ownTop, afterTop] = usePlayerTops(useShallow((t) => [beforeId && t[windowId]?.[beforeId], ownId && t[windowId]?.[ownId], afterId && t[windowId]?.[afterId]]));
  const shift = (top: unknown) => (typeof top === "number" && typeof ownTop === "number" ? top - ownTop : 0);
  const before = !!beforeId;
  const after = !!afterId;
  const beforeShift = shift(beforeTop);
  const afterShift = shift(afterTop);
  return useMemo(
    () => (before || after ? stationaryPlayerMotion(pos, slot, width, { before, after }, { before: beforeShift, after: afterShift }) : null),
    [pos, slot, width, before, after, beforeShift, afterShift],
  );
}

export function useSharedTilesStyle(windowId: string, slot: number, width: number, paging: boolean) {
  const { pos } = pagerFor(windowId);
  const [before, after] = useBrowser(
    useShallow((s) => {
      if (!paging) return [false, false] as const;
      const sides = sharedTileSides(s, slot);
      return [sides.before, sides.after] as const;
    }),
  );
  return useMemo(() => (before || after ? sharedTilesMotion(pos, slot, width, { before, after }) : null), [pos, slot, width, before, after]);
}
