import type { View } from "react-native";
import { layout } from "../ui/theme";
import type { DragController } from "./dragController";
import { blockKind, measure } from "./dragModel";

type Held = View[];

const frozen = new WeakMap<DragController, Held>();

export async function freezeOffscreenRows(controller: DragController) {
  thawRows(controller);
  const held: Held = [];
  frozen.set(controller, held);
  const viewport = await measure(controller.scroll as unknown as View);
  if (!viewport || frozen.get(controller) !== held) return;
  const margin = layout.rowHeight * 2;
  const entries = [...controller.items.values()].filter((item) => blockKind(item) && !item.parentGroup && item.view);
  await Promise.all(
    entries.map(async (item) => {
      const view = item.view!;
      const frame = await measure(view);
      if (!frame || frozen.get(controller) !== held) return;
      if (frame.y + frame.h > viewport.y - margin && frame.y < viewport.y + viewport.h + margin) return;
      view.setNativeProps({ style: { width: frame.w } });
      held.push(view);
    }),
  );
}

export function thawRows(controller: DragController) {
  const held = frozen.get(controller);
  if (!held) return;
  frozen.delete(controller);
  for (const view of held) view.setNativeProps({ style: { width: null } });
}
