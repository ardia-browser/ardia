import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useTab } from "../../state/browser/hooks";
import { currentTab } from "../../state/browser/current";
import { useTabBookmarkProfileId } from "../../state/bookmarks/hooks";
import { updateLive, updateTab } from "../../state/tabs/actions";
import { setPageProgress } from "../../state/tabs/pageProgress";
import { BookmarksPage } from "./BookmarksPage";
import { DownloadsPage } from "./DownloadsPage";
import { HistoryPage } from "./HistoryPage";
import { INTERNAL_PAGES, internalPageOf, internalQuery, pluginPageOf, tabDestination } from "../../state/pages/urls";
import { usePluginPageSpec } from "../../state/plugins/hooks";
import { PluginPage } from "../plugins/PluginPage";

export function InternalPage({ contentAreaOf: tabId, hidden = false }: { contentAreaOf: string; hidden?: boolean }) {
  const url = useTab(tabId, (t) => (t ? tabDestination(t) : ""));
  const page = internalPageOf(url);
  const plugin = page ? null : pluginPageOf(url);
  const pluginTitle = usePluginPageSpec(plugin ?? "")?.title ?? plugin ?? "";
  const profileId = useTab(tabId, (t) => t?.profileId ?? "");
  const bookmarkProfile = useTabBookmarkProfileId(tabId);

  useEffect(() => {
    if (!page && !plugin) return;
    const t = currentTab(tabId);
    const title = page ? INTERNAL_PAGES[page].title : t?.title || pluginTitle;
    if (t && (t.url !== url || t.title !== title)) updateTab(tabId, { url, title, favicon: null });
    if (!plugin) updateLive(tabId, { isLoading: false, canGoBack: false, canGoForward: false });
    else updateLive(tabId, { isLoading: false });
    setPageProgress(tabId, 0);
  }, [page, plugin, pluginTitle, url]);

  if (plugin) {
    return (
      <View style={hidden ? HIDDEN : StyleSheet.absoluteFill} pointerEvents={hidden ? "none" : "auto"}>
        <PluginPage tabId={tabId} name={plugin} />
      </View>
    );
  }
  if (!page) return null;
  return (
    <View style={StyleSheet.absoluteFill}>
      {page === "history" && <HistoryPage tabId={tabId} profileId={profileId} initialQuery={internalQuery(url)} />}
      {page === "bookmarks" && <BookmarksPage key={bookmarkProfile} tabId={tabId} profileId={bookmarkProfile} />}
      {page === "downloads" && <DownloadsPage tabId={tabId} />}
    </View>
  );
}

const HIDDEN = { ...StyleSheet.absoluteFillObject, display: "none" } as const;
