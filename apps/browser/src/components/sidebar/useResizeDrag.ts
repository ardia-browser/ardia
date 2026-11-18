import { useEffect, useMemo, useRef } from "react";
import { PanResponder, type GestureResponderHandlers } from "react-native";
import { resizeGesture, type ResizeDragOptions } from "./resizeDrag";

export function useResizeDrag(o: ResizeDragOptions): GestureResponderHandlers {
  const latest = useRef(o);
  latest.current = o;
  const gesture = useMemo(() => resizeGesture(latest), []);
  useEffect(() => gesture.abandon, [gesture]);
  return useMemo(() => PanResponder.create(gesture).panHandlers, [gesture]);
}
