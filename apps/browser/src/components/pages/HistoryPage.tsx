import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findNodeHandle, View, type TextInput } from "react-native";
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
import { confirmRemoveSelected, openHistoryRowMenu } from "../../state/history/historyMenus";
import { toggledRow, withoutRows } from "../../state/history/historySelection";
import { openUrl } from "../../state/bookmarks/actions";
import { noteHistoryRowsRemoved } from "../../state/telemetry/historyRemovalCounts";
import { consentToken } from "../../state/telemetry/client";
import { HistoryList } from "./HistoryList";
import { hostLabel, PageHeader } from "./PageLayout";
import { menuRows } from "./listCursor";
import { useListCursor } from "./useListCursor";


export function HistoryPage({ tabId, profileId, initialQuery }: { tabId: string; profileId: string; initialQuery: string }) {
  const windowId = useTab(tabId, (t) => t?.windowId ?? "");
  const history = useProfileHistory(profileId);
  const [query, setQuery] = useState(initialQuery);
  const [clearOpen, setClearOpen] = useState(false);

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
  const { selection, setSelection, cursor, listProps, enter } = useListCursor(urls, {
    open: (url) => openUrl(url, windowId, "current"),
    menu: (url) => {
      const entry = layout.rows.find((r) => r.entry.url === url)?.entry;
      if (entry) void openHistoryRowMenu(menuTargets(entry), windowId, moreFromSite, remove);
    },
    remove: () => void deleteSelected("key"),
  });
  const selected = selection.selected;
  const latest = useRef({ layout, urls, profileId, selection });
  latest.current = { layout, urls, profileId, selection };

  const toggle = useCallback((url: string, shift: boolean) => setSelection((prev) => toggledRow(latest.current.urls, prev, url, shift)), []);
  const moreFromSite = useCallback((url: string) => setQuery(hostLabel(url)), []);
  const remove = useCallback((removed: string[]) => {
    removeHistory(latest.current.profileId, removed);
    noteHistoryRowsRemoved("menu", removed.length);
    setSelection((prev) => withoutRows(prev, removed));
  }, []);
  const menuTargets = useCallback((entry: HistoryEntry) => {
    const { layout, urls, selection } = latest.current;
    const picked = new Set(menuRows(urls, selection, entry.url));
    return picked.size < 2 ? [entry] : layout.rows.map((r) => r.entry).filter((e) => picked.has(e.url));
  }, []);

  const deleteSelected = async (via: "key" | "button") => {
    if (!selected.size) return;
    const consent = consentToken();
    const confirmed = await confirmRemoveSelected(windowId);
    if (!confirmed) return;
    removeHistory(profileId, [...selected]);
    noteHistoryRowsRemoved(via, selected.size, consent);
    setSelection((prev) => ({ ...prev, selected: new Set() }));
  };

  const actions =
    selected.size > 0 ? (
      <>
        <Text size="small" tone="textSecondary">{`${selected.size} selected`}</Text>
        <Button title="Cancel" onPress={() => setSelection((prev) => ({ ...prev, selected: new Set() }))} />
        <Button title="Remove…" kind="primary" onPress={() => void deleteSelected("button")} />
      </>
    ) : (
      <Button title="Clear Browsing Data…" onPress={() => setClearOpen(true)} />
    );

  return (
    <View style={{ flex: 1 }}>
      <PageHeader title="History" query={query} onQuery={setQuery} actions={actions} searchRef={search} onArrow={enter} />
      {layout.rows.length === 0 ? (
        <EmptyState
          symbol={query ? "magnifyingglass" : "clock"}
          title={query ? "No results" : "Your browsing history appears here"}
        />
      ) : (
        <View {...listProps} style={LIST_KEYS_VIEW}>
          <HistoryList
            layout={layout}
            cursor={cursor}
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

const LIST_KEYS_VIEW = { flex: 1 } as const;
