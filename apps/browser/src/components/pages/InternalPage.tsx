import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useTab } from "../../state/browser/hooks";
import { currentTab } from "../../state/browser/current";
import { useTabBookmarkSpaceId } from "../../state/bookmarks/hooks";
import { updateLive, updateTab } from "../../state/tabs/actions";
import { setPageProgress } from "../../state/tabs/pageProgress";
import { BookmarksPage } from "./BookmarksPage";
import { DownloadsPage } from "./DownloadsPage";
import { HistoryPage } from "./HistoryPage";
import { INTERNAL_PAGES, internalPageOf, internalQuery, pluginPageOf, tabDestination } from "../../state/pages/urls";
import { usePluginPageSpec } from "../../state/plugins/hooks";
import { PluginPage } from "../plugins/PluginPage";

export function InternalPage({ tabId }: { tabId: string }) {
  const url = useTab(tabId, (t) => (t ? tabDestination(t) : ""));
  const page = internalPageOf(url);
  const plugin = page ? null : pluginPageOf(url);
  const pluginTitle = usePluginPageSpec(plugin ?? "")?.title ?? plugin ?? "";
  const spaceId = useTab(tabId, (t) => t?.spaceId ?? "");
  const bookmarkSpace = useTabBookmarkSpaceId(tabId);

  useEffect(() => {
    if (!page && !plugin) return;
    const t = currentTab(tabId);
    const title = page ? INTERNAL_PAGES[page].title : pluginTitle;
    if (t && (t.url !== url || t.title !== title)) updateTab(tabId, { url, title, favicon: null });
    updateLive(tabId, { isLoading: false, canGoBack: false, canGoForward: false });
    setPageProgress(tabId, 0);
  }, [page, plugin, pluginTitle, url]);

  if (plugin) return <PluginPage tabId={tabId} name={plugin} />;
  if (!page) return null;
  return (
    <View style={StyleSheet.absoluteFill}>
      {page === "history" && <HistoryPage tabId={tabId} spaceId={spaceId} initialQuery={internalQuery(url)} />}
      {page === "bookmarks" && <BookmarksPage key={bookmarkSpace} tabId={tabId} spaceId={bookmarkSpace} />}
      {page === "downloads" && <DownloadsPage tabId={tabId} />}
    </View>
  );
}
