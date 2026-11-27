import { useReducer, useState } from "react";
import { savedNtpQuery } from "../../state/omnibox/barState";
import { barReducer, editsDraft, initialBar, selectionTracker, type BarEvent } from "./barText";
import { cancelLateNewTabOverride } from "../../state/tabs/newTabHome";

export const cancelsLateOverride = (hero: boolean, tabId: string, dispatch: (e: BarEvent) => void) => (e: BarEvent) => {
  if (hero && editsDraft(e)) cancelLateNewTabOverride(tabId);
  dispatch(e);
};

export function useBarText(hero: boolean, tabId: string, initialText: string) {
  const [start] = useState(() => {
    const restored = hero ? savedNtpQuery(tabId) : null;
    const bar = initialBar(restored, initialText);
    return { bar, selection: selectionTracker(restored?.selection ?? { start: 0, end: bar.typed.length }) };
  });
  const [state, reduce] = useReducer(barReducer, start.bar);
  const [dispatch] = useState(() => cancelsLateOverride(hero, tabId, reduce));
  return { ...state, dispatch, selection: start.selection };
}
