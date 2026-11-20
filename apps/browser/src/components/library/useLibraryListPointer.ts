import { useEffect, useState } from "react";
import { setLibraryHeaderPointed, setLibraryListPointed } from "../../state/sidebar/hover";

function usePointed(windowId: string, set: (windowId: string, by: object, inside: boolean) => void) {
  const [by] = useState(() => ({}));
  const [props] = useState(() => ({
    onMouseEnter: () => set(windowId, by, true),
    onMouseLeave: () => set(windowId, by, false),
  }));
  useEffect(() => () => set(windowId, by, false), [windowId]);
  return props;
}

export const useLibraryListPointer = (windowId: string) => usePointed(windowId, setLibraryListPointed);

export const useLibraryHeaderPointer = (windowId: string) => usePointed(windowId, setLibraryHeaderPointed);
