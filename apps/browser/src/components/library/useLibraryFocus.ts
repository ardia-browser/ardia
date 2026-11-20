import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import type { TextInput } from "react-native";
import { useLibraryOpen } from "../../state/library/hooks";
import { libraryOf } from "../../state/library/library";
import { returnFocusToPage } from "../../state/sidebar/actions";

export const LibraryWindowContext = createContext("");

export type LibraryFocusHandlers = { onFocus: () => void; onBlur: () => void };

export function useLibraryFocus(input?: RefObject<TextInput | null>): LibraryFocusHandlers {
  const windowId = useContext(LibraryWindowContext);
  const open = useLibraryOpen(windowId);
  const holding = useRef(false);
  useEffect(() => {
    if (open || !holding.current) return;
    holding.current = false;
    input?.current?.blur();
    returnFocusToPage(windowId);
  }, [open, windowId, input]);
  useEffect(
    () => () => {
      if (!holding.current) return;
      holding.current = false;
      if (!libraryOf(windowId).open) returnFocusToPage(windowId);
    },
    [windowId],
  );
  const [handlers] = useState<LibraryFocusHandlers>(() => ({
    onFocus: () => void (holding.current = true),
    onBlur: () => void (holding.current = false),
  }));
  return handlers;
}
