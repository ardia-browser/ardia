import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewInstance } from "react-native";
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PinnedTile, SyncedProfile } from "../../state/sync/store";
import { SPACES_LARGE_TEXT, Switcher, Tiles, Unavailable } from "./SpacesParts";
import { CrossfadeText } from "../settings/SettingsKit";
import { haptics } from "../../state/app/haptics";
import { countUsage } from "../../state/telemetry/telemetry";
import { closeArchive, openArchive } from "../../state/browse/store";
import { copyLink, menuOpenedHaptic, shareUrl } from "../../state/browse/tabMenus";
import { openSettings } from "../../state/settings/nav";
import { openRemote, selectProfile, syncNow } from "../../state/sync/actions";
import { useSelectedProfile, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { remoteTitle, spaceGroupColor, spaceRows, type SpaceRow } from "../../state/sync/spaces";
import { showAllDeviceTabs, toggleSpaceRow, useSpaceOpenFor } from "../../state/sync/spaceOpen";
import { spaceTone } from "../../lib/profileLook";
import { sfSymbol } from "../../lib/sfSymbols";
import { syncBanner, type BannerIcon } from "../../state/sync/syncRules";
import {
  capsule,
  FadingBackdrop,
  DEFAULT_PROFILE_COLOR,
  Favicon,
  FloatingMenu,
  font,
  screenReaderActions,
  toastMotion,
  useIncreasedContrast,
  useSheetFrame,
  isSymbolName,
  PROFILE_PRESETS,
  space,
  Symbol,
  spacesLayout,
  syncInk,
  tabsLayout,
  tabsMotion,
  useTheme,
  type MenuItem,
  type SymbolName,
  useReduceMotion,
} from "../ui";
import type { Point } from "../../lib/menuPlace";

const BANNER_ICONS: Record<BannerIcon, SymbolName> = { folder: "folderFill", lock: "lockFill", reset: "arrowClockwise", warning: "exclamationmarkTriangle", offline: "wifiSlash" };
const IPHONE_BANNER_ICONS: Record<BannerIcon, SymbolName> = { folder: "folderBadgeQuestionmark", lock: "lockFill", reset: "exclamationmarkArrowTriangle2Circlepath", warning: "exclamationmarkIcloud", offline: "wifiSlash" };
const bannerIcon = (icon: BannerIcon) => (Platform.OS === "ios" ? IPHONE_BANNER_ICONS : BANNER_ICONS)[icon];
const HEADER_ICONS: Record<"star" | "laptop" | "desktop" | "phone", SymbolName> = { star: "star", laptop: "laptop", desktop: "macDesktop", phone: "iphone" };
const INDENT = 20;

const SPACE_ROWS_FIRST = 16;
const SPACE_ROWS_WINDOW = 5;

type RowMenu = { items: MenuItem[]; at: Point | null; anchor?: RefObject<ViewInstance | null> };

export function SpacesView() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const frame = useSheetFrame();
  const status = useSyncStatus();
  const view = useSyncView();
  const shown = useSelectedProfile();
  const [chosen, setChosen] = useState<string | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const profile = (chosen ? view.profiles.find((p) => p.syncId === chosen) : undefined) ?? shown ?? view.profiles[0] ?? null;
  useEffect(() => {
    if (chosen && shown?.syncId === chosen) setChosen(null);
  }, [chosen, shown?.syncId]);
  const contrast = useIncreasedContrast();
  const tone = useMemo(() => spaceTone(profile, theme.dark, contrast, PROFILE_PRESETS, DEFAULT_PROFILE_COLOR), [profile, theme.dark, contrast]);
  const banner = syncBanner(status);
  const reduceMotion = useReduceMotion();
  const window = useWindowDimensions();
  const [width, setWidth] = useState(window.width);
  const pager = useRef<FlatList<SyncedProfile>>(null);
  const index = Math.max(
    0,
    view.profiles.findIndex((p) => p.syncId === profile?.syncId),
  );
  const pagerIndex = useRef(index);
  useEffect(() => {
    if (pagerIndex.current === index) return;
    pagerIndex.current = index;
    pager.current?.scrollToOffset({ offset: index * width, animated: false });
  }, [index, width]);
  const select = (id: string) => {
    pagerIndex.current = view.profiles.findIndex((p) => p.syncId === id);
    haptics.selection();
    setChosen(id);
    selectProfile(id);
  };
  const choose = (id: string) => {
    if (id === profile?.syncId) return;
    const to = view.profiles.findIndex((p) => p.syncId === id);
    if (to < 0) return;
    pager.current?.scrollToIndex({ index: to, animated: !reduceMotion });
    select(id);
  };
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) return;
    const page = view.profiles[Math.round(event.nativeEvent.contentOffset.x / width)];
    if (!page || page.syncId === profile?.syncId) return;
    countUsage("spaces_swiped");
    select(page.syncId);
  };
  return (
    <View style={StyleSheet.absoluteFill}>
      <FadingBackdrop colors={tone} />
      <View style={[styles.column, { paddingTop: frame ? 0 : insets.top }]}>
        <View style={styles.header}>
          <View accessibilityRole="header" accessible accessibilityLabel={profile?.name ?? "Spaces"} style={styles.fill}>
            <CrossfadeText testID="spacesTitle" text={profile?.name ?? "Spaces"} style={[font.title2, styles.bold, { color: theme.label }]} />
          </View>
          <HeaderButton icon="archivebox" label="Archive" onPress={openArchive} />
          <HeaderButton icon="xmark" label="Close" onPress={closeArchive} />
        </View>
        {banner ? (
          <View style={[styles.banner, { backgroundColor: theme.tertiaryFill }]}>
            <Symbol name={bannerIcon(banner.icon)} size={18} color={syncInk.banner} />
            <Text style={[font.subheadline, styles.fill, { color: theme.label }]}>{banner.text}</Text>
            {banner.needsAction ? (
              <Pressable accessibilityRole="button" onPress={() => openSettings({ page: "sync" })} style={[styles.fix, { borderColor: theme.separator }]}>
                <Text style={[font.subheadline, styles.bold, { color: theme.formAccent }]}>Fix</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {profile ? (
          <FlatList
            ref={pager}
            testID="spacesPager"
            style={styles.fill}
            data={view.profiles}
            keyExtractor={(page) => page.syncId}
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={index}
            extraData={`${width}:${profile.syncId}`}
            getItemLayout={(_data, at) => ({ length: width, offset: width * at, index: at })}
            onLayout={(event) => {
              const next = event.nativeEvent.layout.width;
              if (next <= 0 || next === width) return;
              setWidth(next);
              pager.current?.scrollToOffset({ offset: index * next, animated: false });
            }}
            onMomentumScrollEnd={settle}
            renderItem={({ item }) => {
              const isShown = item.syncId === profile.syncId;
              return (
                <View style={{ width }} accessibilityElementsHidden={!isShown} importantForAccessibility={isShown ? "auto" : "no-hide-descendants"}>
                  <SpacePage profile={item} isShown={isShown} onMenu={setMenu} bottom={view.profiles.length > 1 ? 0 : insets.bottom} />
                </View>
              );
            }}
          />
        ) : (
          <Unavailable isOff={status.phase === "off"} />
        )}
        {view.profiles.length > 1 && profile ? <Switcher profiles={view.profiles} selected={profile.syncId} onChoose={choose} bottom={insets.bottom} /> : null}
      </View>
      {menu ? <FloatingMenu items={menu.items} anchor={menu.anchor} at={menu.at} dimmed={menu.at !== null} place={{ top: 0, left: space.xl, width: tabsLayout.menuWidth }} onDismiss={() => setMenu(null)} /> : null}
    </View>
  );
}

function HeaderButton({ icon, label, onPress }: { icon: SymbolName; label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.headerButton}>
      <View style={[styles.headerCircle, { backgroundColor: theme.tertiaryFill }]}>
        <Symbol name={icon} size={15} color={theme.secondaryLabel} />
      </View>
    </Pressable>
  );
}

function SpacePage({ profile, isShown, onMenu, bottom }: { profile: SyncedProfile; isShown: boolean; onMenu: (menu: RowMenu) => void; bottom: number }) {
  const theme = useTheme();
  const remembered = useSpaceOpenFor(profile.syncId);
  const open = useMemo(() => new Set(remembered.open), [remembered.open]);
  const expanded = useMemo(() => new Set(remembered.expanded), [remembered.expanded]);
  const [refreshing, setRefreshing] = useState(false);
  const frame = useSheetFrame();
  const rows = useMemo(() => spaceRows(profile, open, expanded), [profile, open, expanded]);
  const reduceMotion = useReduceMotion();
  const known = useRef<ReadonlySet<string> | null>(null);
  const fresh = useMemo(() => {
    const before = known.current;
    const now = new Set(rows.map((row) => row.key));
    known.current = now;
    return before ? new Set([...now].filter((key) => !before.has(key))) : new Set<string>();
  }, [rows]);
  const toggle = (key: string) => toggleSpaceRow(profile.syncId, key);
  const linkMenu = (url: string, title: string, at: Point | null) => {
    menuOpenedHaptic();
    const sharing: MenuItem[] = /^https?:\/\//i.test(url)
      ? [
          { label: "Copy Link", icon: "link", onPress: () => copyLink(url) },
          { label: "Share", icon: "squareAndArrowUp", onPress: () => shareUrl(url, title) },
        ]
      : [];
    onMenu({ items: [{ label: "Open", icon: "arrowUpForward", onPress: () => openRemote(url, title, profile.syncId) }, ...sharing], at });
  };
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.key}
      initialNumToRender={SPACE_ROWS_FIRST}
      windowSize={SPACE_ROWS_WINDOW}
      removeClippedSubviews
      {...(isShown ? frame?.list(true) : undefined)}
      contentContainerStyle={{ paddingBottom: bottom + space.l }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void syncNow().then(() => setRefreshing(false));
          }}
        />
      }
      extraData={fresh}
      renderItem={({ item }) => (
        <Appearing fresh={fresh.has(item.key) && !reduceMotion}>
          <Row
            row={item}
            profileId={profile.syncId}
            onToggle={toggle}
            onShowAll={(id) => showAllDeviceTabs(profile.syncId, id)}
            onLongPress={linkMenu}
            onFolder={(tile, anchor) => onMenu({ items: (tile.folder ?? []).map((tab) => ({ label: remoteTitle(tab.title, tab.url), onPress: () => openRemote(tab.url, tab.title, profile.syncId, tab.key) })), at: null, anchor })}
            tint={theme.secondaryLabel}
          />
        </Appearing>
      )}
    />
  );
}

type RowProps = {
  row: SpaceRow;
  profileId: string;
  tint: string;
  onToggle: (key: string) => void;
  onShowAll: (deviceId: string) => void;
  onLongPress: (url: string, title: string, at: Point | null) => void;
  onFolder: (tile: PinnedTile, anchor: RefObject<ViewInstance | null>) => void;
};

function Appearing({ fresh, children }: { fresh: boolean; children: ReactNode }) {
  if (!fresh) return <>{children}</>;
  return (
    <Animated.View testID="spaceRowAppearing" entering={FadeIn.duration(tabsMotion.fade)}>
      {children}
    </Animated.View>
  );
}

function Disclosure({ open, tint }: { open: boolean; tint: string }) {
  const reduceMotion = useReduceMotion();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = reduceMotion ? (open ? 1 : 0) : withSpring(open ? 1 : 0, toastMotion.snappy);
  }, [open, reduceMotion, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 90}deg` }] }));
  return (
    <Animated.View testID="spaceDisclosure" style={style}>
      <Symbol name="chevronRight" size={14} color={tint} />
    </Animated.View>
  );
}

function Row({ row, profileId, tint, onToggle, onShowAll, onLongPress, onFolder }: RowProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const iconSide = TAB_ICON_BASE * Math.min(fontScale, TAB_ICON_MAX / TAB_ICON_BASE);
  switch (row.kind) {
    case "tiles":
      return <Tiles tiles={row.tiles} profileId={profileId} onFolder={onFolder} onLink={onLongPress} />;
    case "tab":
      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => openRemote(row.url, row.title, profileId, row.pinnedKey)}
          onLongPress={(event) => onLongPress(row.url, row.title, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
          {...screenReaderActions([{ name: "longpress", run: () => onLongPress(row.url, row.title, null) }])}
          style={({ pressed }) => [styles.row, { paddingLeft: space.l + INDENT * row.depth }, pressed ? { backgroundColor: theme.rowHighlight } : null]}
        >
          <View testID="spaceTabIcon" style={[styles.tabSymbol, { width: iconSide, height: iconSide }]}>
            {tabSymbol(row.icon) ? <Symbol name={tabSymbol(row.icon)!} size={iconSide * 0.8} color={tint} /> : <Favicon iconUrl={null} pageUrl={row.url} size={iconSide - 2} />}
          </View>
          <Text style={[font.body, styles.medium, styles.fill, { color: theme.label }]} numberOfLines={fontScale >= SPACES_LARGE_TEXT ? 3 : 1}>
            {row.title}
          </Text>
        </Pressable>
      );
    case "group":
    case "folder":
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: row.isOpen }}
          {...screenReaderActions([{ name: "activate", label: row.isOpen ? "Collapse" : "Expand", run: () => onToggle(row.key) }])}
          onPress={() => onToggle(row.key)}
          style={({ pressed }) => [styles.row, { paddingLeft: space.l + INDENT * row.depth }, pressed ? { backgroundColor: theme.rowHighlight } : null]}
        >
          <Symbol name={groupSymbol(row.kind === "group" ? row.icon : null)} size={20} color={(row.kind === "group" ? spaceGroupColor(row.color) : null) ?? tint} />
          <Text style={[font.body, styles.medium, styles.fill, { color: theme.label }]} numberOfLines={2}>
            {row.title}
          </Text>
          <Disclosure open={row.isOpen} tint={tint} />
        </Pressable>
      );
    case "header":
      return (
        <View accessibilityRole="header" accessible style={styles.sectionHeader}>
          <Symbol name={HEADER_ICONS[row.icon]} size={15} color={tint} />
          <Text style={[font.footnote, styles.bold, { color: tint }]}>{row.title}</Text>
        </View>
      );
    case "showAll":
      return (
        <Pressable accessibilityRole="button" onPress={() => onShowAll(row.deviceId)} style={styles.showAll}>
          <Text style={[font.subheadline, styles.bold, { color: tint }]}>Show All</Text>
        </Pressable>
      );
    case "empty":
      return (
        <View style={styles.empty}>
          <Symbol name="squareStack" size={40} color={tint} />
          <Text style={[font.title3, styles.bold, styles.centered, { color: theme.label }]}>Nothing Here Yet</Text>
          <Text style={[font.subheadline, styles.centered, { color: tint }]}>{`Pinned and open tabs from ${row.name} show up here.`}</Text>
        </View>
      );
  }
}

const TAB_ICON_BASE = 24;
const TAB_ICON_MAX = 40;

function tabSymbol(icon: string | null): SymbolName | null {
  const symbol = sfSymbol(icon, isSymbolName);
  return symbol && isSymbolName(symbol) ? symbol : null;
}

function groupSymbol(icon: string | null): SymbolName {
  const symbol = sfSymbol(icon, isSymbolName);
  return symbol && isSymbolName(symbol) ? symbol : "folderFill";
}

const styles = StyleSheet.create({
  column: { flex: 1 },
  tabSymbol: { alignItems: "center", justifyContent: "center" },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  centered: { textAlign: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: space.s, paddingLeft: space.l + 4, paddingRight: space.s, paddingTop: space.m, paddingBottom: space.xs },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerCircle: { width: spacesLayout.headerCircle, height: spacesLayout.headerCircle, borderRadius: capsule(spacesLayout.headerCircle), alignItems: "center", justifyContent: "center" },
  banner: { flexDirection: "row", alignItems: "center", gap: spacesLayout.bannerGap, marginHorizontal: space.l, marginBottom: space.xs, padding: spacesLayout.bannerPadding, borderRadius: spacesLayout.bannerRadius },
  fix: { borderWidth: StyleSheet.hairlineWidth, borderRadius: capsule(32), minHeight: 32, paddingHorizontal: space.m, justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: 48, paddingRight: space.l },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: spacesLayout.headerGap, paddingHorizontal: space.l, paddingTop: space.l, paddingBottom: spacesLayout.headerBottom },
  showAll: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.l },
  empty: { alignItems: "center", gap: spacesLayout.stackGap, paddingTop: space.huge * 2, paddingHorizontal: space.xxl },
});
