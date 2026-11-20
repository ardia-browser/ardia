import { memo, type ReactNode, type RefObject, useCallback, useMemo } from "react";
import { Image, View, type GestureResponderEvent } from "react-native";
import { pickLibraryItem } from "../../state/library/actions";
import { libraryDayGroups, useLibraryMedia, useLibraryQuery, useLibraryScope, useLibraryToday, useSectionLive, type MediaFolderProblem } from "../../state/library/hooks";
import type { DayGroup, MediaItem } from "../../state/library/items";
import { mediaItemMenu } from "../../state/library/mediaMenu";
import type { LibraryView } from "../../state/library/views";
import { modifiersOf } from "../../lib/keys";
import { Button, Symbol, Text, useTheme } from "../ui";
import { openExternalURL } from "../../state/app/system";
import { openSettings } from "../../state/settings/settingsWindows";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { useLibraryScrollFrame } from "./LibraryScrollEdge";
import { FileIcon } from "../downloads/Downloads";
import { useDownloadView } from "../downloads/useDownloadView";
import { CardGrid } from "./CardGrid";
import { LibraryViewPair } from "./LibraryViewPair";
import { DayList } from "./DayList";
import { LibraryCard } from "./LibraryCard";
import { LibraryRow, RowSubtitle } from "./LibraryRow";
import { downloadLine, fileKind } from "./format";
import { LIBRARY } from "./tokens";
import { aspectOf, cropsToShow, fitInBox } from "./thumbnailFit";
import { useFileThumb, type Thumb } from "./useFileThumbnail";
import { LibraryProfileBadge, useOwnedLabel } from "./LibraryProfileBadge";
import { soleOwner } from "../../state/library/profileScope";

const G = LIBRARY.grid;
const L = LIBRARY.list;
const square = (tile: number) => tile;
const keyOf = (item: MediaItem) => item.id;

type SectionProps = { windowId: string; panelWidth: number; entry: RefObject<(() => void) | null>; empty: ReactNode };

function MediaSectionPage({ view, windowId, panelWidth, entry, empty }: SectionProps & { view: LibraryView }) {
  const { items, folderProblem } = useLibraryMedia(windowId);
  const searching = !!useLibraryQuery(windowId).trim();
  const live = useSectionLive(windowId, "media");
  const today = useLibraryToday(live);
  const merged = useLibraryScope(windowId).merged;
  const cardGroups = useMemo((): DayGroup<MediaItem>[] => [{ key: "all", title: "", items: items as MediaItem[] }], [items]);
  const open = useCallback((item: MediaItem) => pickLibraryItem(windowId, "media", item.id, {}, merged ? soleOwner(item.owners) : undefined), [windowId, merged]);
  const renderCard = useCallback(
    (item: MediaItem, tile: number, highlighted: boolean) => <MediaCard item={item} size={tile} windowId={windowId} highlighted={highlighted} merged={merged} />,
    [windowId, merged],
  );
  const renderRow = useCallback((item: MediaItem, highlighted: boolean) => <MediaRow item={item} windowId={windowId} highlighted={highlighted} merged={merged} />, [windowId, merged]);
  if (!items.length) return folderProblem && !searching ? <FolderProblem problem={folderProblem} /> : <>{empty}</>;
  return (
    <LibraryViewPair
      view={view}
      live={live}
      entry={entry}
      render={(v, slot) =>
        v === "list" ? (
          <DayList windowId={windowId} groups={libraryDayGroups(items, today)} keyOf={keyOf} renderRow={renderRow} onOpen={open} entry={slot.entry} scroll={slot.scroll} />
        ) : (
          <CardGrid windowId={windowId} groups={cardGroups} panelWidth={panelWidth} keyOf={keyOf} rowHeight={square} renderCard={renderCard} onOpen={open} entry={slot.entry} scroll={slot.scroll} />
        )
      }
    />
  );
}

type EntryProps = { item: MediaItem; windowId: string; highlighted: boolean; merged: boolean };

const MediaCard = memo(function MediaCard({ item, size, windowId, highlighted, merged }: EntryProps & { size: number }) {
  const d = item.download;
  const { exists } = useDownloadView(d);
  const name = d.filename || d.path;
  const label = useOwnedLabel(name, item.owners, merged);
  const owner = merged ? soleOwner(item.owners) : undefined;
  return (
    <LibraryCard
      windowId={windowId}
      card={{ kind: "media", id: item.id }}
      width={size}
      faceHeight={size}
      highlighted={highlighted}
      label={label}
      path={exists ? d.path : null}
      face={<MediaFace item={item} exists={exists} box={size - 2 * G.tileInset} />}
      badge={merged ? <LibraryProfileBadge owners={item.owners} place="card" /> : null}
      onPress={(e: GestureResponderEvent) => exists && pickLibraryItem(windowId, "media", item.id, modifiersOf(e), owner)}
      onContextMenu={() => void mediaItemMenu(d, windowId)}
    />
  );
});

const MediaRow = memo(function MediaRow({ item, windowId, highlighted, merged }: EntryProps) {
  const d = item.download;
  const { exists } = useDownloadView(d);
  const name = d.filename || d.path;
  const label = useOwnedLabel(name, item.owners, merged);
  const owner = merged ? soleOwner(item.owners) : undefined;
  const line = downloadLine(d, exists);
  const text = d.state === "finished" && exists ? `${fileKind(name, d.mimeType)} · ${line.text}` : line.text;
  return (
    <LibraryRow
      windowId={windowId}
      card={{ kind: "media", id: item.id }}
      icon={<MediaFace item={item} exists={exists} box={L.fileIcon} small />}
      title={name}
      label={label}
      muted={!exists}
      truncate="middle"
      highlighted={highlighted}
      path={exists ? d.path : null}
      subtitle={<RowSubtitle text={text} tone={line.tone} />}
      badge={merged ? <LibraryProfileBadge owners={item.owners} place="row" /> : null}
      onPress={(e: GestureResponderEvent) => exists && pickLibraryItem(windowId, "media", item.id, modifiersOf(e), owner)}
      onContextMenu={() => void mediaItemMenu(d, windowId)}
    />
  );
});

export function MediaFace({ item, exists, box, small }: { item: MediaItem; exists: boolean; box: number; small?: boolean }) {
  const theme = useTheme();
  const d = item.download;
  const audio = item.media === "audio";
  const thumb = useFileThumb(d, Math.round(box), exists && !audio);
  if (audio && exists) return <Symbol name="waveform" size={small ? box * 0.7 : G.audioGlyph} color={theme.textSecondary} style={{ width: box, height: box }} />;
  if (thumb) return <Thumbnail thumb={thumb} box={box} fill={small} />;
  return (
    <View style={{ opacity: exists ? 1 : L.missingOpacity }}>
      <FileIcon path={d.path || d.filename} size={Math.min(G.fileIcon, box)} />
    </View>
  );
}

export function Thumbnail({ thumb, box, fill }: { thumb: Thumb; box: number; fill?: boolean }) {
  const aspect = aspectOf(thumb);
  return (
    <Image
      source={{ uri: thumb.uri }}
      resizeMode={fill || cropsToShow(aspect) ? "cover" : undefined}
      style={fill ? { width: box, height: box, borderRadius: L.thumbRadius } : { ...fitInBox(box, aspect), borderRadius: G.thumbRadius }}
    />
  );
}

const FOLDER_PROBLEMS: Record<MediaFolderProblem, { title: string; action?: { title: string; run: () => void } }> = {
  denied: {
    title: "Can't Open Downloads Folder",
    action: PLATFORM_TERMS.filesAccessSettingsUrl ? { title: "Open System Settings", run: () => void openExternalURL(PLATFORM_TERMS.filesAccessSettingsUrl) } : undefined,
  },
  missing: { title: "Downloads Folder Not Found", action: { title: "Open Settings", run: () => openSettings("general") } },
  unavailable: { title: "Downloads Folder Unavailable" },
};

const CENTERED = { textAlign: "center" } as const;
const PROBLEM = { flex: 1, alignItems: "center", justifyContent: "center", gap: LIBRARY.empty.actionGap, paddingHorizontal: LIBRARY.panel.pad, paddingBottom: LIBRARY.empty.lift } as const;

const FolderProblem = memo(function FolderProblem({ problem }: { problem: MediaFolderProblem }) {
  const { inset } = useLibraryScrollFrame();
  const { title, action } = FOLDER_PROBLEMS[problem];
  return (
    <View style={[PROBLEM, { paddingTop: inset }]}>
      <Text size="title" weight="medium" tone="textSecondary" style={CENTERED}>
        {title}
      </Text>
      {action ? <Button title={action.title} onPress={action.run} /> : null}
    </View>
  );
});

export const MediaSection = memo(MediaSectionPage);
