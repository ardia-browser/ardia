import { useEffect, useRef, useState } from "react";
import { FlatList, Platform, PlatformColor, Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle } from "react-native";
import { Host, Image as SystemImage } from "@expo/ui/swift-ui";
import { font as systemFont } from "@expo/ui/swift-ui/modifiers";
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { redesignedBarCenterFromBottom } from "../../lib/deckGeometry";
import { sfSymbol } from "../../lib/sfSymbols";
import { haptics } from "../../state/app/haptics";
import { newTab } from "../../state/browse/store";
import { copyLink, menuOpenedHaptic, shareUrl } from "../../state/browse/tabMenus";
import { openSettings } from "../../state/settings/nav";
import { openRemote, selectProfile } from "../../state/sync/actions";
import { useSelectedProfile, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { remoteTitle } from "../../state/sync/spaces";
import type { PinnedTile, SyncedProfile } from "../../state/sync/store";
import { countUsage } from "../../state/telemetry/telemetry";
import {
  ArdiaLogo,
  browseLayout,
  capsule,
  ChromeSurface,
  Favicon,
  font,
  isSymbolName,
  rolesFor,
  settingsUIAvailable,
  spaceSymbol,
  startInk,
  startLayout,
  startMotion,
  Symbol,
  SystemGlyph,
  tabsCurve,
  tabsLayout,
  useReduceMotion,
  type MenuItem,
  type SymbolName,
} from "../ui";
import { MenuTrigger, type MenuHandlers } from "../ui/MenuTrigger";
import { syncOffered } from "../../state/sync/offer";

export type StartGeometry = { width: number; height: number; safeSide: number; barCenterY: number };

export const startBarCenterY = (height: number, safeBottom: number, os: string = Platform.OS) => height - redesignedBarCenterFromBottom(safeBottom, os);

export function StartSpaces({ geometry, dark, incognito }: { geometry: StartGeometry; dark: boolean; incognito: boolean }) {
  const status = useSyncStatus();
  const view = useSyncView();
  const shown = useSelectedProfile();
  const spaces = status.isEnabled ? view.profiles : [];
  const [chosen, setChosen] = useState<string | null>(null);
  const current = (chosen ? spaces.find((p) => p.syncId === chosen) : undefined) ?? shown ?? spaces[0] ?? null;
  useEffect(() => {
    if (chosen && shown?.syncId === chosen) setChosen(null);
  }, [chosen, shown?.syncId]);
  const reduceMotion = useReduceMotion();
  const pager = useRef<FlatList<SyncedProfile>>(null);
  const index = Math.max(
    0,
    spaces.findIndex((p) => p.syncId === current?.syncId),
  );
  const pagerIndex = useRef(index);
  const pagerWidth = useRef(geometry.width);
  useEffect(() => {
    const widthChanged = pagerWidth.current !== geometry.width;
    pagerWidth.current = geometry.width;
    if (pagerIndex.current === index && !widthChanged) return;
    pagerIndex.current = index;
    pager.current?.scrollToOffset({ offset: index * geometry.width, animated: false });
  }, [index, geometry.width]);
  const select = (id: string) => {
    pagerIndex.current = spaces.findIndex((p) => p.syncId === id);
    haptics.selection();
    setChosen(id);
    selectProfile(id);
  };
  const choose = (id: string) => {
    if (id === current?.syncId) return;
    const to = spaces.findIndex((p) => p.syncId === id);
    if (to < 0) return;
    pager.current?.scrollToOffset({ offset: to * geometry.width, animated: !reduceMotion });
    if (!incognito) countUsage("spaces_picked");
    select(id);
  };
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (geometry.width <= 0) return;
    const page = spaces[Math.round(event.nativeEvent.contentOffset.x / geometry.width)];
    if (!page || page.syncId === current?.syncId) return;
    if (!incognito) countUsage("spaces_swiped");
    select(page.syncId);
  };
  const page = (space: SyncedProfile) => <StartSpacePage geometry={geometry} space={space} dark={dark} incognito={incognito} />;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {spaces.length > 1 && current ? (
        <>
          <FlatList
            ref={pager}
            testID="startPager"
            style={StyleSheet.absoluteFill}
            data={spaces}
            keyExtractor={(space) => space.syncId}
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={index}
            extraData={`${geometry.width}:${current.syncId}:${dark}`}
            getItemLayout={(_data, at) => ({ length: geometry.width, offset: geometry.width * at, index: at })}
            onMomentumScrollEnd={settle}
            renderItem={({ item }) => {
              const isShown = item.syncId === current.syncId;
              return (
                <View style={{ width: geometry.width, height: geometry.height }} accessibilityElementsHidden={!isShown} importantForAccessibility={isShown ? "auto" : "no-hide-descendants"}>
                  {page(item)}
                </View>
              );
            }}
          />
          <SpacePageDots
            count={spaces.length}
            index={index}
            name={current.name}
            onStep={(by) => {
              const next = spaces[index + by];
              if (next) choose(next.syncId);
            }}
            dark={dark}
            y={geometry.barCenterY - startLayout.pageDotsAboveBar}
          />
        </>
      ) : spaces.length === 1 ? (
        page(spaces[0]!)
      ) : Platform.OS === "android" ? (
        <StartLogo y={geometry.height * startLayout.switcherRatio} incognito={incognito} />
      ) : status.phase === "off" ? (
        syncOffered() ? <SyncInvitation y={geometry.height * startLayout.switcherRatio} dark={dark} incognito={incognito} /> : null
      ) : null}
    </View>
  );
}

function StartSpacePage({
  geometry,
  space: profile,
  dark,
  incognito,
}: {
  geometry: StartGeometry;
  space: SyncedProfile;
  dark: boolean;
  incognito: boolean;
}) {
  const switcherY = geometry.height * startLayout.switcherRatio;
  const menuPlace = { left: (geometry.width - tabsLayout.menuWidth) / 2, width: tabsLayout.menuWidth };
  return (
    <View style={{ width: geometry.width, height: geometry.height }} pointerEvents="box-none">
      <View testID="startSwitcher" pointerEvents="box-none" style={[styles.switcherRow, { top: switcherY - browseLayout.hitTarget / 2, height: browseLayout.hitTarget }]}>
        <View accessible accessibilityRole="header" accessibilityLabel={profile.name}>
          <SpaceTitle space={profile} dark={dark} showsChevron={false} />
        </View>
      </View>
      {profile.pinned.tiles.length ? (
        <View testID="startTiles" style={[styles.tiles, { top: switcherY + startLayout.tilesGap, paddingHorizontal: geometry.safeSide + startLayout.tileSide }]}>
          <PinnedTiles tiles={profile.pinned.tiles} width={geometry.width - 2 * (geometry.safeSide + startLayout.tileSide)} profileId={profile.syncId} dark={dark} incognito={incognito} menuPlace={menuPlace} />
        </View>
      ) : null}
    </View>
  );
}

function PinnedTiles({ tiles, width, profileId, dark, incognito, menuPlace }: { tiles: PinnedTile[]; width: number; profileId: string; dark: boolean; incognito: boolean; menuPlace: ViewStyle }) {
  const columns = Math.max(1, Math.min(startLayout.tilesPerRow, tiles.length));
  const side = (width - startLayout.tileGap * (columns - 1)) / columns;
  const rows: PinnedTile[][] = [];
  for (let i = 0; i < tiles.length; i += columns) rows.push(tiles.slice(i, i + columns));
  return (
    <>
      {rows.map((row, at) => (
        <View key={at} testID="startTileRow" style={styles.tileRow}>
          {row.map((tile) => (
            <PinnedTileButton key={tile.key} tile={tile} width={side} profileId={profileId} dark={dark} incognito={incognito} menuPlace={menuPlace} />
          ))}
        </View>
      ))}
    </>
  );
}

function PinnedTileButton({ tile, width, profileId, dark, incognito, menuPlace }: { tile: PinnedTile; width: number; profileId: string; dark: boolean; incognito: boolean; menuPlace: ViewStyle }) {
  const folder = tile.folder?.length ? tile.folder : null;
  const label = remoteTitle(tile.title, tile.url);
  const items: MenuItem[] = folder
    ? folder.map((tab) => ({ label: remoteTitle(tab.title, tab.url), onPress: () => openRemote(tab.url, tab.title, profileId, tab.key) }))
    : /^https?:\/\//i.test(tile.url)
      ? [
          { label: "Copy Link", onPress: () => copyLink(tile.url) },
          { label: "Share", onPress: () => shareUrl(tile.url, tile.title) },
        ]
      : [];
  const button = ({ onPress, onLongPress }: MenuHandlers) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={folder ? "Shows the folder’s tabs." : undefined}
      onPress={folder ? onPress : () => openRemote(tile.url, tile.title, profileId, tile.key)}
      onLongPress={folder ? undefined : onLongPress}
      onPressIn={haptics.barPress}
      style={({ pressed }) => (pressed && !folder ? styles.pressed : null)}
    >
      <ChromeSurface testID="startTile" shape="rounded" cornerRadius={startLayout.tileRadius} incognito={incognito} dark={dark} style={[styles.tile, { width }]}>
        <View pointerEvents="none">
          <TileIcon tile={tile} isFolder={folder !== null} dark={dark} />
        </View>
      </ChromeSurface>
    </Pressable>
  );
  if (!items.length) return button({});
  return (
    <MenuTrigger items={items} trigger={folder ? "tap" : "longPress"} haptic={menuOpenedHaptic} place={menuPlace}>
      {button}
    </MenuTrigger>
  );
}

function TileIcon({ tile, isFolder, dark }: { tile: PinnedTile; isFolder: boolean; dark: boolean }) {
  const roles = rolesFor(dark);
  const systemSymbol = Platform.OS === "ios" && settingsUIAvailable() ? (isFolder ? "folder.fill" : spaceSymbol(tile.icon)) : null;
  if (systemSymbol)
    return (
      <Host matchContents style={isFolder ? { opacity: startLayout.folderInkOpacity } : undefined}>
        <SystemImage systemName={systemSymbol as never} size={startLayout.tileIcon * (isFolder ? startLayout.folderIconShare : startLayout.symbolIconShare)} color={isFolder ? roles.formAccent : PlatformColor("secondaryLabel")} modifiers={isFolder ? undefined : [systemFont({ weight: "medium" })]} />
      </Host>
    );
  if (isFolder)
    return (
      <View style={{ opacity: startLayout.folderInkOpacity }}>
        <Symbol name="folderFill" size={startLayout.tileIcon * startLayout.folderIconShare} color={roles.formAccent} />
      </View>
    );
  const symbol = symbolOf(tile.icon);
  if (symbol) return <Symbol name={symbol} size={startLayout.tileIcon * startLayout.symbolIconShare} color={roles.secondaryLabel} />;
  const emoji = emojiOf(tile.icon);
  if (emoji) return <Text style={{ fontSize: startLayout.tileIcon }}>{emoji}</Text>;
  return <Favicon iconUrl={null} pageUrl={tile.url} size={startLayout.tileIcon} />;
}

export function SpaceTitle({ space: profile, dark, showsChevron }: { space: SyncedProfile; dark: boolean; showsChevron: boolean }) {
  const roles = rolesFor(dark);
  return (
    <View style={styles.title}>
      <SpaceGlyph space={profile} dark={dark} />
      <Text style={[font.body, styles.headline, { color: roles.headerText }]} numberOfLines={1}>
        {profile.name}
      </Text>
      {showsChevron ? <SystemGlyph testID="spaceTitleChevron" systemName="chevron.down" pointSize={12} weight="semibold" fitted name="chevronDown" size={startLayout.chevron} color={roles.secondaryLabel} /> : null}
    </View>
  );
}

function SpaceGlyph({ space: profile, dark }: { space: SyncedProfile; dark: boolean }) {
  const ink = dark ? startInk.dark : startInk.light;
  const size = startLayout.spaceBadge;
  const symbol = symbolOf(profile.icon);
  if (symbol)
    return (
      <View testID="startSpaceGlyph" style={[styles.centered, { width: size * startLayout.badgeSymbolWidth, height: size }]}>
        <Symbol name={symbol} size={size * startLayout.badgeSymbolShare} color={ink.badgeInk} />
      </View>
    );
  const emoji = emojiOf(profile.icon);
  if (!emoji) return null;
  return (
    <View testID="startSpaceGlyph" style={[styles.centered, { width: size, height: size }]}>
      <Text style={{ fontSize: size * startLayout.badgeEmojiShare }}>{emoji}</Text>
    </View>
  );
}

function SpacePageDots({ count, index, name, onStep, dark, y }: { count: number; index: number; name: string; onStep: (by: 1 | -1) => void; dark: boolean; y: number }) {
  return (
    <View
      testID="startPageDots"
      pointerEvents="none"
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`Space ${index + 1} of ${count}`}
      accessibilityValue={{ text: name }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => onStep(event.nativeEvent.actionName === "increment" ? 1 : -1)}
      style={[styles.dots, { top: y - startLayout.pageDot / 2, height: startLayout.pageDot }]}
    >
      {Array.from({ length: count }, (_, dot) => (
        <PageDot key={dot} on={dot === index} dark={dark} />
      ))}
    </View>
  );
}

function PageDot({ on, dark }: { on: boolean; dark: boolean }) {
  const ink = dark ? startInk.dark : startInk.light;
  const lit = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    lit.value = withTiming(on ? 1 : 0, { duration: startMotion.pageDot, easing: tabsCurve.easeOut });
  }, [on, lit]);
  const style = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(lit.value, [0, 1], [ink.pageDot, ink.badgeInk]) }), [ink]);
  return <Animated.View testID="startPageDot" style={[styles.dot, style]} />;
}

function StartLogo({ y, incognito }: { y: number; incognito: boolean }) {
  const height = browseLayout.logoHeight;
  const search = () => {
    if (!incognito) countUsage("start_logo_taps");
    newTab();
  };
  return (
    <View testID="startLogo" pointerEvents="box-none" style={[styles.switcherRow, { top: y - height / 2, height }]}>
      <Pressable testID="startLogoButton" accessibilityRole="button" accessibilityLabel="Search" accessibilityHint="Opens Search." onPressIn={haptics.barPress} onPress={search} style={({ pressed }) => [styles.logoButton, pressed ? styles.logoPressed : null]}>
        <ArdiaLogo width={browseLayout.logoWidth} />
      </Pressable>
    </View>
  );
}

function SyncInvitation({ y, dark, incognito }: { y: number; dark: boolean; incognito: boolean }) {
  const roles = rolesFor(dark);
  return (
    <View testID="startSyncInvitation" pointerEvents="box-none" style={[styles.switcherRow, { top: y - startLayout.barCircle / 2, minHeight: startLayout.barCircle }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Sync With Your Mac" accessibilityHint="Brings your Mac’s spaces, tabs and pinned sites." onPress={() => openSettings({ page: "syncConnect" })}>
        <ChromeSurface shape="capsule" cornerRadius={capsule(startLayout.barCircle)} incognito={incognito} dark={dark} style={styles.invitation}>
          <Text style={[font.body, styles.headline, { color: roles.headerText }]}>Sync With Your Mac</Text>
        </ChromeSurface>
      </Pressable>
    </View>
  );
}

function symbolOf(icon: string | null): SymbolName | null {
  const symbol = sfSymbol(icon, isSymbolName);
  return symbol && isSymbolName(symbol) ? symbol : null;
}

export function spaceMenuSymbol(profile: SyncedProfile): SymbolName | null {
  return symbolOf(profile.icon);
}

export function emojiOf(icon: string | null): string | null {
  if (!icon || [...icon].length > 2 || !/\p{Emoji_Presentation}/u.test(icon)) return null;
  return icon;
}

const styles = StyleSheet.create({
  switcherRow: { position: "absolute", left: 0, right: 0, alignItems: "center", justifyContent: "center" },
  title: { flexDirection: "row", alignItems: "center", gap: startLayout.titleSpacing, minHeight: browseLayout.hitTarget },
  headline: { fontWeight: "600" },
  tiles: { position: "absolute", left: 0, right: 0, gap: startLayout.tileGap },
  tileRow: { flexDirection: "row", gap: startLayout.tileGap },
  tile: { height: startLayout.tileHeight, alignItems: "center", justifyContent: "center" },
  pressed: { transform: [{ scale: startLayout.tilePressScale }] },
  logoButton: { width: browseLayout.logoWidth, height: browseLayout.logoHeight, alignItems: "center", justifyContent: "center" },
  logoPressed: { opacity: startLayout.logoPressOpacity, transform: [{ scale: startLayout.tilePressScale }] },
  centered: { alignItems: "center", justifyContent: "center" },
  dots: { position: "absolute", left: 0, right: 0, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: startLayout.pageDotSpacing },
  dot: { width: startLayout.pageDot, height: startLayout.pageDot, borderRadius: capsule(startLayout.pageDot) },
  invitation: { minHeight: startLayout.barCircle, paddingHorizontal: startLayout.invitationPadding, justifyContent: "center" },
});
