import { layout, useScopedTheme } from "../ui/theme";
import { devRegister } from "../dev/devRegister";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Animated, PanResponder, type View } from "react-native";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { perLook, radius } from "../ui";
import { useClipped, type ClipSource } from "./EntryMotion";
import { LANDING, markNow, noDragMarks, SOURCE, SPLIT_LEFT, SPLIT_RIGHT, watchMarks, type SplitHalfMark } from "../../state/sidebar/dragMarks";
import { useKeyed } from "../../state/browser/keyedWatch";
import { cellKey, dragItemStyle, restingTail, type Ghost, type ItemSpec } from "./dragModel";
import { DragController } from "./dragController";
import { DragItems } from "./dragItems";
import { onAppEvent } from "../../state/drag/dragNative";
import { WindowDropGlow } from "../tabstrip/WindowDropGlow";
import { dragGesture } from "./dragGesture";
import { FoldedAway } from "./hoverController";
import { useWindowId } from "../../state/browser/hooks";

const dropGlowPlace = perLook(() => ({ left: 5, right: 5, top: 44, bottom: 6, borderRadius: radius.chrome }));

const DragContext = createContext<DragController | null>(null);
const DragItemsContext = createContext<DragItems | null>(null);
export const FoldEntryContext = createContext(false);


export function DragProvider({ children }: { children: (ghost: Ghost | null, controller: DragController) => ReactNode }) {
  const controller = useMemo(() => new DragController(), []);
  controller.windowId = useWindowId();
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

export function useDragPage(live: boolean) {
  const controller = useContext(DragContext);
  const items = useMemo(() => controller && new DragItems(controller, false), [controller]);
  useLayoutEffect(() => items?.setLive(live), [items, live]);
  return (children: ReactNode) => <DragItemsContext.Provider value={items}>{children}</DragItemsContext.Provider>;
}

export function DragScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const controller = useContext(DragContext);
  return <DragContext.Provider value={enabled ? controller : null}>{children}</DragContext.Provider>;
}

export const useDragController = () => useContext(DragContext) ?? undefined;
export const useDropInto = (groupId: string) => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.dropInto === groupId);
export const useDropTile = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.tile);
export const useDropRow = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.row);
export const useDropPane = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.pane);
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
export const useDragFolded = (key: string) => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.folded === key);
export const useDragging = () => useStore(useContext(DragContext)?.marks ?? noDragMarks, (m) => m.sources.size > 0);

export function useCollapsingSlot(key: string, gap: number) {
  const controller = useContext(DragItemsContext)?.controller;
  const source = useStore(controller?.marks ?? noDragMarks, (m) => m.sources.has(key));
  const item = source ? controller?.items.get(key) : undefined;
  return useMemo(() => (item && item.kind !== "tile" ? { marginBottom: -gap } : null), [item, gap]);
}

export function useDragItem(key: string, spec: ItemSpec, clip: ClipSource | null = null) {
  const items = useContext(DragItemsContext);
  const controller = items?.controller;
  const marks = controller?.marks ?? noDragMarks;
  const item = useMemo(() => controller?.create(key), [controller, key]);
  if (item) Object.assign(item, spec);
  const folded = useContext(FoldedAway);
  useEffect(() => {
    if (!items || !item) return;
    return items.addWhileShown(key, item, folded);
  }, [items, item, key, folded]);

  const responder = useMemo(
    () =>
      PanResponder.create(
        dragGesture(spec.kind !== "tail", {
          begin: (x, y) => void controller?.begin(key, x, y),
          move: (x, y) => controller?.move(x, y),
          end: (commit) => (commit ? controller?.end(true) : controller?.interrupt()),
        }),
      ),
    [controller, key],
  );
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

  const mark = useKeyed(watchMarks(marks), key, () => markNow(marks, key));
  const source = !!(mark & SOURCE);
  const landing = !!(mark & LANDING);
  const scoped = !!useContext(DragContext);
  const clipped = useClipped(clip);
  useScopedTheme();
  const inFold = useContext(FoldEntryContext);
  const rowGap = layout.rowGap;
  const tailOffset = useMemo(() => item && Animated.add(item.gap, -rowGap), [item, rowGap]);
  const style = item
    ? dragItemStyle(item, { source, landing, clipped, inFold, rowGap, tailOffset: tailOffset! })
    : spec.kind === "tail"
      ? restingTail()
      : {};
  const splitSide: SplitHalfMark["side"] | null = !scoped ? null : mark & SPLIT_LEFT ? "left" : mark & SPLIT_RIGHT ? "right" : null;
  return { wrapper: { ref, style }, handle: responder.panHandlers, headerRef, dragging: source, gap: item?.gap, splitSide };
}
