import type { GestureResponderEvent, PanResponderGestureState } from "react-native";
import { TAB_CLICK_SLOP } from "../../state/sidebar/heldTabPress";

type Travel = Pick<PanResponderGestureState, "dx" | "dy">;

type DragGestureTarget = {
  begin: (x: number, y: number) => void;
  move: (x: number, y: number) => void;
  end: (commit: boolean) => void;
};

export const leavesClickSlop = ({ dx, dy }: Travel) => Math.hypot(dx, dy) > TAB_CLICK_SLOP;

export function dragGesture(draggable: boolean, target: DragGestureTarget) {
  return {
    onMoveShouldSetPanResponder: (_: GestureResponderEvent, g: Travel) => draggable && leavesClickSlop(g),
    onPanResponderGrant: (_: GestureResponderEvent, g: PanResponderGestureState) => target.begin(g.x0, g.y0),
    onPanResponderMove: (_: GestureResponderEvent, g: PanResponderGestureState) => target.move(g.moveX, g.moveY),
    onPanResponderRelease: () => target.end(true),
    onPanResponderTerminate: () => target.end(false),
    onPanResponderTerminationRequest: () => false,
  };
}
