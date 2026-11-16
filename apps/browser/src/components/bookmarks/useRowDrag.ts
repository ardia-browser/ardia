import { useMemo, useRef, useState } from "react";
import { Animated, PanResponder } from "react-native";

export type RowDragHandlers = {
  onDragStart: () => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: (x: number, y: number) => void;
};

const DRAG_THRESHOLD = { dx: 8, dy: 4 } as const;

export function useRowDrag(handlers: RowDragHandlers | null) {
  const dy = useRef(new Animated.Value(0)).current;
  const [dragging, setDragging] = useState(false);
  const current = useRef(handlers);
  current.current = handlers;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => !!current.current && (Math.abs(g.dy) > DRAG_THRESHOLD.dy || Math.abs(g.dx) > DRAG_THRESHOLD.dx),
        onPanResponderGrant: () => {
          setDragging(true);
          current.current?.onDragStart();
        },
        onPanResponderMove: (_, g) => {
          dy.setValue(g.dy);
          current.current?.onDragMove(g.moveX, g.moveY);
        },
        onPanResponderRelease: (_, g) => {
          dy.setValue(0);
          setDragging(false);
          current.current?.onDragEnd(g.moveX, g.moveY);
        },
        onPanResponderTerminate: () => {
          dy.setValue(0);
          setDragging(false);
          current.current?.onDragEnd(-1, -1);
        },
      }),
    [],
  );
  return { panHandlers: responder.panHandlers, dy, dragging };
}
