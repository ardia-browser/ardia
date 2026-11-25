import type { ReactNode } from "react";
import { openDroppedInTab } from "../../state/drag/windowDrop";
import { FileDropArea, type DropUpdate } from "../ui";

const SHOWN = { flex: 1 };
const KEPT = { flex: 1, display: "none" as const };

export function NewTabDropArea({ contentAreaOf: tabId, accepting, kept = false, children }: { contentAreaOf: string; accepting: boolean; kept?: boolean; children: ReactNode }) {
  const onDropUpdate = (e: DropUpdate) => {
    if (e.phase === "drop") openDroppedInTab(tabId, e.items);
  };
  return (
    <FileDropArea style={kept ? KEPT : SHOWN} accepts="linksAndText" enabled={accepting} onDropUpdate={onDropUpdate}>
      {children}
    </FileDropArea>
  );
}
