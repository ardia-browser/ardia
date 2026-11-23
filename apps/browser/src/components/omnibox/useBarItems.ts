import { suggestionKey, type SearchScope } from "@ardia/core";
import { useEffect, useMemo, type RefObject } from "react";
import type { TextInput } from "react-native";
import { fullUrlShown, previewText } from "./barText";
import { copyFieldAs } from "../../state/omnibox/textInput";
import { offeredScope } from "../../state/omnibox/scopes";
import { useDropdownStart, useOpenTabsStart } from "./dropdownStart";
import { useInlineCompletion } from "./useInlineCompletion";
import { useSuggestions } from "./useSuggestions";
import { useSteadyRows } from "./steadyRows";
import { useHover } from "../ui";
import { barFieldMarks } from "../../state/omnibox/barMarks";
import type { Selection } from "./inline";

export function useBarItems({
  input,
  caret,
  typed,
  edited,
  scope,
  suppressCompletion,
  selected,
  dropdown,
  opensTab,
  switchToOpenTab,
  windowId,
  profileId,
  tabId,
  currentUrl,
}: {
  input: RefObject<TextInput | null>;
  caret: () => Selection;
  typed: string;
  edited: boolean;
  scope: SearchScope | null;
  suppressCompletion: boolean;
  selected: number;
  dropdown: boolean;
  opensTab: boolean;
  switchToOpenTab: boolean;
  windowId: string;
  profileId: string;
  tabId: string;
  currentUrl: string;
}) {
  const { hovered: overRows, hoverProps: rowsHover } = useHover();
  const { items: suggested, completion: suggestedCompletion, via } = useSuggestions({
    text: typed,
    active: edited || !!scope,
    windowId,
    profileId,
    currentTabId: tabId,
    currentUrl: currentUrl || undefined,
    scope,
    preventInline: suppressCompletion,
    switchToOpenTab,
  });
  const start = useDropdownStart(dropdown && !edited && !scope, tabId, profileId);
  const idle = opensTab && !scope && !typed.trim();
  const openTabs = useOpenTabsStart(idle, windowId, profileId);
  const listed = { items: dropdown && !edited && !scope ? start : idle ? openTabs : suggested, completion: suggestedCompletion };
  const rows = useSteadyRows(listed, `${scope?.kind ?? ""}:${scope?.name ?? ""}:${typed}`, overRows, suggestionKey);
  const { items, completion } = rows.value;
  useEffect(() => barFieldMarks.rows(overRows, rows.held, items.length), [overRows, rows.held]);
  const selectedIndex = Math.min(Math.max(selected, 0), items.length - 1);
  const current = items[selectedIndex];
  const preview = !idle && selectedIndex > 0 ? (previewText(current) ?? typed) : null;
  const previewing = preview !== null;
  const inline = useInlineCompletion(input, typed, suppressCompletion || scope ? "" : completion, preview, caret);
  const shownCompletion = previewing ? "" : inline.shown;
  const value = preview ?? typed + shownCompletion;
  const tabScope = useMemo(
    () => (!scope && edited && !previewing ? offeredScope(typed, shownCompletion, windowId) : null),
    [scope, edited, previewing, typed, shownCompletion, windowId],
  );
  const shownUrl = fullUrlShown(value, current);
  useEffect(() => void copyFieldAs(shownUrl && value, shownUrl), [value, shownUrl]);
  useEffect(() => () => void copyFieldAs(null, null), []);
  return { items, completion, via, inline, shownCompletion, value, selectedIndex, current, tabScope, previewing, rowsHover, rowsHeld: rows.held, releaseRows: rows.release, shownUrl };
}
