import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { View } from "react-native";
import type { DragController } from "./dragController";
import { joinsLaunchRows, launchRowsHolding, launchRowsStarted, noteLaunchRowsCancelled, noteLaunchRowsDeferred, noteLaunchRowsMounted, releaseLaunchRows, startLaunchRows, useLaunchRowsHolding } from "../../state/sidebar/launchRows";

type LaunchGrowthInput = { lazy: boolean; current: boolean; total: number; shownRows: number; controller: DragController | undefined };

export function useLaunchGrowth(windowId: string, { lazy, current, total, shownRows, controller }: LaunchGrowthInput) {
  const holdingNow = useLaunchRowsHolding(windowId);
  const holding = lazy && holdingNow;
  const [launch] = useState(() => lazy && current && joinsLaunchRows(windowId));
  const list = useRef<View | null>(null);
  const counted = useRef(false);
  const shown = useRef(shownRows);
  shown.current = shownRows;

  useLayoutEffect(() => {
    if (!launch) return;
    let live = true;
    const contentShown = () => {
      if (!live) return;
      startLaunchRows();
      if (!launchRowsHolding(windowId) || total <= shown.current) return;
      noteLaunchRowsDeferred(total - shown.current);
      counted.current = true;
    };
    if (list.current && !launchRowsStarted()) list.current.measure(contentShown);
    else contentShown();
    return () => {
      live = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!controller || !holding) return;
    const release = () => releaseLaunchRows(windowId, "drag");
    controller.beforeMeasure = release;
    return () => {
      if (controller.beforeMeasure === release) controller.beforeMeasure = null;
    };
  }, [controller, holding, windowId]);


  useEffect(() => {
    if (shownRows < total || !counted.current) return;
    counted.current = false;
    noteLaunchRowsMounted();
  }, [shownRows, total]);

  useEffect(
    () => () => {
      if (!counted.current) return;
      counted.current = false;
      noteLaunchRowsCancelled();
    },
    [],
  );

  return { holding, list };
}
