import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { haptics } from "../../state/app/haptics";
import { hideArchiveCard } from "../../state/browse/archiveCard";
import { closeAllFromDeck, closeTabFromDeck, newIncognitoTab, newTab, openArchive, openSpaces, openTab, reopenLastClosed } from "../../state/browse/store";
import { menuOpenedHaptic, tabTitle } from "../../state/browse/tabMenus";
import { editPageQuery } from "../../state/page/actions";
import { openSettings } from "../../state/settings/hooks";
import { openRemote, selectProfile } from "../../state/sync/actions";
import { useSelectedProfile, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { remoteTitle } from "../../state/sync/spaces";
import type { PinnedTile, SyncedProfile } from "../../state/sync/store";
import { useCanReopen, useDeckOrder, useIncognito, usePrivateCount, useSelectedTab } from "../../state/tabs/hooks";
import { tabsInSpace } from "../../state/tabs/spaces";
import { useTabs } from "../../state/tabs/store";
import { recencyOrder, type BrowserTab } from "../../state/tabs/tabModels";
import { countUsage } from "../../state/telemetry/telemetry";
import { capsule, controlRadius, ChromeSurface, ConfirmSheet, Favicon, font, IncognitoSpecs, rolesFor, startInk, startLayout, Symbol, tabsInk, tabsLayout, useTheme, type Confirmation, type MenuItem } from "../ui";
import { confirmInSheet, MenuTrigger, spaceSystemImage } from "../ui/MenuTrigger";
import { barAddress, spokenAddress } from "../browsing/FloatingBar";
import { spaceMenuSymbol, SpaceTitle } from "../search/StartSpaces";
import { DUO } from "./duoLayout";
import { HostLabel, SidebarGlyph } from "./DuoToolbar";
import { duoInk } from "./tokens";
import { t } from "../../lib/uiLanguage";


export type DuoSidebarVariant = "overlay" | "panel";

type Props = { variant: DuoSidebarVariant; onClose: () => void };

export function DuoSidebar({ variant, onClose }: Props) {
  const theme = useTheme();
  const incognito = useIncognito();
  const dark = theme.dark || incognito;
  const status = useSyncStatus();
  const view = useSyncView();
  const shown = useSelectedProfile();
  const spaces = status.isEnabled ? view.profiles : [];
  const current = shown ?? spaces[0] ?? null;
  const order = useDeckOrder();
  const privateCount = usePrivateCount();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmCloseAll = () => {
    const count = order.length;
    const ask: Confirmation = {
      title: count === 1 ? t(`Close 1 Tab?`) : `Close ${count} Tabs?`,
      message: privateCount ? t(`Incognito tabs aren’t saved. Other tabs stay in your Archive.`) : t(`They’ll stay in your Archive.`),
      action: count === 1 ? t(`Close Tab`) : t(`Close All Tabs`),
      run: () => {
        hideArchiveCard();
        haptics.press();
        closeAllFromDeck();
      },
    };
    confirmInSheet(ask, () => setConfirmation(ask));
  };
  const choose = (id: string) => {
    if (id === current?.syncId) return;
    haptics.selection();
    if (!incognito) countUsage("spaces_picked");
    selectProfile(id);
  };
  return (
    <View testID={variant === "overlay" ? "duoSidebar" : "duoPanel"} accessibilityLabel={variant === "overlay" ? t(`Sidebar`) : t(`Tabs`)} style={styles.fill}>
      {variant === "overlay" ? <View testID="duoSidebarFill" pointerEvents="none" style={[StyleSheet.absoluteFill, styles.overlayFill, { backgroundColor: incognito ? tabsInk.incognitoSheet : theme.surface }]} /> : null}
      <View testID="duoSidebarHeader" style={[styles.header, { marginTop: variant === "overlay" ? DUO.sidebarHeaderTop : DUO.panelTop }]}>
        <View style={styles.switcher}>
          {current && spaces.length > 1 ? (
            <MenuTrigger frost={null}
              items={spaces.map((space) => ({ label: space.name, icon: spaceMenuSymbol(space) ?? undefined, systemImage: spaceSystemImage(space.name, space.icon), checked: space.syncId === current.syncId, onPress: () => choose(space.syncId) }))}
              trigger="tap"
              fixedOrder
              haptic={menuOpenedHaptic}
              dark={dark}
              place={{ width: tabsLayout.menuWidth }}
            >
              {({ onPress }) => (
                <Pressable accessibilityRole="button" accessibilityLabel={`Space, ${current.name}`} accessibilityHint={t(`Shows your Mac’s spaces.`)} onPress={onPress}>
                  <SpaceTitle space={current} dark={dark} showsChevron />
                </Pressable>
              )}
            </MenuTrigger>
          ) : current ? (
            <View accessible accessibilityRole="header" accessibilityLabel={current.name}>
              <SpaceTitle space={current} dark={dark} showsChevron={false} />
            </View>
          ) : (
            <Text accessibilityRole="header" numberOfLines={1} style={[font.body, styles.semibold, { color: rolesFor(dark).headerText }]}>
              Tabs
            </Text>
          )}
        </View>
        <MoreMenu dark={dark} hasTabs={order.length > 0} syncEnabled={status.isEnabled} onCloseAll={confirmCloseAll} />
        {variant === "overlay" ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t(`Hide Sidebar`)} onPress={onClose} style={styles.headerButton}>
            <SidebarGlyph size={DUO.sidebarGlyph} color={rolesFor(dark).foregroundPrimary} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.fieldRow}>
        <AddressField dark={dark} onClose={onClose} />
      </View>
      <SpacePages spaces={spaces} current={current} showsTiles={variant === "overlay"} dark={dark} onChoose={choose} onClose={onClose} />
      {confirmation ? <ConfirmSheet confirmation={confirmation} onClose={() => setConfirmation(null)} /> : null}
    </View>
  );
}

function MoreMenu({ dark, hasTabs, syncEnabled, onCloseAll }: { dark: boolean; hasTabs: boolean; syncEnabled: boolean; onCloseAll: () => void }) {
  const canReopen = useCanReopen();
  const items: MenuItem[] = [
    { label: t(`Archive`), onPress: openArchive },
    ...(syncEnabled ? [{ label: t(`Spaces From Your Mac`), onPress: openSpaces }] : []),
    "divider",
    { label: t(`New Incognito Tab`), onPress: newIncognitoTab },
    ...(canReopen ? [{ label: t(`Reopen Closed Tab`), onPress: reopenLastClosed }] : []),
    ...(hasTabs ? [{ label: t(`Close All Tabs`), destructive: true, onPress: onCloseAll }] : []),
    "divider",
    { label: t(`Settings`), onPress: () => openSettings() },
  ];
  return (
    <MenuTrigger frost={null} items={items} trigger="tap" fixedOrder haptic={menuOpenedHaptic} dark={dark} place={{ width: tabsLayout.menuWidth }}>
      {({ onPress }) => (
        <Pressable testID="duoSidebarMore" accessibilityRole="button" accessibilityLabel={t(`More`)} onPress={onPress} style={styles.headerButton}>
          <Symbol name="ellipsis" size={DUO.sidebarMoreGlyph} color={rolesFor(dark).foregroundPrimary} />
        </Pressable>
      )}
    </MenuTrigger>
  );
}

function AddressField({ dark, onClose }: { dark: boolean; onClose: () => void }) {
  const tab = useSelectedTab();
  const address = tab ? barAddress(tab) : null;
  const edit = () => {
    onClose();
    if (tab) editPageQuery();
    else newTab();
  };
  return (
    <ChromeSurface testID="duoSidebarAddress" shape="rounded" cornerRadius={controlRadius(DUO.sidebarFieldHeight)} dark={dark} style={styles.field}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(`Address`)}
        accessibilityValue={{ text: spokenAddress(address) }}
        accessibilityHint={t(`Opens search with this page’s address.`)}
        onPress={edit}
        style={styles.fieldHit}
      >
        <HostLabel address={address} dark={dark} />
      </Pressable>
    </ChromeSurface>
  );
}

function SpacePages({ spaces, current, showsTiles, dark, onChoose, onClose }: { spaces: SyncedProfile[]; current: SyncedProfile | null; showsTiles: boolean; dark: boolean; onChoose: (id: string) => void; onClose: () => void }) {
  const [width, setWidth] = useState(0);
  const pager = useRef<FlatList<SyncedProfile>>(null);
  const index = Math.max(0, spaces.findIndex((space) => space.syncId === current?.syncId));
  const shownIndex = useRef(index);
  useEffect(() => {
    if (shownIndex.current === index || width <= 0) return;
    shownIndex.current = index;
    pager.current?.scrollToOffset({ offset: index * width, animated: false });
  }, [index, width]);
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) return;
    const at = Math.round(event.nativeEvent.contentOffset.x / width);
    const page = spaces[at];
    if (!page || page.syncId === current?.syncId) return;
    shownIndex.current = at;
    onChoose(page.syncId);
  };
  if (spaces.length <= 1) return <SpaceList space={spaces[0] ?? null} isCurrent showsTiles={showsTiles} dark={dark} onClose={onClose} />;
  return (
    <>
      <View style={styles.pages} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 ? (
          <FlatList
            ref={pager}
            testID="duoSidebarPager"
            data={spaces}
            keyExtractor={(space) => space.syncId}
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={index}
            extraData={`${width}:${current?.syncId}:${dark}`}
            getItemLayout={(_data, at) => ({ length: width, offset: width * at, index: at })}
            onMomentumScrollEnd={settle}
            renderItem={({ item }) => {
              const isCurrent = item.syncId === current?.syncId;
              return (
                <View style={{ width }} accessibilityElementsHidden={!isCurrent} importantForAccessibility={isCurrent ? "auto" : "no-hide-descendants"}>
                  <SpaceList space={item} isCurrent={isCurrent} showsTiles={showsTiles} dark={dark} onClose={onClose} />
                </View>
              );
            }}
          />
        ) : null}
      </View>
      <PageDots count={spaces.length} index={index} dark={dark} />
    </>
  );
}

function useSpaceTabs(space: SyncedProfile | null, isCurrent: boolean, deckOrder: BrowserTab[]): BrowserTab[] {
  const [open, spaces] = useTabs(useShallow((s) => [s.open, s.spaces] as const));
  return useMemo(() => {
    if (isCurrent || !space) return deckOrder;
    return recencyOrder([...tabsInSpace(open, { ...spaces, current: space.syncId })], null);
  }, [isCurrent, space, deckOrder, open, spaces]);
}

function SpaceList({ space, isCurrent, showsTiles, dark, onClose }: { space: SyncedProfile | null; isCurrent: boolean; showsTiles: boolean; dark: boolean; onClose: () => void }) {
  const roles = rolesFor(dark);
  const order = useDeckOrder();
  const tabs = useSpaceTabs(space, isCurrent, order);
  const selected = useSelectedTab();
  const tiles = showsTiles ? (space?.pinned.tiles ?? []) : [];
  return (
    <ScrollView testID="duoSidebarList" style={styles.pages} contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
      {tiles.length && space ? <SidebarTiles tiles={tiles} profileId={space.syncId} dark={dark} onClose={onClose} /> : null}
      <Text accessibilityRole="header" style={[font.subheadline, styles.heading, { color: roles.secondaryLabel }]}>
        Today
      </Text>
      {tabs.map((tab) => (
        <TabRow
          key={tab.id}
          tab={tab}
          dark={dark}
          selected={tab.id === selected?.id}
          onOpen={() => {
            onClose();
            openTab(tab.id);
          }}
          onCloseTab={() => closeTabFromDeck(tab.id)}
        />
      ))}
      <Pressable
        testID="duoSidebarNewTab"
        accessibilityRole="button"
        accessibilityLabel={t(`New Tab`)}
        onPress={() => {
          onClose();
          newTab();
        }}
        style={styles.newTab}
      >
        <View style={styles.rowIcon}>
          <Symbol name="plus" size={DUO.sidebarPlusGlyph} color={roles.secondaryLabel} />
        </View>
        <Text style={[font.body, { color: roles.secondaryLabel }]}>New Tab</Text>
      </Pressable>
    </ScrollView>
  );
}

function TabRow({ tab, dark, selected, onOpen, onCloseTab }: { tab: BrowserTab; dark: boolean; selected: boolean; onOpen: () => void; onCloseTab: () => void }) {
  const roles = rolesFor(dark);
  const title = tabTitle(tab);
  const host = barAddress(tab).host;
  return (
    <MenuTrigger frost={null} items={[{ label: t(`Close Tab`), destructive: true, onPress: onCloseTab }]} haptic={menuOpenedHaptic} dark={dark} place={{ width: tabsLayout.menuWidth }} style={styles.rowPitch}>
      {({ onLongPress }) => (
        <View testID={`duoSidebarRow:${tab.id}`} style={styles.row}>
          {selected ? <ChromeSurface testID="duoSidebarRowGlass" shape="rounded" cornerRadius={DUO.sidebarRowRadius} interactive={false} dark={dark} style={StyleSheet.absoluteFill} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityValue={{ text: tab.isPrivate ? `Incognito, ${host}` : host }}
            accessibilityState={{ selected }}
            onPress={onOpen}
            onLongPress={onLongPress}
            style={styles.rowHit}
          >
            <View style={styles.rowIcon}>{tab.isPrivate ? <IncognitoSpecs size={DUO.sidebarPrivateGlyph} color={roles.secondaryLabel} /> : <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url || null} size={DUO.sidebarRowIcon} />}</View>
            <Text numberOfLines={1} style={[font.body, styles.rowTitle, { color: roles.foregroundPrimary }]}>
              {title}
            </Text>
          </Pressable>
          {selected ? (
            <Pressable testID="duoSidebarRowClose" accessibilityRole="button" accessibilityLabel={t(`Close Tab`)} onPress={onCloseTab} style={styles.rowClose}>
              <Symbol name="xmark" size={DUO.sidebarCloseGlyph} color={roles.secondaryLabel} />
            </Pressable>
          ) : null}
        </View>
      )}
    </MenuTrigger>
  );
}

function SidebarTiles({ tiles, profileId, dark, onClose }: { tiles: PinnedTile[]; profileId: string; dark: boolean; onClose: () => void }) {
  const rows: PinnedTile[][] = [];
  for (let at = 0; at < tiles.length; at += DUO.sidebarTilesPerRow) rows.push(tiles.slice(at, at + DUO.sidebarTilesPerRow));
  const open = (tab: { url: string; title: string; key: string }) => {
    onClose();
    openRemote(tab.url, tab.title, profileId, tab.key);
  };
  return (
    <View testID="duoSidebarTiles" style={styles.tiles}>
      {rows.map((row, at) => (
        <View key={at} style={styles.tileRow}>
          {row.map((tile) => (
            <SidebarTile key={tile.key} tile={tile} dark={dark} onOpen={open} />
          ))}
          {row.length < DUO.sidebarTilesPerRow ? <View style={styles.tileSlot} /> : null}
        </View>
      ))}
    </View>
  );
}

function SidebarTile({ tile, dark, onOpen }: { tile: PinnedTile; dark: boolean; onOpen: (tab: { url: string; title: string; key: string }) => void }) {
  const folder = tile.folder?.length ? tile.folder : null;
  const label = remoteTitle(tile.title, tile.url);
  const face = (onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={folder ? t(`Shows the folder’s tabs.`) : undefined} onPress={onPress} style={styles.tileSlot}>
      <ChromeSurface testID="duoSidebarTile" shape="rounded" cornerRadius={startLayout.tileRadius} dark={dark} style={styles.tile}>
        <View pointerEvents="none" style={folder ? styles.folderInk : null}>
          {folder ? <Symbol name="folderFill" size={startLayout.tileIcon * startLayout.folderIconShare} color={rolesFor(dark).formAccent} /> : <Favicon iconUrl={null} pageUrl={tile.url} size={startLayout.tileIcon} />}
        </View>
      </ChromeSurface>
    </Pressable>
  );
  if (!folder) return face(() => onOpen(tile));
  return (
    <MenuTrigger frost={null} items={folder.map((tab) => ({ label: remoteTitle(tab.title, tab.url), onPress: () => onOpen(tab) }))} trigger="tap" haptic={menuOpenedHaptic} dark={dark} place={{ width: tabsLayout.menuWidth }} style={styles.tileSlot}>
      {({ onPress }) => face(onPress ?? (() => undefined))}
    </MenuTrigger>
  );
}

function PageDots({ count, index, dark }: { count: number; index: number; dark: boolean }) {
  const ink = dark ? startInk.dark : startInk.light;
  return (
    <View testID="duoSidebarDots" accessible accessibilityLabel={`Space ${index + 1} of ${count}`} style={styles.dots}>
      {Array.from({ length: count }, (_, dot) => (
        <View key={dot} style={[styles.dot, { backgroundColor: dot === index ? ink.badgeInk : ink.pageDot }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlayFill: { borderRadius: DUO.sidebarRadius, borderCurve: "continuous", boxShadow: duoInk.sidebarShadow },
  header: {
    height: DUO.sidebarHeaderHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: DUO.sidebarHeaderGap,
    paddingLeft: DUO.sidebarPadding + DUO.sidebarHeaderLead,
    paddingRight: DUO.sidebarPadding,
  },
  switcher: { flex: 1, minWidth: 0, flexDirection: "row" },
  semibold: { fontWeight: "600" },
  headerButton: { width: DUO.hitTarget, height: DUO.hitTarget, alignItems: "center", justifyContent: "center" },
  fieldRow: { paddingHorizontal: DUO.sidebarPadding },
  field: { height: DUO.sidebarFieldHeight },
  fieldHit: { flex: 1, paddingHorizontal: DUO.sidebarFieldPadding, justifyContent: "center", alignItems: "flex-start" },
  pages: { flex: 1 },
  list: { paddingHorizontal: DUO.sidebarPadding, paddingBottom: DUO.sidebarPadding },
  heading: { fontWeight: "500", paddingLeft: DUO.sidebarHeadingLead, paddingTop: DUO.sidebarHeadingTop, paddingBottom: DUO.sidebarHeadingBottom },
  rowPitch: { height: DUO.sidebarRowPitch, justifyContent: "center" },
  row: { height: DUO.sidebarRowHeight, flexDirection: "row", alignItems: "center", borderRadius: DUO.sidebarRowRadius },
  rowHit: { flex: 1, height: DUO.sidebarRowHeight, flexDirection: "row", alignItems: "center", gap: DUO.sidebarRowGap, paddingLeft: DUO.sidebarRowLead },
  rowIcon: { width: DUO.sidebarRowIcon, alignItems: "center", justifyContent: "center" },
  rowTitle: { flexShrink: 1 },
  rowClose: { width: DUO.sidebarRowClose, height: DUO.sidebarRowHeight, alignItems: "center", justifyContent: "center" },
  newTab: { height: DUO.sidebarRowPitch, flexDirection: "row", alignItems: "center", gap: DUO.sidebarRowGap, paddingLeft: DUO.sidebarRowLead },
  tiles: { paddingTop: DUO.sidebarPadding, gap: startLayout.tileGap },
  tileRow: { flexDirection: "row", gap: startLayout.tileGap },
  tileSlot: { flex: 1 },
  tile: { height: startLayout.tileHeight, alignItems: "center", justifyContent: "center" },
  folderInk: { opacity: startLayout.folderInkOpacity },
  dots: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: startLayout.pageDotSpacing, marginTop: DUO.sidebarDotsTop, marginBottom: DUO.sidebarDotsBottom, height: startLayout.pageDot },
  dot: { width: startLayout.pageDot, height: startLayout.pageDot, borderRadius: capsule(startLayout.pageDot) },
});
