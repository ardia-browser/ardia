import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BackHandler, FlatList, Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BookmarkItem } from "../../platform/sync";
import type { Point } from "../../lib/menuPlace";
import { haptics } from "../../state/app/haptics";
import { copyLink, menuOpenedHaptic, shareUrl } from "../../state/browse/tabMenus";
import { bookmarkMatches, bookmarkSections } from "../../state/library/bookmarkSearch";
import { filterHistory, historyDays, historyDayTitle, historyHost, type HistoryEntry } from "../../state/library/historyTimeline";
import { clockTime, downloadSubtitle } from "../../state/library/libraryText";
import {
  closeLibrary,
  deleteAllDownloads,
  deleteDownload,
  deleteHistoryEntry,
  LIBRARY_CLEAR_DATA,
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
import { useSelectedProfile, useSyncEnabled } from "../../state/sync/hooks";
import { useSync } from "../../state/sync/store";
import { useTabs } from "../../state/tabs/store";
import { ClearDataPage } from "../settings/DataPages";
import { EmptyState } from "../settings/SettingsKit";
import { MenuTrigger, confirmInSheet } from "../ui/MenuTrigger";
import { ConfirmSheet, Favicon, FloatingMenu, font, LookBackdrop, radius, space, SwipeToDelete, Symbol, tabsLayout, tabsMotion, useSheetFrame, useTheme, type Confirmation, type MenuItem, type SymbolName } from "../ui";

const FOLDER = "folder:";
const ROW_FAVICON = 20;
const ROW_FAVICON_SCALE_CAP = 2;
const DEVICE_GLYPH = 13;
const SWITCHER_HEIGHT = 32;

const SECTION_SYMBOLS: Record<LibrarySection, SymbolName> = { history: "clockArrow", bookmarks: "star", downloads: "arrowDownCircle" };

const shareable = (url: string) => /^https?:\/\//i.test(url);

type RowMenu = { items: MenuItem[]; at: Point };

const linkItems = (url: string, title: string): MenuItem[] =>
  shareable(url)
    ? [
        { label: "Copy Link", icon: "link", onPress: () => copyLink(url) },
        { label: "Share", icon: "squareAndArrowUp", onPress: () => shareUrl(url, title) },
      ]
    : [];

function openRow(url: string, title: string) {
  haptics.selection();
  openFromLibrary(url, title);
}

function findFolder(items: readonly BookmarkItem[], key: string): BookmarkItem | null {
  for (const item of items) {
    if (item.key === key && !item.url) return item;
    const found = item.children ? findFolder(item.children, key) : null;
    if (found) return found;
  }
  return null;
}

function useBookmarks(): BookmarkItem[] {
  const enabled = useSyncEnabled();
  const profile = useSelectedProfile();
  return enabled ? (profile?.bookmarks ?? []) : [];
}

function useRowIcon() {
  const { fontScale } = useWindowDimensions();
  return ROW_FAVICON * Math.min(fontScale, ROW_FAVICON_SCALE_CAP);
}

export function LibraryView() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const frame = useSheetFrame();
  const section = useLibrary((s) => s.section);
  const path = useLibrary((s) => s.path);
  const hasFiles = useLibrary((s) => s.files.length > 0);
  const bookmarks = useBookmarks();
  const [query, setQuery] = useState("");
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const route = path.at(-1);
  const clearing = route === LIBRARY_CLEAR_DATA;
  useEffect(() => setQuery(""), [section]);
  useEffect(() => {
    if (!query || clearing) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      setQuery("");
      return true;
    });
    return () => back.remove();
  }, [Boolean(query), clearing]);
  if (clearing) return <ClearDataPage onBack={popLibraryPage} />;
  const folderKey = route?.startsWith(FOLDER) ? route.slice(FOLDER.length) : null;
  const folder = folderKey ? findFolder(bookmarks, folderKey) : null;
  const prompt = folderKey ? null : LIBRARY_SEARCH_PROMPTS[section];
  const showMenu = (items: MenuItem[], at: Point) => {
    menuOpenedHaptic();
    setRowMenu({ items, at });
  };
  const confirmDeleteAll = () => {
    const asked: Confirmation = {
      title: "Delete All Downloads?",
      message: "The files are removed from this phone.",
      action: "Delete All",
      run: () => {
        haptics.warning();
        deleteAllDownloads();
      },
    };
    confirmInSheet(asked, () => setConfirmation(asked));
  };
  const items: MenuItem[] = [
    ...(section === "downloads" ? ([{ label: "Delete All Downloads…", icon: "trash", destructive: true, disabled: !hasFiles, onPress: confirmDeleteAll }, "divider"] as MenuItem[]) : []),
    {
      label: "Clear Browsing Data",
      icon: "eraserFill",
      onPress: () => pushLibraryPage(LIBRARY_CLEAR_DATA),
    },
  ];
  const listBottom = insets.bottom + space.l;
  const content = folderKey ? (
    <BookmarkFolder folder={folder} bottom={listBottom} onMenu={showMenu} />
  ) : section === "history" ? (
    <HistoryList query={query} bottom={listBottom} onMenu={showMenu} />
  ) : section === "bookmarks" ? (
    <BookmarkList bookmarks={bookmarks} query={query} bottom={listBottom} onMenu={showMenu} />
  ) : (
    <DownloadList bottom={listBottom} onMenu={showMenu} />
  );
  return (
    <View testID="libraryView" style={StyleSheet.absoluteFill}>
      <LookBackdrop />
      <View style={[styles.column, { paddingTop: frame ? 0 : insets.top }]}>
        <View style={styles.top}>
          {folderKey ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={popLibraryPage} style={styles.topButton}>
              <Symbol name="chevronLeft" size={20} color={theme.formAccent} />
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" onPress={closeLibrary} style={styles.topButton}>
              <Text style={[font.body, styles.bold, { color: theme.formAccent }]}>Done</Text>
            </Pressable>
          )}
          <Text accessibilityRole="header" numberOfLines={1} style={[font.body, styles.bold, styles.title, { color: theme.label }]}>
            {folderKey ? folder?.title || "Untitled Folder" : LIBRARY_NAMES[section]}
          </Text>
          <MenuTrigger items={items} trigger="tap" place={{ right: space.s, width: Math.min(tabsLayout.menuWidth, width - space.l) }}>
            {({ onPress }) => (
              <Pressable accessibilityRole="button" accessibilityLabel="More" onPress={onPress} style={[styles.topButton, styles.end]}>
                <Symbol name="ellipsis" size={22} color={theme.formAccent} />
              </Pressable>
            )}
          </MenuTrigger>
        </View>
        {folderKey ? null : <Switcher section={section} />}
        {prompt ? <SearchField prompt={prompt} query={query} onChange={setQuery} /> : null}
        {content}
      </View>
      {rowMenu ? <FloatingMenu items={rowMenu.items} at={rowMenu.at} dimmed place={{ width: Math.min(tabsLayout.menuWidth, width - space.xl * 2) }} onDismiss={() => setRowMenu(null)} /> : null}
      {confirmation ? <ConfirmSheet confirmation={confirmation} onClose={() => setConfirmation(null)} /> : null}
    </View>
  );
}

function Switcher({ section }: { section: LibrarySection }) {
  const theme = useTheme();
  return (
    <View testID="librarySwitcher" accessibilityRole="tablist" style={[styles.switcher, { backgroundColor: theme.fieldFill }]}>
      {LIBRARY_SECTIONS.map((item) => {
        const selected = item === section;
        return (
          <Pressable
            key={item}
            testID={`librarySection:${item}`}
            accessibilityRole="tab"
            accessibilityLabel={LIBRARY_NAMES[item]}
            accessibilityState={{ selected }}
            onPress={() => showLibrarySection(item)}
            style={[styles.segment, selected ? { backgroundColor: theme.groupFill } : null]}
          >
            <Symbol name={SECTION_SYMBOLS[item]} size={17} color={selected ? theme.label : theme.secondaryLabel} />
          </Pressable>
        );
      })}
    </View>
  );
}

function SearchField({ prompt, query, onChange }: { prompt: string; query: string; onChange: (text: string) => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.search, { backgroundColor: theme.fieldFill }]}>
      <Symbol name="magnifyingglass" size={17} color={theme.secondaryLabel} />
      <TextInput
        testID="librarySearch"
        value={query}
        onChangeText={onChange}
        placeholder={prompt}
        placeholderTextColor={theme.secondaryLabel}
        style={[font.body, styles.input, { color: theme.label }]}
        selectionColor={theme.formAccent}
        autoCorrect={false}
        autoCapitalize="none"
      />
      {query ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear Search" onPress={() => onChange("")}>
          <Symbol name="xmarkCircleFill" size={18} color={theme.secondaryLabel} />
        </Pressable>
      ) : null}
    </View>
  );
}

const noResults = (query: string) => <EmptyState title={`No Results for “${query.trim()}”`} message="Check the spelling or try a new search." icon="magnifyingglass" />;

type MenuOpener = (items: MenuItem[], at: Point) => void;

function SectionHeader({ title }: { title: string }) {
  const theme = useTheme();
  return (
    <Text accessibilityRole="header" style={[font.footnote, styles.section, { color: theme.secondaryLabel, backgroundColor: theme.surface }]}>
      {title}
    </Text>
  );
}

function HistoryList({ query, bottom, onMenu }: { query: string; bottom: number; onMenu: MenuOpener }) {
  const frame = useSheetFrame();
  const open = useLibrary((s) => s.open);
  const entries = useLibrary((s) => s.history);
  const loaded = useLibrary((s) => s.historyLoaded);
  const syncRevision = useSync((s) => s.revision);
  const space = useTabs((s) => s.spaces.current);
  useEffect(() => {
    if (open) loadHistory();
  }, [open, syncRevision, space]);
  const shown = useMemo(() => filterHistory(entries, query), [entries, query]);
  const now = Date.now();
  const sections = useMemo(() => historyDays(shown).map((day) => ({ key: String(day.day), title: historyDayTitle(day.day, now), data: day.entries })), [shown]);
  const iconSize = useRowIcon();
  if (!loaded) return null;
  if (!entries.length) return <EmptyState title="No History" message="Pages you visit here and on your Mac show up here." icon="clockArrow" />;
  if (!shown.length) return noResults(query);
  return (
    <SectionList
      testID="libraryHistory"
      sections={sections}
      keyExtractor={(entry) => entry.url}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      stickySectionHeadersEnabled
      {...frame?.list(false)}
      contentContainerStyle={{ paddingBottom: bottom }}
      renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
      renderItem={({ item }) => <HistoryRow entry={item} iconSize={iconSize} onMenu={onMenu} />}
    />
  );
}

function HistoryRow({ entry, iconSize, onMenu }: { entry: HistoryEntry; iconSize: number; onMenu: MenuOpener }) {
  const theme = useTheme();
  const host = historyHost(entry.url);
  const time = clockTime(entry.visitedAt);
  const thisDevice = entry.source === "thisDevice";
  const remove = () => deleteHistoryEntry(entry);
  return (
    <SwipeToDelete onDelete={remove}>
      <LibraryRow
        title={entry.title || entry.url}
        label={`${entry.title || entry.url}, ${host}, ${time}, ${thisDevice ? "This phone" : "Another device"}`}
        icon={<Favicon iconUrl={null} pageUrl={entry.url} size={iconSize} />}
        onPress={() => openRow(entry.url, entry.title)}
        onLongPress={(at) => onMenu([...linkItems(entry.url, entry.title), "divider", { label: "Delete", icon: "trash", destructive: true, onPress: remove }], at)}
      >
        <View style={styles.subtitle}>
          <Symbol name={thisDevice ? "iphone" : "laptop"} size={DEVICE_GLYPH} color={theme.secondaryLabel} />
          <Text style={[font.footnote, styles.shrink, { color: theme.secondaryLabel }]} numberOfLines={1}>{`${host} · ${time}`}</Text>
        </View>
      </LibraryRow>
    </SwipeToDelete>
  );
}

function LibraryRow({ title, label, icon, onPress, onLongPress, hint = "Opens the page.", children }: { title: string; label?: string; icon: ReactNode; onPress: () => void; onLongPress?: (at: Point) => void; hint?: string; children?: ReactNode }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      onLongPress={onLongPress ? (event) => onLongPress({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }) : undefined}
      delayLongPress={tabsMotion.longPress}
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
    >
      <View style={styles.icon}>{icon}</View>
      <View style={styles.label}>
        <Text style={[font.body, { color: theme.label }]} numberOfLines={1}>
          {title}
        </Text>
        {children}
      </View>
    </Pressable>
  );
}

function BookmarkList({ bookmarks, query, bottom, onMenu }: { bookmarks: BookmarkItem[]; query: string; bottom: number; onMenu: MenuOpener }) {
  const frame = useSheetFrame();
  const enabled = useSyncEnabled();
  const iconSize = useRowIcon();
  const trimmed = query.trim();
  const matches = useMemo(() => (trimmed ? bookmarkMatches(bookmarks, trimmed) : null), [bookmarks, trimmed]);
  const sections = useMemo(() => (matches ? [{ id: "matches", title: null, data: matches }] : bookmarkSections(bookmarks).map((section) => ({ id: section.id, title: section.title, data: section.items }))), [bookmarks, matches]);
  if (!bookmarks.length) return <EmptyState title="No Bookmarks" message={enabled ? "Bookmarks you save on your Mac show up here." : "Sync with your Mac to see its bookmarks here."} icon="star" />;
  if (matches && !matches.length) return noResults(trimmed);
  return (
    <SectionList
      testID="libraryBookmarks"
      sections={sections}
      keyExtractor={(item) => item.key}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      stickySectionHeadersEnabled
      {...frame?.list(false)}
      contentContainerStyle={{ paddingBottom: bottom }}
      renderSectionHeader={({ section }) => (section.title ? <SectionHeader title={section.title} /> : null)}
      renderItem={({ item }) => <BookmarkRow item={item} iconSize={iconSize} onMenu={onMenu} />}
    />
  );
}

function BookmarkFolder({ folder, bottom, onMenu }: { folder: BookmarkItem | null; bottom: number; onMenu: MenuOpener }) {
  const frame = useSheetFrame();
  const iconSize = useRowIcon();
  const children = folder?.children ?? [];
  if (!children.length) return <EmptyState title="Empty Folder" message="" icon="folderFill" />;
  return (
    <FlatList
      testID="libraryFolder"
      data={children}
      keyExtractor={(item) => item.key}
      {...frame?.list(false)}
      contentContainerStyle={{ paddingBottom: bottom }}
      renderItem={({ item }) => <BookmarkRow item={item} iconSize={iconSize} onMenu={onMenu} />}
    />
  );
}

function BookmarkRow({ item, iconSize, onMenu }: { item: BookmarkItem; iconSize: number; onMenu: MenuOpener }) {
  const theme = useTheme();
  if (!item.url) {
    const count = (item.children ?? []).length;
    return (
      <LibraryRow
        title={item.title || "Untitled Folder"}
        label={`${item.title || "Untitled Folder"}, ${count.toLocaleString()}`}
        hint="Opens the folder."
        icon={<Symbol name="folderFill" size={iconSize} color={theme.secondaryLabel} />}
        onPress={() => pushLibraryPage(`${FOLDER}${item.key}`)}
      >
        <Text style={[font.footnote, { color: theme.secondaryLabel }]}>{count.toLocaleString()}</Text>
      </LibraryRow>
    );
  }
  const url = item.url;
  const links = linkItems(url, item.title);
  return (
    <LibraryRow title={item.title || url} icon={<Favicon iconUrl={null} pageUrl={url} size={iconSize} />} onPress={() => openRow(url, item.title)} onLongPress={links.length ? (at) => onMenu(links, at) : undefined}>
      <Text style={[font.footnote, { color: theme.secondaryLabel }]} numberOfLines={1}>
        {historyHost(url)}
      </Text>
    </LibraryRow>
  );
}

function DownloadList({ bottom, onMenu }: { bottom: number; onMenu: MenuOpener }) {
  const frame = useSheetFrame();
  const open = useLibrary((s) => s.open);
  const files = useLibrary((s) => s.files);
  const loaded = useLibrary((s) => s.filesLoaded);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (open) void loadDownloads();
  }, [open]);
  const refresh = async () => {
    setRefreshing(true);
    await loadDownloads();
    setRefreshing(false);
  };
  if (loaded && !files.length) return <EmptyState title="No Downloads" message="Files you download show up here." icon="arrowDownCircle" />;
  return (
    <FlatList
      testID="libraryDownloads"
      data={files}
      keyExtractor={(file) => file.uri}
      {...frame?.list(true)}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      contentContainerStyle={{ paddingBottom: bottom }}
      renderItem={({ item }) => <DownloadRow file={item} onMenu={onMenu} />}
    />
  );
}

function DownloadRow({ file, onMenu }: { file: DownloadedFile; onMenu: MenuOpener }) {
  const theme = useTheme();
  const iconSize = useRowIcon();
  const subtitle = downloadSubtitle(file.size, file.modified);
  const remove = () => deleteDownload(file);
  return (
    <SwipeToDelete onDelete={remove}>
      <LibraryRow
        title={file.name}
        label={`${file.name}, ${subtitle}`}
        hint="Shows the file."
        icon={<Symbol name="docText" size={iconSize} color={theme.secondaryLabel} />}
        onPress={() => previewDownload(file)}
        onLongPress={(at) =>
          onMenu(
            [
              { label: "Share", icon: "squareAndArrowUp", onPress: () => shareDownload(file) },
              "divider",
              { label: "Delete", icon: "trash", destructive: true, onPress: remove },
            ],
            at,
          )
        }
      >
        <Text style={[font.footnote, { color: theme.secondaryLabel }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </LibraryRow>
    </SwipeToDelete>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1 },
  top: { minHeight: tabsLayout.archiveTop, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.s },
  topButton: { minWidth: tabsLayout.archiveButton, minHeight: tabsLayout.archiveButton, justifyContent: "center", paddingHorizontal: space.s },
  end: { alignItems: "flex-end" },
  title: { flexShrink: 1, textAlign: "center" },
  bold: { fontWeight: "600" },
  switcher: { flexDirection: "row", alignSelf: "center", padding: space.hair, borderRadius: radius.field - space.xs, marginTop: space.xs },
  segment: { minWidth: SWITCHER_HEIGHT * 1.5, height: SWITCHER_HEIGHT, alignItems: "center", justifyContent: "center", borderRadius: radius.field - space.xs - space.hair },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 2,
    marginHorizontal: space.l,
    marginVertical: space.s,
    paddingHorizontal: space.s + 2,
    minHeight: tabsLayout.archiveField,
    borderRadius: radius.field - space.xs,
  },
  input: { flex: 1, paddingVertical: space.s },
  section: { paddingHorizontal: space.xl, paddingTop: space.l, paddingBottom: space.xs, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: space.m, paddingHorizontal: space.l, paddingVertical: space.s, marginHorizontal: space.s, borderRadius: radius.row },
  icon: { paddingTop: space.tight, alignSelf: "flex-start" },
  label: { flex: 1, gap: space.hair },
  subtitle: { flexDirection: "row", alignItems: "center", gap: space.xs },
  shrink: { flexShrink: 1 },
});
