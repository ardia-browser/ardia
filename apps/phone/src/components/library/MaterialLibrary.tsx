import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BackHandler, FlatList, Keyboard, Pressable, SectionList, StyleSheet, Text, TextInput, View, type GestureResponderEvent } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { predictiveBack } from "@ardia/phone-native";
import type { BookmarkItem } from "../../platform/sync";
import { haptics } from "../../state/app/haptics";
import { copyLink, menuOpenedHaptic } from "../../state/browse/tabMenus";
import { bookmarkMatches, bookmarkSections } from "../../state/library/bookmarkSearch";
import { filterHistory, historyDays, historyDayTitle, historyHost, type HistoryEntry } from "../../state/library/historyTimeline";
import { clockTime, downloadSubtitle, type FileKind } from "../../state/library/libraryText";
import {
  closeLibrary,
  deleteAllDownloads,
  deleteDownload,
  deleteHistoryEntry,
  LIBRARY_NAMES,
  LIBRARY_SEARCH_PROMPTS,
  LIBRARY_SECTIONS,
  loadDownloads,
  loadHistory,
  openFromLibrary,
  popLibraryPage,
  previewDownload,
  pushLibraryPage,
  shareDownload,
  showLibrarySection,
  useLibrary,
  type DownloadedFile,
  type LibrarySection,
} from "../../state/library/store";
import { useSync } from "../../state/sync/store";
import { useSelectedProfile, useSyncEnabled } from "../../state/sync/hooks";
import { useTabs } from "../../state/tabs/store";
import { ConfirmDialog, Favicon, FloatingMenu, MaterialIconButton, Symbol, type Confirmation, type MenuItem, type SymbolName } from "../ui";
import { useReduceMotion } from "../ui/contrast";
import { backSwipe, countMaterialBackSwipe, useMaterialRipple } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialDuration, materialMotion, materialMove, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { reducedMotionMs } from "../ui/motion";
import { actionWords, listWords } from "../../lib/sharedWords";
import { iconRoles } from "../ui/iconRoles";
import { listSheetWords } from "./listSheetWords";

const FOLDER = "folder:";
const HIDE_FALLBACK_MS = 900;
const ENTER_RISE = 48;
const INDICATOR = 3;
const EMPTY_ICON = 48;
const HEADER_HEIGHT = 48;

export const LIBRARY_ICONS: Record<LibrarySection, SymbolName> = { history: "clockArrow", bookmarks: "star", downloads: "arrowDownCircle" };

export const MATERIAL_FILE_ICONS: Record<FileKind, SymbolName> = { image: "docText", video: "video", audio: "docText", pdf: "docText", archive: "archivebox", document: "docPlaintext" };

export const materialLibraryMs = (reduceMotion: boolean, entering: boolean) =>
  reduceMotion ? reducedMotionMs(materialDuration.short3) : entering ? materialMotion.sheetEnter.durationMs : materialMotion.sheetExit.durationMs;

export type LibraryBackStep = "endSearch" | "popFolder" | "close";

export const libraryBackStep = (searching: boolean, depth: number): LibraryBackStep => (searching ? "endSearch" : depth > 0 ? "popFolder" : "close");

export const folderKeyOf = (page: string | undefined) => (page?.startsWith(FOLDER) ? page.slice(FOLDER.length) : null);

const shareable = (url: string) => /^https?:\/\//i.test(url);

export function findBookmarkFolder(items: readonly BookmarkItem[], key: string): BookmarkItem | null {
  for (const item of items) {
    if (item.key === key && !item.url) return item;
    const found = item.children ? findBookmarkFolder(item.children, key) : null;
    if (found) return found;
  }
  return null;
}

const MENU_END_INSET = 8;

type MenuState = { items: MenuItem[]; y: number; atEnd: boolean } | null;

type ShowMenu = (items: MenuItem[], event: { nativeEvent: { pageY: number } }, atEnd?: boolean) => void;

export function MaterialLibrary() {
  const open = useLibrary((s) => s.open);
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const gone = useCallback(() => {
    if (!useLibrary.getState().open) setMounted(false);
  }, []);
  if (!mounted) return null;
  return <MaterialLibraryView open={open} onGone={gone} />;
}

function MaterialLibraryView({ open, onGone }: { open: boolean; onGone: () => void }) {
  const { scheme } = useMaterialTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const section = useLibrary((s) => s.section);
  const path = useLibrary((s) => s.path);
  const shown = useSharedValue(0);
  const back = useSharedValue(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const folderKey = folderKeyOf(path[path.length - 1]);
  const activeSpace = useTabs((s) => s.spaces.current);
  useEffect(() => {
    setSearching(false);
    setQuery("");
  }, [section, open]);
  useEffect(() => {
    setMenu(null);
    setConfirmation(null);
  }, [activeSpace]);
  const endSearch = useCallback(() => {
    Keyboard.dismiss();
    setSearching(false);
    setQuery("");
  }, []);
  const step = useRef<() => void>(() => undefined);
  step.current = () => {
    const next = libraryBackStep(searching, path.length);
    if (next === "endSearch") endSearch();
    else if (next === "popFolder") popLibraryPage();
    else closeLibrary();
  };
  const claimsBack = open && menu === null && confirmation === null;
  useEffect(() => {
    if (!claimsBack) return;
    const swipe = backSwipe(countMaterialBackSwipe);
    const claim = predictiveBack.claim({
      onProgress: (progress) => {
        swipe.progress(progress);
        back.value = progress;
      },
      onCancel: () => {
        swipe.cancel();
        back.value = materialMove(0, "standard", materialDuration.short4);
      },
      onCommit: () => {
        swipe.commit();
        back.value = materialMove(0, "standard", materialDuration.short4);
        step.current();
      },
    });
    const hardware = predictiveBack.isNative()
      ? null
      : BackHandler.addEventListener("hardwareBackPress", () => {
          step.current();
          return true;
        });
    return () => {
      claim.remove();
      hardware?.remove();
      back.value = 0;
    };
  }, [claimsBack]);
  useEffect(() => {
    if (open) {
      shown.value = materialMove(1, materialMotion.sheetEnter.easing, materialLibraryMs(reduceMotion, true));
      return;
    }
    Keyboard.dismiss();
    setMenu(null);
    setConfirmation(null);
    const hidden = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(onGone)();
    };
    shown.value = materialMove(0, materialMotion.sheetExit.easing, materialLibraryMs(reduceMotion, false), hidden);
    const fallback = setTimeout(onGone, HIDE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [open]);
  const enter = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateY: (1 - shown.value) * ENTER_RISE + back.value * 24 }, { scale: 1 - 0.1 * back.value }],
    borderRadius: back.value * materialShape.extraLarge,
  }));
  const showMenu = useCallback<ShowMenu>((items, event, atEnd = false) => {
    if (!items.length) return;
    menuOpenedHaptic();
    setMenu({ items, y: event.nativeEvent.pageY, atEnd });
  }, []);
  const askDeleteAll = useCallback(() => {
    const run = () => {
      haptics.warning();
      deleteAllDownloads();
    };
    setConfirmation({ title: "Delete All Downloads?", message: "The files are removed from this phone.", action: listSheetWords.deleteAll, run });
  }, []);
  const searchable = LIBRARY_SEARCH_PROMPTS[section] !== null && folderKey === null;
  return (
    <Animated.View
      testID="materialLibrary"
      accessibilityViewIsModal={open}
      collapsable={false}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      pointerEvents={open ? "auto" : "none"}
      style={[StyleSheet.absoluteFill, styles.surface, { backgroundColor: scheme.surface, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }, enter]}
    >
      {searching ? (
        <LibrarySearchBar prompt={LIBRARY_SEARCH_PROMPTS[section] ?? ""} query={query} onQuery={setQuery} onEnd={endSearch} />
      ) : (
        <LibraryTopBar section={section} folderKey={folderKey} onBack={() => step.current()} onSearch={searchable ? () => setSearching(true) : null} onDeleteAll={section === "downloads" ? askDeleteAll : null} showMenu={showMenu} />
      )}
      {searching || folderKey !== null ? <View style={[styles.divider, { backgroundColor: scheme.outlineVariant }]} /> : <LibraryTabs section={section} />}
      <View style={[styles.content, { paddingBottom: insets.bottom }]}>
        {section === "history" ? <HistoryList open={open} query={query} showMenu={showMenu} /> : section === "bookmarks" ? <BookmarkList query={query} folderKey={folderKey} showMenu={showMenu} /> : <DownloadList open={open} showMenu={showMenu} />}
      </View>
      {menu ? <FloatingMenu items={menu.items} place={menu.atEnd ? { top: menu.y, right: MENU_END_INSET } : { top: menu.y, left: materialSize.listInset }} onDismiss={() => setMenu(null)} /> : null}
      {confirmation ? <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} /> : null}
    </Animated.View>
  );
}

function IconButton({ testID, label, icon, color, onPress, flipped = false }: { testID: string; label: string; icon: SymbolName; color: string; onPress: (event: { nativeEvent: { pageY: number } }) => void; flipped?: boolean }) {
  return <MaterialIconButton testID={testID} label={label} icon={icon} ink={color} flipped={flipped} onPress={onPress} />;
}

function LibraryTopBar({ section, folderKey, onBack, onSearch, onDeleteAll, showMenu }: { section: LibrarySection; folderKey: string | null; onBack: () => void; onSearch: (() => void) | null; onDeleteAll: (() => void) | null; showMenu: ShowMenu }) {
  const { scheme } = useMaterialTheme();
  const bookmarks = useBookmarks();
  const hasFiles = useLibrary((s) => s.files.length > 0);
  const folder = folderKey === null ? null : findBookmarkFolder(bookmarks, folderKey);
  const title = folderKey === null ? LIBRARY_NAMES[section] : folder?.title || "Untitled Folder";
  return (
    <View testID="materialLibraryBar" style={[styles.bar, { backgroundColor: scheme.surface }]}>
      <IconButton testID="materialLibraryBack" label={folderKey === null ? "Close Library" : "Back"} icon="arrowRight" color={scheme.onSurface} onPress={onBack} flipped />
      <Text testID="materialLibraryTitle" accessibilityRole="header" numberOfLines={1} style={[materialType.titleLarge, styles.title, { color: scheme.onSurface }]}>
        {title}
      </Text>
      {onSearch ? <IconButton testID="materialLibrarySearch" label={LIBRARY_SEARCH_PROMPTS[section] ?? "Search"} icon="magnifyingglass" color={scheme.onSurfaceVariant} onPress={onSearch} /> : null}
      {onDeleteAll ? (
        <IconButton
          testID="materialLibraryMore"
          label={actionWords.more}
          icon={iconRoles.more}
          color={scheme.onSurfaceVariant}
          onPress={(event) => showMenu([{ label: listSheetWords.deleteAllEntry, icon: "trash", destructive: true, disabled: !hasFiles, onPress: onDeleteAll }], event, true)}
        />
      ) : null}
    </View>
  );
}

function LibrarySearchBar({ prompt, query, onQuery, onEnd }: { prompt: string; query: string; onQuery: (text: string) => void; onEnd: () => void }) {
  const { scheme } = useMaterialTheme();
  return (
    <View testID="materialLibraryBar" style={[styles.bar, { backgroundColor: scheme.surface }]}>
      <IconButton testID="materialLibraryBack" label="Close Search" icon="arrowRight" color={scheme.onSurface} onPress={onEnd} flipped />
      <TextInput
        testID="materialLibrarySearchField"
        autoFocus
        value={query}
        onChangeText={onQuery}
        placeholder={prompt}
        placeholderTextColor={scheme.onSurfaceVariant}
        selectionColor={scheme.primary}
        cursorColor={scheme.primary}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        style={[materialType.bodyLarge, styles.input, { color: scheme.onSurface }]}
      />
      {query ? <IconButton testID="materialLibraryClear" label={actionWords.clearText} icon="xmark" color={scheme.onSurfaceVariant} onPress={() => onQuery("")} /> : null}
    </View>
  );
}

function LibraryTabs({ section }: { section: LibrarySection }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  return (
    <View testID="materialLibraryTabs" accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: scheme.surface, borderBottomColor: scheme.outlineVariant }]}>
      {LIBRARY_SECTIONS.map((item) => {
        const active = item === section;
        return (
          <Pressable
            key={item}
            testID={`materialLibraryTab-${item}`}
            accessibilityRole="tab"
            accessibilityLabel={LIBRARY_NAMES[item]}
            accessibilityState={{ selected: active }}
            android_ripple={ripple}
            onPress={() => showLibrarySection(item)}
            style={styles.tab}
          >
            <View style={styles.tabContent}>
              <Text numberOfLines={1} style={[materialType.titleSmall, { color: active ? scheme.primary : scheme.onSurfaceVariant }]}>
                {LIBRARY_NAMES[item]}
              </Text>
              {active ? <View testID="materialLibraryIndicator" style={[styles.indicator, { backgroundColor: scheme.primary }]} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

type ListItemProps = { testID?: string; leading: ReactNode; headline: string; supporting?: string | null; trailing?: string | null; label?: string; hint?: string; onPress: () => void; onLongPress?: (event: GestureResponderEvent) => void };

function ListItem({ testID, leading, headline, supporting, trailing, label, hint, onPress, onLongPress }: ListItemProps) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label ?? [headline, supporting].filter(Boolean).join(", ")}
      accessibilityHint={hint}
      android_ripple={ripple}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.item, { minHeight: supporting ? materialSize.listItemTwoLine : materialSize.listItemOneLine }]}
    >
      <View style={styles.leading}>{leading}</View>
      <View style={styles.itemText}>
        <Text numberOfLines={1} ellipsizeMode={supporting ? "tail" : "middle"} style={[materialType.bodyLarge, { color: scheme.onSurface }]}>
          {headline}
        </Text>
        {supporting ? (
          <Text numberOfLines={1} style={[materialType.bodyMedium, { color: scheme.onSurfaceVariant }]}>
            {supporting}
          </Text>
        ) : null}
      </View>
      {trailing ? <Text style={[materialType.labelSmall, { color: scheme.onSurfaceVariant }]}>{trailing}</Text> : null}
    </Pressable>
  );
}

function SectionHeader({ title }: { title: string }) {
  const { scheme } = useMaterialTheme();
  return (
    <View testID="materialLibraryHeader" style={styles.header}>
      <Text accessibilityRole="header" numberOfLines={1} style={[materialType.titleSmall, { color: scheme.primary }]}>
        {title}
      </Text>
    </View>
  );
}

function EmptyState({ icon, title, message }: { icon: SymbolName; title: string; message?: string }) {
  const { scheme } = useMaterialTheme();
  return (
    <View testID="materialLibraryEmpty" style={styles.empty}>
      <Symbol name={icon} size={EMPTY_ICON} color={scheme.onSurfaceVariant} />
      <Text style={[materialType.titleMedium, styles.emptyText, { color: scheme.onSurfaceVariant }]}>{title}</Text>
      {message ? <Text style={[materialType.bodyMedium, styles.emptyText, { color: scheme.onSurfaceVariant }]}>{message}</Text> : null}
    </View>
  );
}

const noResults = (query: string) => <EmptyState icon={iconRoles.noResults} title={listWords.noResults} message={listWords.noResultsCue(query.trim())} />;

const pageFavicon = (url: string) => <Favicon iconUrl={null} pageUrl={url} size={materialSize.icon} />;

type DaySection = { key: string; title: string; data: HistoryEntry[] };

function HistoryList({ open, query, showMenu }: { open: boolean; query: string; showMenu: ShowMenu }) {
  const entries = useLibrary((s) => s.history);
  const loaded = useLibrary((s) => s.historyLoaded);
  const syncRevision = useSync((s) => s.revision);
  const space = useTabs((s) => s.spaces.current);
  useEffect(() => {
    if (open) loadHistory();
  }, [open, syncRevision, space]);
  const shown = useMemo(() => filterHistory(entries, query), [entries, query]);
  const sections = useMemo<DaySection[]>(() => {
    const now = Date.now();
    return historyDays(shown).map((day) => ({ key: String(day.day), title: historyDayTitle(day.day, now), data: day.entries }));
  }, [shown]);
  const renderItem = useCallback(({ item }: { item: HistoryEntry }) => <HistoryRow entry={item} showMenu={showMenu} />, [showMenu]);
  const renderHeader = useCallback(({ section }: { section: DaySection }) => <SectionHeader title={section.title} />, []);
  if (!loaded) return null;
  if (!entries.length) return <EmptyState icon="clockArrow" title="No History" message="Pages you visit here and on your Mac show up here." />;
  if (!shown.length) return noResults(query);
  return (
    <SectionList
      testID="materialLibraryHistory"
      sections={sections}
      keyExtractor={(entry) => entry.url}
      renderItem={renderItem}
      renderSectionHeader={renderHeader}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      initialNumToRender={14}
      maxToRenderPerBatch={20}
      windowSize={9}
      removeClippedSubviews
    />
  );
}

function HistoryRow({ entry, showMenu }: { entry: HistoryEntry; showMenu: ShowMenu }) {
  const host = historyHost(entry.url);
  const time = clockTime(entry.visitedAt);
  const items: MenuItem[] = [...(shareable(entry.url) ? [{ label: actionWords.copyLink, icon: iconRoles.copyLink, onPress: () => copyLink(entry.url) }] : []), { label: "Delete", icon: "trash", destructive: true, onPress: () => deleteHistoryEntry(entry) }];
  return (
    <ListItem
      testID="materialLibraryHistoryRow"
      leading={pageFavicon(entry.url)}
      headline={entry.title || entry.url}
      supporting={`${host} · ${time}`}
      label={`${entry.title || entry.url}, ${host}, ${time}, ${entry.source === "thisDevice" ? "This phone" : "Another device"}`}
      hint="Opens the page."
      onPress={() => {
        haptics.selection();
        openFromLibrary(entry.url, entry.title);
      }}
      onLongPress={(event) => showMenu(items, event)}
    />
  );
}

function useBookmarks(): BookmarkItem[] {
  const enabled = useSyncEnabled();
  const profile = useSelectedProfile();
  return enabled ? (profile?.bookmarks ?? []) : [];
}

type BookmarkGroup = { key: string; title: string | null; data: readonly BookmarkItem[] };

function BookmarkList({ query, folderKey, showMenu }: { query: string; folderKey: string | null; showMenu: ShowMenu }) {
  const enabled = useSyncEnabled();
  const bookmarks = useBookmarks();
  const trimmed = query.trim();
  const groups = useMemo<BookmarkGroup[] | null>(() => {
    if (trimmed) {
      const found = bookmarkMatches(bookmarks, trimmed);
      return found.length ? [{ key: "matches", title: null, data: found }] : null;
    }
    if (folderKey !== null) {
      const children = findBookmarkFolder(bookmarks, folderKey)?.children ?? [];
      return children.length ? [{ key: folderKey, title: null, data: children }] : null;
    }
    const sections = bookmarkSections(bookmarks);
    return sections.length ? sections.map((section) => ({ key: section.id, title: section.title, data: section.items })) : null;
  }, [bookmarks, trimmed, folderKey]);
  const renderItem = useCallback(({ item }: { item: BookmarkItem }) => <BookmarkRow item={item} showMenu={showMenu} />, [showMenu]);
  const renderHeader = useCallback(({ section }: { section: BookmarkGroup }) => (section.title ? <SectionHeader title={section.title} /> : null), []);
  if (!bookmarks.length) return <EmptyState icon="star" title="No Bookmarks" message={enabled ? "Bookmarks you save on your Mac show up here." : "Sync with your Mac to see its bookmarks here."} />;
  if (!groups) return trimmed ? noResults(trimmed) : <EmptyState icon="folderFill" title="Empty Folder" />;
  return (
    <SectionList
      testID="materialLibraryBookmarks"
      sections={groups}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      renderSectionHeader={renderHeader}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      initialNumToRender={14}
      windowSize={9}
    />
  );
}

function BookmarkRow({ item, showMenu }: { item: BookmarkItem; showMenu: ShowMenu }) {
  const { scheme } = useMaterialTheme();
  if (!item.url) {
    const count = (item.children ?? []).length;
    return (
      <ListItem
        testID="materialLibraryFolderRow"
        leading={<Symbol name="folderFill" size={materialSize.icon} color={scheme.onSurfaceVariant} />}
        headline={item.title || "Untitled Folder"}
        trailing={count.toLocaleString()}
        label={`${item.title || "Untitled Folder"}, ${count} items`}
        hint="Opens the folder."
        onPress={() => pushLibraryPage(`${FOLDER}${item.key}`)}
      />
    );
  }
  const url = item.url;
  return (
    <ListItem
      testID="materialLibraryBookmarkRow"
      leading={pageFavicon(url)}
      headline={item.title || url}
      supporting={historyHost(url)}
      hint="Opens the page."
      onPress={() => {
        haptics.selection();
        openFromLibrary(url, item.title);
      }}
      onLongPress={shareable(url) ? (event) => showMenu([{ label: actionWords.copyLink, icon: iconRoles.copyLink, onPress: () => copyLink(url) }], event) : undefined}
    />
  );
}

function DownloadList({ open, showMenu }: { open: boolean; showMenu: ShowMenu }) {
  const files = useLibrary((s) => s.files);
  const loaded = useLibrary((s) => s.filesLoaded);
  useEffect(() => {
    if (open) void loadDownloads();
  }, [open]);
  const renderItem = useCallback(({ item }: { item: DownloadedFile }) => <DownloadRow file={item} showMenu={showMenu} />, [showMenu]);
  if (loaded && !files.length) return <EmptyState icon="arrowDownCircle" title="No Downloads" message="Files you download show up here." />;
  return <FlatList testID="materialLibraryDownloads" data={files} keyExtractor={(file) => file.uri} renderItem={renderItem} initialNumToRender={14} windowSize={9} />;
}

function DownloadRow({ file, showMenu }: { file: DownloadedFile; showMenu: ShowMenu }) {
  const { scheme } = useMaterialTheme();
  return (
    <ListItem
      testID="materialLibraryDownloadRow"
      leading={<Symbol name={MATERIAL_FILE_ICONS[file.kind]} size={materialSize.icon} color={scheme.onSurfaceVariant} />}
      headline={file.name}
      supporting={downloadSubtitle(file.size, file.modified)}
      hint="Shows the file."
      onPress={() => previewDownload(file)}
      onLongPress={(event) =>
        showMenu(
          [
            { label: actionWords.share, icon: iconRoles.share, onPress: () => shareDownload(file) },
            { label: "Delete", icon: "trash", destructive: true, onPress: () => deleteDownload(file) },
          ],
          event,
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  surface: { overflow: "hidden" },
  bar: { height: materialSize.topAppBar, flexDirection: "row", alignItems: "center", paddingHorizontal: 4, gap: 4 },
  title: { flex: 1, paddingHorizontal: 4 },
  input: { flex: 1, paddingVertical: 0 },
  divider: { height: 1 },
  tabs: { height: materialSize.touchTarget, flexDirection: "row", borderBottomWidth: 1 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tabContent: { height: materialSize.touchTarget, justifyContent: "center", minWidth: materialSize.icon },
  indicator: { position: "absolute", left: 0, right: 0, bottom: 0, height: INDICATOR, borderTopLeftRadius: INDICATOR, borderTopRightRadius: INDICATOR },
  content: { flex: 1 },
  header: { height: HEADER_HEIGHT, justifyContent: "flex-end", paddingHorizontal: materialSize.listInset, paddingBottom: 8 },
  item: { flexDirection: "row", alignItems: "center", gap: materialSize.listIconGap, paddingHorizontal: materialSize.listInset, paddingVertical: 8 },
  leading: { width: materialSize.icon, height: materialSize.icon, alignItems: "center", justifyContent: "center" },
  itemText: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 32 },
  emptyText: { textAlign: "center" },
});
