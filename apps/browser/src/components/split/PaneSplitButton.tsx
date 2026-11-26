import { useEffect, useMemo, useRef } from "react";
import { PanResponder, View } from "react-native";
import { Button } from "../ui";
import type { ToolbarPalette } from "../ui/toolbarColors";
import { showSplitMenu } from "../../state/splits/actions";
import { useSplitOrientation } from "../../state/splits/hooks";
import { beginTabDrag, cancelTabDrag, endTabDrag, setDragPicture, tabDragging, tabDragSeq, updateTabDrag } from "../../state/drag/tabDrag";
import { captureEscape, onAppEvent } from "../../state/drag/dragNative";
import { dragGesture } from "../sidebar/dragGesture";

const CLICK_AFTER_DRAG_MS = 300;

export function usePaneDrag(tabId: string) {
  const view = useRef<View>(null);
  const latest = useRef(tabId);
  latest.current = tabId;
  const drag = useRef(0);
  const clicksIgnoredUntil = useRef(0);
  const pointer = useRef([0, 0]);
  const owned = () => !!drag.current && tabDragSeq() === drag.current;
  const stop = useRef((commit: boolean) => {
    if (!drag.current) return;
    const mine = owned();
    drag.current = 0;
    clicksIgnoredUntil.current = Date.now() + CLICK_AFTER_DRAG_MS;
    captureEscape("paneDrag", false);
    if (!mine) return;
    if (commit) endTabDrag();
    else cancelTabDrag();
  }).current;
  useEffect(() => {
    const escape = onAppEvent((e) => e.type === "dragEscape" && stop(false));
    return () => {
      escape.remove();
      stop(false);
    };
  }, []);
  const responder = useMemo(
    () =>
      PanResponder.create(
        dragGesture(true, {
          begin: (x, y) => {
            if (tabDragging()) return;
            clicksIgnoredUntil.current = Infinity;
            const seq = (drag.current = beginTabDrag(latest.current, undefined, { staysOnPage: true }));
            captureEscape("paneDrag", true);
            pointer.current = [x, y];
            updateTabDrag(x, y);
            view.current?.measureInWindow((left, top, width, height) =>
              setDragPicture(seq, () => [pointer.current[0]! - (x - left), pointer.current[1]! - (y - top), width, height], [pointer.current[0]!, pointer.current[1]!]),
            );
          },
          move: (x, y) => {
            if (!owned()) return;
            pointer.current = [x, y];
            updateTabDrag(x, y);
          },
          end: stop,
        }),
      ),
    [],
  );
  const pressed = () => {
    if (!drag.current) clicksIgnoredUntil.current = 0;
  };
  const clicked = (open: () => void) => {
    const ignored = Date.now() < clicksIgnoredUntil.current;
    clicksIgnoredUntil.current = 0;
    if (!ignored) open();
  };
  return { ref: view, panHandlers: responder.panHandlers, pressed, clicked };
}

export function PaneSplitButton({ tabId, palette }: { tabId: string; palette: ToolbarPalette }) {
  const drag = usePaneDrag(tabId);
  const orientation = useSplitOrientation(tabId);
  return (
    <View ref={drag.ref} {...drag.panHandlers} collapsable={false} mouseDownCanMoveWindow={false}>
      <Button variant="icon" toolbar palette={palette} icon={orientation === "vertical" ? "rectangle.split.1x2" : "rectangle.split.2x1"} look="row" onPressIn={drag.pressed} onPress={() => drag.clicked(() => void showSplitMenu(tabId))} tooltip="Split View" />
    </View>
  );
}
