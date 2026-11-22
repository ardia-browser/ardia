import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { PlatformColor, StyleSheet, useWindowDimensions, View } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, ContentUnavailableView, ContextMenu, Divider, HStack, Host, Label, List, Menu, NavigationStack, Picker, RNHostView, Section, ShareLink, Spacer, Text, Toolbar, ToolbarItem, VStack, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityElement, accessibilityHint, buttonStyle, disabled, environment, font, foregroundStyle, frame, lineLimit, listRowInsets, listStyle, navigationBarTitleDisplayMode, navigationTitle, onAppear, pickerStyle, searchable, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { ARCHIVE_SEARCH_DELAY_MS, archiveDayTitle } from "../../lib/archiveDay";
import { eagerSections, LIST_PAGE_ROWS, sectionOverscan, sectionsWithin, sheetWasSlow } from "../../lib/sectionWindow";
import { countUsage } from "../../state/telemetry/telemetry";
import { haptics } from "../../state/app/haptics";
import { closeArchive, useBrowse } from "../../state/browse/store";
import { canShareTab, copyTabLink, deleteArchivedTab, openArchivedTab } from "../../state/browse/tabMenus";
import { display } from "../../state/search/omnibox";
import { usePreferences } from "../../state/settings/hooks";
import { useArchiveDays, useArchiveLoaded } from "../../state/tabs/hooks";
import { clearArchivedTabs, loadArchiveUnlessPrepared, searchArchive, setAutoArchiveInterval } from "../../state/tabs/store";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval, type BrowserTab } from "../../state/tabs/tabModels";
import { Favicon, modifierList, settingsChrome } from "../ui";
import { t } from "../../lib/uiLanguage";


const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const FILL = Number.MAX_SAFE_INTEGER;
const ROW_FAVICON = 20;
const ROW_FAVICON_SCALE_CAP = 2;
const ROW_INSETS = { top: 5, bottom: 5, leading: 14, trailing: 14 };
const ROW_GAP = 14;
const INTERVALS = Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[];

export function ExpoArchiveSheet() {
  const open = useBrowse((s) => s.sheet === "archive");
  const requestedAt = useRef<number | null>(null);
  if (!open) requestedAt.current = null;
  else requestedAt.current ??= Date.now();
  const deckShown = useBrowse((s) => s.surface === "deck");
  const [warming, setWarming] = useState(false);
  useEffect(() => {
    if (!deckShown || sheetWarmed) return;
    const start = setTimeout(() => {
      sheetWarmed = true;
      setWarming(true);
    }, SHEET_WARM_AFTER_MS);
    return () => clearTimeout(start);
  }, [deckShown]);
  useEffect(() => {
    if (!warming) return;
    const cool = setTimeout(() => setWarming(false), SHEET_WARM_MS);
    return () => clearTimeout(cool);
  }, [warming]);
  return (
    <>
      {warming && !open ? (
        <View style={styles.anchor} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Host style={styles.anchor}>
            <WarmArchive />
          </Host>
        </View>
      ) : null}
      <Host testID="expoArchiveSheet" style={styles.anchor} pointerEvents="none">
        <BottomSheet isPresented={open} onIsPresentedChange={(presented) => (presented ? undefined : closeArchive())}>
          <ArchiveNavigation requestedAt={requestedAt} />
        </BottomSheet>
      </Host>
    </>
  );
}

const SHEET_WARM_AFTER_MS = 1_000;
const SHEET_WARM_MS = 700;
let sheetWarmed = false;

const WARM_ROWS: BrowserTab[] = [{ id: "archive-warm", url: "https://example.com/", title: "", created: 0, lastActive: 0, archivedAt: 0, position: 0, profileSyncId: null, faviconUrl: null, themeColorHex: null, snapshotFileName: null, origin: "typed", receivedKey: null, receivedFromDevice: null, pinnedKey: null, isPrivate: false }];

function WarmArchive() {
  const searchText = useNativeState("");
  const page = modifierList(navigationTitle(t(`Archive`)), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), searchable(searchText, { placement: "navigationBarDrawer", prompt: t(`Search Archive`) }));
  return (
    <NavigationStack>
      <Toolbar>
        <List modifiers={modifierList(...page, listStyle("insetGrouped"))}>
          <Section title="">
            <ArchiveRows tabs={WARM_ROWS} overscan={0} />
          </Section>
        </List>
        <Toolbar.Content>
          <ToolbarItem placement="topBarLeading">
            <Button label={t(`Edit`)} onPress={noop} />
          </ToolbarItem>
          <ToolbarItem placement="primaryAction">
            <Menu label={t(`Options`)} systemImage="ellipsis">{null}</Menu>
          </ToolbarItem>
          <ToolbarItem placement="confirmationAction">
            <Button label={t(`Done`)} onPress={noop} />
          </ToolbarItem>
        </Toolbar.Content>
      </Toolbar>
    </NavigationStack>
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
  useEffect(() => loadArchiveUnlessPrepared(), []);
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
  const now = Date.now();
  const page = modifierList(navigationTitle(t(`Archive`)), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), searchable(searchText, { placement: "navigationBarDrawer", prompt: t(`Search Archive`), onChange: setQuery }));
  const content = !loaded ? (
    <List modifiers={page}>{null}</List>
  ) : !hasArchive ? (
    <ContentUnavailableView title={t(`No Archived Tabs`)} systemImage="archivebox.fill" description={t(`Closed and inactive tabs show up here.`)} modifiers={page} />
  ) : results && !results.length ? (
    <ContentUnavailableView title={`No Results for “${searched}”`} systemImage="magnifyingglass" description={t(`Check the spelling or try a new search.`)} modifiers={page} />
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
        <ConfirmationDialog title={t(`Delete All Archived Tabs?`)} isPresented={confirmingClear} onIsPresentedChange={setConfirmingClear} titleVisibility="visible">
          <ConfirmationDialog.Trigger>{content}</ConfirmationDialog.Trigger>
          <ConfirmationDialog.Actions>
            <Button
              role="destructive"
              label={t(`Delete All`)}
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
            <Button label={editing ? t(`Done`) : t(`Edit`)} onPress={() => setEditing((now) => !now)} modifiers={[disabled(!hasArchive && !editing)]} />
          </ToolbarItem>
          <ToolbarItem placement="primaryAction">
            <Menu label={t(`Options`)} systemImage="ellipsis">
              {shown ? (
                <>
                  <Picker label={t(`Archive Inactive Tabs`)} systemImage="archivebox" selection={interval} onSelectionChange={(next: AutoArchiveInterval) => setAutoArchiveInterval(next)} modifiers={[pickerStyle("menu")]}>
                    {INTERVALS.map((option) => (
                      <Text key={option} modifiers={[tag(option)]}>
                        {autoArchiveTitle(option)}
                      </Text>
                    ))}
                  </Picker>
                  <Divider />
                  <Button label={t(`Delete All…`)} systemImage="trash" role="destructive" onPress={() => setConfirmingClear(true)} modifiers={[disabled(!hasArchive)]} />
                </>
              ) : null}
            </Menu>
          </ToolbarItem>
          <ToolbarItem placement="confirmationAction">
            <Button label={t(`Done`)} onPress={closeArchive} />
          </ToolbarItem>
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
  const { fontScale } = useWindowDimensions();
  const iconSize = ROW_FAVICON * Math.min(fontScale, ROW_FAVICON_SCALE_CAP);
  const row = useCallback(({ item }: { item: BrowserTab }) => <ArchiveRow tab={item} iconSize={iconSize} />, [iconSize]);
  return (
    <List.ForEach data={tabs} keyExtractor={(tab) => tab.id} onDelete={(indices) => indices.forEach((index) => tabs[index] && deleteArchivedTab(tabs[index]))} estimatedItemSize={60} overscanCount={overscan}>
      {row}
    </List.ForEach>
  );
}

function ArchiveRow({ tab, iconSize }: { tab: BrowserTab; iconSize: number }) {
  const shown = display(tab.url);
  const restore = () => {
    haptics.selection();
    openArchivedTab(tab);
  };
  return (
    <ContextMenu modifiers={[listRowInsets(ROW_INSETS)]}>
      <ContextMenu.Trigger>
        <Button onPress={restore} modifiers={[buttonStyle("plain"), accessibilityHint(t(`Reopens the tab.`))]}>
          <HStack alignment="center" spacing={ROW_GAP} modifiers={[frame({ maxWidth: FILL, alignment: "leading" }), accessibilityElement("combine")]}>
            <RNHostView matchContents>
              <View style={{ width: iconSize, height: iconSize }}>
                <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url} size={iconSize} />
              </View>
            </RNHostView>
            <VStack alignment="leading" spacing={1}>
              <Text modifiers={[font({ textStyle: "body" }), lineLimit(1)]}>{tab.title || shown.host}</Text>
              <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(SECONDARY), lineLimit(1)]}>{shown.display || shown.host}</Text>
            </VStack>
            <Spacer />
          </HStack>
        </Button>
      </ContextMenu.Trigger>
      <ContextMenu.Items>
        <Button label={t(`Open`)} systemImage="arrow.up.forward.square" onPress={restore} />
        {canShareTab(tab) ? <Button label={t(`Copy Link`)} systemImage="link" onPress={() => copyTabLink(tab)} /> : null}
        {canShareTab(tab) ? <ShareLink item={tab.url}><Label title={t(`Share`)} systemImage="square.and.arrow.up" /></ShareLink> : null}
        <Divider />
        <Button label={t(`Delete`)} systemImage="trash" role="destructive" onPress={() => deleteArchivedTab(tab)} />
      </ContextMenu.Items>
    </ContextMenu>
  );
}

const noop = () => undefined;

const styles = StyleSheet.create({
  anchor: { position: "absolute", width: 0, height: 0 },
});
