import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findNodeHandle, View, type TextInput, type ViewProps } from "react-native";
import { useTab, useWindow } from "../../state/browser/hooks";
import { useProfileHistory } from "../../state/history/hooks";
import { removeHistory } from "../../state/history/actions";
import type { HistoryEntry } from "../../state/browser/types";
import { requestClearData, useClearDataRequest } from "../../state/profiles/clearDataRequest";
import { takeHistorySearchFocusRequest, useHistorySearchFocusRequest } from "../../state/history/showHistory";
import { claimFocusTag, historySearchFocus } from "../../state/focus/focusClaims";
import { Button, EmptyState, Text } from "../ui";
import { ClearDataDialog } from "./ClearDataDialog";
import { layoutHistory } from "./historyLayout";
import { confirmRemoveSelected } from "../../state/history/historyMenus";
import { allRows, movedCursor, NO_ROWS_SELECTED, shownRows, toggledCursor, toggledRow, withoutRows, type RowSelection } from "../../state/history/historySelection";
import { noteHistoryRowsRemoved } from "../../state/telemetry/historyRemovalCounts";
import { HistoryList } from "./HistoryList";
import { hostLabel, PageHeader } from "./PageLayout";


export function HistoryPage({ tabId, profileId, initialQuery }: { tabId: string; profileId: string; initialQuery: string }) {
  const windowId = useTab(tabId, (t) => t?.windowId ?? "");
  const history = useProfileHistory(profileId);
  const [query, setQuery] = useState(initialQuery);
  const [selection, setSelection] = useState<RowSelection>(NO_ROWS_SELECTED);
  const selected = selection.selected;
  const [clearOpen, setClearOpen] = useState(false);
  const list = useRef<View>(null);

  const clearRequest = useClearDataRequest((r) => r.windowId);
  const activeHere = useWindow(windowId, (w) => w?.activeTabIds[w!.profileId] === tabId);
  useEffect(() => {
    if (clearRequest === windowId && activeHere) {
      setClearOpen(true);
      requestClearData(null);
    }
  }, [clearRequest, activeHere]);

  const search = useRef<TextInput>(null);
  const searchFocusRequested = useHistorySearchFocusRequest((r) => r.tabId === tabId);
  useEffect(() => {
    if (!searchFocusRequested || !activeHere || !windowId) return;
    takeHistorySearchFocusRequest();
    search.current?.focus();
    search.current?.setSelection(0, query.length);
    claimFocusTag(windowId, historySearchFocus(tabId), () => findNodeHandle(search.current));
  }, [searchFocusRequested, activeHere, windowId]);

  useEffect(() => setQuery(initialQuery), [initialQuery]);

  const layout = useMemo(() => layoutHistory(history, query), [history, query]);
  const urls = useMemo(() => layout.rows.map((r) => r.entry.url), [layout]);
  const latest = useRef({ layout, urls, profileId, selected });
  latest.current = { layout, urls, profileId, selected };
  useEffect(() => setSelection((prev) => shownRows(urls, prev)), [urls]);

  const toggle = useCallback((url: string, shift: boolean) => setSelection((prev) => toggledRow(latest.current.urls, prev, url, shift)), []);
  const moreFromSite = useCallback((url: string) => setQuery(hostLabel(url)), []);
  const remove = useCallback((removed: string[]) => {
    removeHistory(latest.current.profileId, removed);
    noteHistoryRowsRemoved("menu", removed.length);
    setSelection((prev) => withoutRows(prev, removed));
  }, []);
  const menuTargets = useCallback((entry: HistoryEntry) => {
    const chosen = latest.current.selected;
    if (chosen.size < 2 || !chosen.has(entry.url)) return [entry];
    return latest.current.layout.rows.map((r) => r.entry).filter((e) => chosen.has(e.url));
  }, []);

  const deleteSelected = async (via: "key" | "button") => {
    if (!selected.size) return;
    const confirmed = await confirmRemoveSelected(windowId);
    if (!confirmed) return;
    removeHistory(profileId, [...selected]);
    noteHistoryRowsRemoved(via, selected.size);
    setSelection((prev) => ({ ...prev, selected: new Set() }));
  };
  const enterList = (step: 1 | -1) => {
    if (step !== 1 || !urls.length) return;
    list.current?.focus();
    setSelection((prev) => movedCursor(urls, { ...prev, cursor: null }, 1, false));
  };
  const onListKey: ViewProps["onKeyDown"] = ({ nativeEvent: { key, metaKey, shiftKey } }) => {
    if (key === "ArrowDown" || key === "ArrowUp") setSelection((prev) => movedCursor(urls, prev, key === "ArrowDown" ? 1 : -1, !!shiftKey));
    else if (key === " ") setSelection((prev) => toggledCursor(urls, prev));
    else if (key === "a" && metaKey) setSelection((prev) => allRows(urls, prev));
    else if (key === "Backspace" || key === "Delete") void deleteSelected("key");
    else if (key === "Escape") setSelection((prev) => ({ ...prev, selected: new Set() }));
  };

  const actions =
    selected.size > 0 ? (
      <>
        <Text size="small" tone="textSecondary">{`${selected.size} selected`}</Text>
        <Button title="Cancel" onPress={() => setSelection((prev) => ({ ...prev, selected: new Set() }))} />
        <Button title="Delete" kind="primary" onPress={() => void deleteSelected("button")} />
      </>
    ) : (
      <Button title="Clear Browsing Data…" onPress={() => setClearOpen(true)} />
    );

  return (
    <View style={{ flex: 1 }}>
      <PageHeader title="History" query={query} onQuery={setQuery} actions={actions} searchRef={search} onArrow={enterList} />
      {layout.rows.length === 0 ? (
        <EmptyState
          symbol="clock"
          title={query ? "No search results found" : "Your browsing history appears here"}
        />
      ) : (
        <View ref={list} focusable enableFocusRing={false} keyDownEvents={selected.size ? LIST_KEYS_WITH_ESCAPE : LIST_KEYS} onKeyDown={onListKey} style={LIST_KEYS_VIEW}>
          <HistoryList
            layout={layout}
            cursor={selection.cursor}
            profileId={profileId}
            windowId={windowId}
            selected={selected}
            onToggle={toggle}
            onMoreFromSite={moreFromSite}
            onRemove={remove}
            menuTargets={menuTargets}
          />
        </View>
      )}
      {clearOpen && <ClearDataDialog profileId={profileId} onClose={() => setClearOpen(false)} />}
    </View>
  );
}

const LIST_KEYS = [
  { key: "ArrowDown" },
  { key: "ArrowUp" },
  { key: "ArrowDown", shiftKey: true },
  { key: "ArrowUp", shiftKey: true },
  { key: " " },
  { key: "a", metaKey: true },
  { key: "Backspace" },
  { key: "Delete" },
];
const LIST_KEYS_WITH_ESCAPE = [...LIST_KEYS, { key: "Escape" }];
const LIST_KEYS_VIEW = { flex: 1 } as const;
