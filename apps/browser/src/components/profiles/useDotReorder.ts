import { useLayoutEffect, useRef, useState } from "react";
import { Animated, PanResponder, type PanResponderInstance } from "react-native";
import { hapticTick } from "../../state/app/system";
import { reorderProfiles } from "../../state/profiles/actions";
import { noteProfileDotReorder } from "../../state/telemetry/pagerCounts";
import { curve, duration } from "../ui/motion";
import { dotDrag, dotShifts, movedOrder } from "./dotReorder";

const DRAG_START_DISTANCE = 4;

const settle = (value: Animated.Value, toValue: number) => Animated.timing(value, { toValue, duration: duration.base, easing: curve.enter, useNativeDriver: true });

export type DotReorder = { dragging: string | null; offsetOf(id: string): Animated.Value; panFor(id: string): PanResponderInstance };

export function useDotReorder(ids: string[], widths: number[]): DotReorder {
  const offsets = useRef(new Map<string, Animated.Value>()).current;
  const pans = useRef(new Map<string, PanResponderInstance>()).current;
  const [dragging, setDragging] = useState<string | null>(null);
  const live = useRef({ ids, widths });
  live.current = { ids, widths };
  const drag = useRef({ id: "", to: -1, committed: false, downX: 0 });

  useLayoutEffect(() => {
    if (!drag.current.committed) return;
    drag.current.committed = false;
    offsets.forEach((v) => v.setValue(0));
  }, [ids]);

  const offsetOf = (id: string) => {
    let v = offsets.get(id);
    if (!v) offsets.set(id, (v = new Animated.Value(0)));
    return v;
  };

  const controller = useRef({
    press(pageX: number) {
      drag.current.downX = pageX;
    },
    start(id: string) {
      drag.current = { id, to: live.current.ids.indexOf(id), committed: false, downX: drag.current.downX };
      setDragging(id);
    },
    moveTo(pageX: number) {
      const dx = pageX - drag.current.downX;
      const { id } = drag.current;
      const { ids, widths } = live.current;
      const from = ids.indexOf(id);
      if (from < 0) return;
      const { shift, to } = dotDrag(widths, from, dx);
      offsetOf(id).setValue(shift);
      if (to === drag.current.to) return;
      drag.current.to = to;
      hapticTick();
      const shifts = dotShifts(widths, from, to);
      ids.forEach((other, j) => other !== id && settle(offsetOf(other), shifts[j]!).start());
    },
    end(commit: boolean) {
      const { id, to } = drag.current;
      const { ids } = live.current;
      const from = ids.indexOf(id);
      setDragging(null);
      if (!commit || from < 0 || to < 0 || from === to) {
        offsets.forEach((v) => settle(v, 0).start());
        return;
      }
      drag.current.committed = true;
      reorderProfiles(movedOrder(ids, from, to));
      noteProfileDotReorder();
    },
  }).current;

  const panFor = (id: string) => {
    let pan = pans.get(id);
    if (!pan) {
      pan = PanResponder.create({
        onStartShouldSetPanResponderCapture: (e) => {
          controller.press(e.nativeEvent.pageX);
          return false;
        },
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > DRAG_START_DISTANCE && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderGrant: () => controller.start(id),
        onPanResponderMove: (e) => controller.moveTo(e.nativeEvent.pageX),
        onPanResponderRelease: (e) => {
          controller.moveTo(e.nativeEvent.pageX);
          controller.end(true);
        },
        onPanResponderTerminate: () => controller.end(false),
        onPanResponderTerminationRequest: () => false,
      });
      pans.set(id, pan);
    }
    return pan;
  };

  return { dragging, offsetOf, panFor };
}
