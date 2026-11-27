import { useRef, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ViewInstance } from "react-native";
import { sfSymbol } from "../../lib/sfSymbols";
import { openSettings } from "../../state/settings/nav";
import { openRemote, opensRemotely } from "../../state/sync/actions";
import { remoteTitle } from "../../state/sync/spaces";
import type { PinnedTile, SyncedProfile } from "../../state/sync/store";
import { copyLink, shareUrl } from "../../state/browse/tabMenus";
import { capsule, Favicon, font, iconRoles, isSymbolName, screenReaderActions, space, spacesLayout, Symbol, useTheme, ActionButton, slopToReach, Tappable, usePressStyle, type MenuItem } from "../ui";
import type { Point } from "../../lib/menuPlace";
import { actionWords, destinationWords } from "../../lib/sharedWords";

const TILE_MIN_WIDTH = 72;
const TILE_HEIGHT = 56;
const TILE_HEIGHT_MAX = 72;
export const SPACES_LARGE_TEXT = 1.5;

export type PinOpener = (url: string, title: string, pinnedKey: string | null) => void;

const opensRemote = (profileId: string): PinOpener => (url, title, pinnedKey) => openRemote(url, title, profileId, pinnedKey);

export type PinLink = { url: string; title: string };

export function pinnedLinkMenu(url: string, title: string, profileId: string, pinnedKey: string | null = null, open: PinOpener = opensRemote(profileId), current: () => PinLink | null = () => ({ url, title })): MenuItem[] {
  const shared = (use: (link: PinLink) => void) => () => {
    const link = current();
    if (link && opensRemotely(link.url)) use(link);
  };
  const sharing: MenuItem[] = opensRemotely(url)
    ? [
        { label: actionWords.copyLink, icon: iconRoles.copyLink, onPress: shared((link) => copyLink(link.url)) },
        { label: actionWords.share, icon: iconRoles.share, onPress: shared((link) => shareUrl(link.url, link.title)) },
      ]
    : [];
  return [{ label: actionWords.open, icon: "arrowUpForward", onPress: () => open(url, title, pinnedKey) }, ...sharing];
}

export function pinnedFolderMenu(tile: PinnedTile, profileId: string, open: PinOpener = opensRemote(profileId)): MenuItem[] {
  return (tile.folder ?? []).map((tab) => ({ label: remoteTitle(tab.title, tab.url), onPress: () => open(tab.url, tab.title, tab.key) }));
}

const tileColumns = (width: number) => Math.max(1, Math.floor((width - space.l * 2 + space.s) / (TILE_MIN_WIDTH + space.s)));

export function tilesHeight(count: number, width: number, fontScale: number): number {
  if (count <= 0) return 0;
  const rows = Math.ceil(count / tileColumns(width));
  const face = Math.min(TILE_HEIGHT * fontScale, TILE_HEIGHT_MAX);
  const tile = fontScale < SPACES_LARGE_TEXT ? face + spacesLayout.tileGap + font.caption.lineHeight * fontScale : face;
  return space.xs + space.s + rows * tile + (rows - 1) * space.s;
}

export function Tiles({ tiles, profileId, onFolder, onLink, open = opensRemote(profileId) }: { tiles: PinnedTile[]; profileId: string; onFolder: (tile: PinnedTile, anchor: RefObject<ViewInstance | null>) => void; onLink: (url: string, title: string, at: Point | null, pinnedKey: string | null, from?: RefObject<ViewInstance | null>) => void; open?: PinOpener }) {
  const { width, fontScale } = useWindowDimensions();
  const height = Math.min(TILE_HEIGHT * fontScale, TILE_HEIGHT_MAX);
  const titled = fontScale < SPACES_LARGE_TEXT;
  const columns = tileColumns(width);
  const rows: PinnedTile[][] = [];
  for (let i = 0; i < tiles.length; i += columns) rows.push(tiles.slice(i, i + columns));
  return (
    <View style={styles.tiles}>
      {rows.map((row, index) => (
        <View key={index} style={styles.tileRow}>
          {row.map((tile) => (
            <TileButton key={tile.key} tile={tile} height={height} titled={titled} onFolder={onFolder} onLink={onLink} open={open} />
          ))}
          {Array.from({ length: columns - row.length }, (_, i) => (
            <View key={`gap${i}`} style={styles.tile} />
          ))}
        </View>
      ))}
    </View>
  );
}

function TileButton({
  tile,
  height,
  titled,
  onFolder,
  onLink,
  open,
}: {
  tile: PinnedTile;
  height: number;
  titled: boolean;
  onFolder: (tile: PinnedTile, anchor: RefObject<ViewInstance | null>) => void;
  onLink: (url: string, title: string, at: Point | null, pinnedKey: string | null, from?: RefObject<ViewInstance | null>) => void;
  open: PinOpener;
}) {
  const theme = useTheme();
  const anchor = useRef<ViewInstance>(null);
  const tileStyle = usePressStyle("icon", { style: styles.tile });
  const folder = tile.folder?.length ? tile.folder : null;
  const label = tile.title.trim() || remoteTitle("", tile.url);
  return (
    <Pressable
      ref={anchor}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        if (folder) {
          onFolder(tile, anchor);
          return;
        }
        open(tile.url, tile.title, tile.key);
      }}
      onLongPress={folder ? undefined : (event) => onLink(tile.url, tile.title, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }, tile.key, anchor)}
      {...(folder ? {} : screenReaderActions([{ name: "longpress", run: () => onLink(tile.url, tile.title, null, tile.key, anchor) }]))}
      style={tileStyle}
    >
      <View testID="spaceTileFace" style={[styles.tileFace, { height, backgroundColor: theme.groupFill }]}>
        {folder ? <Symbol name="folderFill" size={22} color={theme.secondaryLabel} /> : <Favicon iconUrl={null} pageUrl={tile.url} size={24} />}
      </View>
      {titled ? (
        <Text style={[font.caption, styles.medium, { color: theme.secondaryLabel }]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function Switcher({ profiles, selected, onChoose, bottom }: { profiles: SyncedProfile[]; selected: string; onChoose: (id: string) => void; bottom: number }) {
  const theme = useTheme();
  return (
    <View style={[styles.switcherRow, { paddingBottom: bottom + space.xs }]}>
      <ScrollView overScrollMode="never"
        horizontal
        testID="spacesSwitcher"
        showsHorizontalScrollIndicator={false}
        bounces={false}
        accessibilityRole="tablist"
        style={[styles.switcher, { backgroundColor: theme.tertiaryFill, borderColor: theme.separator }]}
        contentContainerStyle={styles.switcherContent}
      >
        {profiles.map((profile) => {
          const isSelected = profile.syncId === selected;
          return (
            <Tappable
              key={profile.syncId}
              kind="icon"
              role="tab"
              label={profile.name}
              selected={isSelected}
              hitSlop={slopToReach(spacesLayout.switchWidth, spacesLayout.switchHeight)}
              onPress={() => onChoose(profile.syncId)}
              style={[styles.switch, isSelected ? null : styles.switchUnselected]}
            >
              <ProfileMark icon={profile.icon} />
            </Tappable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function ProfileMark({ icon }: { icon: string | null }) {
  const theme = useTheme();
  const symbol = sfSymbol(icon, isSymbolName);
  if (symbol && isSymbolName(symbol)) return <Symbol name={symbol} size={20} color={theme.label} />;
  return <View style={[styles.dot, { backgroundColor: theme.label }]} />;
}

export function Unavailable({ isOff }: { isOff: boolean }) {
  const theme = useTheme();
  return (
    <View style={styles.unavailable}>
      <Symbol name="macAndPhone" size={48} color={theme.secondaryLabel} />
      <Text style={[font.title2, styles.bold, styles.centered, { color: theme.label }]}>Your Mac’s Spaces</Text>
      <Text style={[font.subheadline, styles.centered, { color: theme.secondaryLabel }]}>{isOff ? "Every tab, anywhere." : "Waiting for your Mac."}</Text>
      <View style={styles.primary}>
        <ActionButton title={destinationWords.sync} variant="filled" tone="accent" size="compact" onPress={() => openSettings({ page: isOff ? "syncConnect" : "sync" })} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  centered: { textAlign: "center" },
  tiles: { gap: space.s, paddingHorizontal: space.l, paddingTop: space.xs, paddingBottom: space.s },
  tileRow: { flexDirection: "row", gap: space.s },
  tile: { flex: 1, alignItems: "center", gap: spacesLayout.tileGap },
  tileFace: { alignSelf: "stretch", borderRadius: spacesLayout.tileFaceRadius, alignItems: "center", justifyContent: "center" },
  switcherRow: { alignItems: "center", paddingTop: space.xs },
  switcherContent: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.xs },
  switcher: { flexGrow: 0, maxWidth: "100%", height: 44, borderRadius: capsule(44), borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth },
  switch: { width: spacesLayout.switchWidth, height: spacesLayout.switchHeight, alignItems: "center", justifyContent: "center" },
  switchUnselected: { opacity: spacesLayout.switchUnselectedOpacity },
  dot: { width: spacesLayout.dot, height: spacesLayout.dot, borderRadius: capsule(spacesLayout.dot) },
  unavailable: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacesLayout.stackGap, paddingHorizontal: space.xxl },
  primary: { marginTop: spacesLayout.buttonTop },
});
