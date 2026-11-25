import { useEffect, useReducer, type RefObject } from "react";
import { findNodeHandle, type TextInput } from "react-native";
import { replayingInto, watchKeyHoldReplay } from "../../state/omnibox/keyHoldReplay";

export function useKeyHoldReplay(input: RefObject<TextInput | null>): boolean {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => watchKeyHoldReplay(redraw), []);
  return replayingInto(findNodeHandle(input.current));
}
