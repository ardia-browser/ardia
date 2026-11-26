import { useEffect, useMemo, useState } from "react";
import { ARCHIVE_SEARCH_DELAY_MS, archiveDayTitle } from "../../lib/archiveDay";
import { haptics } from "../../state/app/haptics";
import { ArchiveTile } from "./ArchiveTile";
import { BackHandler, Platform, Pressable, SectionList, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { closeArchive } from "../../state/browse/store";
import { canShareTab, copyTabLink, deleteArchivedTab, menuOpenedHaptic, openArchivedTab, shareTab } from "../../state/browse/tabMenus";
import { display } from "../../state/search/omnibox";
import { usePreferences } from "../../state/settings/hooks";
import { useArchiveDays, useArchiveLoaded } from "../../state/tabs/hooks";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveSymbol, autoArchiveTitle, type AutoArchiveInterval, type BrowserTab } from "../../state/tabs/tabModels";
import { clearArchivedTabs, loadArchive, searchArchive, setAutoArchiveInterval } from "../../state/tabs/store";
import { MenuTrigger, confirmInSheet } from "../ui/MenuTrigger";
import { MaterialEmptyIcon, MaterialIconAction, MaterialSearchField, MaterialTopBar } from "../ui/MaterialTopBar";
import { actionWords, destinationWords, dismissWords } from "../../lib/sharedWords";
import { ConfirmSheet, Favicon, FieldAccessory, FloatingMenu, iconRoles, font, NoResultsState, Tappable, ink, LookBackdrop, radius, smoothCorners, space, SwipeToDelete, Symbol, tabsLayout, tabsMotion, useDesign, useSheetFrame, useTheme, type Confirmation, type MenuItem, slopToReach, capsule } from "../ui";
import type { Point } from "../../lib/menuPlace";

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
  const [editing, setEditing] = useState(false);
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
        systemImage: autoArchiveSymbol(option),
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
              title={destinationWords.archive}
              nav="close"
              onNav={closeArchive}
              actions={
                <MenuTrigger items={items} trigger="tap" frost={null} place={{ right: space.s, width: Math.min(tabsLayout.menuWidth, width - space.l) }}>
                  {({ onPress }) => <MaterialIconAction icon="ellipsis" turned label={actionWords.more} onPress={onPress ?? (() => undefined)} />}
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
          <View style={styles.side}>
            <Tappable kind="text" label={editing ? dismissWords.done : EDIT} disabled={!hasArchive && !editing} onPress={() => setEditing((now) => !now)} style={styles.topButton}>
              <Text style={[font.body, editing ? styles.bold : null, { color: hasArchive || editing ? theme.spaceAccentInk : theme.tertiaryLabel }]}>{editing ? dismissWords.done : EDIT}</Text>
            </Tappable>
          </View>
          <Text accessibilityRole="header" style={[font.body, styles.bold, { color: theme.label }]}>
            Archive
          </Text>
          <View style={[styles.side, styles.end]}>
            <MenuTrigger items={items} trigger="tap" place={{ right: space.s, width: Math.min(tabsLayout.menuWidth, width - space.l) }}>
              {({ onPress }) => (
                <Tappable kind="icon" label={actionWords.more} onPress={onPress ?? (() => undefined)} style={[styles.topButton, styles.iconButton]}>
                  <Symbol name={iconRoles.more} size={tabsLayout.archiveMoreGlyph} color={theme.spaceAccentInk} />
                </Tappable>
              )}
            </MenuTrigger>
            <Tappable kind="text" label={dismissWords.done} onPress={closeArchive} style={[styles.topButton, styles.endButton]}>
              <Text style={[font.body, styles.bold, { color: theme.spaceAccentInk }]}>{dismissWords.done}</Text>
            </Tappable>
          </View>
        </View>
        <View style={[styles.search, { backgroundColor: theme.fieldFill }]}>
          <Symbol name="magnifyingglass" size={17} color={theme.secondaryLabel} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search Archive"
            placeholderTextColor={theme.secondaryLabel}
            style={[font.body, styles.input, { color: theme.label }]}
            selectionColor={theme.spaceAccentInk}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query ? (
            <FieldAccessory icon={iconRoles.clearText} label={actionWords.clearText} color={theme.secondaryLabel} layout="slop" onPress={() => setQuery("")} />
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
          <View style={styles.noResults}>
            <NoResultsState testID="archiveNoResults" query={searched} />
          </View>
        ) : (
          <SectionList bounces={false} overScrollMode="never"
            sections={sections}
            keyExtractor={(tab) => tab.id}
            keyboardShouldPersistTaps="handled"
            stickySectionHeadersEnabled={false}
            {...frame?.list(false)}
            contentContainerStyle={{ paddingBottom: insets.bottom + space.l }}
            renderSectionHeader={({ section }) =>
              section.title ? <Text style={[font.footnote, styles.section, { color: theme.secondaryLabel }]}>{section.title.toLocaleUpperCase()}</Text> : <View style={styles.sectionGap} />
            }
            renderItem={({ item, index, section }) => (
              <ArchiveRow
                tab={item}
                first={index === 0}
                last={index === section.data.length - 1}
                editing={editing}
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
        { label: actionWords.copyLink, icon: iconRoles.copyLink, onPress: () => copyTabLink(tab) },
        { label: actionWords.share, icon: iconRoles.share, onPress: () => shareTab(tab) },
      ]
    : [];
  return [
    { label: actionWords.open, icon: "arrowUpForward", systemImage: "arrow.up.forward.square", onPress: () => restoreRow(tab) },
    ...sharing,
    "divider",
    { label: "Delete", icon: "trash", destructive: true, onPress: () => deleteArchivedTab(tab) },
  ];
}

function restoreRow(tab: BrowserTab) {
  haptics.selection();
  openArchivedTab(tab);
}

function ArchiveRow({ tab, first, last, editing, faviconSize, onMenu }: { tab: BrowserTab; first: boolean; last: boolean; editing: boolean; faviconSize: number; onMenu: (at: Point) => void }) {
  const theme = useTheme();
  const shown = display(tab.url);
  const corners = { borderTopLeftRadius: first ? archiveGroup.radius : 0, borderTopRightRadius: first ? archiveGroup.radius : 0, borderBottomLeftRadius: last ? archiveGroup.radius : 0, borderBottomRightRadius: last ? archiveGroup.radius : 0 };
  return (
    <View testID="archiveGroupRow" style={[styles.group, corners, { backgroundColor: theme.groupFill }]}>
      <SwipeToDelete onDelete={() => deleteArchivedTab(tab)} revealsOnly={Platform.OS === "ios"}>
        <View style={[styles.rowLine, { backgroundColor: theme.groupFill }]}>
          {editing ? (
            <Tappable kind="icon" label={`Delete ${tab.title || shown.host}`} onPress={() => deleteArchivedTab(tab)} hitSlop={slopToReach(archiveGroup.rowPadding + archiveGroup.deleteGlyph, archiveGroup.deleteGlyph)} style={styles.deleteHit}>
              <View style={[styles.deleteDot, { backgroundColor: theme.destructive }]}>
                <Symbol name="minus" size={archiveGroup.deleteGlyph * 0.6} color={ink.white} />
              </View>
            </Tappable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Reopens the tab."
            disabled={editing}
            onPress={() => restoreRow(tab)}
            onLongPress={(event) => onMenu({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
            delayLongPress={tabsMotion.longPress}
            style={({ pressed }) => [styles.row, corners, pressed ? { backgroundColor: theme.rowHighlight } : null]}
          >
            <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url} size={faviconSize} />
            <View style={[styles.label, last ? null : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.separator }]}>
              <Text style={[font.body, { color: theme.label }]} numberOfLines={1}>
                {tab.title || shown.host}
              </Text>
              <Text style={[font.footnote, { color: theme.secondaryLabel }]} numberOfLines={1}>
                {shown.display || shown.host}
              </Text>
            </View>
          </Pressable>
        </View>
      </SwipeToDelete>
    </View>
  );
}

const archiveGroup = { inset: 16, radius: 12, rowGap: 14, rowPadding: 14, rowVertical: 5, deleteGlyph: 22 } as const;
const EMPTY_TILE = 64;
const EDIT = "Edit";
const EMPTY_WIDTH = 320;
const ROW_FAVICON = 20;
const ROW_FAVICON_SCALE_CAP = 2;

const styles = StyleSheet.create({
  materialSearch: { paddingHorizontal: 16, paddingBottom: 8 },
  column: { flex: 1 },
  top: { minHeight: tabsLayout.archiveTop, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.s },
  side: { flex: 1, flexDirection: "row", alignItems: "center" },
  topButton: { minWidth: tabsLayout.archiveButton, minHeight: tabsLayout.archiveButton, justifyContent: "center", paddingHorizontal: space.s },
  iconButton: { alignItems: "center" },
  endButton: { alignItems: "flex-end" },
  end: { justifyContent: "flex-end" },
  bold: { fontWeight: "600" },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 2,
    marginHorizontal: archiveGroup.inset,
    marginVertical: space.s,
    paddingHorizontal: space.s + 2,
    minHeight: tabsLayout.archiveField,
    borderRadius: radius.field - space.xs,
    ...smoothCorners,
  },
  input: { flex: 1, paddingVertical: space.s },
  section: { paddingHorizontal: archiveGroup.inset * 2, paddingTop: space.xl, paddingBottom: space.s - 2 },
  sectionGap: { height: space.s },
  group: { marginHorizontal: archiveGroup.inset, overflow: "hidden", ...smoothCorners },
  rowLine: { flexDirection: "row", alignItems: "center" },
  deleteHit: { paddingLeft: archiveGroup.rowPadding },
  deleteDot: { width: archiveGroup.deleteGlyph, height: archiveGroup.deleteGlyph, borderRadius: capsule(archiveGroup.deleteGlyph), alignItems: "center", justifyContent: "center" },
  row: { flex: 1, flexDirection: "row", alignItems: "center", gap: archiveGroup.rowGap, paddingLeft: archiveGroup.rowPadding },
  centered: { textAlign: "center" },
  label: { flex: 1, gap: 1, paddingVertical: archiveGroup.rowVertical + space.xs, paddingRight: archiveGroup.rowPadding },
  noResults: { flex: 1, justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.xs + 2, paddingHorizontal: space.xxl, maxWidth: EMPTY_WIDTH, alignSelf: "center" },
});
