import { useRef, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ViewInstance } from "react-native";
import { sfSymbol } from "../../lib/sfSymbols";
import { openSettings } from "../../state/settings/nav";
import { openRemote } from "../../state/sync/actions";
import { remoteTitle } from "../../state/sync/spaces";
import type { PinnedTile, SyncedProfile } from "../../state/sync/store";
import { capsule, controlRadius, Favicon, font, isSymbolName, screenReaderActions, space, spacesLayout, Symbol, useTheme, ActionButton, slopToReach, Tappable, usePressStyle } from "../ui";
import type { Point } from "../../lib/menuPlace";
import { destinationWords } from "../../lib/sharedWords";

const TILE_MIN_WIDTH = 72;
const TILE_HEIGHT = 56;
const TILE_HEIGHT_MAX = 72;
export const SPACES_LARGE_TEXT = 1.5;

export function Tiles({ tiles, profileId, onFolder, onLink }: { tiles: PinnedTile[]; profileId: string; onFolder: (tile: PinnedTile, anchor: RefObject<ViewInstance | null>) => void; onLink: (url: string, title: string, at: Point | null) => void }) {
  const { width, fontScale } = useWindowDimensions();
  const height = Math.min(TILE_HEIGHT * fontScale, TILE_HEIGHT_MAX);
  const titled = fontScale < SPACES_LARGE_TEXT;
  const columns = Math.max(1, Math.floor((width - space.l * 2 + space.s) / (TILE_MIN_WIDTH + space.s)));
  const rows: PinnedTile[][] = [];
  for (let i = 0; i < tiles.length; i += columns) rows.push(tiles.slice(i, i + columns));
  return (
    <View style={styles.tiles}>
      {rows.map((row, index) => (
        <View key={index} style={styles.tileRow}>
          {row.map((tile) => (
            <TileButton key={tile.key} tile={tile} profileId={profileId} height={height} titled={titled} onFolder={onFolder} onLink={onLink} />
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
  profileId,
  height,
  titled,
  onFolder,
  onLink,
}: {
  tile: PinnedTile;
  profileId: string;
  height: number;
  titled: boolean;
  onFolder: (tile: PinnedTile, anchor: RefObject<ViewInstance | null>) => void;
  onLink: (url: string, title: string, at: Point | null) => void;
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
      onPress={() => (folder ? onFolder(tile, anchor) : openRemote(tile.url, tile.title, profileId, tile.key))}
      onLongPress={folder ? undefined : (event) => onLink(tile.url, tile.title, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
      {...(folder ? {} : screenReaderActions([{ name: "longpress", run: () => onLink(tile.url, tile.title, null) }]))}
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
  switcher: { flexGrow: 0, maxWidth: "100%", height: 44, borderRadius: controlRadius(44), borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth },
  switch: { width: spacesLayout.switchWidth, height: spacesLayout.switchHeight, alignItems: "center", justifyContent: "center" },
  switchUnselected: { opacity: spacesLayout.switchUnselectedOpacity },
  dot: { width: spacesLayout.dot, height: spacesLayout.dot, borderRadius: capsule(spacesLayout.dot) },
  unavailable: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacesLayout.stackGap, paddingHorizontal: space.xxl },
  primary: { marginTop: spacesLayout.buttonTop },
});
