import { layout, useScopedTheme } from "../ui/theme";
import { devRegister } from "../dev/devRegister";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { PanResponder, type View } from "react-native";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { perLook, radius } from "../ui";
import { useClipped, type ClipSource } from "./EntryMotion";
import { noDragMarks } from "../../state/sidebar/dragMarks";
import { cellKey, restingTail, type Ghost, type ItemSpec } from "./dragModel";
import { DragController } from "./dragController";
import { DragItems } from "./dragItems";
import { onAppEvent } from "../../state/drag/dragNative";
import { WindowDropGlow } from "../tabstrip/WindowDropGlow";
import { TAB_CLICK_SLOP } from "../../state/sidebar/heldTabPress";

const dropGlowPlace = perLook(() => ({ left: 5, right: 5, top: 44, bottom: 6, borderRadius: radius.chrome }));

const DragContext = createContext<DragController | null>(null);
const DragItemsContext = createContext<DragItems | null>(null);

export function DragProvider({ children }: { children: (ghost: Ghost | null, controller: DragController) => ReactNode }) {
  const controller = useMemo(() => new DragController(), []);
  const items = useMemo(() => new DragItems(controller, true), [controller]);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  controller.setGhost = setGhost;
  useEffect(() => () => void (controller.active && controller.end(false)), [controller]);
  useEffect(() => devRegister("sidebarDrag", null, controller), [controller]);
  useEffect(() => {
    const sub = onAppEvent((e) => e.type === "dragEscape" && controller.active && controller.end(false));
    return () => sub.remove();
  }, [controller]);
  return (
    <DragContext.Provider value={controller}>
      <DragItemsContext.Provider value={items}>
        {children(ghost, controller)}
        <WindowDropGlow place={dropGlowPlace()} />
      </DragItemsContext.Provider>
    </DragContext.Provider>
  );
}

export function DragPage({ live, children }: { live: boolean; children: ReactNode }) {
  const controller = useContext(DragContext);
  const items = useMemo(() => controller && new DragItems(controller, false), [controller]);
  useLayoutEffect(() => items?.setLive(live), [items, live]);
  return <DragItemsContext.Provider value={items}>{children}</DragItemsContext.Provider>;
}

export function DragScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const controller = useContext(DragContext);
  return <DragContext.Provider value={enabled ? controller : null}>{children}</DragContext.Provider>;
}

export const useDragController = () => useContext(DragContext) ?? undefined;
export const useDropInto = (groupId: string) => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.dropInto === groupId);
export const useDropSplit = (key: string) => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => (m.split?.key === key ? m.split.side : null));
export const useDropLine = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.line);
export const useDropTile = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.tile);
export const useDropRow = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.row);
export const useDropPins = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.pins);
export const usePinSlots = (cells: string[]) =>
  useStore(
    useContext(DragContext)?.marks ?? noDragMarks,
    useShallow((m) => {
      let slot = 0;
      return cells.map((cell) => {
        const key = cellKey(cell);
        if (m.pinBefore === key) slot += m.pinCount;
        return m.sources.has(key) ? slot : slot++;
      });
    }),
  );
export const usePinnedCount = (cells: string[]) =>
  useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => cells.reduce((n, cell) => n + (m.sources.has(cellKey(cell)) ? 0 : 1), 0) + m.pinCount);
export const useFolderTarget = (key: string) => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.folderTarget === key);
export const useFolderAway = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.folderAway);
export const useEdgeHold = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.edgeHold);
export const useOverProfiles = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.overProfiles);
export const useProfileHold = (profileId: string) => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.profileHold === profileId);
export const useProfileTarget = (profileId: string) => {
  const controller = useContext(DragContext);
  return useCallback(
    (view: View | null) => {
      if (!controller) return;
      if (view) controller.profiles.views.set(profileId, view);
      else controller.profiles.views.delete(profileId);
    },
    [controller, profileId],
  );
};
export const useDragging = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.sources.size > 0);

export function useDragItem(key: string, spec: ItemSpec, clip: ClipSource | null = null) {
  const items = useContext(DragItemsContext);
  const controller = items?.controller;
  const marks = controller?.marks ?? noDragMarks;
  const item = useMemo(() => controller?.create(key), [controller, key]);
  if (item) Object.assign(item, spec);
  useEffect(() => {
    if (!items || !item) return;
    return items.add(key, item);
  }, [items, item, key]);

  const responder = useMemo(() => {
    let far = 0;
    let pressAt = [0, 0];
    const reach = (x: number, y: number) => (far = Math.max(far, Math.hypot(x - pressAt[0]!, y - pressAt[1]!)));
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        pressAt = [g.moveX - g.dx, g.moveY - g.dy];
        return spec.kind !== "tail" && Math.hypot(g.dx, g.dy) > 4;
      },
      onPanResponderGrant: (_, g) => {
        far = 0;
        reach(g.moveX, g.moveY);
        void controller?.begin(key, g.x0, g.y0);
      },
      onPanResponderMove: (_, g) => {
        reach(g.moveX, g.moveY);
        controller?.move(g.moveX, g.moveY);
      },
      onPanResponderRelease: (e, g) => controller?.end(true, Math.max(reach(g.moveX, g.moveY), reach(e.nativeEvent.pageX, e.nativeEvent.pageY)) <= TAB_CLICK_SLOP ? e : null),
      onPanResponderTerminate: () => controller?.interrupt(),
      onPanResponderTerminationRequest: () => false,
    });
  }, [controller, key]);
  const ref = useCallback(
    (view: View | null) => {
      if (item) item.view = view;
    },
    [item],
  );
  const headerRef = useCallback(
    (view: View | null) => {
      if (item) item.header = view;
    },
    [item],
  );

  const source = useStore(marks, (m) => m.sources.has(key));
  const landing = useStore(marks, (m) => m.landing === key);
  const clipped = useClipped(clip);
  const horizontal = spec.kind === "tile";
  useScopedTheme();
  const hidden = (source && horizontal) || landing;
  const style = {
    ...(spec.kind === "tail" ? restingTail() : null),
    ...(item && hidden ? { opacity: 0 } : null),
    ...(item && clipped && !hidden ? { marginTop: -layout.rowGap, paddingTop: layout.rowGap, overflow: "hidden" as const } : null),
  };
  return { wrapper: { ref, style }, handle: responder.panHandlers, headerRef, dragging: source, gap: item?.gap };
}
