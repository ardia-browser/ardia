import { useEffect, useMemo, useState } from "react";
import { ARCHIVE_SEARCH_DELAY_MS, archiveDayTitle } from "../../lib/archiveDay";
import { parseColor } from "../../lib/color";
import { haptics } from "../../state/app/haptics";
import { ArchiveTile } from "./ArchiveTile";
import { BackHandler, Platform, Pressable, SectionList, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { closeArchive } from "../../state/browse/store";
import { canShareTab, copyTabLink, deleteArchivedTab, menuOpenedHaptic, openArchivedTab, shareTab } from "../../state/browse/tabMenus";
import { display } from "../../state/search/omnibox";
import { usePreferences } from "../../state/settings/hooks";
import { useArchiveDays, useArchiveLoaded } from "../../state/tabs/hooks";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval, type BrowserTab } from "../../state/tabs/tabModels";
import { clearArchivedTabs, loadArchive, searchArchive, setAutoArchiveInterval } from "../../state/tabs/store";
import { MenuTrigger, confirmInSheet } from "../ui/MenuTrigger";
import { MaterialEmptyIcon, MaterialIconAction, MaterialSearchField, MaterialTopBar } from "../ui/MaterialTopBar";
import { ConfirmSheet, Favicon, FloatingMenu, font, LookBackdrop, radius, space, SwipeToDelete, Symbol, tabsLayout, tabsMotion, useDesign, useSheetFrame, useTheme, type Confirmation, type MenuItem } from "../ui";
import type { Point } from "../../lib/menuPlace";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function ArchiveView() {
  const theme = useTheme();
  const material = useDesign() === "material";
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const frame = useSheetFrame();
  const days = useArchiveDays();
  const loaded = useArchiveLoaded();
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const [query, setQuery] = useState("");
  const [rowMenu, setRowMenu] = useState<{ tab: BrowserTab; at: Point } | null>(null);
  useEffect(() => loadArchive(), []);
  const [searched, setSearched] = useState("");
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearched("");
      return;
    }
    const wait = setTimeout(() => setSearched(trimmed), ARCHIVE_SEARCH_DELAY_MS);
    return () => clearTimeout(wait);
  }, [query]);
  useEffect(() => {
    if (!query) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      setQuery("");
      return true;
    });
    return () => back.remove();
  }, [Boolean(query)]);
  const results = useMemo(() => (searched ? searchArchive(searched) : null), [searched, days]);
  const now = Date.now();
  const sections = results
    ? [{ title: "", data: results }]
    : days.map((day) => ({ title: archiveDayTitle(day.tabs[0]!.archivedAt ?? day.tabs[0]!.lastActive, now), data: day.tabs }));
  const hasArchive = days.some((day) => day.tabs.length > 0);
  const headerFill = useMemo(() => {
    const [r, g, b] = parseColor(theme.surface);
    return `rgba(${r}, ${g}, ${b}, ${HEADER_ALPHA})`;
  }, [theme.surface]);

  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const ask = (asked: Confirmation) => confirmInSheet(asked, () => setConfirmation(asked));
  const confirmClear = () =>
    ask({
      title: "Delete All Archived Tabs?",
      message: "This can’t be undone.",
      action: "Delete All",
      run: () => {
        haptics.warning();
        clearArchivedTabs();
      },
    });
  const items: MenuItem[] = [
    {
      label: "Archive Inactive Tabs",
      icon: "archivebox",
      children: (Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[]).map((option) => ({
        label: autoArchiveTitle(option),
        checked: option === interval,
        onPress: () => setAutoArchiveInterval(option),
      })),
    },
    "divider",
    { label: "Delete All…", icon: "trash", destructive: true, disabled: !hasArchive, onPress: confirmClear },
  ];

  return (
    <View style={StyleSheet.absoluteFill}>
      <LookBackdrop />
      <View style={[styles.column, { paddingTop: frame ? 0 : insets.top }]}>
        {material ? (
          <>
            <MaterialTopBar
              title="Archive"
              nav="close"
              onNav={closeArchive}
              actions={
                <MenuTrigger items={items} trigger="tap" frost={null} place={{ right: space.s, width: Math.min(tabsLayout.menuWidth, width - space.l) }}>
                  {({ onPress }) => <MaterialIconAction icon="ellipsis" turned label="Options" onPress={onPress ?? (() => undefined)} />}
                </MenuTrigger>
              }
            />
            <View style={styles.materialSearch}>
              <MaterialSearchField value={query} onChangeText={setQuery} placeholder="Search Archive" />
            </View>
          </>
        ) : (
          <>
        <View style={styles.top}>
          <Pressable accessibilityRole="button" onPress={closeArchive} style={styles.topButton}>
            <Text style={[font.body, styles.bold, { color: theme.formAccent }]}>Done</Text>
          </Pressable>
          <Text accessibilityRole="header" style={[font.body, styles.bold, { color: theme.label }]}>
            Archive
          </Text>
          <MenuTrigger items={items} trigger="tap" place={{ right: space.s, width: Math.min(tabsLayout.menuWidth, width - space.l) }}>
            {({ onPress }) => (
              <Pressable accessibilityRole="button" accessibilityLabel="Options" onPress={onPress} style={[styles.topButton, styles.end]}>
                <Symbol name="ellipsis" size={22} color={theme.formAccent} />
              </Pressable>
            )}
          </MenuTrigger>
        </View>
        <View style={[styles.search, { backgroundColor: theme.fieldFill }]}>
          <Symbol name="magnifyingglass" size={17} color={theme.secondaryLabel} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search Archive"
            placeholderTextColor={theme.secondaryLabel}
            style={[font.body, styles.input, { color: theme.label }]}
            selectionColor={theme.formAccent}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear Search" onPress={() => setQuery("")}>
              <Symbol name="xmarkCircleFill" size={18} color={theme.secondaryLabel} />
            </Pressable>
          ) : null}
        </View>
          </>
        )}
        {loaded && !hasArchive ? (
          <View style={styles.empty} accessible accessibilityRole="header" accessibilityLabel="No Archived Tabs. Closed and inactive tabs show up here.">
            {material ? <MaterialEmptyIcon icon="archivebox" /> : <ArchiveTile side={EMPTY_TILE} />}
            <Text style={[font.title2, styles.bold, styles.centered, { color: theme.label }]}>No Archived Tabs</Text>
            <Text style={[font.subheadline, styles.centered, { color: theme.secondaryLabel }]}>Closed and inactive tabs show up here.</Text>
          </View>
        ) : results && !results.length ? (
          <View style={styles.empty} accessible accessibilityLabel={`No Results for “${searched}”. Check the spelling or try a new search.`}>
            <Symbol name="magnifyingglass" size={NO_RESULTS_ICON} color={theme.secondaryLabel} />
            <Text style={[font.title2, styles.bold, styles.centered, { color: theme.label }]}>{`No Results for “${searched}”`}</Text>
            <Text style={[font.subheadline, styles.centered, { color: theme.secondaryLabel }]}>Check the spelling or try a new search.</Text>
          </View>
        ) : (
          <SectionList
            sections={sections}
            keyExtractor={(tab) => tab.id}
            keyboardShouldPersistTaps="handled"
            stickySectionHeadersEnabled
            {...frame?.list(false)}
            contentContainerStyle={{ paddingBottom: insets.bottom + space.l }}
            renderSectionHeader={({ section }) =>
              section.title ? <Text style={[font.footnote, styles.section, { color: theme.secondaryLabel, backgroundColor: headerFill }]}>{section.title}</Text> : null
            }
            renderItem={({ item }) => (
              <ArchiveRow
                tab={item}
                faviconSize={ROW_FAVICON * Math.min(fontScale, ROW_FAVICON_SCALE_CAP)}
                onMenu={(at) => {
                  menuOpenedHaptic();
                  setRowMenu({ tab: item, at });
                }}
              />
            )}
          />
        )}
      </View>
      {rowMenu ? (
        <FloatingMenu
          items={rowMenuItems(rowMenu.tab)}
          at={rowMenu.at}
          dimmed
          place={{ width: Math.min(tabsLayout.menuWidth, width - space.xl * 2) }}
          onDismiss={() => setRowMenu(null)}
        />
      ) : null}
      {confirmation ? <ConfirmSheet confirmation={confirmation} onClose={() => setConfirmation(null)} /> : null}
    </View>
  );
}

function rowMenuItems(tab: BrowserTab): MenuItem[] {
  const sharing: MenuItem[] = canShareTab(tab)
    ? [
        { label: "Copy Link", icon: "link", onPress: () => copyTabLink(tab) },
        { label: "Share", icon: "squareAndArrowUp", onPress: () => shareTab(tab) },
      ]
    : [];
  return [
    { label: "Open", icon: "arrowUpForward", systemImage: "arrow.up.forward.square", onPress: () => restoreRow(tab) },
    ...sharing,
    "divider",
    { label: "Delete", icon: "trash", destructive: true, onPress: () => deleteArchivedTab(tab) },
  ];
}

function restoreRow(tab: BrowserTab) {
  haptics.selection();
  openArchivedTab(tab);
}

function ArchiveRow({ tab, faviconSize, onMenu }: { tab: BrowserTab; faviconSize: number; onMenu: (at: Point) => void }) {
  const theme = useTheme();
  const shown = display(tab.url);
  return (
    <SwipeToDelete onDelete={() => deleteArchivedTab(tab)} revealsOnly={Platform.OS === "ios"}>
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Reopens the tab."
        onPress={() => restoreRow(tab)}
        onLongPress={(event) => onMenu({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
        delayLongPress={tabsMotion.longPress}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <View style={styles.icon}>
          <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url} size={faviconSize} />
        </View>
        <View style={styles.label}>
          <Text style={[font.body, { color: theme.label }]} numberOfLines={2}>
            {tab.title || shown.host}
          </Text>
          <Text style={[font.footnote, { color: theme.secondaryLabel }]} numberOfLines={1}>
            {`${shown.host} · ${time(tab.archivedAt ?? tab.lastActive)}`}
          </Text>
        </View>
      </Pressable>
    </SwipeToDelete>
  );
}

const HEADER_ALPHA = 0.92;
const EMPTY_TILE = 64;
const NO_RESULTS_ICON = 44;
const EMPTY_WIDTH = 320;
const ROW_FAVICON = 20;
const ROW_FAVICON_SCALE_CAP = 2;

const styles = StyleSheet.create({
  materialSearch: { paddingHorizontal: 16, paddingBottom: 8 },
  column: { flex: 1 },
  top: { minHeight: tabsLayout.archiveTop, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.s },
  topButton: { minWidth: tabsLayout.archiveButton, minHeight: tabsLayout.archiveButton, justifyContent: "center", paddingHorizontal: space.s },
  end: { alignItems: "flex-end" },
  bold: { fontWeight: "600" },
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
  centered: { textAlign: "center" },
  label: { flex: 1, gap: space.hair },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.xs + 2, paddingHorizontal: space.xxl, maxWidth: EMPTY_WIDTH, alignSelf: "center" },
});
