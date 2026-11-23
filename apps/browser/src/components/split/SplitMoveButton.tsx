import { memo, useMemo, useRef } from "react";
import { PanResponder, View } from "react-native";
import { TOOLBAR_TRAILING } from "../../lib/toolbarRow";
import { useShortcutHints } from "../../state/commands/commandShortcuts";
import { useSplitForTab } from "../../state/splits/hooks";
import { beginSplitMoveDrag, cancelSplitMoveDrag, finishSplitMoveDrag, updateSplitMoveDrag, useSplitMoveDrag } from "../../state/splits/moveDrag";
import { useHover, useTooltip } from "../ui";
import type { ToolbarPalette } from "../ui/toolbarColors";
import { useToolbarRow } from "../toolbar/useToolbarRow";
import { SplitMoveIcon } from "./SplitMoveIcon";
import { moveHandleTooltip } from "./splitMove";
import { MOVE_HANDLE } from "./tokens";

const MOVE_HINTS = ["movePaneLeft", "movePaneRight", "movePaneUp", "movePaneDown"] as const;

export const SplitMoveButton = memo(function SplitMoveButton({
  windowId,
  tabId,
  palette,
}: {
  windowId: string;
  tabId: string;
  palette: ToolbarPalette;
}) {
  const row = useToolbarRow();
  const split = useSplitForTab(tabId);
  const hints = useShortcutHints(MOVE_HINTS);
  const tooltip = useTooltip(moveHandleTooltip(split, hints));
  const drag = useSplitMoveDrag(windowId);
  const { hovered, hoverProps, clearHover } = useHover();
  const draggingThis = drag?.tabId === tabId;
  const draggingAny = !!drag?.moved;
  const latest = useRef({ windowId, tabId, clearHover });
  latest.current = { windowId, tabId, clearHover };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          const cur = latest.current;
          beginSplitMoveDrag(cur.windowId, cur.tabId, "toolbar");
        },
        onPanResponderMove: (_, g) => updateSplitMoveDrag(latest.current.windowId, latest.current.tabId, g.dx, g.dy, MOVE_HANDLE.dragSlop),
        onPanResponderRelease: (_, g) => {
          const cur = latest.current;
          cur.clearHover();
          finishSplitMoveDrag(cur.windowId, cur.tabId, g.dx, g.dy);
        },
        onPanResponderTerminate: () => {
          const cur = latest.current;
          cur.clearHover();
          cancelSplitMoveDrag(false, cur.windowId, cur.tabId);
        },
      }),
    [],
  );

  return (
    <View
      testID={`ardia.splitMoveHandle.${tabId}`}
      accessibilityRole="button"
      accessibilityLabel="Move Split Pane"
      tooltip={draggingAny ? undefined : tooltip}
      mouseDownCanMoveWindow={false}
      {...hoverProps}
      {...responder.panHandlers}
      style={{
        width: row.button,
        height: row.button,
        borderRadius: row.buttonRadius,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered || draggingThis ? palette.hover : undefined,
        cursor: draggingThis ? "grabbing" : "grab",
      }}
    >
      <SplitMoveIcon size={TOOLBAR_TRAILING.splitGlyph} color={palette.icon} />
    </View>
  );
});
