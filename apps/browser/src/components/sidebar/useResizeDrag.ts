import { useMemo, useRef } from "react";
import { PanResponder, type GestureResponderHandlers } from "react-native";
import { resizeGesture, type ResizeDragOptions } from "./resizeDrag";

export function useResizeDrag(o: ResizeDragOptions): GestureResponderHandlers {
  const latest = useRef(o);
  latest.current = o;
  return useMemo(() => PanResponder.create(resizeGesture(latest)).panHandlers, []);
}
