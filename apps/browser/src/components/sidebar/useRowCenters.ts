import { useEffect, useState } from "react";
import { measure } from "./dragModel";
import { grabbedView, sidebarDividerOf, sidebarDragOf } from "./stripDrag";
import { layout } from "../ui/theme";
import { currentInterfaceScale } from "../../state/settings/interfaceScale";

const NONE: Readonly<Record<string, number>> = {};

export function useRowCenters(windowId: string, keys: readonly string[], offset: number, paused: boolean, layoutKey: string, dividerKey: string | null = null): Readonly<Record<string, number>> {
  const [centers, setCenters] = useState(NONE);
  const joined = keys.join("|");
  const rows = `${layout.rowHeight}:${layout.rowGap}:${layout.pinnedHeight}:${currentInterfaceScale()}`;
  useEffect(() => {
    if (paused) return;
    let gone = false;
    const frame = requestAnimationFrame(() => {
      const controller = sidebarDragOf(windowId);
      if (!controller) return;
      const measured = keys.map((key) => {
        const item = controller.items.get(key);
        return item ? measure(grabbedView(item)).then((f) => (f && f.h > 0 ? ([key, f.y + f.h / 2 + offset] as const) : null)) : Promise.resolve(null);
      });
      const divider = dividerKey ? sidebarDividerOf(windowId) : null;
      if (dividerKey && divider) measured.push(measure(divider).then((f) => (f && f.h > 0 ? ([dividerKey, f.y + f.h / 2 + offset] as const) : null)));
      void Promise.all(measured).then((found) => {
        if (gone) return;
        const next = Object.fromEntries(found.filter((row): row is readonly [string, number] => !!row));
        setCenters((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
      });
    });
    return () => {
      gone = true;
      cancelAnimationFrame(frame);
    };
  }, [windowId, joined, offset, paused, layoutKey, rows, dividerKey]);
  return centers;
}
