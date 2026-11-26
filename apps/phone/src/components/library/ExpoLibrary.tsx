import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PlatformColor, StyleSheet } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, ContentUnavailableView, ContextMenu, HStack, Host, Image, List, Menu, NavigationDestination, NavigationLink, NavigationStack, Picker, Spacer, SwipeActions, Text, Toolbar, ToolbarItem, useNativeState } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityLabel,
  alignmentGuide,
  disabled,
  font,
  foregroundStyle,
  frame,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  onAppear,
  padding,
  pickerStyle,
  refreshable,
  scrollContentBackground,
  scrollDismissesKeyboard,
  searchable,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { BookmarkItem } from "../../platform/sync";
import { haptics } from "../../state/app/haptics";
import { copyLink } from "../../state/browse/tabMenus";
import { bookmarkMatches, bookmarkSections } from "../../state/library/bookmarkSearch";
import { filterHistory, historyDays, historyDayTitle, historyHost, type HistoryEntry } from "../../state/library/historyTimeline";
import { clockTime, downloadSubtitle, FILE_SYMBOLS } from "../../state/library/libraryText";
import { eagerSections, LIST_PAGE_ROWS, sectionOverscan, sectionsWithin, sheetWasSlow } from "../../lib/sectionWindow";
import { countUsage } from "../../state/telemetry/telemetry";
import {
  closeLibrary,
  deleteAllDownloads,
  deleteDownload,
  deleteHistoryEntry,
  followLibraryPath,
  LIBRARY_CLEAR_DATA,
  LIBRARY_NAMES,
  LIBRARY_SEARCH_PROMPTS,
  LIBRARY_SECTIONS,
  LIBRARY_SYMBOLS,
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
import { usePageUi } from "../../state/page/store";
import { ExpoClearDataPage } from "../settings/ExpoClearDataPage";
import { actionWords } from "../../lib/sharedWords";
import { DoneToolbarItem } from "../settings/ExpoSettingsDone";
import { contentMargins, iconRoles, modifierList, neverBounces, settingsChrome, sfName } from "../ui";
import { LinkMenuItems, ListLoading, ListNoResults, ListRow, ListRowSubtitle, listSheetWords, opensPage } from "./listSheet";
import { libraryLayout as L, listRowLayout } from "./listSheetTokens";

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const FILL = Number.MAX_SAFE_INTEGER;
const FOLDER = "folder:";

const ROW_CHROME = [listRowBackground(PlatformColor("secondarySystemGroupedBackground")), listRowInsets({ top: 0, leading: L.page, bottom: 0, trailing: L.page }), alignmentGuide("listRowSeparatorLeading", listRowLayout.icon + listRowLayout.gap)];
const HEADER_ROW = [listRowBackground("transparent"), listRowSeparator("hidden"), listRowInsets({ top: 0, leading: L.page, bottom: 0, trailing: L.page }), accessibilityAddTraits(["isHeader"])];

const shareable = (url: string) => /^https?:\/\//i.test(url);

export function ExpoLibrarySheet() {
  const open = useLibrary((s) => s.open);
  const inPageMenu = usePageUi((s) => s.menuOpen && s.menuPage === "library");
  return (
    <Host testID="expoLibrarySheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open && !inPageMenu} onIsPresentedChange={(presented) => (presented ? undefined : closeLibrary())}>
        <LibraryNavigation />
      </BottomSheet>
    </Host>
  );
}

export function LibraryNavigation() {
  const section = useLibrary((s) => s.section);
  const path = useLibrary((s) => s.path);
  const hasFiles = useLibrary((s) => s.files.length > 0);
  const searchText = useNativeState("");
  const [query, setQuery] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    searchText.value = "";
    setQuery("");
  }, [section]);
  const prompt = LIBRARY_SEARCH_PROMPTS[section];
  const page = modifierList(
    navigationTitle(LIBRARY_NAMES[section]),
    navigationBarTitleDisplayMode("inline"),
    tint(PlatformColor("systemBlue")),
    settingsChrome(),
    neverBounces(),
    prompt ? searchable(searchText, { placement: "navigationBarDrawer", prompt, onChange: setQuery }) : null,
  );
  const content = section === "history" ? <HistoryContent query={query} page={page} /> : section === "bookmarks" ? <BookmarksContent query={query} page={page} /> : <DownloadsContent page={page} />;
  return (
    <NavigationStack path={path} onPathChange={followLibraryPath}>
      <Toolbar>
        <ConfirmationDialog title="Delete All Downloads?" isPresented={confirmingDelete} onIsPresentedChange={setConfirmingDelete} titleVisibility="visible">
          <ConfirmationDialog.Trigger>{content}</ConfirmationDialog.Trigger>
          <ConfirmationDialog.Actions>
            <Button
              role="destructive"
              label={listSheetWords.deleteAll}
              onPress={() => {
                haptics.warning();
                deleteAllDownloads();
              }}
            />
          </ConfirmationDialog.Actions>
          <ConfirmationDialog.Message>
            <Text>The files are removed from this iPhone.</Text>
          </ConfirmationDialog.Message>
        </ConfirmationDialog>
        <Toolbar.Content>
          <ToolbarItem placement="principal">
            <LibrarySwitcher section={section} />
          </ToolbarItem>
          <ToolbarItem placement="primaryAction">
            <Menu label={actionWords.more} systemImage={sfName(iconRoles.more)} modifiers={[accessibilityLabel(actionWords.more)]}>
              {section === "downloads" ? <Button label={listSheetWords.deleteAllEntry} systemImage="trash" role="destructive" onPress={() => setConfirmingDelete(true)} modifiers={[disabled(!hasFiles)]} /> : null}
              <Button label="Clear Browsing Data" onPress={() => pushLibraryPage(LIBRARY_CLEAR_DATA)} />
            </Menu>
          </ToolbarItem>
          <DoneToolbarItem onDone={closeLibrary} />
        </Toolbar.Content>
      </Toolbar>
      {path.map((key) => (
        <NavigationDestination key={key} value={key}>
          <LibraryDestination routeKey={key} />
        </NavigationDestination>
      ))}
    </NavigationStack>
  );
}

function LibrarySwitcher({ section }: { section: LibrarySection }) {
  return (
    <Picker selection={section} onSelectionChange={(next: LibrarySection) => showLibrarySection(next)} modifiers={[pickerStyle("segmented"), frame({ width: L.switcherSegment * LIBRARY_SECTIONS.length + L.tight * 2 })]}>
      {LIBRARY_SECTIONS.map((item) => (
        <Image key={item} systemName={LIBRARY_SYMBOLS[item] as never} modifiers={[tag(item), accessibilityLabel(LIBRARY_NAMES[item])]} />
      ))}
    </Picker>
  );
}

function LibraryDestination({ routeKey }: { routeKey: string }) {
  if (routeKey === LIBRARY_CLEAR_DATA) return <ExpoClearDataPage onCleared={popLibraryPage} />;
  if (routeKey.startsWith(FOLDER)) return <BookmarkFolderPage folderKey={routeKey.slice(FOLDER.length)} />;
  return null;
}

type PageModifiers = ReturnType<typeof modifierList>;

const listModifiers = (page: PageModifiers, extra: PageModifiers = []) => modifierList(...page, listStyle("plain"), contentMargins({ edges: "top", length: L.tight }), scrollContentBackground("hidden"), scrollDismissesKeyboard("immediately"), ...extra);

const noResults = (query: string, page: PageModifiers) => <ListNoResults query={query} modifiers={page} />;

function HistoryContent({ query, page }: { query: string; page: PageModifiers }) {
  const open = useLibrary((s) => s.open);
  const entries = useLibrary((s) => s.history);
  const loaded = useLibrary((s) => s.historyLoaded);
  const syncRevision = useSync((s) => s.revision);
  const space = useTabs((s) => s.spaces.current);
  useEffect(() => {
    if (open) loadHistory();
  }, [open, syncRevision, space]);
  const shown = useMemo(() => filterHistory(entries, query), [entries, query]);
  const days = useMemo(() => historyDays(shown), [shown]);
  const sizes = useMemo(() => days.map((day) => day.entries.length), [days]);
  const eager = useMemo(() => eagerSections(sizes), [sizes]);
  const [pageRows, setPageRows] = useState(LIST_PAGE_ROWS);
  const listed = sectionsWithin(sizes, pageRows);
  const more = useCallback(() => {
    countUsage("list_pages_added");
    setPageRows((rows) => rows + LIST_PAGE_ROWS);
  }, []);
  const requestedAt = useRef<number | null>(null);
  if (!open) requestedAt.current = null;
  else requestedAt.current ??= Date.now();
  useEffect(() => {
    if (!loaded) return;
    const frame = requestAnimationFrame(() => {
      if (sheetWasSlow(requestedAt.current, Date.now())) countUsage("list_sheets_late");
      requestedAt.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [loaded]);
  const now = Date.now();
  if (!loaded) return <ListLoading modifiers={page} />;
  if (!entries.length) return <ContentUnavailableView title="No History" systemImage="clock" description="Pages you visit here and on your Mac show up here." modifiers={page} />;
  if (!shown.length) return noResults(query, page);
  return (
    <List modifiers={listModifiers(page)}>
      {days.slice(0, listed).map((day, index) => (
        <HistoryDaySection key={day.day} title={historyDayTitle(day.day, now)} entries={day.entries} eager={eager[index] ?? false} onLast={index === listed - 1 && listed < days.length ? more : undefined} />
      ))}
    </List>
  );
}

function HistoryDaySection({ title, entries, eager, onLast }: { title: string; entries: HistoryEntry[]; eager: boolean; onLast?: () => void }) {
  const row = useCallback(({ item }: { item: HistoryEntry }) => <HistoryRow entry={item} />, []);
  const [seen, setSeen] = useState(false);
  const near = eager || seen;
  const wake = useCallback(() => setSeen(true), []);
  return (
    <>
      <LibrarySectionHeader title={title} onAppear={near && !onLast ? undefined : () => {
        wake();
        onLast?.();
      }} />
      <List.ForEach data={entries} keyExtractor={(entry) => entry.url} onDelete={(indices) => indices.forEach((index) => entries[index] && deleteHistoryEntry(entries[index]))} estimatedItemSize={64} overscanCount={sectionOverscan(near)}>
        {row}
      </List.ForEach>
    </>
  );
}

function LibrarySectionHeader({ title, onAppear: appeared }: { title: string; onAppear?: () => void }) {
  return <Text modifiers={[font({ textStyle: "headline" }), foregroundStyle(SECONDARY), frame({ maxWidth: FILL, alignment: "leading" }), padding({ top: L.headerTop, bottom: L.tight }), ...HEADER_ROW, ...(appeared ? [onAppear(appeared)] : [])]}>{title}</Text>;
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const host = historyHost(entry.url);
  const time = clockTime(entry.visitedAt);
  const thisDevice = entry.source === "thisDevice";
  const subtitle = (
    <HStack spacing={L.deviceGap} modifiers={[accessibilityElement("ignore")]}>
      <Image systemName={thisDevice ? "iphone" : "laptopcomputer"} size={L.deviceGlyph} color={PlatformColor("secondaryLabel")} />
      <ListRowSubtitle text={`${host} · ${time}`} />
    </HStack>
  );
  return (
    <ContextMenu modifiers={ROW_CHROME}>
      <ContextMenu.Trigger>
        <LibraryRow title={entry.title} url={entry.url} subtitle={subtitle} label={`${entry.title || entry.url}, ${host}, ${time}, ${thisDevice ? "This iPhone" : "Another device"}`} />
      </ContextMenu.Trigger>
      <ContextMenu.Items>
        {shareable(entry.url) ? <LinkMenuItems url={entry.url} onCopy={() => copyLink(entry.url)} /> : null}
        <Button label="Delete" systemImage="trash" role="destructive" onPress={() => deleteHistoryEntry(entry)} />
      </ContextMenu.Items>
    </ContextMenu>
  );
}

function LibraryRow({ title, url, subtitle, label }: { title: string; url: string; subtitle: ReactNode; label?: string }) {
  return <ListRow title={title || url} subtitle={subtitle} label={label} leading={{ favicon: { url } }} hint="Opens the page." rowModifiers={[padding({ vertical: L.rowPadding })]} onPress={opensPage(() => openFromLibrary(url, title))} />;
}

function useBookmarks(): BookmarkItem[] {
  const enabled = useSyncEnabled();
  const profile = useSelectedProfile();
  return enabled ? (profile?.bookmarks ?? []) : [];
}

function BookmarksContent({ query, page }: { query: string; page: PageModifiers }) {
  const enabled = useSyncEnabled();
  const bookmarks = useBookmarks();
  const trimmed = query.trim();
  const matches = useMemo(() => (trimmed ? bookmarkMatches(bookmarks, trimmed) : null), [bookmarks, trimmed]);
  const sections = useMemo(() => bookmarkSections(bookmarks), [bookmarks]);
  if (!bookmarks.length) return <ContentUnavailableView title="No Bookmarks" systemImage="book" description={enabled ? "Bookmarks you save on your Mac show up here." : "Sync with your Mac to see its bookmarks here."} modifiers={page} />;
  if (matches && !matches.length) return noResults(trimmed, page);
  return (
    <List modifiers={listModifiers(page)}>
      {matches
        ? matches.map((item) => <BookmarkRow key={item.key} item={item} />)
        : sections.map((section) => (
            <BookmarkGroup key={section.id} title={section.title} items={section.items} />
          ))}
    </List>
  );
}

function BookmarkGroup({ title, items }: { title: string | null; items: readonly BookmarkItem[] }) {
  return (
    <>
      {title ? <LibrarySectionHeader title={title} /> : null}
      {items.map((item) => (
        <BookmarkRow key={item.key} item={item} />
      ))}
    </>
  );
}

function BookmarkRow({ item }: { item: BookmarkItem }) {
  if (!item.url) {
    return (
      <NavigationLink value={`${FOLDER}${item.key}`} modifiers={ROW_CHROME}>
        <HStack spacing={listRowLayout.gap} modifiers={[padding({ vertical: L.folderPadding })]}>
          <Text>{item.title || "Untitled Folder"}</Text>
          <Spacer />
          <Text modifiers={[foregroundStyle(SECONDARY)]}>{(item.children ?? []).length.toLocaleString()}</Text>
        </HStack>
      </NavigationLink>
    );
  }
  const url = item.url;
  return (
    <ContextMenu modifiers={ROW_CHROME}>
      <ContextMenu.Trigger>
        <LibraryRow title={item.title} url={url} subtitle={historyHost(url)} />
      </ContextMenu.Trigger>
      <ContextMenu.Items>{shareable(url) ? <LinkMenuItems url={url} onCopy={() => copyLink(url)} /> : null}</ContextMenu.Items>
    </ContextMenu>
  );
}

function findFolder(items: readonly BookmarkItem[], key: string): BookmarkItem | null {
  for (const item of items) {
    if (item.key === key && !item.url) return item;
    const found = item.children ? findFolder(item.children, key) : null;
    if (found) return found;
  }
  return null;
}

function BookmarkFolderPage({ folderKey }: { folderKey: string }) {
  const bookmarks = useBookmarks();
  const folder = findFolder(bookmarks, folderKey);
  const page = modifierList(navigationTitle(folder?.title ?? ""), navigationBarTitleDisplayMode("inline"), settingsChrome(), neverBounces());
  const children = folder?.children ?? [];
  if (!children.length) return <ContentUnavailableView title="Empty Folder" systemImage="folder" modifiers={page} />;
  return (
    <List modifiers={listModifiers(page)}>
      <BookmarkGroup title={null} items={children} />
    </List>
  );
}

function DownloadsContent({ page }: { page: PageModifiers }) {
  const open = useLibrary((s) => s.open);
  const files = useLibrary((s) => s.files);
  const loaded = useLibrary((s) => s.filesLoaded);
  useEffect(() => {
    if (open) void loadDownloads();
  }, [open]);
  if (!loaded) return <ListLoading modifiers={page} />;
  if (!files.length) return <ContentUnavailableView title="No Downloads" systemImage="arrow.down.circle" description="Files you download show up here." modifiers={page} />;
  return (
    <List modifiers={listModifiers(page, [refreshable(loadDownloads)])}>
      {files.map((file) => (
        <DownloadRow key={file.uri} file={file} />
      ))}
    </List>
  );
}

function DownloadRow({ file }: { file: DownloadedFile }) {
  const share = () => shareDownload(file);
  const remove = () => deleteDownload(file);
  return (
    <SwipeActions modifiers={ROW_CHROME}>
      <ContextMenu>
        <ContextMenu.Trigger>
          <ListRow title={file.name} titleTruncation="middle" subtitle={downloadSubtitle(file.size, file.modified)} leading={{ symbol: FILE_SYMBOLS[file.kind] }} hint="Shows the file." rowModifiers={[padding({ vertical: L.rowPadding })]} onPress={() => previewDownload(file)} />
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          <Button label={actionWords.share} systemImage={sfName(iconRoles.share)} onPress={share} />
          <Button label="Delete" systemImage="trash" role="destructive" onPress={remove} />
        </ContextMenu.Items>
      </ContextMenu>
      <SwipeActions.Actions edge="trailing">
        <Button label="Delete" role="destructive" onPress={remove} />
        <Button label={actionWords.share} onPress={share} modifiers={[tint(PlatformColor("systemBlue"))]} />
      </SwipeActions.Actions>
    </SwipeActions>
  );
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", width: 0, height: 0 },
});
