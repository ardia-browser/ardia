import { useLayoutEffect, useMemo, useRef } from "react";
import type { View } from "react-native";
import { markHoverProps } from "../../lib/hoverMarks";
import { addLibraryAnchor, pointLibraryAnchor } from "../../state/sidebar/libraryAnchors";
import type { HoverPointerEvent } from "../../state/sidebar/hover";
import type { LibraryItemKind } from "../../state/sidebar/sidebarUi";
import { useRowHover } from "../sidebar/hoverController";

export function useLibraryItemHover(windowId: string, kind: LibraryItemKind, id: string) {
  const target = useMemo(() => ({ kind, id }), [kind, id]);
  const { hovered, hoverProps: rowProps } = useRowHover(windowId, target);
  const anchorRef = useRef<View>(null);
  useLayoutEffect(() => {
    const view = anchorRef.current;
    return view ? addLibraryAnchor(windowId, id, view) : undefined;
  }, [windowId, id]);
  const hoverProps = useMemo(
    () =>
      markHoverProps({
        ...rowProps,
        onMouseEnter: (event?: HoverPointerEvent) => {
          if (anchorRef.current) pointLibraryAnchor(windowId, anchorRef.current);
          rowProps.onMouseEnter(event);
        },
      }),
    [rowProps, windowId],
  );
  return { hovered, hoverProps, anchorRef };
}
