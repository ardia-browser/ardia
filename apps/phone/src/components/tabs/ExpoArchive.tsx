import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { PlatformColor, StyleSheet } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, ContentUnavailableView, ContextMenu, Divider, Host, List, Menu, NavigationStack, Picker, Section, Text, Toolbar, ToolbarItem, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityLabel, disabled, environment, listRowInsets, listStyle, navigationBarTitleDisplayMode, navigationTitle, onAppear, pickerStyle, searchable, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { actionWords, destinationWords, dismissWords } from "../../lib/sharedWords";
import { DoneToolbarItem } from "../settings/ExpoSettingsDone";
import { ARCHIVE_SEARCH_DELAY_MS, archiveDayTitle } from "../../lib/archiveDay";
import { eagerSections, LIST_PAGE_ROWS, sectionOverscan, sectionsWithin, sheetWasSlow } from "../../lib/sectionWindow";
import { countUsage } from "../../state/telemetry/telemetry";
import { haptics } from "../../state/app/haptics";
import { closeArchive, useBrowse } from "../../state/browse/store";
import { canShareTab, copyTabLink, deleteArchivedTab, deleteArchivedTabs, openArchivedTab } from "../../state/browse/tabMenus";
import { display } from "../../state/search/omnibox";
import { usePreferences } from "../../state/settings/hooks";
import { useArchiveDays, useArchiveLoaded } from "../../state/tabs/hooks";
import { archiveInMemory, clearArchivedTabs, loadArchiveUnlessPrepared, searchArchive, setAutoArchiveInterval } from "../../state/tabs/store";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval, type BrowserTab } from "../../state/tabs/tabModels";
import { LinkMenuItems, ListLoading, ListNoResults, ListRow, listSheetWords, opensPage } from "../library/listSheet";
import { listSheetInsets } from "../library/listSheetTokens";
import { iconRoles, modifierList, settingsChrome, sfName } from "../ui";

const INTERVALS = Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[];

export function ExpoArchiveSheet() {
  const open = useBrowse((s) => s.sheet === "archive");
  const requestedAt = useRef<number | null>(null);
  if (!open) requestedAt.current = null;
  else requestedAt.current ??= Date.now();
  return (
    <Host testID="expoArchiveSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} onIsPresentedChange={(presented) => (presented ? undefined : closeArchive())}>
        <ArchiveNavigation requestedAt={requestedAt} />
      </BottomSheet>
    </Host>
  );
}

function ArchiveNavigation({ requestedAt }: { requestedAt: MutableRefObject<number | null> }) {
  const days = useArchiveDays();
  const loaded = useArchiveLoaded();
  const sizes = useMemo(() => days.map((day) => day.tabs.length), [days]);
  const eager = useMemo(() => eagerSections(sizes), [sizes]);
  const [pageRows, setPageRows] = useState(LIST_PAGE_ROWS);
  const listed = sectionsWithin(sizes, pageRows);
  const more = useCallback(() => {
    countUsage("list_pages_added");
    setPageRows((rows) => rows + LIST_PAGE_ROWS);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const frame = requestAnimationFrame(() => {
      if (sheetWasSlow(requestedAt.current, Date.now())) countUsage("list_sheets_late");
      requestedAt.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [loaded, requestedAt]);
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const searchText = useNativeState("");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const appeared = useCallback(() => setShown(true), []);
  useEffect(() => {
    if (!archiveInMemory()) loadArchiveUnlessPrepared();
  }, []);
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearched("");
      return;
    }
    const wait = setTimeout(() => setSearched(trimmed), ARCHIVE_SEARCH_DELAY_MS);
    return () => clearTimeout(wait);
  }, [query]);
  const results = useMemo(() => (searched ? searchArchive(searched) : null), [searched, days]);
  const hasArchive = days.some((day) => day.tabs.length > 0);
  const onScreen = shown || (loaded && !hasArchive);
  useEffect(() => {
    if (onScreen) loadArchiveUnlessPrepared();
  }, [onScreen]);
  const now = Date.now();
  const page = modifierList(navigationTitle(destinationWords.archive), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), searchable(searchText, { placement: "navigationBarDrawer", prompt: SEARCH_PROMPT, onChange: setQuery }));
  const content = !loaded ? (
    <ListLoading modifiers={page} />
  ) : !hasArchive ? (
    <ContentUnavailableView title="No Archived Tabs" systemImage="archivebox.fill" description="Closed and inactive tabs show up here." modifiers={page} />
  ) : results && !results.length ? (
    <ListNoResults query={searched} modifiers={page} />
  ) : (
    <List modifiers={modifierList(...page, listStyle("insetGrouped"), environment("editMode", editing ? "active" : "inactive"), ...(shown ? [] : [onAppear(appeared)]))}>
      {results ? (
        <Section title="">
          <ArchiveRows tabs={results} />
        </Section>
      ) : (
        days.slice(0, listed).filter((_, index) => shown || eager[index]).map((day, index) => <ArchiveDaySection key={day.tabs[0]!.id} title={archiveDayTitle(day.tabs[0]!.archivedAt ?? day.tabs[0]!.lastActive, now).toLocaleUpperCase()} tabs={day.tabs} eager={eager[index] ?? false} onLast={shown && index === listed - 1 && listed < days.length ? more : undefined} />)
      )}
    </List>
  );
  return (
    <NavigationStack>
      <Toolbar>
        <ConfirmationDialog title="Delete All Archived Tabs?" isPresented={confirmingClear} onIsPresentedChange={setConfirmingClear} titleVisibility="visible">
          <ConfirmationDialog.Trigger>{content}</ConfirmationDialog.Trigger>
          <ConfirmationDialog.Actions>
            <Button
              role="destructive"
              label={listSheetWords.deleteAll}
              onPress={() => {
                haptics.warning();
                clearArchivedTabs();
              }}
            />
          </ConfirmationDialog.Actions>
          <ConfirmationDialog.Message>
            <Text>This can’t be undone.</Text>
          </ConfirmationDialog.Message>
        </ConfirmationDialog>
        <Toolbar.Content>
          <ToolbarItem placement="topBarLeading">
            <Button label={editing ? dismissWords.finishEditing : EDIT} onPress={() => setEditing((now) => !now)} modifiers={[disabled(!hasArchive && !editing)]} />
          </ToolbarItem>
          <ToolbarItem placement="primaryAction">
            <Menu label={actionWords.more} systemImage={sfName(iconRoles.more)} modifiers={[accessibilityLabel(actionWords.more)]}>
              {shown || (loaded && !hasArchive) ? (
                <>
                  <Picker label="Archive Inactive Tabs" systemImage="archivebox" selection={interval} onSelectionChange={(next: AutoArchiveInterval) => setAutoArchiveInterval(next)} modifiers={[pickerStyle("menu")]}>
                    {INTERVALS.map((option) => (
                      <Text key={option} modifiers={[tag(option)]}>
                        {autoArchiveTitle(option)}
                      </Text>
                    ))}
                  </Picker>
                  <Divider />
                  <Button label={listSheetWords.deleteAllEntry} systemImage="trash" role="destructive" onPress={() => setConfirmingClear(true)} modifiers={[disabled(!hasArchive)]} />
                </>
              ) : null}
            </Menu>
          </ToolbarItem>
          <DoneToolbarItem onDone={closeArchive} />
        </Toolbar.Content>
      </Toolbar>
    </NavigationStack>
  );
}

function ArchiveDaySection({ title, tabs, eager, onLast }: { title: string; tabs: BrowserTab[]; eager: boolean; onLast?: () => void }) {
  const [seen, setSeen] = useState(false);
  const near = eager || seen;
  const appeared = () => {
    setSeen(true);
    onLast?.();
  };
  return (
    <Section title={title} modifiers={near && !onLast ? undefined : [onAppear(appeared)]}>
      <ArchiveRows tabs={tabs} overscan={sectionOverscan(near)} />
    </Section>
  );
}

function ArchiveRows({ tabs, overscan }: { tabs: BrowserTab[]; overscan?: number }) {
  const row = useCallback(({ item }: { item: BrowserTab }) => <ArchiveRow tab={item} />, []);
  return (
    <List.ForEach data={tabs} keyExtractor={(tab) => tab.id} onDelete={(indices) => deleteArchivedTabs(indices.flatMap((index) => (tabs[index] ? [tabs[index]] : [])))} estimatedItemSize={60} overscanCount={overscan}>
      {row}
    </List.ForEach>
  );
}

function ArchiveRow({ tab }: { tab: BrowserTab }) {
  const shown = display(tab.url);
  const restore = opensPage(() => openArchivedTab(tab));
  return (
    <ContextMenu modifiers={[listRowInsets(listSheetInsets.archive)]}>
      <ContextMenu.Trigger>
        <ListRow title={tab.title || shown.host} subtitle={shown.display || shown.host} leading={{ favicon: { url: tab.url, iconUrl: tab.faviconUrl } }} hint="Reopens the tab." onPress={restore} />
      </ContextMenu.Trigger>
      <ContextMenu.Items>
        <Button label={actionWords.open} systemImage="arrow.up.forward.square" onPress={restore} />
        {canShareTab(tab) ? <LinkMenuItems url={tab.url} onCopy={() => copyTabLink(tab)} /> : null}
        <Divider />
        <Button label="Delete" systemImage="trash" role="destructive" onPress={() => deleteArchivedTab(tab)} />
      </ContextMenu.Items>
    </ContextMenu>
  );
}

const EDIT = "Edit";
const SEARCH_PROMPT = "Search Archive";

const styles = StyleSheet.create({
  anchor: { position: "absolute", width: 0, height: 0 },
});
